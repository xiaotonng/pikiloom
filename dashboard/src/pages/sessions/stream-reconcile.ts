export type SnapshotSource = 'ws' | 'seed';

export interface SnapshotGateInput {
  updatedAt: number | null | undefined;
  isNull: boolean;
  source: SnapshotSource;
  lastAppliedUpdatedAt: number;
  localStreamPending: boolean;
  holdsActiveState: boolean;
  // True when the local hold (pending send / active stream view) has gone unconfirmed past its
  // TTL — no non-null snapshot has arrived for that long. Without this escape hatch a worker
  // replaced under the tab wedges the panel forever: the new worker's stream-state is null,
  // the null is rejected because of the very hold it can no longer confirm, and only a manual
  // page refresh recovers.
  holdExpired?: boolean;
}

export type SnapshotGateDecision = 'apply' | 'reject-stale' | 'reject-null';

export function snapshotGate(input: SnapshotGateInput): SnapshotGateDecision {
  if (input.isNull) {
    if ((input.localStreamPending || input.holdsActiveState) && !input.holdExpired) return 'reject-null';
    return 'apply';
  }
  const updatedAt = typeof input.updatedAt === 'number' ? input.updatedAt : 0;
  if (updatedAt < input.lastAppliedUpdatedAt) return 'reject-stale';
  return 'apply';
}

export function nextAppliedUpdatedAt(
  current: number,
  updatedAt: number | null | undefined,
): number {
  if (typeof updatedAt !== 'number') return current;
  return updatedAt > current ? updatedAt : current;
}

export function filterTombstonedIds(
  ids: readonly string[] | null | undefined,
  tombstones: ReadonlyMap<string, number>,
): string[] {
  if (!ids || !ids.length) return [];
  if (!tombstones.size) return ids.slice();
  return ids.filter(id => !tombstones.has(id));
}

export function pruneTombstones(
  tombstones: ReadonlyMap<string, number>,
  authoritativeIds: readonly string[],
  now: number,
  ttlMs: number,
): Map<string, number> {
  if (!tombstones.size) return tombstones as Map<string, number>;
  const live = new Set(authoritativeIds);
  let changed = false;
  const next = new Map<string, number>();
  for (const [id, ts] of tombstones) {
    if (now - ts > ttlMs || !live.has(id)) { changed = true; continue; }
    next.set(id, ts);
  }
  return changed ? next : (tombstones as Map<string, number>);
}
