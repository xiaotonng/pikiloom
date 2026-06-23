import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeTmpDir } from './support/env.js';

import {
  findPikiloomSession,
  deleteAgentSession,
  listPikiloomSessions,
} from '../src/agent/index.js';
import { saveSessionRecord } from '../src/agent/session.js';
import type { ManagedSessionRecord } from '../src/agent/types.js';

function makeRecord(workdir: string, sessionId: string, opts: Partial<ManagedSessionRecord> = {}): ManagedSessionRecord {
  return {
    agent: 'claude',
    sessionId,
    threadId: `thread-${sessionId}`,
    workspacePath: path.join(workdir, '.pikiloom', 'sessions', 'claude', sessionId, 'workspace'),
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
    {
      const workdir = makeTmpDir('pikiloom-del-');
      const record = makeRecord(workdir, 'sess-1');
      saveSessionRecord(workdir, record);

      const sessionDir = path.join(workdir, '.pikiloom', 'sessions', 'claude', 'sess-1');
      expect(fs.existsSync(sessionDir)).toBe(true);
      expect(findPikiloomSession(workdir, 'claude', 'sess-1')).not.toBeNull();

      const result = await deleteAgentSession({ workdir, agent: 'claude', sessionId: 'sess-1' });
      expect(result.ok).toBe(true);
      expect(result.refusedReason).toBeNull();
      expect(result.recordRemoved).toBe(true);
      expect(result.pikiloomPathsRemoved.length).toBeGreaterThanOrEqual(1);
      expect(result.nativePathsRemoved).toEqual([]);

      expect(findPikiloomSession(workdir, 'claude', 'sess-1')).toBeNull();
      expect(fs.existsSync(sessionDir)).toBe(false);
    }

    {
      const workdir = makeTmpDir('pikiloom-del-');
      saveSessionRecord(workdir, makeRecord(workdir, 'keep'));
      saveSessionRecord(workdir, makeRecord(workdir, 'drop'));

      await deleteAgentSession({ workdir, agent: 'claude', sessionId: 'drop' });

      const remaining = listPikiloomSessions(workdir, 'claude');
      expect(remaining.map(s => s.sessionId)).toEqual(['keep']);
    }

    {
      const workdir = makeTmpDir('pikiloom-del-');
      saveSessionRecord(workdir, makeRecord(workdir, 'running', {
        runState: 'running',
        runPid: process.pid,
        runUpdatedAt: new Date().toISOString(),
      }));

      const result = await deleteAgentSession({ workdir, agent: 'claude', sessionId: 'running' });
      expect(result.ok).toBe(false);
      expect(result.refusedReason).toBe('session-running');
      expect(result.recordRemoved).toBe(false);

      expect(findPikiloomSession(workdir, 'claude', 'running')).not.toBeNull();
    }

    {
      const workdir = makeTmpDir('pikiloom-del-');
      const result = await deleteAgentSession({ workdir, agent: 'claude', sessionId: 'never-existed' });
      expect(result.ok).toBe(true);
      expect(result.recordRemoved).toBe(false);
      expect(result.pikiloomPathsRemoved).toEqual([]);
    }
  });
});
