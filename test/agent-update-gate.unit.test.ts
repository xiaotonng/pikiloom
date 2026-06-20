/**
 * pikiloom auto-updates an agent's CLI in the background at startup (and via the
 * dashboard "Update" button) by running `npm install -g` / `brew upgrade`, which
 * briefly tears down and rewrites the bin symlink. An agent spawn that races it
 * execs into "/bin/sh: <cli>: command not found" (exit 127). The updating
 * process drops a cross-process marker for the destructive step; the spawn path
 * awaits `awaitAgentUpdateIdle()` so it never launches mid-swap — and, because
 * the marker carries the updater's pid, a marker orphaned by a crashed updater
 * is detected via liveness rather than hanging spawns forever. This covers that
 * contract. (Both the dev worker and the `npx pikiloom@latest` self-bootstrap
 * share these marker files, so coordination must be on-disk, not in-memory.)
 */

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  withAgentUpdateGate,
  awaitAgentUpdateIdle,
  agentUpdateMarkerPath,
} from '../src/agent/auto-update.ts';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
// Fake agent ids so we never collide with a real running pikiloom's markers.
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

    // While the install holds the marker, the spawn must stay parked.
    await tick();
    expect(unblocked).toBe(false);

    // Install completes -> marker cleared -> the spawn proceeds.
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

    // A different agent's spawn is unaffected and proceeds immediately.
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
    // A crashed updater can leave a marker behind. Forge one pointing at a pid
    // that does not exist, so a spawn must not hang on it.
    const marker = agentUpdateMarkerPath('__vitest_c__');
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, '2147483646\n'); // pid that is not running

    const start = Date.now();
    await awaitAgentUpdateIdle('__vitest_c__', 10_000);
    expect(Date.now() - start).toBeLessThan(50);
    expect(fs.existsSync(marker)).toBe(false); // self-healed
  });
});
