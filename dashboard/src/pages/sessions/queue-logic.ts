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
