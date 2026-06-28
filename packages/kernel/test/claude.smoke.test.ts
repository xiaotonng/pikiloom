import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createLoom } from '../src/runtime/loom.js';
import { ClaudeDriver } from '../src/drivers/claude.js';
import { FsSessionStore } from '../src/ports/defaults.js';
import type { UniversalSnapshot } from '../src/protocol/index.js';

function claudePresent(): boolean {
  try { execSync('command -v claude', { stdio: 'ignore' }); return true; } catch { return false; }
}
// Real network/auth-dependent. Off by default so the suite stays hermetic.
const enabled = process.env.KERNEL_E2E_REAL === '1' && claudePresent();

describe.skipIf(!enabled)('ClaudeDriver real smoke', () => {
  it('runs one real claude turn and streams text + session id', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-claude-'));
    const loom = createLoom({ drivers: [new ClaudeDriver()], defaultAgent: 'claude', sessionStore: new FsSessionStore(tmp) });
    await loom.start();
    let final: UniversalSnapshot | null = null;
    const done = new Promise<UniversalSnapshot>((resolve) => {
      loom.io.subscribe((_k, s) => { if (s.phase === 'done') resolve(structuredClone(s)); });
    });
    await loom.io.prompt({ prompt: 'Reply with exactly this token and nothing else: KERNEL_OK' });
    final = await done;
    await loom.stop();
    fs.rmSync(tmp, { recursive: true, force: true });

    expect(final.phase).toBe('done');
    expect(final.error).toBeFalsy();
    expect(final.text).toContain('KERNEL_OK');
    expect(final.sessionId).toBeTruthy();
  }, 180_000);
});
