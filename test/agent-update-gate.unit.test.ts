import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  withAgentUpdateGate,
  awaitAgentUpdateIdle,
  agentUpdateMarkerPath,
} from '../src/agent/auto-update.ts';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const IDS = ['__vitest_a__', '__vitest_b__', '__vitest_c__'];

afterEach(() => {
  for (const id of IDS) {
    try { fs.rmSync(agentUpdateMarkerPath(id), { force: true }); } catch {}
  }
});

describe('agent update gate', () => {
  it('is a no-op when no reinstall is in flight', async () => {
    const start = Date.now();
    await awaitAgentUpdateIdle('__vitest_a__', 10_000);
    expect(Date.now() - start).toBeLessThan(50);
  });

  it('makes a spawn wait until the in-flight reinstall finishes', async () => {
    let finishInstall!: () => void;
    const install = new Promise<void>(resolve => { finishInstall = resolve; });

    const updatePromise = withAgentUpdateGate('__vitest_a__', () => install);
    expect(fs.existsSync(agentUpdateMarkerPath('__vitest_a__'))).toBe(true);

    let unblocked = false;
    const waitPromise = awaitAgentUpdateIdle('__vitest_a__', 10_000).then(() => { unblocked = true; });

    await tick();
    expect(unblocked).toBe(false);

    finishInstall();
    await updatePromise;
    await waitPromise;
    expect(unblocked).toBe(true);
    expect(fs.existsSync(agentUpdateMarkerPath('__vitest_a__'))).toBe(false);
  });

  it('only gates the agent actually being updated', async () => {
    let finishInstall!: () => void;
    const install = new Promise<void>(resolve => { finishInstall = resolve; });
    const updatePromise = withAgentUpdateGate('__vitest_a__', () => install);

    const start = Date.now();
    await awaitAgentUpdateIdle('__vitest_b__', 10_000);
    expect(Date.now() - start).toBeLessThan(50);

    finishInstall();
    await updatePromise;
  });

  it('stops waiting after the timeout even if the reinstall is stuck', async () => {
    let finishInstall!: () => void;
    const stuck = new Promise<void>(resolve => { finishInstall = resolve; });
    const updatePromise = withAgentUpdateGate('__vitest_a__', () => stuck);

    const start = Date.now();
    await awaitAgentUpdateIdle('__vitest_a__', 40);
    const waited = Date.now() - start;
    expect(waited).toBeGreaterThanOrEqual(30);
    expect(waited).toBeLessThan(2_000);

    finishInstall();
    await updatePromise;
  });

  it('clears the marker even when the reinstall throws', async () => {
    await expect(
      withAgentUpdateGate('__vitest_a__', async () => { throw new Error('npm exploded'); }),
    ).rejects.toThrow('npm exploded');

    expect(fs.existsSync(agentUpdateMarkerPath('__vitest_a__'))).toBe(false);
    const start = Date.now();
    await awaitAgentUpdateIdle('__vitest_a__', 10_000);
    expect(Date.now() - start).toBeLessThan(50);
  });

  it('ignores (and cleans up) a marker orphaned by a dead updater', async () => {
    const marker = agentUpdateMarkerPath('__vitest_c__');
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, '2147483646\n');

    const start = Date.now();
    await awaitAgentUpdateIdle('__vitest_c__', 10_000);
    expect(Date.now() - start).toBeLessThan(50);
    expect(fs.existsSync(marker)).toBe(false);
  });
});
