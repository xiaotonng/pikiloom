import { describe, expect, it, beforeEach, vi } from 'vitest';

// Shared, hoisted mock state so the vi.mock factory (hoisted above imports) can reach it.
const h = vi.hoisted(() => ({
  resolvers: [] as Array<(value: unknown) => void>,
  count: 0,
}));

vi.mock('../dashboard/src/api', () => ({
  api: {
    getSessionMessages: () => {
      h.count++;
      return new Promise((resolve) => { h.resolvers.push(resolve); });
    },
  },
}));

import { loadSessionMessages } from '../dashboard/src/session-preload.ts';

function query(sessionId: string) {
  return { workdir: '/w', agent: 'claude', sessionId, rich: true, turnOffset: 0, turnLimit: 12 };
}
const userOnly = { ok: true, richMessages: [{ role: 'user', text: 'u', blocks: [] }], messages: [], totalTurns: 1 };
const withAssistant = {
  ok: true,
  richMessages: [
    { role: 'user', text: 'u', blocks: [] },
    { role: 'assistant', text: 'A', blocks: [{ type: 'text', content: 'A' }] },
  ],
  messages: [],
  totalTurns: 1,
};

describe('loadSessionMessages force vs in-flight de-dup', () => {
  beforeEach(() => { h.resolvers.length = 0; h.count = 0; });

  it('de-dupes concurrent non-forced reads onto a single request', async () => {
    const p1 = loadSessionMessages(query('dedupe'));
    const p2 = loadSessionMessages(query('dedupe'));
    expect(h.count).toBe(1); // second call rides the in-flight promise
    h.resolvers[0](userOnly);
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe(r2);
  });

  it('force issues a fresh request instead of reusing an in-flight (possibly stale) promise', async () => {
    // A mid-turn read that will resolve with a user-only tail (assistant not flushed yet).
    const nonForced = loadSessionMessages(query('race'));
    expect(h.count).toBe(1);

    // The post-`done` reconcile forces a reload; it must NOT piggyback on the stale in-flight one.
    const forced = loadSessionMessages(query('race'), { force: true });
    expect(h.count).toBe(2);

    h.resolvers[0](userOnly);        // stale in-flight resolves user-only
    h.resolvers[1](withAssistant);   // fresh forced request carries the assistant
    const forcedResult = await forced;
    expect(forcedResult.richMessages?.some((m: { role: string }) => m.role === 'assistant')).toBe(true);
    await nonForced;
  });
});
