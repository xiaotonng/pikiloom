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

function workspaceFor(sessionId: string): string {
  return path.join(path.dirname(sessionAwaitPath(workdir, AGENT, sessionId)), 'workspace');
}

describe('await-resume marker', () => {
  it('round-trips, rejects empty reason, clears idempotently, and reads null for missing', () => {
    const ctx = { workspace: workspaceFor(sid), stagedFiles: [], callbackUrl: '' };

    const res = awaitResumeTools.handle('await_background', { reason: 'rebuilding, will confirm after restart' }, ctx);
    expect('isError' in (res as any) ? (res as any).isError : false).toBeFalsy();

    expect(fs.existsSync(sessionAwaitPath(workdir, AGENT, sid))).toBe(true);
    const marker = readAwaitResume(workdir, AGENT, sid);
    expect(marker?.reason).toBe('rebuilding, will confirm after restart');
    expect(typeof marker?.since).toBe('string');
    expect(Number.isNaN(Date.parse(marker!.since))).toBe(false);

    expect(readAwaitResume(workdir, AGENT, sid)).not.toBeNull();
    clearAwaitResume(workdir, AGENT, sid);
    expect(readAwaitResume(workdir, AGENT, sid)).toBeNull();
    expect(() => clearAwaitResume(workdir, AGENT, sid)).not.toThrow();

    const res2 = awaitResumeTools.handle('await_background', { reason: '   ' }, ctx) as any;
    expect(res2.isError).toBe(true);
    expect(fs.existsSync(sessionAwaitPath(workdir, AGENT, sid))).toBe(false);
    expect(readAwaitResume(workdir, AGENT, sid)).toBeNull();

    expect(readAwaitResume(workdir, AGENT, 'never_parked')).toBeNull();
  });
});
