import { describe, expect, it } from 'vitest';
import {
  snapshotGate,
  nextAppliedUpdatedAt,
  filterTombstonedIds,
  pruneTombstones,
  type SnapshotGateInput,
} from '../dashboard/src/pages/sessions/stream-reconcile';

const base: SnapshotGateInput = {
  updatedAt: 100,
  isNull: false,
  source: 'ws',
  lastAppliedUpdatedAt: 0,
  localStreamPending: false,
  holdsActiveState: false,
};

describe('snapshotGate — monotonic version guard', () => {
  it('applies the first snapshot for a fresh session', () => {
    expect(snapshotGate({ ...base, updatedAt: 100, lastAppliedUpdatedAt: 0 })).toBe('apply');
  });

  it('applies a newer snapshot', () => {
    expect(snapshotGate({ ...base, updatedAt: 200, lastAppliedUpdatedAt: 100 })).toBe('apply');
  });

  it('re-applies an equal snapshot (idempotent, WS ordering protects us)', () => {
    expect(snapshotGate({ ...base, updatedAt: 100, lastAppliedUpdatedAt: 100 })).toBe('apply');
  });

  it('rejects an older snapshot regardless of source (stale REST clobber)', () => {
    expect(snapshotGate({ ...base, source: 'seed', updatedAt: 90, lastAppliedUpdatedAt: 100 })).toBe('reject-stale');
    expect(snapshotGate({ ...base, source: 'ws', updatedAt: 90, lastAppliedUpdatedAt: 100 })).toBe('reject-stale');
  });
});

describe('snapshotGate — null is "no info"', () => {
  it('rejects a null while a local send is in flight (symptom: just-sent swallowed)', () => {
    expect(snapshotGate({ ...base, isNull: true, localStreamPending: true })).toBe('reject-null');
  });

  it('rejects a null while active state is held (symptom: post-stop send swallowed / stale clear)', () => {
    expect(snapshotGate({ ...base, isNull: true, holdsActiveState: true })).toBe('reject-null');
  });

  it('applies a null when genuinely idle (settles an idle mount)', () => {
    expect(snapshotGate({ ...base, isNull: true, localStreamPending: false, holdsActiveState: false })).toBe('apply');
  });
});

describe('snapshotGate — expired hold escape hatch (worker replaced under the tab)', () => {
  // Regression 2026-07-06: the worker was restarted while a tab held a pending send / live
  // stream view. The new worker's stream-state is null forever, but the null was rejected
  // because of that very hold — the panel wedged (no bubble, no spinner, stale view) until a
  // manual page refresh. Once the hold has gone unconfirmed past its TTL the null must win so
  // the panel reconciles from disk.
  it('lets a null through when a pending send outlived the hold TTL', () => {
    expect(snapshotGate({ ...base, isNull: true, localStreamPending: true, holdExpired: true })).toBe('apply');
  });

  it('lets a null through when active stream state outlived the hold TTL', () => {
    expect(snapshotGate({ ...base, isNull: true, holdsActiveState: true, holdExpired: true })).toBe('apply');
  });

  it('still rejects a null within the TTL (the original guards stay intact)', () => {
    expect(snapshotGate({ ...base, isNull: true, localStreamPending: true, holdExpired: false })).toBe('reject-null');
    expect(snapshotGate({ ...base, isNull: true, holdsActiveState: true })).toBe('reject-null');
  });

  it('holdExpired never bypasses the stale guard for non-null snapshots', () => {
    expect(snapshotGate({ ...base, updatedAt: 90, lastAppliedUpdatedAt: 100, holdExpired: true })).toBe('reject-stale');
  });
});

describe('nextAppliedUpdatedAt', () => {
  it('advances to a newer value', () => {
    expect(nextAppliedUpdatedAt(100, 200)).toBe(200);
  });
  it('never regresses', () => {
    expect(nextAppliedUpdatedAt(200, 100)).toBe(200);
  });
  it('ignores missing updatedAt', () => {
    expect(nextAppliedUpdatedAt(200, undefined)).toBe(200);
    expect(nextAppliedUpdatedAt(200, null)).toBe(200);
  });
});

describe('recall tombstones', () => {
  it('filters a recalled id out of incoming queued ids', () => {
    const tomb = new Map([['task-x', 1000]]);
    expect(filterTombstonedIds(['task-a', 'task-x', 'task-b'], tomb)).toEqual(['task-a', 'task-b']);
  });

  it('passes ids through untouched when there are no tombstones', () => {
    expect(filterTombstonedIds(['task-a', 'task-b'], new Map())).toEqual(['task-a', 'task-b']);
  });

  it('keeps the tombstone while the backend still lists the id (pre-recall snapshot in flight)', () => {
    const tomb = new Map([['task-x', 1000]]);
    // a snapshot that still contains task-x → recall not yet processed → keep filtering
    const next = pruneTombstones(tomb, ['task-running', 'task-x'], 1500, 60_000);
    expect(next.has('task-x')).toBe(true);
    expect(filterTombstonedIds(['task-running', 'task-x'], next)).toEqual(['task-running']);
  });

  it('drops the tombstone once the backend confirms removal (self-healing)', () => {
    const tomb = new Map([['task-x', 1000]]);
    const next = pruneTombstones(tomb, ['task-running'], 1500, 60_000);
    expect(next.has('task-x')).toBe(false);
  });

  it('expires a tombstone after the TTL even without a confirming snapshot', () => {
    const tomb = new Map([['task-x', 1000]]);
    const next = pruneTombstones(tomb, ['task-x'], 1000 + 60_001, 60_000);
    expect(next.has('task-x')).toBe(false);
  });

  it('returns the same map reference when nothing changes (avoids churn)', () => {
    const tomb = new Map([['task-x', 1000]]);
    expect(pruneTombstones(tomb, ['task-x'], 1500, 60_000)).toBe(tomb);
  });
});
