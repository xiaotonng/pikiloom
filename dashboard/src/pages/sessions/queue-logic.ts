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
