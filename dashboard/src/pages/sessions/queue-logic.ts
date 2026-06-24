export interface SendClassificationInput {
  streaming: boolean;
  liveStreamPhase: 'streaming' | 'done' | null | undefined;
  streamPhase: string | null | undefined;
  queuedTaskCount: number;
  pendingQueuedCount: number;
}

export function sendWillQueue(input: SendClassificationInput): boolean {
  const streamActive = input.streaming || input.liveStreamPhase === 'streaming';
  const queuedExists = input.queuedTaskCount > 0
    || input.pendingQueuedCount > 0
    || input.streamPhase === 'queued';
  return streamActive || queuedExists;
}

export interface OptimisticSendQueuedInput {
  pendingTaskId: string | null | undefined;
  streamTaskId: string | null | undefined;
  queuedTaskIds: readonly string[] | null | undefined;
}

export function optimisticSendWasQueued(input: OptimisticSendQueuedInput): boolean {
  const { pendingTaskId, streamTaskId, queuedTaskIds } = input;
  if (!pendingTaskId) return false;
  if (pendingTaskId === streamTaskId) return false;
  return !!queuedTaskIds && queuedTaskIds.includes(pendingTaskId);
}

export interface VisibleQueuedIdsInput {
  queuedTaskIds: readonly string[] | null | undefined;
  streamPhase: string | null | undefined;
  streamTaskId: string | null | undefined;
  localTaskId: string | null | undefined;
}

export function visibleQueuedIds(input: VisibleQueuedIdsInput): string[] {
  const { queuedTaskIds, streamPhase, streamTaskId, localTaskId } = input;
  const ids: string[] = [];
  if (queuedTaskIds && queuedTaskIds.length) ids.push(...queuedTaskIds);
  if (streamPhase === 'queued' && streamTaskId && !ids.includes(streamTaskId)) {
    ids.unshift(streamTaskId);
  }
  if (localTaskId && !ids.includes(localTaskId)) {
    const optimisticAllowed = streamPhase === 'queued' || !streamPhase;
    if (optimisticAllowed) ids.push(localTaskId);
  }
  const runningId = streamPhase === 'streaming' ? (streamTaskId ?? null) : null;
  return runningId ? ids.filter(id => id !== runningId) : ids;
}

export function doneAppliesToLivePreview(
  currentLiveTaskId: string | null | undefined,
  doneTaskId: string | null | undefined,
): boolean {
  if (currentLiveTaskId == null) return true;
  if (doneTaskId == null) return true;
  return currentLiveTaskId === doneTaskId;
}
