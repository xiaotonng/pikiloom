/**
 * await-resume.ts — "waiting for background work" session marker.
 *
 *   <sessionRoot>/awaiting.json — persisted marker
 *
 * A turn runs as a one-shot `claude -p` process that exits at its `result`
 * event. When the agent launches truly detached work (a daemon outliving the
 * harness, e.g. an install that must survive a restart) and ends the turn
 * intending to report back, the process exits and the session reads as plainly
 * "completed" — there is no live process for the background task to wake. This
 * marker lets the agent declare that intent (via the `await_background` MCP
 * tool, which writes the file directly) so the dashboard can show a distinct
 * "waiting" state instead of "completed".
 *
 * The MCP tool (child process) writes the file; the parent only reads and
 * clears it — the same split used by goal.ts / tools/goal.ts. The marker is
 * cleared the next time the session runs (clearAwaitResume in stream.ts), so a
 * resumed turn naturally drops back out of the "waiting" state.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Agent, AwaitResumeState } from './types.js';

const AWAIT_FILE = 'awaiting.json';
const MAX_REASON_CHARS = 280;

export function sessionAwaitPath(workdir: string, agent: Agent, sessionId: string): string {
  return path.join(workdir, '.pikiclaw', 'sessions', agent, sessionId, AWAIT_FILE);
}

export function readAwaitResume(workdir: string, agent: Agent, sessionId: string): AwaitResumeState | null {
  const file = sessionAwaitPath(workdir, agent, sessionId);
  if (!fs.existsSync(file)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const reason = typeof raw?.reason === 'string' ? raw.reason.trim() : '';
    const since = typeof raw?.since === 'string' ? raw.since.trim() : '';
    if (!since) return null;
    return { reason: reason.slice(0, MAX_REASON_CHARS), since };
  } catch {
    return null;
  }
}

export function clearAwaitResume(workdir: string, agent: Agent, sessionId: string): void {
  try {
    fs.rmSync(sessionAwaitPath(workdir, agent, sessionId), { force: true });
  } catch {
    /* best-effort */
  }
}
