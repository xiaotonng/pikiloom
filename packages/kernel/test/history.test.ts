import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLoom, type Loom } from '../src/runtime/loom.js';
import { EchoDriver } from '../src/drivers/echo.js';
import { FsSessionStore } from '../src/ports/defaults.js';
import type { UniversalSnapshot } from '../src/protocol/index.js';
import type { LoomIO } from '../src/contracts/surface.js';

function watchDone(io: LoomIO) {
  let resolveDone: (s: UniversalSnapshot) => void;
  const done = new Promise<UniversalSnapshot>((r) => { resolveDone = r; });
  const unsub = io.subscribe((_k, s) => { if (s.phase === 'done') resolveDone(structuredClone(s)); });
  return { done, unsub };
}
const waitFor = async (pred: () => boolean | Promise<boolean>, ms = 5000) => {
  const t0 = Date.now();
  while (!(await pred())) {
    if (Date.now() - t0 > ms) throw new Error('waitFor timeout');
    await new Promise(r => setTimeout(r, 5));
  }
};

describe('session history / transcript (hermetic)', () => {
  let tmp: string;
  let loom: Loom;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-hist-'));
    loom = createLoom({ drivers: [new EchoDriver()], defaultAgent: 'echo', sessionStore: new FsSessionStore(tmp) });
    await loom.start();
  });
  afterEach(async () => { await loom.stop(); fs.rmSync(tmp, { recursive: true, force: true }); });

  it('accumulates one transcript entry per completed turn, in order, as full snapshots', async () => {
    const w1 = watchDone(loom.io);
    const { sessionKey } = await loom.io.prompt({ prompt: 'first turn' });
    await w1.done; w1.unsub();
    // transcript is written in a .then just after the 'done' snapshot publishes
    await waitFor(async () => (await loom.io.getHistory(sessionKey)).length === 1);

    const w2 = watchDone(loom.io);
    await loom.io.prompt({ prompt: 'second turn', sessionKey });
    await w2.done; w2.unsub();
    await waitFor(async () => (await loom.io.getHistory(sessionKey)).length === 2);

    const hist = await loom.io.getHistory(sessionKey);
    expect(hist.map(h => h.prompt)).toEqual(['first turn', 'second turn']);
    expect(hist.every(h => h.phase === 'done')).toBe(true);
    expect(hist[0].text).toBe('Echo: first turn');
    expect(hist[1].text).toBe('Echo: second turn');
    // each entry is a FULL snapshot — tool calls + usage survive the round-trip
    expect(hist[0].toolCalls?.find(t => t.id === 't1')?.status).toBe('done');
    expect(hist[1].usage?.outputTokens).toBeGreaterThan(0);
  });

  it('returns [] for an unknown session', async () => {
    expect(await loom.io.getHistory('echo:does-not-exist')).toEqual([]);
  });

  it('persists to disk — a fresh store instance reads the same transcript', async () => {
    const w = watchDone(loom.io);
    const { sessionKey } = await loom.io.prompt({ prompt: 'persist me' });
    await w.done; w.unsub();
    await waitFor(async () => (await loom.io.getHistory(sessionKey)).length === 1);

    const fresh = new FsSessionStore(tmp);              // no in-memory reliance
    const id = sessionKey.split(':')[1];
    const hist = await fresh.history('echo', id);
    expect(hist.length).toBe(1);
    expect(hist[0].text).toBe('Echo: persist me');
  });
});
