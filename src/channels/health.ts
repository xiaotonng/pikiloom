export type ChannelHealthLogLevel = 'info' | 'warn' | 'error';
export type ChannelHealthLogger = (msg: string, level: ChannelHealthLogLevel) => void;

export interface ChannelHealthOpts {
  label: string;
  opAction: string;
  initialDelayMs: number;
  maxDelayMs: number;
  log: ChannelHealthLogger;
  sustainedThresholdMs?: number;
  sustainedFailureHint?: string;
  transientFailureLevel?: ChannelHealthLogLevel;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? 'unknown error');
}

export class ChannelHealth {
  private readonly label: string;
  private readonly opAction: string;
  private readonly initialDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly log: ChannelHealthLogger;
  private readonly sustainedThresholdMs: number;
  private readonly sustainedFailureHint: string;
  private readonly transientFailureLevel: ChannelHealthLogLevel;

  private delayMs: number;
  private consecutiveFailures = 0;
  private firstFailureAt: number | null = null;
  private lastLoggedDelayMs = 0;
  private sustainedNoticeFired = false;

  constructor(opts: ChannelHealthOpts) {
    this.label = opts.label;
    this.opAction = opts.opAction;
    this.initialDelayMs = opts.initialDelayMs;
    this.maxDelayMs = opts.maxDelayMs;
    this.log = opts.log;
    this.sustainedThresholdMs = opts.sustainedThresholdMs ?? 5 * 60_000;
    this.sustainedFailureHint = opts.sustainedFailureHint ?? '';
    this.transientFailureLevel = opts.transientFailureLevel ?? 'warn';
    this.delayMs = opts.initialDelayMs;
  }

  recordSuccess(): void {
    if (this.consecutiveFailures > 0 && this.firstFailureAt !== null) {
      const downtimeMs = Date.now() - this.firstFailureAt;
      this.log(
        `${this.label}: connection recovered after ${Math.round(downtimeMs / 1000)}s `
          + `(${this.consecutiveFailures} failed attempts)`,
        'info',
      );
    }
    this.delayMs = this.initialDelayMs;
    this.consecutiveFailures = 0;
    this.firstFailureAt = null;
    this.lastLoggedDelayMs = 0;
    this.sustainedNoticeFired = false;
  }

  recordFailure(error: unknown): number {
    this.consecutiveFailures += 1;
    if (this.firstFailureAt === null) this.firstFailureAt = Date.now();
    const elapsedMs = Date.now() - this.firstFailureAt;
    const delayMs = this.delayMs;

    if (delayMs !== this.lastLoggedDelayMs) {
      this.log(
        `${this.label} ${this.opAction} failed (retrying in ${Math.ceil(delayMs / 1000)}s): ${describeError(error)}`,
        this.transientFailureLevel,
      );
      this.lastLoggedDelayMs = delayMs;
    }

    if (!this.sustainedNoticeFired && elapsedMs >= this.sustainedThresholdMs) {
      this.sustainedNoticeFired = true;
      const hint = this.sustainedFailureHint ? ` — ${this.sustainedFailureHint}` : '';
      this.log(
        `⚠ ${this.label}: connection has been failing for ${Math.round(elapsedMs / 60_000)}+ min `
          + `(${this.consecutiveFailures} attempts)${hint}. Retries continue at ${Math.ceil(delayMs / 1000)}s intervals.`,
        'warn',
      );
    }

    this.delayMs = Math.min(this.delayMs * 2, this.maxDelayMs);
    return delayMs;
  }

  get failureCount(): number {
    return this.consecutiveFailures;
  }
}
