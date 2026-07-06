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

export interface TrailingLoaderInput {
  // Server-hydrated running state for this session (sessionDisplayState === 'running').
  sessionRunning: boolean;
  streaming: boolean;
  streamPhase: string | null | undefined;
  queuedTaskCount: number;
  pendingQueuedCount: number;
  // A loading affordance is already on screen: the live preview is actively streaming,
  // or the optimistic pending bubble is showing its own dots. Don't stack a second one.
  liveTurnStreaming: boolean;
  pendingBubbleDots: boolean;
}

// Whether to render a trailing "still working" loader at the tail of the transcript.
// This closes the gaps where a turn has reconciled into history (or a next task is only
// queued) yet the session is still in progress — without it the transcript looks frozen
// even though work continues. Suppressed whenever another loader is already visible.
export function shouldShowTrailingLoader(input: TrailingLoaderInput): boolean {
  if (input.liveTurnStreaming || input.pendingBubbleDots) return false;
  return input.sessionRunning
    || input.streaming
    || input.streamPhase === 'streaming'
    || input.streamPhase === 'queued'
    || input.queuedTaskCount > 0
    || input.pendingQueuedCount > 0;
}
