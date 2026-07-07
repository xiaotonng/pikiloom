import fs from 'node:fs';
import path from 'node:path';
import { getUserConfigPath } from '../core/config/user-config.js';

// Durable per-turn snapshot of the content pikiloom actually delivered.
//
// The agent CLIs are the source of truth for transcript history, but their session jsonl is
// lossy under two upstream conditions we cannot prevent: (1) a turn's closing reply dies before
// the CLI flushes it to disk (kill/flush race), and (2) the CLI's resume rewrites the jsonl in
// place and drops a turn that never got a synthetic-free conclusion. In both cases pikiloom has
// already streamed the complete reply to the user (turn-audit confirms ok/end_turn), yet a later
// history render reads only a "No response requested." tombstone — the swallow.
//
// This sidecar is the missing durable copy: one JSON line per delivered turn, keyed by the user
// prompt, so the claude history renderer can restore the real reply at a tombstone instead of
// showing a bare "ended before a closing message" notice. It complements turn-audit.jsonl (which
// records how a turn ended, not what it said). See [[posttool-empty-result-no-response-requested]].

const MAX_SNAPSHOT_BYTES = 512 * 1024;   // per-session cap, single-slot rotation
const MAX_TEXT_CHARS = 40_000;           // don't archive megabyte replies verbatim
const STALE_MS = 30 * 24 * 60 * 60 * 1000;

export interface DeliveredTurn {
  prompt: string;
  promptNorm: string;
  text: string;
  model: string | null;
}

// Match the raw prompt pikiloom ran against the user text reconstructed from the jsonl. Both
// sides normalize identically: collapse whitespace, trim, cap length. Case is preserved (matching
// is mostly CJK / mixed-script prose).
export function normalizeSnapshotPrompt(s: string): string {
  return (s || '').replace(/\s+/g, ' ').trim().slice(0, 240);
}

function snapshotDir(): string {
  return path.join(path.dirname(getUserConfigPath()), 'turn-snapshots');
}

function sessionSnapshotPath(sessionId: string): string {
  // sessionId is a uuid / codex rollout id — safe as a filename, but strip separators defensively.
  const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, '_');
  return path.join(snapshotDir(), `${safe}.jsonl`);
}

// A finished turn whose delivered message is only a placeholder or an appended incomplete-notice
// carries nothing worth restoring. Strip a trailing "⚠️ …" note (composeKernelFinalPresentation
// and the legacy driver append one to real prose) and drop the empty/placeholder shapes.
function bodyWorthSaving(message: string): string | null {
  let text = (message || '').replace(/\n\n⚠️[^\n]*$/u, '').trim();
  if (!text) return null;
  if (text === '(no textual response)' || text === '(no output)') return null;
  if (text.length > MAX_TEXT_CHARS) text = text.slice(0, MAX_TEXT_CHARS);
  return text;
}

let cleanedThisProcess = false;
function cleanupStaleSnapshots(): void {
  if (cleanedThisProcess) return;
  cleanedThisProcess = true;
  try {
    const dir = snapshotDir();
    const now = Date.now();
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      try { if (now - fs.statSync(p).mtimeMs > STALE_MS) fs.unlinkSync(p); } catch { /* skip */ }
    }
  } catch { /* no dir yet */ }
}

export function recordDeliveredTurn(entry: {
  sessionId: string | null;
  prompt: string;
  message: string;
  model: string | null;
  ok: boolean;
  stopReason: string | null;
}): void {
  try {
    if (!entry.sessionId) return;
    const text = bodyWorthSaving(entry.message);
    if (!text) return;
    const prompt = (entry.prompt || '').slice(0, 500);
    const dir = snapshotDir();
    fs.mkdirSync(dir, { recursive: true });
    cleanupStaleSnapshots();
    const file = sessionSnapshotPath(entry.sessionId);
    try {
      if (fs.statSync(file).size > MAX_SNAPSHOT_BYTES) fs.renameSync(file, `${file}.1`);
    } catch { /* no file yet */ }
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      prompt,
      promptNorm: normalizeSnapshotPrompt(prompt),
      text,
      model: entry.model ?? null,
      ok: entry.ok,
      stopReason: entry.stopReason ?? null,
    });
    fs.appendFileSync(file, line + '\n');
  } catch { /* snapshotting is best-effort by design */ }
}

// Ordered list (append order == turn order) of delivered turns for a session, for render merge.
export function loadDeliveredTurns(sessionId: string | null): DeliveredTurn[] {
  if (!sessionId) return [];
  try {
    const content = fs.readFileSync(sessionSnapshotPath(sessionId), 'utf-8');
    const out: DeliveredTurn[] = [];
    for (const raw of content.split('\n')) {
      if (!raw.trim() || raw[0] !== '{') continue;
      try {
        const ev = JSON.parse(raw);
        if (typeof ev.text !== 'string' || !ev.text) continue;
        out.push({
          prompt: typeof ev.prompt === 'string' ? ev.prompt : '',
          promptNorm: typeof ev.promptNorm === 'string' ? ev.promptNorm : normalizeSnapshotPrompt(ev.prompt || ''),
          text: ev.text,
          model: typeof ev.model === 'string' ? ev.model : null,
        });
      } catch { /* skip bad line */ }
    }
    return out;
  } catch { return []; }
}

// A per-prompt FIFO of delivered replies. A tombstone consumes the next reply recorded for its
// preceding prompt. Front-pop is exact for the common case (a unique recent prompt was swallowed);
// for a prompt repeated across turns with mixed outcomes the match is by order and may attach a
// sibling occurrence's reply — still strictly better than a bare tombstone.
export function buildRecoveryQueue(turns: DeliveredTurn[]): Map<string, string[]> {
  const q = new Map<string, string[]>();
  for (const t of turns) {
    if (!t.promptNorm) continue;
    const list = q.get(t.promptNorm);
    if (list) list.push(t.text);
    else q.set(t.promptNorm, [t.text]);
  }
  return q;
}
