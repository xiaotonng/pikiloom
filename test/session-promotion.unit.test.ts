import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeTmpDir } from './support/env.js';

import {
  saveSessionRecord,
  syncManagedSessionIdentity,
  resolveCanonicalSessionId,
  getSessionPromotions,
} from '../src/agent/session.js';
import { findPikiloomSession, deleteAgentSession } from '../src/agent/index.js';
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

function mkSession(rec: ManagedSessionRecord) {
  return { sessionId: rec.sessionId, workspacePath: rec.workspacePath, record: rec };
}

describe('durable session promotions', () => {
  it('resolves a pending id to its native id after promotion (fixes orphaned "暂无消息记录")', () => {
    const workdir = makeTmpDir('promo-');
    const rec = makeRecord(workdir, 'pending_aaaaaa');
    saveSessionRecord(workdir, rec);

    const session = mkSession(rec);
    expect(syncManagedSessionIdentity(session as any, workdir, 'native-1')).toBe(true);
    saveSessionRecord(workdir, session.record);

    expect(resolveCanonicalSessionId(workdir, 'claude', 'pending_aaaaaa')).toBe('native-1');
    expect(getSessionPromotions(workdir)['claude:pending_aaaaaa']).toBe('native-1');
    expect(findPikiloomSession(workdir, 'claude', 'native-1')).not.toBeNull();
    expect(findPikiloomSession(workdir, 'claude', 'pending_aaaaaa')).toBeNull();
  });

  it('compacts a multi-hop chain (pending → n1 → n2) so every stale id resolves in one lookup', () => {
    const workdir = makeTmpDir('promo-');
    const rec = makeRecord(workdir, 'pending_bbbbbb');
    saveSessionRecord(workdir, rec);
    const session = mkSession(rec);

    syncManagedSessionIdentity(session as any, workdir, 'n1');
    saveSessionRecord(workdir, session.record);
    syncManagedSessionIdentity(session as any, workdir, 'n2');
    saveSessionRecord(workdir, session.record);

    expect(resolveCanonicalSessionId(workdir, 'claude', 'pending_bbbbbb')).toBe('n2');
    expect(resolveCanonicalSessionId(workdir, 'claude', 'n1')).toBe('n2');
    const promos = getSessionPromotions(workdir);
    expect(promos['claude:pending_bbbbbb']).toBe('n2');
    expect(promos['claude:n1']).toBe('n2');
  });

  it('returns the input unchanged when nothing maps', () => {
    const workdir = makeTmpDir('promo-');
    expect(resolveCanonicalSessionId(workdir, 'claude', 'whatever')).toBe('whatever');
    expect(getSessionPromotions(workdir)).toEqual({});
  });

  it('prunes a promotion once its target session is deleted (bounded growth)', async () => {
    const workdir = makeTmpDir('promo-');

    const recA = makeRecord(workdir, 'pending_a1');
    saveSessionRecord(workdir, recA);
    const sessA = mkSession(recA);
    syncManagedSessionIdentity(sessA as any, workdir, 'nativeA');
    saveSessionRecord(workdir, sessA.record);
    expect(getSessionPromotions(workdir)['claude:pending_a1']).toBe('nativeA');

    await deleteAgentSession({ workdir, agent: 'claude', sessionId: 'nativeA' });

    const recB = makeRecord(workdir, 'pending_b1');
    saveSessionRecord(workdir, recB);
    const sessB = mkSession(recB);
    syncManagedSessionIdentity(sessB as any, workdir, 'nativeB');
    saveSessionRecord(workdir, sessB.record);

    const promos = getSessionPromotions(workdir);
    expect(promos['claude:pending_a1']).toBeUndefined();
    expect(promos['claude:pending_b1']).toBe('nativeB');
  });

  it('retroactively heals a pre-map orphan via the on-disk dir symlink (legacy promoteSessionId)', () => {
    const workdir = makeTmpDir('promo-');
    const native = makeRecord(workdir, 'native-legacy');
    saveSessionRecord(workdir, native);

    const pendingDir = path.join(workdir, '.pikiloom', 'sessions', 'claude', 'pending_legacy0000');
    fs.symlinkSync('native-legacy', pendingDir, 'dir');
    expect(getSessionPromotions(workdir)['claude:pending_legacy0000']).toBeUndefined();

    expect(resolveCanonicalSessionId(workdir, 'claude', 'pending_legacy0000')).toBe('native-legacy');
    expect(getSessionPromotions(workdir)['claude:pending_legacy0000']).toBe('native-legacy');
  });
});
