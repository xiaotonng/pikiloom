import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLoom, type Loom } from '../src/runtime/loom.js';
import { EchoDriver } from '../src/drivers/echo.js';
import { FsSessionStore } from '../src/ports/defaults.js';
import { applySnapshotPatch, type UniversalSnapshot } from '../src/protocol/index.js';
import type { LoomIO } from '../src/contracts/surface.js';

function watchAll(io: LoomIO) {
  const updates: UniversalSnapshot[] = [];
  const unsub = io.subscribe((_k, s) => updates.push(structuredClone(s)));
  return { updates, unsub };
}
const waitFor = async (pred: () => boolean | Promise<boolean>, ms = 6000) => {
  const t0 = Date.now();
  while (!(await pred())) { if (Date.now() - t0 > ms) throw new Error('waitFor timeout'); await new Promise(r => setTimeout(r, 5)); }
};

describe('per-session serial queue (hermetic)', () => {
  let tmp: string;
  let loom: Loom;
  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-q-'));
    loom = createLoom({ drivers: [new EchoDriver()], defaultAgent: 'echo', sessionStore: new FsSessionStore(tmp) });
    await loom.start();
  });
  afterEach(async () => { await loom.stop(); fs.rmSync(tmp, { recursive: true, force: true }); });

  it('a 2nd prompt to a busy session queues, then promotes in order on finish', async () => {
    const w = watchAll(loom.io);
    const { sessionKey, taskId: t1 } = await loom.io.prompt({ prompt: 'HOLD' });
    await waitFor(() => w.updates.some(u => u.activity === 'holding for steer'));

    const { taskId: t2 } = await loom.io.prompt({ prompt: 'second', sessionKey });   // session busy -> queues
    await waitFor(() => (loom.io.getSnapshot(sessionKey)?.snapshot.queued?.length || 0) === 1);
    expect(loom.io.getSnapshot(sessionKey)!.snapshot.queued![0]).toMatchObject({ taskId: t2, prompt: 'second' });
    // the queued turn is NOT a separate session
    expect(loom.io.listSessions().filter(s => s.sessionKey === sessionKey)).toHaveLength(1);

    expect(await loom.io.steer(t1, 'go')).toBe(true);                                 // release turn 1
    await waitFor(async () => (await loom.io.getHistory(sessionKey)).length === 2);
    const hist = await loom.io.getHistory(sessionKey);
    expect(hist.map(h => h.prompt)).toEqual(['HOLD', 'second']);                      // serial order preserved
    expect(hist[0].text).toContain('steered: go');
    expect(hist[1].text).toBe('Echo: second');
    expect(loom.io.getSnapshot(sessionKey)?.snapshot.queued ?? []).toEqual([]);        // queue drained
  });

  it('no cross-turn bleed: a 2nd turn resets the cumulative client snapshot (text + queued)', async () => {
    // mimic a wire client: accumulate patches exactly like applySnapshotPatch on the wire
    let cum: UniversalSnapshot | null = null;
    const unsub = loom.io.subscribe((_k, _s, patch) => { cum = applySnapshotPatch(cum, patch); });

    const { sessionKey } = await loom.io.prompt({ prompt: 'one' });
    await waitFor(() => cum?.phase === 'done');
    expect(cum!.text).toBe('Echo: one');

    await loom.io.prompt({ prompt: 'two', sessionKey });        // 2nd turn, same session
    await waitFor(() => cum?.phase === 'done' && cum?.text === 'Echo: two');
    expect(cum!.text).toBe('Echo: two');                         // NOT 'Echo: oneEcho: two'
    expect(cum!.queued ?? []).toEqual([]);
    unsub();
  });

  it('stop() ends the active turn but the queued turn still promotes', async () => {
    const w = watchAll(loom.io);
    const { sessionKey } = await loom.io.prompt({ prompt: 'HOLD' });
    await waitFor(() => w.updates.some(u => u.activity === 'holding for steer'));
    await loom.io.prompt({ prompt: 'after-stop', sessionKey });
    await waitFor(() => (loom.io.getSnapshot(sessionKey)?.snapshot.queued?.length || 0) === 1);

    expect(loom.io.stop(sessionKey)).toBe(true);                                       // stop the active (held) turn
    await waitFor(async () => (await loom.io.getHistory(sessionKey)).length === 2);
    const hist = await loom.io.getHistory(sessionKey);
    expect(hist.map(h => h.prompt)).toEqual(['HOLD', 'after-stop']);
    expect(hist[0].incomplete).toBe(true);                                            // turn 1 interrupted
    expect(hist[1].text).toBe('Echo: after-stop');                                    // turn 2 still ran
  });
});
