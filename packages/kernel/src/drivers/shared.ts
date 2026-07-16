import type { ChildProcess } from 'node:child_process';

// Driver-internal helpers shared by the concrete drivers (claude/codex/gemini/acp).
// NOT part of the public API — nothing here is re-exported by any barrel. Each helper
// exists because the same code appeared verbatim in 3+ drivers.

/** Stateful newline splitter for a child process' stdout: feed chunks, get complete lines. */
export function createLineBuffer(): (chunk: Buffer | string) => string[] {
  let buf = '';
  return (chunk) => {
    buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    return lines;
  };
}

/** Parse one ndjson line; undefined for blank lines / non-JSON noise. */
export function parseJsonLine(line: string): any | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try { return JSON.parse(trimmed); } catch { return undefined; }
}

/**
 * Run `fn` when the signal aborts (immediately if it already has). Returns an
 * unsubscribe for drivers that must detach the handler when the turn settles.
 */
export function wireAbort(signal: AbortSignal, fn: () => void): () => void {
  if (signal.aborted) { fn(); return () => {}; }
  signal.addEventListener('abort', fn, { once: true });
  return () => signal.removeEventListener('abort', fn);
}

/** SIGTERM a child, swallowing the already-dead race. */
export function sigterm(proc: ChildProcess | null | undefined): void {
  try { proc?.kill('SIGTERM'); } catch { /* ignore */ }
}

// Attachment vocabulary lives in ../attachments.ts (the Hub also normalizes oversized
// images there); re-exported so drivers keep one import site for driver-internal helpers.
export { imageMimeForFile, attachedFileNote } from '../attachments.js';

/**
 * Context-window occupancy as a display percent (one decimal, capped at 99.9).
 * Pass `used` as null when the caller wants "no data" rather than 0%.
 */
export function contextPercent(used: number | null | undefined, window: number | null | undefined): number | null {
  return window && used != null ? Math.min(99.9, Math.round((used / window) * 1000) / 10) : null;
}
