import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLoom, type Loom } from '../src/runtime/loom.js';
import { EchoDriver } from '../src/drivers/echo.js';
import { FsSessionStore } from '../src/ports/defaults.js';
import type { UniversalSnapshot } from '../src/protocol/index.js';
import type { LoomIO } from '../src/contracts/surface.js';

function watch(io: LoomIO) {
  const updates: UniversalSnapshot[] = [];
  let resolveDone: (s: UniversalSnapshot) => void;
  const done = new Promise<UniversalSnapshot>((r) => { resolveDone = r; });
  const unsub = io.subscribe((_k, s) => {
    updates.push(structuredClone(s));
    if (s.phase === 'done') resolveDone(structuredClone(s));
  });
  return { updates, done, unsub };
}
const waitFor = async (pred: () => boolean | Promise<boolean>, ms = 5000) => {
  const t0 = Date.now();
  while (!(await pred())) {
    if (Date.now() - t0 > ms) throw new Error('waitFor timeout');
    await new Promise(r => setTimeout(r, 5));
  }
};

describe('kernel runtime (EchoDriver, hermetic)', () => {
  let tmp: string;
  let loom: Loom;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-rt-'));
    loom = createLoom({ drivers: [new EchoDriver()], defaultAgent: 'echo', sessionStore: new FsSessionStore(tmp) });
    await loom.start();
  });
  afterEach(async () => { await loom.stop(); fs.rmSync(tmp, { recursive: true, force: true }); });

  it('streams a turn to completion: reasoning + text + tool + usage', async () => {
    const w = watch(loom.io);
    const { sessionKey, taskId } = await loom.io.prompt({ prompt: 'hello world' });
    expect(sessionKey).toMatch(/^echo:/);
    expect(taskId).toBeTruthy();
    const final = await w.done;
    expect(final.phase).toBe('done');
    expect(final.text).toBe('Echo: hello world');
    expect(final.reasoning).toContain('Considering: hello world');
    expect(final.toolCalls?.find(t => t.id === 't1')?.status).toBe('done');
    expect(final.usage?.outputTokens).toBeGreaterThan(0);
    expect(final.incomplete).toBe(false);
    // streaming was incremental (more than one text length observed)
    const textLens = new Set(w.updates.map(u => (u.text || '').length));
    expect(textLens.size).toBeGreaterThan(2);
    w.unsub();
  });

  it('stop() interrupts a held turn', async () => {
    const w = watch(loom.io);
    const { sessionKey } = await loom.io.prompt({ prompt: 'HOLD then echo' });
    await waitFor(() => w.updates.some(u => u.activity === 'holding for steer'));
    expect(loom.io.stop(sessionKey)).toBe(true);
    const final = await w.done;
    expect(final.phase).toBe('done');
    expect(final.incomplete).toBe(true);
    expect(final.error).toMatch(/Interrupted/);
    w.unsub();
  });

  it('steer() injects mid-turn input', async () => {
    const w = watch(loom.io);
    const { taskId } = await loom.io.prompt({ prompt: 'HOLD' });
    await waitFor(() => w.updates.some(u => u.activity === 'holding for steer'));
    expect(await loom.io.steer(taskId, 'EXTRA')).toBe(true);
    const final = await w.done;
    expect(final.text).toContain('steered: EXTRA');
    expect(final.incomplete).toBe(false);
    w.unsub();
  });

  it('interact() resolves a human-in-the-loop question', async () => {
    const w = watch(loom.io);
    await loom.io.prompt({ prompt: 'ASK: favorite color?' });
    await waitFor(() => w.updates.some(u => (u.interactions?.length || 0) > 0));
    const pid = w.updates.flatMap(u => u.interactions || []).find(Boolean)!.promptId;
    expect(loom.io.interact(pid, 'text', 'blue')).toBe(true);
    const final = await w.done;
    expect(final.text).toBe('You said: blue');
    expect(final.interactions).toEqual([]);
    w.unsub();
  });

  it('persists a session record and resumes by key', async () => {
    const w = watch(loom.io);
    const { sessionKey } = await loom.io.prompt({ prompt: 'first turn' });
    await w.done;
    const store = new FsSessionStore(tmp);
    const id = sessionKey.split(':')[1];
    // persistence completes just after the 'done' snapshot (Hub records in a .then)
    await waitFor(async () => (await store.get('echo', id))?.runState === 'completed');
    const rec = await store.get('echo', id);
    expect(rec?.runState).toBe('completed');

    // resume: same key -> same session
    const w2 = watch(loom.io);
    const res2 = await loom.io.prompt({ prompt: 'second turn', sessionKey });
    expect(res2.sessionKey).toBe(sessionKey);
    await w2.done;
    w.unsub(); w2.unsub();
  });
});
