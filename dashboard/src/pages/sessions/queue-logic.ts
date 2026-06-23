/**
 * Pure send-classification logic for the session composer.
 *
 * Extracted from SessionPanel so the rule can be unit-tested without a DOM:
 * it has bitten us repeatedly (the "继续对话被吞" / "插队→撤回→输入被吞" swallows),
 * always through the same mistake — counting a non-active stream as active.
 */

/** State a send is classified against. All fields are read from live refs. */
export interface SendClassificationInput {
  /** True while a turn is actively streaming tokens. */
  streaming: boolean;
  /** Phase of the on-screen live preview, if any. A `'done'` preview is a
   *  FROZEN turn (stopped / steered) we kept visible — it is NOT active. */
  liveStreamPhase: 'streaming' | 'done' | null | undefined;
  /** Phase of the latest stream snapshot. `'queued'` means a task is waiting
   *  with nothing streaming yet. */
  streamPhase: string | null | undefined;
  /** Tasks the server reports queued behind the running one. */
  queuedTaskCount: number;
  /** Optimistic queued sends not yet reflected in the snapshot. */
  pendingQueuedCount: number;
}

/**
 * Decide whether a new send should QUEUE behind existing work (→ optimistic
 * queued row) or START a fresh running turn (→ optimistic bubble + spinner).
 *
 * The trap: a stopped/steered turn leaves its partial output on screen as a
 * `phase:'done'` live preview (freezePartial). Treating that lingering preview
 * as "a stream is running" misroutes the next send into the queued-sends list,
 * where it renders NEITHER a bubble NOR a queue row until the server's `start`
 * snapshot arrives — the message looks swallowed. So we queue only when work is
 * genuinely active (streaming) or already waiting (queued / pending-queued).
 */
export function sendWillQueue(input: SendClassificationInput): boolean {
  const streamActive = input.streaming || input.liveStreamPhase === 'streaming';
  const queuedExists = input.queuedTaskCount > 0
    || input.pendingQueuedCount > 0
    || input.streamPhase === 'queued';
  return streamActive || queuedExists;
}
