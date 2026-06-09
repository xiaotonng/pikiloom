import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeTmpDir } from './support/env.js';

// Import after side-effectful driver registration runs.
import {
  findPikiclawSession,
  deleteAgentSession,
  listPikiclawSessions,
} from '../src/agent/index.js';
import { saveSessionRecord } from '../src/agent/session.js';
import type { ManagedSessionRecord } from '../src/agent/types.js';

function makeRecord(workdir: string, sessionId: string, opts: Partial<ManagedSessionRecord> = {}): ManagedSessionRecord {
  return {
    agent: 'claude',
    sessionId,
    threadId: `thread-${sessionId}`,
    workspacePath: path.join(workdir, '.pikiclaw', 'sessions', 'claude', sessionId, 'workspace'),
    model: 'claude-sonnet-4-6',
    thinkingEffort: null,
    title: 'test',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    runState: 'completed',
    runDetail: null,
    runUpdatedAt: new Date().toISOString(),
    runPid: null,
    classification: null,
    userStatus: null,
    userNote: null,
    migratedFrom: null,
    migratedTo: null,
    linkedSessions: [],
    ...opts,
  } as ManagedSessionRecord;
}

describe('deleteAgentSession', () => {
  it('deletes sessions correctly: removes entry, preserves siblings, refuses running, handles missing', async () => {
    // removes the index entry and per-session directory when scope is pikiclaw-only
    {
      const workdir = makeTmpDir('pikiclaw-del-');
      const record = makeRecord(workdir, 'sess-1');
      saveSessionRecord(workdir, record);

      const sessionDir = path.join(workdir, '.pikiclaw', 'sessions', 'claude', 'sess-1');
      expect(fs.existsSync(sessionDir)).toBe(true);
      expect(findPikiclawSession(workdir, 'claude', 'sess-1')).not.toBeNull();

      const result = await deleteAgentSession({ workdir, agent: 'claude', sessionId: 'sess-1' });
      expect(result.ok).toBe(true);
      expect(result.refusedReason).toBeNull();
      expect(result.recordRemoved).toBe(true);
      expect(result.pikiclawPathsRemoved.length).toBeGreaterThanOrEqual(1);
      expect(result.nativePathsRemoved).toEqual([]);

      expect(findPikiclawSession(workdir, 'claude', 'sess-1')).toBeNull();
      expect(fs.existsSync(sessionDir)).toBe(false);
    }

    // leaves other sessions in the same workdir alone
    {
      const workdir = makeTmpDir('pikiclaw-del-');
      saveSessionRecord(workdir, makeRecord(workdir, 'keep'));
      saveSessionRecord(workdir, makeRecord(workdir, 'drop'));

      await deleteAgentSession({ workdir, agent: 'claude', sessionId: 'drop' });

      const remaining = listPikiclawSessions(workdir, 'claude');
      expect(remaining.map(s => s.sessionId)).toEqual(['keep']);
    }

    // refuses to delete a session whose record is actively running
    {
      const workdir = makeTmpDir('pikiclaw-del-');
      saveSessionRecord(workdir, makeRecord(workdir, 'running', {
        runState: 'running',
        runPid: process.pid,         // current process is definitely alive
        runUpdatedAt: new Date().toISOString(),
      }));

      const result = await deleteAgentSession({ workdir, agent: 'claude', sessionId: 'running' });
      expect(result.ok).toBe(false);
      expect(result.refusedReason).toBe('session-running');
      expect(result.recordRemoved).toBe(false);

      // Session should still be there.
      expect(findPikiclawSession(workdir, 'claude', 'running')).not.toBeNull();
    }

    // returns ok=true with no record removed when the session does not exist (native-only delete)
    {
      const workdir = makeTmpDir('pikiclaw-del-');
      const result = await deleteAgentSession({ workdir, agent: 'claude', sessionId: 'never-existed' });
      expect(result.ok).toBe(true);
      expect(result.recordRemoved).toBe(false);
      expect(result.pikiclawPathsRemoved).toEqual([]);
    }
  });
});
