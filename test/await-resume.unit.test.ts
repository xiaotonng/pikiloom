import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  sessionAwaitPath, readAwaitResume, clearAwaitResume,
} from '../src/agent/await-resume.ts';
import { awaitResumeTools } from '../src/agent/mcp/tools/await-resume.ts';
import { makeTmpDir } from './support/env.ts';

const AGENT = 'claude' as const;
const sid = 'session_await_001';

let workdir: string;

beforeEach(() => {
  workdir = makeTmpDir('pikiloom-await-');
});

afterEach(() => {
  try { fs.rmSync(workdir, { recursive: true, force: true }); } catch {}
});

/** The MCP tool resolves the session root from its workspace path
 *  (<sessionRoot>/workspace); the parent resolves it from workdir/agent/sid.
 *  Both must land on the same <sessionRoot>/awaiting.json. */
function workspaceFor(sessionId: string): string {
  return path.join(path.dirname(sessionAwaitPath(workdir, AGENT, sessionId)), 'workspace');
}

describe('await-resume marker', () => {
  it('round-trips, rejects empty reason, clears idempotently, and reads null for missing', () => {
    const ctx = { workspace: workspaceFor(sid), stagedFiles: [], callbackUrl: '' };

    // round-trips a marker written by the MCP tool and read by the parent
    const res = awaitResumeTools.handle('await_background', { reason: 'rebuilding, will confirm after restart' }, ctx);
    expect('isError' in (res as any) ? (res as any).isError : false).toBeFalsy();

    expect(fs.existsSync(sessionAwaitPath(workdir, AGENT, sid))).toBe(true);
    const marker = readAwaitResume(workdir, AGENT, sid);
    expect(marker?.reason).toBe('rebuilding, will confirm after restart');
    expect(typeof marker?.since).toBe('string');
    expect(Number.isNaN(Date.parse(marker!.since))).toBe(false);

    // clearAwaitResume removes the marker (the next-run auto-clear path)
    expect(readAwaitResume(workdir, AGENT, sid)).not.toBeNull();
    clearAwaitResume(workdir, AGENT, sid);
    expect(readAwaitResume(workdir, AGENT, sid)).toBeNull();
    // Idempotent — clearing a missing marker is a no-op.
    expect(() => clearAwaitResume(workdir, AGENT, sid)).not.toThrow();

    // rejects an empty reason and writes nothing
    const res2 = awaitResumeTools.handle('await_background', { reason: '   ' }, ctx) as any;
    expect(res2.isError).toBe(true);
    expect(fs.existsSync(sessionAwaitPath(workdir, AGENT, sid))).toBe(false);
    expect(readAwaitResume(workdir, AGENT, sid)).toBeNull();

    // returns null for a session with no marker
    expect(readAwaitResume(workdir, AGENT, 'never_parked')).toBeNull();
  });
});
