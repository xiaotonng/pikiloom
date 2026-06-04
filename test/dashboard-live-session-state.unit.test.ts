import { describe, expect, it } from 'vitest';
import {
  applyLiveSessionState,
  normalizeLiveSessionState,
  sessionDisplayState,
} from '../dashboard/src/utils.ts';

describe('dashboard live session state helpers', () => {
  it('normalizes promoted stream snapshots onto the native session key', () => {
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
  });

  it('maps queued and streaming snapshots to running UI state', () => {
    const base = {
      sessionId: 'sess-1',
      agent: 'codex',
      runState: 'completed' as const,
      running: false,
      runUpdatedAt: null,
      runDetail: 'old detail',
    };

    const queued = normalizeLiveSessionState('codex:sess-1', { phase: 'queued', updatedAt: 100 });
    const streaming = normalizeLiveSessionState('codex:sess-1', { phase: 'streaming', updatedAt: 200 });

    expect(sessionDisplayState(applyLiveSessionState(base, queued))).toBe('running');
    expect(sessionDisplayState(applyLiveSessionState(base, streaming))).toBe('running');
    expect(applyLiveSessionState(base, streaming).runDetail).toBeNull();
  });

  it('maps incomplete done snapshots to incomplete instead of completed', () => {
    const base = {
      sessionId: 'sess-2',
      agent: 'codex',
      runState: 'running' as const,
      running: true,
      runUpdatedAt: null,
      runDetail: null,
    };

    const done = normalizeLiveSessionState('codex:sess-2', {
      phase: 'done',
      updatedAt: 300,
      incomplete: true,
      error: 'Timed out before completion.',
    });

    const next = applyLiveSessionState(base, done);
    expect(sessionDisplayState(next)).toBe('incomplete');
    expect(next.runDetail).toBe('Timed out before completion.');
  });

  it('lets a fresh server "running" state supersede a stale "done" snapshot', () => {
    // A previous turn ended → a 'done' snapshot lingers in the live-state map
    // (15-min TTL). Then a new turn starts; the sessions API reports the
    // session running again with a newer runUpdatedAt (server truth), but the
    // client never saw a fresh 'start' (e.g. claude-tui resumed outside the
    // dashboard, or a WS reconnect replayed no event). The stale 'done' must
    // not paint a running session gray.
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
      // Observed ~57 min before the server's latest run update.
      updatedAt: Date.parse('2026-06-03T11:03:10.000Z'),
    });

    const merged = applyLiveSessionState(base, staleDone);
    expect(sessionDisplayState(merged)).toBe('running');
    expect(merged.running).toBe(true);

    // The real production shape: turn A finished and turn B started back-to-back,
    // so the lingering 'done' is timestamped at ~the same instant as the
    // server's new run (not minutes earlier). The server must still win.
    const backToBackBase = { ...base, runUpdatedAt: '2026-06-03T11:59:50.000Z' };
    const coincidentDone = normalizeLiveSessionState('claude:sess-resume', {
      phase: 'done',
      updatedAt: Date.parse('2026-06-03T11:59:50.000Z'),
    });
    const mergedBackToBack = applyLiveSessionState(backToBackBase, coincidentDone);
    expect(sessionDisplayState(mergedBackToBack)).toBe('running');
    // The card keeps the server's run timestamp (renders "Nm ago"), not the
    // stale done's — matching the reported "2m + gray" symptom, now green.
    expect(mergedBackToBack.runUpdatedAt).toBe('2026-06-03T11:59:50.000Z');

    // The post-stream flash case is unchanged: when the server's runUpdatedAt
    // is *behind* the 'done' (stale sessionsMap still says running), the 'done'
    // still wins so the card doesn't flash "running" after the stream ended.
    const flashBase = { ...base, runUpdatedAt: '2026-06-03T11:00:00.000Z' };
    const freshDone = normalizeLiveSessionState('claude:sess-resume', {
      phase: 'done',
      updatedAt: Date.parse('2026-06-03T11:00:05.000Z'),
    });
    expect(sessionDisplayState(applyLiveSessionState(flashBase, freshDone))).toBe('completed');
  });

  it('shows "waiting" when a non-running session parked background work', () => {
    const parked = {
      sessionId: 'sess-3',
      agent: 'claude',
      runState: 'completed' as const,
      running: false,
      runUpdatedAt: null,
      runDetail: null,
      awaiting: { reason: 'rebuilding pikiclaw, will confirm after restart', since: '2026-06-01T00:00:00.000Z' },
    };
    // A parked, not-running session reads as "waiting", not "completed".
    expect(sessionDisplayState(parked)).toBe('waiting');

    // Running always wins over the marker.
    expect(sessionDisplayState({ ...parked, running: true })).toBe('running');

    // No marker → ordinary completed.
    expect(sessionDisplayState({ ...parked, awaiting: null })).toBe('completed');

    // The marker survives the live "done" snapshot merge (applyLiveSessionState
    // spreads the session), so a turn that just ended still reads as waiting.
    const done = normalizeLiveSessionState('claude:sess-3', { phase: 'done', updatedAt: 400 });
    expect(sessionDisplayState(applyLiveSessionState(parked, done))).toBe('waiting');
  });
});
