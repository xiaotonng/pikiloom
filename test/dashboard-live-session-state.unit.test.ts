import { describe, expect, it } from 'vitest';
import {
  applyLiveSessionState,
  normalizeLiveSessionState,
  sessionDisplayState,
} from '../dashboard/src/utils.ts';

describe('dashboard live session state helpers', () => {
  it('normalizes snapshots, maps phases to UI states, and handles incomplete done', () => {
    // normalizes promoted stream snapshots onto the native session key
    const live = normalizeLiveSessionState('codex:pending_123', {
      phase: 'streaming',
      sessionId: 'native-456',
      updatedAt: 123,
    });
    expect(live).toEqual({
      key: 'codex:pending_123',
      resolvedKey: 'codex:native-456',
      phase: 'streaming',
      sessionId: 'native-456',
      updatedAt: 123,
      incomplete: false,
      error: null,
    });

    // maps queued and streaming snapshots to running UI state
    const base1 = {
      sessionId: 'sess-1',
      agent: 'codex',
      runState: 'completed' as const,
      running: false,
      runUpdatedAt: null,
      runDetail: 'old detail',
    };
    const queued = normalizeLiveSessionState('codex:sess-1', { phase: 'queued', updatedAt: 100 });
    const streaming = normalizeLiveSessionState('codex:sess-1', { phase: 'streaming', updatedAt: 200 });
    expect(sessionDisplayState(applyLiveSessionState(base1, queued))).toBe('running');
    expect(sessionDisplayState(applyLiveSessionState(base1, streaming))).toBe('running');
    expect(applyLiveSessionState(base1, streaming).runDetail).toBeNull();

    // maps incomplete done snapshots to incomplete instead of completed
    const base2 = {
      sessionId: 'sess-2',
      agent: 'codex',
      runState: 'running' as const,
      running: true,
      runUpdatedAt: null,
      runDetail: null,
    };
    const doneTimed = normalizeLiveSessionState('codex:sess-2', {
      phase: 'done',
      updatedAt: 300,
      incomplete: true,
      error: 'Timed out before completion.',
    });
    const next = applyLiveSessionState(base2, doneTimed);
    expect(sessionDisplayState(next)).toBe('incomplete');
    expect(next.runDetail).toBe('Timed out before completion.');
  });

  it('lets fresh server running state supersede stale done snapshots, and shows waiting for parked sessions', () => {
    // lets a fresh server "running" state supersede a stale "done" snapshot
    const base = {
      sessionId: 'sess-resume',
      agent: 'claude',
      runState: 'running' as const,
      running: true,
      runUpdatedAt: '2026-06-03T11:59:50.000Z',
      runDetail: null,
    };
    const staleDone = normalizeLiveSessionState('claude:sess-resume', {
      phase: 'done',
      updatedAt: Date.parse('2026-06-03T11:03:10.000Z'),
    });
    const merged = applyLiveSessionState(base, staleDone);
    expect(sessionDisplayState(merged)).toBe('running');
    expect(merged.running).toBe(true);

    const backToBackBase = { ...base, runUpdatedAt: '2026-06-03T11:59:50.000Z' };
    const coincidentDone = normalizeLiveSessionState('claude:sess-resume', {
      phase: 'done',
      updatedAt: Date.parse('2026-06-03T11:59:50.000Z'),
    });
    const mergedBackToBack = applyLiveSessionState(backToBackBase, coincidentDone);
    expect(sessionDisplayState(mergedBackToBack)).toBe('running');
    expect(mergedBackToBack.runUpdatedAt).toBe('2026-06-03T11:59:50.000Z');

    const flashBase = { ...base, runUpdatedAt: '2026-06-03T11:00:00.000Z' };
    const freshDone = normalizeLiveSessionState('claude:sess-resume', {
      phase: 'done',
      updatedAt: Date.parse('2026-06-03T11:00:05.000Z'),
    });
    expect(sessionDisplayState(applyLiveSessionState(flashBase, freshDone))).toBe('completed');

    // shows "waiting" when a non-running session parked background work
    const parked = {
      sessionId: 'sess-3',
      agent: 'claude',
      runState: 'completed' as const,
      running: false,
      runUpdatedAt: null,
      runDetail: null,
      awaiting: { reason: 'rebuilding pikiloom, will confirm after restart', since: '2026-06-01T00:00:00.000Z' },
    };
    expect(sessionDisplayState(parked)).toBe('waiting');
    expect(sessionDisplayState({ ...parked, running: true })).toBe('running');
    expect(sessionDisplayState({ ...parked, awaiting: null })).toBe('completed');
    const doneParked = normalizeLiveSessionState('claude:sess-3', { phase: 'done', updatedAt: 400 });
    expect(sessionDisplayState(applyLiveSessionState(parked, doneParked))).toBe('waiting');
  });
});
