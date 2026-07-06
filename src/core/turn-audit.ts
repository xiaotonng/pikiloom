import fs from 'node:fs';
import path from 'node:path';
import { getUserConfigPath } from './config/user-config.js';

// Per-turn终态 audit trail. Prod runs with no disk logs at all, which turns every
// swallowed-reply report into jsonl archaeology (reconstructing process lifetimes from MCP log
// filenames). One JSON line per finished turn — how it ended, not what it said — is enough to
// answer "who ended this turn and why" after the fact. Appends must never break a turn.

const MAX_AUDIT_BYTES = 2 * 1024 * 1024;

export interface TurnAuditEntry {
  agent: string;
  sessionId: string | null;
  ok: boolean;
  stopReason: string | null;
  incomplete: boolean;
  error: string | null;
  elapsedS?: number;
  model?: string | null;
  promptPreview?: string;
}

export function turnAuditPath(): string {
  return path.join(path.dirname(getUserConfigPath()), 'logs', 'turn-audit.jsonl');
}

export function appendTurnAudit(entry: TurnAuditEntry): void {
  try {
    const file = turnAuditPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      // Single-slot rotation: cap the live file, keep exactly one predecessor.
      if (fs.statSync(file).size > MAX_AUDIT_BYTES) fs.renameSync(file, `${file}.1`);
    } catch { /* no file yet */ }
    fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
  } catch { /* auditing is best-effort by design */ }
}
