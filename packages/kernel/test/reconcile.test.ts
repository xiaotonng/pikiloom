import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FsSessionStore, isProcessAlive } from '../src/ports/defaults.js';
import { createLoom } from '../src/runtime/loom.js';

// Orphan reconciliation: a session stranded at runState:'running' by a process that died
// mid-turn must be repaired to 'incomplete' at startup — but ONLY when its owner pid is dead,
// so a store shared by several live processes (dev + prod on one home dir) never has a live
// turn clobbered by another instance's boot.
describe('FsSessionStore orphan reconciliation', () => {
  let tmp: string; let store: FsSessionStore;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-reconcile-'));
    store = new FsSessionStore(tmp);
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  async function seed(agent: string, sessionId: string, patch: Record<string, unknown>): Promise<void> {
    await store.ensure(agent, { sessionId, workdir: tmp, title: sessionId });
    const rec = (await store.get(agent, sessionId))!;
    await store.save({ ...rec, ...patch });
  }

  it('reaps a running record whose owner pid is dead; leaves live/pidless/finished ones alone', async () => {
    const DEAD = 2147480000;   // astronomically unlikely to be a live pid
    await seed('codex', 'dead-owner',   { runState: 'running', runPid: DEAD });
    await seed('codex', 'live-owner',   { runState: 'running', runPid: process.pid });   // pid of THIS test process
    await seed('codex', 'legacy-nopid', { runState: 'running', runPid: undefined });     // pre-fix record
    await seed('claude', 'finished',    { runState: 'completed', runPid: null });

    const repaired = await store.reconcileRunning(isProcessAlive);

    expect(repaired).toBe(1);
    expect((await store.get('codex', 'dead-owner'))!.runState).toBe('incomplete');
    expect((await store.get('codex', 'dead-owner'))!.runPid).toBeNull();
    expect((await store.get('codex', 'dead-owner'))!.runDetail).toMatch(/owner process exited/);
    // Untouched:
    expect((await store.get('codex', 'live-owner'))!.runState).toBe('running');
    expect((await store.get('codex', 'legacy-nopid'))!.runState).toBe('running');
    expect((await store.get('claude', 'finished'))!.runState).toBe('completed');
  });

  it('markRunning stamps runState:running + owner; recordResult clears the owner', async () => {
    await store.ensure('codex', { sessionId: 's1', workdir: tmp, title: 's1' });
    await store.markRunning('codex', 's1', { pid: 4242, startedAt: 111 });
    let rec = (await store.get('codex', 's1'))!;
    expect(rec.runState).toBe('running');
    expect(rec.runPid).toBe(4242);
    expect(rec.runStartedAt).toBe(111);

    await store.recordResult('codex', 's1', { ok: true, text: 'done' });
    rec = (await store.get('codex', 's1'))!;
    expect(rec.runState).toBe('completed');
    expect(rec.runPid).toBeNull();
  });

  it('isProcessAlive: current process alive, an impossible pid dead', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(2147480000)).toBe(false);
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
  });

  it('loom.start() auto-reconciles orphaned running records', async () => {
    await seed('codex', 'crashed', { runState: 'running', runPid: 2147480000 });
    const loom = createLoom({ sessionStore: store });
    await loom.start();
    expect((await store.get('codex', 'crashed'))!.runState).toBe('incomplete');
    await loom.stop();
  });
});
