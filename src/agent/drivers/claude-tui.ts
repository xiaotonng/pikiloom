/**
 * Claude TUI driver — runs the interactive `claude` CLI under a PTY so usage
 * counts against the user's Pro/Max subscription instead of the API-priced
 * Agent SDK credit pool. Functionally near-equivalent to the headless -p
 * stream: we tail the JSONL transcript that Claude Code writes incrementally
 * to `~/.claude/projects/<encoded>/<id>.jsonl` and surface tool/text/usage
 * events through the same `claudeParse` parser used by the print-mode driver.
 *
 * Default driver for Claude turns. Set `PIKICLAW_CLAUDE_PRINT=1` (or the
 * legacy `PIKICLAW_CLAUDE_TUI=0`) to force the print-mode driver instead.
 * When any startup prerequisite fails (node-pty missing, prebuilt helper
 * unusable, PTY allocation refused) this function THROWS — the dispatcher in
 * `claude.ts` catches that and falls back to print mode so pikiclaw stays
 * working out of the box.
 *
 * How it works:
 *   1. Reserve a session id upfront (random UUID, or the resume target).
 *   2. Drop a temp settings file with `SessionStart` / `Stop` /
 *      `UserPromptSubmit` hooks pointing at a tiny helper script — the script
 *      mutates a shared state JSON file so the parent process learns the real
 *      session id / transcript path / turn-end signal.
 *   3. Spawn `claude` under a real PTY (via `node-pty`) with the prompt as
 *      positional argv. Claude TUI auto-submits the prompt on startup.
 *   4. Poll the transcript JSONL incrementally; feed each line through
 *      `claudeParse`. JSONL records lack `stream_event` / `result` events, so
 *      we patch up the missing `s.text` / `s.thinking` accumulation and
 *      `assistant.message.usage` extraction in the loop.
 *   5. When the `Stop` hook fires (Claude has finished the assistant turn),
 *      SIGTERM the PTY process. The JSONL is fully flushed by then.
 *      Exception — background sub-agents: Claude fires `Stop` whenever the
 *      main loop finishes a response segment, *including* the segment that
 *      launched `run_in_background` agents. Those agents live inside the
 *      claude process, so killing on that first Stop would destroy them
 *      mid-flight. The driver therefore refuses to terminate while launched
 *      background agents haven't reported their `<task-notification>`, and
 *      only accepts a Stop that is "fresh" (fired after the last
 *      notification) — see `decideClaudeTuiStop`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import type { StreamOpts, StreamResult } from '../types.js';
import {
  Q, agentLog, agentWarn, agentError,
  buildStreamPreviewMeta, computeContext, joinErrorMessages,
  emitSessionIdUpdate, normalizeClaudeModelId,
  pushRecentActivity, summarizeClaudeToolUse, summarizeClaudeToolResult,
  previewToolCallInput, previewToolCallResult,
  detectClaudeApiError,
} from '../utils.js';
import { encodePathAsDirName, getHome, whichSync } from '../../core/platform.js';
import { createRetainedLogSink } from '../../core/logging.js';
import { stripAnsiEscapes } from '../../core/utils.js';
import {
  AGENT_STREAM_HARD_KILL_GRACE_MS,
  CLAUDE_TUI_STALL_QUIET_MS, CLAUDE_TUI_STALL_PENDING_TOOL_MS,
  CLAUDE_TUI_STALL_PTY_DEAD_MS, CLAUDE_TUI_STOP_HOLD_QUIET_TTL_MS,
} from '../../core/constants.js';
import {
  claudeParse, createClaudeStreamState,
  claudeContextWindowFromModel, claudeEffectiveContextWindow,
  registerClaudeBackgroundAgentLaunch, pendingClaudeBackgroundAgentCount,
  registerClaudeBackgroundBashLaunch, pendingClaudeBackgroundBashCount,
  extractClaudeBackgroundTaskId,
} from './claude.js';

// ---------------------------------------------------------------------------
// Stall diagnostics (capture-only)
// ---------------------------------------------------------------------------
//
// We instrument the mid-turn freeze before tuning the watchdog: the next pause
// should be classified from data, not guesswork. Records land append-only in
// ~/.pikiclaw/diagnostics/claude-tui-stall.jsonl across three moments:
//   - 'quiet'    — heartbeat while a turn has gone silent past the threshold
//                  (captures the lead-up to a stall, throttled)
//   - 'stall'    — the watchdog declared the turn dead and SIGTERMed it
//   - 'resolved' — a turn that went quiet ended (completed / killed / aborted),
//                  so benign long-thinking is separable from true freezes
//
// The decisive field is `ptyQuietMs` vs `quietMs`: a large quietMs (JSONL/hook
// signals silent) paired with a small ptyQuietMs (PTY still painting frames)
// means the model stream froze behind a live spinner — which defeats the
// PTY-dead fast path and forces the slow 10-min quiet threshold. Confirming
// that pattern (or refuting it) is the whole point of this pass.

/** Begin recording heartbeats once no live signal has advanced for this long. */
const STALL_DIAG_QUIET_THRESHOLD_MS = 45_000;
/** Throttle heartbeats while a turn stays quiet, so a long freeze is sampled
 *  (not logged every 200ms poll tick). */
const STALL_DIAG_HEARTBEAT_INTERVAL_MS = 30_000;

// undefined = not yet initialised; null = init failed (give up, never retry);
// function = ready. Shared across all turns so every session appends to one file.
let stallDiagSink: ((chunk: string) => void) | null | undefined;
function writeStallDiag(record: Record<string, unknown>): void {
  if (stallDiagSink === null) return;
  try {
    if (stallDiagSink === undefined) {
      const file = path.join(getHome(), '.pikiclaw', 'diagnostics', 'claude-tui-stall.jsonl');
      stallDiagSink = createRetainedLogSink(file, {
        maxLines: 50_000,
        maxAgeMs: 14 * 24 * 60 * 60_000,
        trimEveryWrites: 500,
      });
      agentLog(`[claude-tui] stall diagnostics → ${file}`);
    }
    stallDiagSink(JSON.stringify({ ts: Date.now(), ...record }) + '\n');
  } catch {
    stallDiagSink = null;
  }
}

/** Cheap capture-only label for the last transcript event before a quiet
 *  stretch — the freeze signature is "next assistant never starts after a
 *  tool_result", so the kind of the last event matters. */
export function classifyClaudeJsonlEvent(ev: any): string {
  const type = typeof ev?.type === 'string' ? ev.type : 'unknown';
  const content = ev?.message?.content;
  if (Array.isArray(content)) {
    if (content.some((b: any) => b?.type === 'tool_use')) return `${type}:tool_use`;
    if (content.some((b: any) => b?.type === 'tool_result')) return `${type}:tool_result`;
    if (content.some((b: any) => b?.type === 'thinking')) return `${type}:thinking`;
    if (content.some((b: any) => b?.type === 'text')) return `${type}:text`;
  }
  return type;
}

// ---------------------------------------------------------------------------
// node-pty (dynamic import — optional dependency)
// ---------------------------------------------------------------------------

/** Minimal subset of the node-pty API we rely on. Declared inline so we don't
 *  hard-require `@types/node-pty` at type-check time when the optional dep
 *  isn't installed. */
interface PtyProcess {
  pid: number;
  onData(cb: (data: string) => void): { dispose(): void };
  onExit(cb: (event: { exitCode: number; signal?: number | null }) => void): { dispose(): void };
  write(data: string): void;
  kill(signal?: string): void;
  resize(cols: number, rows: number): void;
}

interface PtyModule {
  spawn(file: string, args: string[], options: {
    cwd?: string;
    env?: { [key: string]: string };
    cols?: number;
    rows?: number;
    name?: string;
    encoding?: string | null;
  }): PtyProcess;
}

async function loadPty(): Promise<PtyModule> {
  // Dynamic import keeps node-pty an optional dependency — if it's not
  // installed the print-mode dispatcher in claude.ts will catch the throw
  // and fall back to `-p`. The variable-specifier indirection is required so
  // TypeScript does not try to resolve `node-pty` at compile time when the
  // dep is absent.
  const specifier = 'node-pty';
  const mod: any = await import(/* @vite-ignore */ specifier);
  const api = mod?.default ?? mod;
  if (!api?.spawn) throw new Error('node-pty loaded but spawn() is missing');
  await preflightSpawnHelper();
  return api as PtyModule;
}

/**
 * On macOS / Linux, node-pty's prebuilt `spawn-helper` ships without the
 * executable bit set on some npm installs (the npm tarball drops mode bits
 * when extracted under certain umask settings). Without the bit, every
 * `pty.spawn` returns the cryptic `posix_spawnp failed.` because the helper
 * itself can't run. Restore the bit eagerly the first time the driver loads
 * so users don't have to debug this on their own.
 */
let spawnHelperPreflightDone = false;
async function preflightSpawnHelper(): Promise<void> {
  if (spawnHelperPreflightDone || process.platform === 'win32') {
    spawnHelperPreflightDone = true;
    return;
  }
  spawnHelperPreflightDone = true;
  try {
    // Resolve relative to the loaded node-pty package. require.resolve isn't
    // available in ESM; walk node_modules from this file's URL instead.
    const ptyRoot = await locatePtyPackageRoot();
    if (!ptyRoot) return;
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    const platform = process.platform === 'darwin' ? 'darwin' : 'linux';
    const helper = path.join(ptyRoot, 'prebuilds', `${platform}-${arch}`, 'spawn-helper');
    if (!fs.existsSync(helper)) return;
    const stat = fs.statSync(helper);
    if ((stat.mode & 0o111) === 0) {
      fs.chmodSync(helper, stat.mode | 0o755);
      agentLog(`[claude-tui] restored executable bit on ${helper}`);
    }
  } catch (e: any) {
    agentWarn(`[claude-tui] spawn-helper preflight skipped: ${e?.message || e}`);
  }
}

async function locatePtyPackageRoot(): Promise<string | null> {
  // Walk up from this file looking for a node_modules/node-pty/package.json.
  // This is the dist-time layout (compiled to dist/) AND the tsx runtime
  // layout (running from src/) — both have node_modules at the project root.
  let dir = path.dirname(new URL(import.meta.url).pathname);
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, 'node_modules', 'node-pty');
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Hook helper script — written to a temp dir per turn. Receives Claude Code
// hook JSON payloads on stdin and mutates a shared state file so the parent
// can react to lifecycle events without needing socket / IPC plumbing.
// ---------------------------------------------------------------------------

const HOOK_SCRIPT = `#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const event = process.argv[2] || "";
const stateFile = process.argv[3] || "";
const toolEventsFile = process.argv[4] || "";
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => { stdin += d; });
process.stdin.on("end", () => {
  let payload = {};
  try { payload = stdin ? JSON.parse(stdin) : {}; } catch (_) {}
  // Tool events go to an append-only JSONL. Sequential lifecycle events
  // (SessionStart / UserPromptSubmit / Stop) still use the state file —
  // they fire once each so the read-modify-write race is benign there.
  if ((event === "PreToolUse" || event === "PostToolUse") && toolEventsFile) {
    const line = JSON.stringify({
      event,
      at: Date.now(),
      tool_use_id: typeof payload.tool_use_id === "string" ? payload.tool_use_id : null,
      tool_name: typeof payload.tool_name === "string" ? payload.tool_name : null,
      tool_input: payload.tool_input || null,
      tool_response: payload.tool_response || null,
      // Claude Code tags sub-agent tool calls with agent_id so the parent can
      // tell them apart from main-thread calls. Forwarding it lets the driver
      // route the hook to the right sub-agent card instead of the parent's
      // 执行 list.
      agent_id: typeof payload.agent_id === "string" ? payload.agent_id : null,
    }) + "\\n";
    try { fs.appendFileSync(toolEventsFile, line); } catch (_) {}
    process.stdout.write(JSON.stringify({ continue: true }) + "\\n");
    return;
  }
  let state = {};
  try { state = JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch (_) {}
  state.events = Array.isArray(state.events) ? state.events : [];
  state.events.push({ event, at: Date.now() });
  const sid = typeof payload.session_id === "string" ? payload.session_id : null;
  const tpath = typeof payload.transcript_path === "string" ? payload.transcript_path : null;
  if (sid) state.sessionId = sid;
  if (tpath) state.transcriptPath = tpath;
  if (event === "SessionStart") state.sessionStartedAt = Date.now();
  else if (event === "UserPromptSubmit") state.promptSubmittedAt = Date.now();
  else if (event === "Stop") state.stoppedAt = Date.now();
  try { fs.writeFileSync(stateFile, JSON.stringify(state)); } catch (_) {}
  process.stdout.write(JSON.stringify({ continue: true }) + "\\n");
});
process.stdin.on("error", () => {
  try { process.stdout.write(JSON.stringify({ continue: true }) + "\\n"); } catch (_) {}
});
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface HookState {
  events?: Array<{ event: string; at: number }>;
  sessionId?: string;
  transcriptPath?: string;
  sessionStartedAt?: number;
  promptSubmittedAt?: number;
  stoppedAt?: number;
}

function readHookState(statePath: string): HookState {
  try { return JSON.parse(fs.readFileSync(statePath, 'utf8')) as HookState; }
  catch { return {}; }
}

/**
 * Incremental JSONL tail. Reads from `fromOffset` to the file's current size,
 * splits on newlines, and stops one line short if the last segment doesn't end
 * with `\n` (so a partially-written final line gets re-read next tick rather
 * than corrupting JSON.parse).
 */
function readJsonlIncrement(filePath: string, fromOffset: number): { offset: number; lines: string[] } {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size <= fromOffset) return { offset: fromOffset, lines: [] };
    const len = stat.size - fromOffset;
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, fromOffset);
    fs.closeSync(fd);
    const chunk = buf.toString('utf8');
    if (!chunk) return { offset: fromOffset, lines: [] };
    const endsWithNewline = chunk[chunk.length - 1] === '\n';
    const segments = chunk.split('\n');
    if (endsWithNewline) {
      // Last segment after split is empty — drop it.
      segments.pop();
      return { offset: stat.size, lines: segments };
    }
    // Partial last line — keep its bytes unread for the next tick.
    const lastLine = segments.pop() || '';
    const consumed = stat.size - Buffer.byteLength(lastLine, 'utf8');
    return { offset: consumed, lines: segments };
  } catch { return { offset: fromOffset, lines: [] }; }
}

/**
 * Simulated streaming buffer.
 *
 * The print-mode driver gets per-character streaming for free from
 * `stream_event/content_block_delta`. The JSONL transcript that TUI mode
 * reads only carries *complete* content blocks — for a plain-text answer that
 * means the whole response lands in one write, and without this buffer the
 * dashboard / IM would see a sudden big "splat" of text instead of the
 * familiar typing effect.
 *
 * Mechanism: text extracted from each assistant JSONL event accumulates into
 * `trueText`. A timer chews through it `TUI_STREAM_CHUNK_CHARS` at a time,
 * promoting characters into `s.text` and emit()-ing on each step. The cadence
 * is set comfortably above the model's natural generation rate so that during
 * a long, multi-segment turn the buffer stays drained and the user sees
 * fluid typing rather than batch-and-pause.
 *
 * Thinking is rendered in a collapsed panel — we don't bother streaming it,
 * just push the full block straight into `s.thinking`.
 */
interface TuiStreamBuffer {
  /** Canonical text accumulated from JSONL — what the user "should" see in full. */
  trueText: string;
  /** How many chars of `trueText` have been promoted into `s.text`. */
  displayedLen: number;
  /** Pending tick handle, if any. */
  timer: NodeJS.Timeout | null;
}

// 20 chars / 20 ms = 1000 chars/s. Haiku generates ~150 tok/s (~600 chars/s),
// Sonnet/Opus are slower. Running ahead of the model keeps the buffer drained
// during continuous generation. CJK characters render at ~2x ASCII visual
// width but this rate still feels natural in both scripts.
const TUI_STREAM_CHUNK_CHARS = 20;
const TUI_STREAM_CHUNK_INTERVAL_MS = 20;

function makeTuiStreamBuffer(): TuiStreamBuffer {
  return { trueText: '', displayedLen: 0, timer: null };
}

function extractTextBlocks(content: any): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter((block: any) => block?.type === 'text' && typeof block.text === 'string')
    .map((block: any) => block.text)
    .join('\n')
    .trim();
}

function normalizedNoticeLines(text: string): string[] {
  return stripAnsiEscapes(text)
    .split(/\r?\n/)
    .map(line => line.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, ''))
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function limitNoticeFromText(text: string | null | undefined): string | null {
  if (!text) return null;
  const patterns = [
    /you(?:'|’)ve hit your (?:session|usage) limit/i,
    /you have hit your (?:session|usage) limit/i,
    /(?:session|usage) limit (?:reached|exceeded)/i,
    /(?:session|usage) limit.{0,100}resets?/i,
    /(?:rate limit|rate limited).{0,100}(?:try again|resets?|later)/i,
    /(?:try again|resets?|later).{0,100}(?:rate limit|rate limited)/i,
  ];
  for (const line of normalizedNoticeLines(text)) {
    if (patterns.some(pattern => pattern.test(line))) return line.slice(0, 240);
  }
  return null;
}

export function detectClaudeTuiTerminalLimitNotice(msgOrText: any): string | null {
  if (typeof msgOrText === 'string') return limitNoticeFromText(msgOrText);
  if (!msgOrText || msgOrText.model !== '<synthetic>') return null;
  return limitNoticeFromText(extractTextBlocks(msgOrText.content));
}

/**
 * Extract text / thinking blocks from an assistant JSONL event and route them:
 * text → the chunked stream buffer (slow drain), thinking → `s.thinking`
 * directly. Tool uses, stop reasons, sub-agents, etc. are still handled by
 * `claudeParse` once we've stripped the text/thinking blocks out of the event
 * (see `callClaudeParseForTui`) — otherwise `claudeParse`'s "fill if empty"
 * fallback would clobber the buffered streaming.
 */
/**
 * Pull the server-assigned task id out of a PostToolUse hook's tool_response.
 * Claude Code's hook payload mirrors the JSONL tool_result shape — usually
 * `{ task: { id, subject }, ...}` for TaskCreate. Falls back to scanning the
 * textual response for "Task #N created" when the structured form is missing.
 */
function readAssignedTaskIdFromHookResponse(toolResponse: any): string | null {
  const structured = toolResponse?.task?.id;
  if (structured != null && String(structured).trim()) return String(structured).trim();
  if (typeof toolResponse === 'string') {
    const m = toolResponse.match(/Task #(\d+)/);
    if (m) return m[1];
  }
  if (toolResponse && typeof toolResponse.result === 'string') {
    const m = toolResponse.result.match(/Task #(\d+)/);
    if (m) return m[1];
  }
  return null;
}

/**
 * Apply a single PreToolUse / PostToolUse hook event to the parser state.
 * Mirrors what `claudeParse` would do for the matching JSONL tool_use /
 * tool_result, but fires the instant Claude calls the tool — so the IM
 * placeholder card actually updates during the turn instead of staying empty
 * until Stop. Dedup with the eventual JSONL flush is via `tool_use_id`:
 * claudeParse skips tools already in `s.seenClaudeToolIds`, and the new
 * `s.seenClaudeToolResultIds` guards tool_result re-pushes.
 */
export function applyHookToolEvent(ev: any, s: any): boolean {
  const toolUseId = String(ev?.tool_use_id || '').trim();
  const toolName = String(ev?.tool_name || '').trim();
  if (!toolName || !toolUseId) return false;

  // Sub-agent tool calls fire the parent's Pre/PostToolUse hooks too (one
  // hook pipeline per CLI process). Claude Code tags those payloads with
  // `agent_id`; route them to the matching sub-agent's tool list instead of
  // appending to the parent's recentActivity. Without this every Task spawn
  // floods the parent's 执行 card with the children's tool stream while the
  // sub-agent cards sit empty until the sidecar JSONL flushes at Stop.
  const subAgentId = typeof ev?.agent_id === 'string' && ev.agent_id ? ev.agent_id : '';
  if (subAgentId) {
    if (ev.event === 'PreToolUse') {
      const parentToolUseId = s.subAgentIdToParent?.get(subAgentId);
      const sub = parentToolUseId ? s.subAgents?.get(parentToolUseId) : undefined;
      if (sub && !sub.tools.some((t: any) => t.id === toolUseId)) {
        const summary = toolName === 'TodoWrite'
          ? 'Update plan'
          : summarizeClaudeToolUse(toolName, ev.tool_input || {});
        sub.tools.push({ id: toolUseId, name: toolName, summary });
      }
    }
    return true;
  }

  if (ev.event === 'PreToolUse') {
    if (s.seenClaudeToolIds.has(toolUseId)) return false;
    if (toolName === 'TaskCreate') {
      const subject = typeof ev.tool_input?.subject === 'string' ? ev.tool_input.subject.trim() : '';
      if (subject) s.pendingClaudeTaskCreates.set(toolUseId, { subject });
      s.seenClaudeToolIds.add(toolUseId);
      s.claudeToolsById.set(toolUseId, { name: toolName, summary: subject ? `Create task: ${subject}` : 'Create task' });
      return true;
    }
    if (toolName === 'TaskUpdate') {
      const taskId = String(ev.tool_input?.taskId ?? '').trim();
      const rawStatus = String(ev.tool_input?.status ?? '').trim().toLowerCase();
      if (taskId) {
        if (rawStatus === 'deleted') {
          s.claudeTaskList.delete(taskId);
          s.claudeTaskOrder = s.claudeTaskOrder.filter((id: string) => id !== taskId);
        } else if (rawStatus) {
          const existing = s.claudeTaskList.get(taskId);
          if (existing) existing.status = rawStatus;
        }
        rebuildClaudePlanFromTasksFromState(s);
      }
      s.seenClaudeToolIds.add(toolUseId);
      s.claudeToolsById.set(toolUseId, { name: toolName, summary: `Update task ${taskId || '?'} → ${rawStatus || 'unknown'}` });
      return true;
    }
    if (toolName === 'TodoWrite') {
      const plan = parseTodoWriteAsPlanLite(ev.tool_input);
      if (plan) s.plan = plan;
      s.seenClaudeToolIds.add(toolUseId);
      s.claudeToolsById.set(toolUseId, { name: toolName, summary: 'Update plan' });
      return true;
    }
    if (toolName === 'Task' || toolName === 'Agent') {
      // Register the sub-agent so `meta.subAgents` lights up the new
      // Sub-agent preview block. Sub-agents are isolated from parent activity
      // by design (the dedicated section shows their own tool stream); pushing
      // into parent recentActivity would re-introduce the noise the isolation
      // is meant to prevent. Granular sub-agent tool calls land later via the
      // sidecar pump → `routeClaudeSubAgentEvent`.
      const input = ev.tool_input || {};
      const desc = typeof input.description === 'string' ? input.description.trim() : '';
      const kind = typeof input.subagent_type === 'string' ? input.subagent_type.trim() : '';
      if (!s.subAgents.has(toolUseId)) {
        s.subAgents.set(toolUseId, {
          id: toolUseId,
          kind: kind || null,
          description: desc || null,
          model: null,
          tools: [],
          status: 'running',
        });
      }
      // Backgrounded launch — track it so the turn doesn't end (and the PTY
      // doesn't get SIGTERMed) until its <task-notification> arrives. The hook
      // fires live; the JSONL replay of the same tool_use dedupes via
      // seenClaudeToolIds, so this is the only registration point in TUI mode.
      if (input.run_in_background === true) registerClaudeBackgroundAgentLaunch(s, toolUseId);
      s.seenClaudeToolIds.add(toolUseId);
      s.claudeToolsById.set(toolUseId, { name: toolName, summary: desc || kind || 'Sub-agent' });
      return true;
    }
    // Background Bash — register like a backgrounded agent so the turn's Stop
    // holds the PTY open until its <task-notification> lands, instead of
    // SIGTERMing the still-running command (and its future report-back turn).
    if (toolName === 'Bash' && ev.tool_input?.run_in_background === true) {
      registerClaudeBackgroundBashLaunch(s, toolUseId);
    }
    const summary = summarizeClaudeToolUse(toolName, ev.tool_input || {});
    pushRecentActivity(s.recentActivity, summary);
    s.seenClaudeToolIds.add(toolUseId);
    s.claudeToolsById.set(toolUseId, {
      name: toolName,
      summary,
      input: previewToolCallInput(toolName, ev.tool_input),
      status: 'running',
    });
    if (!s.claudeToolCallOrder) s.claudeToolCallOrder = [];
    s.claudeToolCallOrder.push(toolUseId);
    s.activity = s.recentActivity.join('\n');
    return true;
  }

  if (ev.event === 'PostToolUse') {
    if (!s.seenClaudeToolResultIds) s.seenClaudeToolResultIds = new Set<string>();
    if (s.seenClaudeToolResultIds.has(toolUseId)) return false;
    if (toolName === 'TaskCreate') {
      const pending = s.pendingClaudeTaskCreates.get(toolUseId);
      const assignedId = readAssignedTaskIdFromHookResponse(ev.tool_response);
      if (pending && assignedId) {
        s.pendingClaudeTaskCreates.delete(toolUseId);
        if (!s.claudeTaskList.has(assignedId)) s.claudeTaskOrder.push(assignedId);
        s.claudeTaskList.set(assignedId, { subject: pending.subject, status: 'pending' });
        rebuildClaudePlanFromTasksFromState(s);
      }
      s.seenClaudeToolResultIds.add(toolUseId);
      return true;
    }
    if (toolName === 'TaskUpdate' || toolName === 'TodoWrite') {
      s.seenClaudeToolResultIds.add(toolUseId);
      return true;
    }
    if (toolName === 'Task' || toolName === 'Agent') {
      // Sub-agent finished — flip its status so it drops out of the live
      // Sub-agent preview block. The completion fact itself is implicit: the
      // block stops listing this entry.
      // Backgrounded launches are the exception: their PostToolUse fires
      // immediately with a launch ack while the agent keeps running. Leave the
      // status alone — applyClaudeTaskNotification flips it when the real
      // completion lands.
      const sub = s.subAgents.get(toolUseId);
      if (sub) {
        const isBgLaunchAck = !ev.tool_response?.is_error
          && (ev.tool_input?.run_in_background === true
            || (s.bgAgentLaunchedToolUseIds?.has(toolUseId) && !s.bgAgentCompletedToolUseIds?.has(toolUseId)));
        if (!isBgLaunchAck) sub.status = ev.tool_response?.is_error ? 'failed' : 'done';
      }
      s.seenClaudeToolResultIds.add(toolUseId);
      return true;
    }
    const tool = s.claudeToolsById.get(toolUseId);
    if (tool) {
      tool.result = previewToolCallResult(ev.tool_response);
      tool.status = ev.tool_response?.is_error ? 'failed' : 'done';
      const summary = summarizeClaudeToolResult(tool, { content: ev.tool_response }, ev.tool_response);
      if (summary) {
        pushRecentActivity(s.recentActivity, summary);
        s.activity = s.recentActivity.join('\n');
      }
    }
    // Background Bash launch ack → map task id → tool_use for notification
    // resolution (bash notifications usually omit <tool-use-id>).
    if (toolName === 'Bash' && s.bgBashToolUseIds?.has(toolUseId)
        && !s.bgAgentCompletedToolUseIds?.has(toolUseId)) {
      const taskId = extractClaudeBackgroundTaskId(ev.tool_response);
      if (taskId && !s.bgTaskIdToToolUse.has(taskId)) s.bgTaskIdToToolUse.set(taskId, toolUseId);
    }
    s.seenClaudeToolResultIds.add(toolUseId);
    return true;
  }

  return false;
}

/**
 * Lite TodoWrite parser used by the hook path — avoids pulling parseTodoWriteAsPlan
 * from agent/utils into this file's already-large import surface. Identical
 * semantics for the legacy 1.x plan tool.
 */
function parseTodoWriteAsPlanLite(input: any): any {
  if (!input || typeof input !== 'object') return null;
  const rawTodos = Array.isArray(input.todos) ? input.todos : [];
  if (!rawTodos.length) return null;
  const steps: Array<{ step: string; status: string }> = [];
  for (const todo of rawTodos) {
    if (!todo || typeof todo !== 'object') continue;
    const content = typeof todo.content === 'string' ? todo.content.trim() : '';
    if (!content) continue;
    const rawStatus = typeof todo.status === 'string' ? todo.status : 'pending';
    const status = rawStatus === 'completed' ? 'completed'
      : rawStatus === 'in_progress' ? 'inProgress'
      : 'pending';
    steps.push({ step: content, status });
  }
  if (!steps.length) return null;
  return { explanation: null, steps };
}

/**
 * Reimplementation of claude.ts's rebuildClaudePlanFromTasks (it's private to
 * that module). Kept tiny and dependency-free so the hook code path stays
 * independent of the JSONL parser's internals.
 */
function rebuildClaudePlanFromTasksFromState(s: any): void {
  if (!s.claudeTaskOrder?.length) return;
  const steps: Array<{ step: string; status: string }> = [];
  for (const id of s.claudeTaskOrder) {
    const task = s.claudeTaskList.get(id);
    if (!task) continue;
    const lowered = String(task.status || '').toLowerCase();
    const status = lowered === 'completed' ? 'completed'
      : lowered === 'in_progress' || lowered === 'inprogress' ? 'inProgress'
      : 'pending';
    steps.push({ step: task.subject, status });
  }
  s.plan = { explanation: null, steps };
}

function applyAssistantStreaming(s: any, msg: any, buf: TuiStreamBuffer): void {
  if (!msg || msg.model === '<synthetic>') return;
  const contents = Array.isArray(msg.content) ? msg.content : [];
  let appendText = '';
  let appendThinking = '';
  for (const block of contents) {
    if (!block) continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      appendText += (appendText ? '\n\n' : '') + block.text;
    } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
      appendThinking += (appendThinking ? '\n\n' : '') + block.thinking;
    }
  }
  if (appendText) {
    buf.trueText = buf.trueText ? `${buf.trueText}\n\n${appendText}` : appendText;
  }
  if (appendThinking) {
    s.thinking = s.thinking ? `${s.thinking}\n\n${appendThinking}` : appendThinking;
  }
}

/**
 * Hand a JSONL event to the shared `claudeParse`, but for `assistant` events
 * first strip out the text/thinking blocks. Reason: `claudeParse`'s assistant
 * branch contains a `if (tx && !s.text.trim()) s.text = tx` fallback — useful
 * for print mode where deltas may have missed, harmful here because it would
 * dump the entire response into `s.text` in one go, bypassing the simulated
 * stream we just routed into the buffer.
 */
function callClaudeParseForTui(ev: any, s: any): void {
  if (ev.type !== 'assistant' || !ev.message) {
    claudeParse(ev, s);
    return;
  }
  const filtered = {
    ...ev,
    message: {
      ...ev.message,
      content: Array.isArray(ev.message.content)
        ? ev.message.content.filter((b: any) => b?.type !== 'text' && b?.type !== 'thinking')
        : ev.message.content,
    },
  };
  claudeParse(filtered, s);
}

/**
 * Set `s.contextWindow` from a model id, the same way the `-p` parser does on
 * each `system` / `stream_event` / `result` event. TUI mode never sees those
 * events (JSONL is the source of truth and only carries `user`/`assistant`/
 * `attachment`/`summary`), so without this call `s.contextWindow` stays null
 * and `computeContext()` returns `contextPercent: null` → the dashboard's
 * `ContextDot` and percent chip both disappear. Guarded by `byokContextWindow`
 * so BYOK Profiles' externally-cached window wins (matches print-mode).
 */
function applyModelContextWindow(s: any): void {
  if (s.byokContextWindow) return;
  const advertised = claudeContextWindowFromModel(s.model);
  const effective = claudeEffectiveContextWindow(advertised);
  if (effective != null) s.contextWindow = effective;
}

/** Per-call token usage from an assistant event's `message.usage`. -p mode
 *  derives these from `stream_event/message_delta`; JSONL only carries them
 *  here. Per-call semantics: each assistant event represents one LLM call and
 *  its usage replaces the prior snapshot. */
function applyAssistantUsage(s: any, msg: any): void {
  const u = msg?.usage;
  if (!u || typeof u !== 'object') return;
  // JSONL has no message_start marker — a fresh message.id is the per-call
  // boundary. Fold the finished call's output into the turn-cumulative base
  // before this call's counters take over (events of the same call share an
  // id and carry running totals, so only the id transition folds).
  const msgId = typeof msg?.id === 'string' && msg.id ? msg.id : null;
  if (msgId && msgId !== s.turnUsageMsgId) {
    if (s.turnUsageMsgId != null) s.turnOutputTokensBase = (s.turnOutputTokensBase ?? 0) + (s.outputTokens ?? 0);
    s.turnUsageMsgId = msgId;
  }
  if (typeof u.input_tokens === 'number') s.inputTokens = u.input_tokens;
  if (typeof u.output_tokens === 'number') s.outputTokens = u.output_tokens;
  if (typeof u.cache_read_input_tokens === 'number') s.cachedInputTokens = u.cache_read_input_tokens;
  if (typeof u.cache_creation_input_tokens === 'number') s.cacheCreationInputTokens = u.cache_creation_input_tokens;
  const total = (s.inputTokens ?? 0) + (s.cachedInputTokens ?? 0) + (s.cacheCreationInputTokens ?? 0) + (s.outputTokens ?? 0);
  s.contextUsedTokens = total > 0 ? total : null;
}

// ---------------------------------------------------------------------------
// Stop-hook gating
// ---------------------------------------------------------------------------

/**
 * After the last pending background agent reports its <task-notification>,
 * the harness re-invokes the model (wrap-up segment) and a fresh Stop hook
 * follows. A Stop timestamp that *predates* the latest notification belongs to
 * an earlier segment and must not terminate the turn. If no re-invocation
 * materialises, we accept the stale Stop once the main JSONL has been quiet
 * for this long — the safety valve against waiting forever on a harness that
 * chose not to resume.
 */
const BG_RESETTLE_QUIET_MS = 30_000;

export type ClaudeTuiStopDecision = 'terminate' | 'hold-background' | 'hold-resettle';

/**
 * Decide what a fired Stop hook means for the PTY lifecycle.
 *
 *  - `hold-background`: launched `run_in_background` agents haven't reported
 *    completion. They live inside the claude process — SIGTERM now would
 *    destroy them mid-flight (the "进程退出把子代理打断" failure). Keep the
 *    PTY alive; the harness will deliver <task-notification> events and
 *    re-invoke the model, producing further segments and a later Stop.
 *  - `hold-resettle`: nothing pending, but the Stop predates the latest
 *    notification — the model's post-notification segment (and its own Stop)
 *    is still expected. Hold until a fresh Stop or BG_RESETTLE_QUIET_MS of
 *    JSONL silence.
 *  - `terminate`: the Stop is the genuine end of the turn.
 *
 * The `hold-background` path carries a quiet-TTL: a genuinely-running
 * background agent keeps emitting hook/sidecar/JSONL traffic, so a hold whose
 * every channel has been silent past CLAUDE_TUI_STOP_HOLD_QUIET_TTL_MS is a
 * phantom (lost <task-notification> / completion never observed). Releasing
 * it as a normal Stop keeps the turn's clean semantics — letting the stall
 * watchdog reap it instead would mislabel a finished turn 'stalled' and
 * inject a confusing auto-resume prompt into the next turn.
 */
export function decideClaudeTuiStop(input: {
  stoppedAt: number;
  pendingBackgroundAgents: number;
  lastTaskNotificationAt: number;
  lastJsonlEventAt: number;
  now: number;
  resettleQuietMs?: number;
  /** Freshest hook / sub-agent sidecar activity — live agents keep this hot. */
  lastHookOrSidecarEventAt?: number;
  holdQuietTtlMs?: number;
}): ClaudeTuiStopDecision {
  if (input.pendingBackgroundAgents > 0) {
    const ttl = input.holdQuietTtlMs ?? CLAUDE_TUI_STOP_HOLD_QUIET_TTL_MS;
    const lastActivityAt = Math.max(
      input.stoppedAt,
      input.lastJsonlEventAt,
      input.lastTaskNotificationAt,
      input.lastHookOrSidecarEventAt ?? 0,
    );
    if (input.now - lastActivityAt > ttl) return 'terminate';   // 幽灵 hold:全通道静默超 TTL
    return 'hold-background';
  }
  const stopIsStale = input.lastTaskNotificationAt > 0 && input.lastTaskNotificationAt >= input.stoppedAt;
  if (stopIsStale) {
    const quietMs = input.resettleQuietMs ?? BG_RESETTLE_QUIET_MS;
    const lastActivityAt = Math.max(input.lastJsonlEventAt, input.lastTaskNotificationAt);
    if (input.now - lastActivityAt < quietMs) return 'hold-resettle';
  }
  return 'terminate';
}

// ---------------------------------------------------------------------------
// Stall watchdog
// ---------------------------------------------------------------------------

export type ClaudeTuiStallDecision = 'wait' | 'stall';

/**
 * Decide whether the turn has gone dead. claude CLI is known to freeze
 * mid-turn (observed 2026-06-02 on 2.1.160): after a tool_result lands the
 * next assistant segment never starts — the process stays alive, the JSONL
 * goes permanently quiet, no Stop hook ever fires, no error surfaces. Without
 * a watchdog the IM card spins forever.
 *
 * `lastProgressAt` is the freshest of every live signal the driver tracks
 * (main JSONL, hook tool events, sub-agent sidecars, hook lifecycle state).
 * A pending tool (PreToolUse seen, no PostToolUse) extends the threshold:
 * the freeze can also hit mid-execution, but a legitimately long foreground
 * command must not get shot — claude's own Bash timeout fires PostToolUse
 * well inside CLAUDE_TUI_STALL_PENDING_TOOL_MS.
 *
 * Fast path: `lastPtyDataAt` is raw PTY output (any repaint frame counts). A
 * healthy TUI animates continuously mid-turn — spinner, stream ticks, status
 * line — so PTY byte-silence is the cheapest possible "event loop is dead"
 * detector. When BOTH the PTY and all structured signals have been silent
 * past `ptyDeadMs`, declare the stall immediately instead of waiting out the
 * 10/30-minute quiet thresholds. Long thinking and long foreground commands
 * keep painting frames, which routes them to the slow thresholds as before.
 */
export function decideClaudeTuiStall(input: {
  now: number;
  lastProgressAt: number;
  pendingToolCount: number;
  quietMs?: number;
  pendingToolMs?: number;
  /** Wall-clock of the last raw PTY byte; 0/undefined = signal unavailable. */
  lastPtyDataAt?: number;
  ptyDeadMs?: number;
}): ClaudeTuiStallDecision {
  const ptyAt = input.lastPtyDataAt ?? 0;
  if (ptyAt > 0) {
    const ptyDeadMs = input.ptyDeadMs ?? CLAUDE_TUI_STALL_PTY_DEAD_MS;
    if (input.now - Math.max(ptyAt, input.lastProgressAt) > ptyDeadMs) return 'stall';
  }
  const threshold = input.pendingToolCount > 0
    ? (input.pendingToolMs ?? CLAUDE_TUI_STALL_PENDING_TOOL_MS)
    : (input.quietMs ?? CLAUDE_TUI_STALL_QUIET_MS);
  return input.now - input.lastProgressAt > threshold ? 'stall' : 'wait';
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export async function doClaudeTuiStream(opts: StreamOpts): Promise<StreamResult> {
  const start = Date.now();
  const deadline = start + opts.timeout * 1000;

  // 0. Probe node-pty FIRST — before any temp-dir creation or session work.
  // If it's not installed (or its prebuilt helper can't be made executable),
  // throw so the dispatcher in claude.ts catches the error and falls back to
  // print mode. No cleanup needed because no resources have been allocated.
  const pty: PtyModule = await loadPty();

  // 1. Resolve session lifecycle.
  const isFork = !!opts.forkOf;
  const isResume = !isFork && !!opts.sessionId;
  const newSessionId = (isFork || !isResume) ? randomUUID() : opts.sessionId!;

  const home = getHome();
  const projectDir = path.join(home, '.claude', 'projects', encodePathAsDirName(opts.workdir));
  // For resume we know the exact file; for new/fork we either know upfront
  // (--session-id) or learn it from the SessionStart hook (--fork-session
  // rotates to a fresh uuid Claude generates on its own).
  let activeSessionId = isResume ? opts.sessionId! : newSessionId;
  let activeJsonlPath = path.join(projectDir, `${activeSessionId}.jsonl`);
  // Resume: skip everything that was already in the transcript before our turn.
  let jsonlReadOffset = 0;
  if (isResume) {
    try { jsonlReadOffset = fs.statSync(activeJsonlPath).size; } catch {}
  }

  // 2. Temp workspace for hook script + state + settings.
  let workDir: string;
  try {
    workDir = fs.mkdtempSync(path.join(tmpdir(), 'pikiclaw-claude-tui-'));
  } catch (e: any) {
    return makeErrorResult(opts, start, `Failed to create temp dir: ${e?.message || e}`);
  }
  const hookPath = path.join(workDir, 'hook.cjs');
  const statePath = path.join(workDir, 'state.json');
  const toolEventsPath = path.join(workDir, 'tool-events.jsonl');
  const settingsPath = path.join(workDir, 'settings.json');
  const ptyLogPath = path.join(workDir, 'pty.log');

  try {
    fs.writeFileSync(hookPath, HOOK_SCRIPT, { mode: 0o755 });
    fs.writeFileSync(statePath, JSON.stringify({ events: [] }));
    fs.writeFileSync(toolEventsPath, '');
    // Use the same Node binary that's running pikiclaw — `node` may not be on
    // PATH inside the claude TUI's hook subprocess on every distro.
    const nodeBin = Q(process.execPath);
    const hookCmd = (event: string) => `${nodeBin} ${Q(hookPath)} ${event} ${Q(statePath)} ${Q(toolEventsPath)}`;
    // Pre/PostToolUse hooks give us a live event stream. Claude Code 2.x
    // buffers the JSONL transcript and only flushes it when Stop fires, so
    // without these hooks the dashboard / IM see absolutely no progress
    // during a 30s+ turn. The hook script writes to tool-events.jsonl via
    // atomic appends, sidestepping the read-modify-write race that affects
    // the shared state.json file.
    // Pre/PostToolUse require an explicit `matcher` field — without it Claude
    // Code's hook dispatcher silently never fires the hook (the lifecycle
    // hooks below don't need a matcher because they aren't tool-scoped).
    // `*` matches every tool. Without this, the entire live-streaming wire-up
    // is dead code.
    const settings = {
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: hookCmd('SessionStart'), timeout: 5 }] }],
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: hookCmd('UserPromptSubmit'), timeout: 5 }] }],
        PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: hookCmd('PreToolUse'), timeout: 5 }] }],
        PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: hookCmd('PostToolUse'), timeout: 5 }] }],
        Stop: [{ hooks: [{ type: 'command', command: hookCmd('Stop'), timeout: 5 }] }],
      },
    };
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  } catch (e: any) {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
    return makeErrorResult(opts, start, `Failed to seed hook scaffold: ${e?.message || e}`);
  }

  // 3. Build the claude argv. Crucially: NO `-p` — that's the whole point.
  const claudeArgs: string[] = [];
  if (isFork) {
    claudeArgs.push('--resume', opts.forkOf!.parentSessionId, '--fork-session');
  } else if (isResume) {
    claudeArgs.push('--resume', opts.sessionId!);
  } else {
    claudeArgs.push('--session-id', newSessionId);
  }
  claudeArgs.push('--settings', settingsPath);
  const model = normalizeClaudeModelId(opts.claudeModel);
  if (model) claudeArgs.push('--model', model);
  if (opts.claudePermissionMode) claudeArgs.push('--permission-mode', opts.claudePermissionMode);
  if (opts.thinkingEffort) claudeArgs.push('--effort', opts.thinkingEffort);
  if (opts.claudeAppendSystemPrompt) claudeArgs.push('--append-system-prompt', opts.claudeAppendSystemPrompt);
  if (opts.mcpConfigPath) claudeArgs.push('--mcp-config', opts.mcpConfigPath);
  if (opts.claudeExtraArgs?.length) claudeArgs.push(...opts.claudeExtraArgs);

  // Attachments: TUI doesn't accept base64-image stream-json input. Reference
  // local paths via the @-mention syntax — Claude's TUI reads images from
  // disk and inlines them into the message.
  let fullPrompt = opts.prompt;
  if (opts.attachments?.length) {
    const refs = opts.attachments.map(p => `@${p}`).join(' ');
    fullPrompt = `${refs}\n\n${opts.prompt}`;
  }
  // `--mcp-config <configs...>` (and a few other Claude flags) are *variadic*
  // — without a `--` terminator the positional prompt would be consumed as
  // another MCP config path. Always end with `--` then the prompt.
  claudeArgs.push('--', fullPrompt);

  // 4. Honour the existing steer-callback contract — TUI mode can't accept
  // mid-turn additional input, but callers (bot.ts) always pass onSteerReady
  // and expect it to be invoked. Give them a no-op so the orchestration doesn't
  // hang waiting for the callback that never fires.
  try {
    opts.onSteerReady?.(async () => {
      agentWarn('[claude-tui] steer requested but TUI mode does not support mid-turn input — ignored');
      return false;
    });
  } catch (e: any) {
    agentWarn(`[claude-tui] onSteerReady callback raised: ${e?.message || e}`);
  }

  // 5. Set up parser state and ensure the bot side has the upfront session id.
  const s: any = createClaudeStreamState(opts);
  // Resume: lock in the native id we are resuming. Fork: keep a placeholder until
  // Claude reports its rotated id via the SessionStart hook. New session: leave
  // s.sessionId at its initial value (null for a pending session) so the emit
  // below detects a change and fires the pending→native promotion callback.
  if (isResume || isFork) s.sessionId = activeSessionId;
  // Seed the context window from whatever model is configured up front (e.g.
  // "haiku" / "opus" / "sonnet" via opts.claudeModel) so the dashboard's
  // context-percent chip + green-dot indicator can render starting from the
  // very first emit, before any assistant event has arrived to confirm the
  // model. Subsequent assistant events with concrete model ids will refresh
  // s.model + recompute the window via applyModelContextWindow.
  if (!s.model && (opts.claudeModel || opts.model)) {
    s.model = opts.claudeModel || opts.model;
  }
  applyModelContextWindow(s);
  // A brand-new session uses the id we generated and passed via --session-id, so
  // it is final the instant we spawn. Emit it now: s.sessionId is still unset
  // here, so emitSessionIdUpdate fires the onSessionId callback that promotes the
  // pending pikiclaw record (and its in-memory runtime) to the native id. The
  // prior `s.sessionId = activeSessionId` made this a silent no-op (emit dedups on
  // `id === s.sessionId`), so the record stayed `pending_*` for the whole run —
  // and since mergeManagedAndNativeSessions drops pending records, the dashboard
  // never saw the in-flight session as running on (re)load. Fork waits for the
  // SessionStart hook to report Claude's rotated id; resume is already native.
  if (!isResume && !isFork) emitSessionIdUpdate(s, activeSessionId);

  let stderrCapture = '';
  let lineCount = 0;
  let timedOut = false;
  let interrupted = false;
  let stopHookFired = false;
  let stopHookSeenAt = 0;
  let processExited = false;
  let exitCode: number | null = null;
  let exitSignal: number | null = null;
  let terminalLimitNotice: string | null = null;
  let proc: PtyProcess;

  const emit = () => {
    try { opts.onText(s.text, s.thinking, s.activity, buildStreamPreviewMeta(s), s.plan); } catch {}
  };

  const killProc = (signal: string, after = 5000) => {
    try { proc.kill(signal); } catch {}
    setTimeout(() => {
      if (!processExited) { try { proc.kill('SIGKILL'); } catch {} }
    }, after);
  };

  const markTerminalLimitNotice = (notice: string): void => {
    if (terminalLimitNotice) return;
    terminalLimitNotice = notice;
    s.stopReason = 'rate_limit';
    s.errors = [notice];
    agentWarn(`[claude-tui] terminal limit notice detected: ${notice}`);
    emit();
    if (!processExited) killProc('SIGTERM', 1500);
  };

  // Simulated streaming. See TuiStreamBuffer / applyAssistantStreaming above.
  const streamBuf = makeTuiStreamBuffer();
  const scheduleStreamTick = (): void => {
    if (streamBuf.timer) return;
    if (processExited) return;
    if (streamBuf.displayedLen >= streamBuf.trueText.length) return;
    streamBuf.timer = setTimeout(() => {
      streamBuf.timer = null;
      if (streamBuf.displayedLen >= streamBuf.trueText.length) return;
      const next = Math.min(streamBuf.trueText.length, streamBuf.displayedLen + TUI_STREAM_CHUNK_CHARS);
      streamBuf.displayedLen = next;
      s.text = streamBuf.trueText.slice(0, next);
      emit();
      // Keep ticking until we catch up — or until flushStream cancels us.
      if (streamBuf.displayedLen < streamBuf.trueText.length) scheduleStreamTick();
    }, TUI_STREAM_CHUNK_INTERVAL_MS);
  };
  const flushStream = (): void => {
    if (streamBuf.timer) { clearTimeout(streamBuf.timer); streamBuf.timer = null; }
    if (streamBuf.displayedLen < streamBuf.trueText.length) {
      s.text = streamBuf.trueText;
      streamBuf.displayedLen = streamBuf.trueText.length;
      emit();
    }
  };

  // 6. Spawn the TUI under PTY. (node-pty itself was already loaded at step
  // 0 — see the top of this function. By the time we reach this point the
  // module is guaranteed to be importable and `spawn-helper` is executable.)
  const spawnEnv: { [key: string]: string } = { TERM: 'xterm-256color' };
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') spawnEnv[k] = v;
  }
  for (const [k, v] of Object.entries(opts.extraEnv || {})) {
    if (typeof v === 'string') spawnEnv[k] = v;
  }
  // CLAUDECODE is set automatically by the parent claude process when calling
  // children — clear it so this is treated as a fresh top-level invocation.
  delete spawnEnv.CLAUDECODE;
  // Critical: leaving ANTHROPIC_API_KEY set would route TUI through API
  // billing too, defeating the whole point. Strip it unless the user
  // explicitly opts back in.
  if (process.env.PIKICLAW_CLAUDE_TUI_KEEP_API_KEY !== '1') {
    delete spawnEnv.ANTHROPIC_API_KEY;
    delete spawnEnv.ANTHROPIC_AUTH_TOKEN;
  }

  // Resolve `claude` to an absolute path. node-pty's `posix_spawnp` does not
  // reliably honour PATH on macOS when the lookup happens inside an embedded
  // libuv worker — passing the absolute path sidesteps cryptic
  // "posix_spawnp failed" errors. Falls back to the bare name (let
  // posix_spawnp try) when `which` can't resolve it.
  const claudeBin = whichSync('claude') || 'claude';
  agentLog(`[claude-tui] spawning ${claudeBin} TUI session=${activeSessionId} model=${model || '(default)'} prompt=${fullPrompt.length}ch resume=${isResume} fork=${isFork}`);

  try {
    proc = pty.spawn(claudeBin, claudeArgs, {
      cwd: opts.workdir,
      env: spawnEnv,
      cols: 200,
      rows: 50,
      name: 'xterm-256color',
    });
  } catch (e: any) {
    // Throw rather than return an error result — pty.spawn failures (PTY
    // allocation refused in sandboxed CI / Docker without /dev/ptmx, etc.)
    // mean TUI can't run at all, so the dispatcher should fall back to
    // print mode. Clean up the temp scaffolding before bailing.
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
    throw new Error(`pty.spawn failed (bin=${claudeBin}): ${e?.message || e}`);
  }
  agentLog(`[claude-tui] pid=${proc.pid}`);

  const dbg = process.env.PIKICLAW_CLAUDE_TUI_DEBUG === '1';
  /** Wall-clock of the last raw PTY byte — stall watchdog fast-path signal. */
  let lastPtyDataAt = Date.now();
  proc.onData((data: string) => {
    // We deliberately do not parse the TUI screen output. The JSONL is the
    // canonical source of structured events. Stash bytes only when debugging.
    // Raw byte arrival doubles as the cheapest liveness signal: a healthy TUI
    // repaints continuously mid-turn, so PTY silence = event loop dead — feeds
    // the stall watchdog's fast path (decideClaudeTuiStall.lastPtyDataAt).
    lastPtyDataAt = Date.now();
    if (dbg) {
      try { fs.appendFileSync(ptyLogPath, data); } catch {}
    }
    // Capture stderr-ish bytes (TUI startup errors, "claude: command not
    // found"-style messages) for the final error payload when the run aborts
    // before any JSONL is written. Strip ANSI on the way in — otherwise the
    // raw PTY screen (cursor positions, SGR colours, column-aligned reply
    // rendering) leaks into IM as gibberish like "[3G你把 [8Gsnipe …" when a
    // user hits Stop before the JSONL has flushed any assistant text. Keep
    // the buffer bounded after stripping.
    if (stderrCapture.length < 4096) {
      stderrCapture += stripAnsiEscapes(data);
      if (stderrCapture.length > 4096) stderrCapture = stderrCapture.slice(0, 4096);
      const notice = detectClaudeTuiTerminalLimitNotice(stderrCapture);
      if (notice) markTerminalLimitNotice(notice);
    }
  });

  // 7. Abort handling.
  const abortStream = () => {
    if (interrupted || processExited) return;
    interrupted = true;
    s.stopReason = 'interrupted';
    agentWarn(`[claude-tui] abort requested pid=${proc.pid}`);
    killProc('SIGTERM');
  };
  if (opts.abortSignal?.aborted) abortStream();
  opts.abortSignal?.addEventListener('abort', abortStream, { once: true });

  // 8. Hard deadline timer.
  const hardTimer = setTimeout(() => {
    if (processExited) return;
    timedOut = true;
    s.stopReason = 'timeout';
    agentWarn(`[claude-tui] hard deadline reached (${opts.timeout}s) pid=${proc.pid}`);
    killProc('SIGTERM');
  }, opts.timeout * 1000 + AGENT_STREAM_HARD_KILL_GRACE_MS);

  // 9. Poll loop — hook state + JSONL tail.
  const POLL_INTERVAL_MS = 200;
  // After Stop hook fires we give the JSONL ~600ms to settle (matches the
  // print-mode driver's graceful-abort observation window) so the assistant's
  // final event lands before we SIGTERM.
  const POST_STOP_DRAIN_MS = 600;
  // Fallback Enter — most Claude versions auto-submit a positional prompt in
  // TUI mode, but if UserPromptSubmit hasn't fired by this deadline we type a
  // carriage return into the PTY in case the prompt is sitting on the input
  // line waiting for it.
  const PROMPT_SUBMIT_NUDGE_MS = 1500;
  let promptNudged = false;
  let pollHandle: NodeJS.Timeout | null = null;
  let drainScheduled = false;
  // Wall-clock of the last parsed main-JSONL line. Feeds the stale-Stop
  // quiet-window check in decideClaudeTuiStop — sidecar / hook traffic is
  // deliberately excluded (only main-JSONL activity signals a model segment).
  let lastMainJsonlEventAt = start;
  // Last pending-background count we logged, so the waiting state logs on
  // transitions instead of every 200ms poll tick.
  let lastLoggedPendingBg = -1;
  // Stall-watchdog liveness signals. Together with lastMainJsonlEventAt they
  // answer "is the claude process still doing anything at all?" — see
  // decideClaudeTuiStall for why this exists (claude CLI mid-turn freeze).
  let lastToolEventAt = start;
  let lastSidecarEventAt = 0;
  let stallKilled = false;
  // Stall diagnostics (capture-only) — see writeStallDiag.
  let observedClaudeVersion = '';
  let lastMainJsonlType = '';
  let lastStallDiagHeartbeatAt = 0;
  let stallDiagWentQuiet = false;
  let stallDiagMaxQuietMs = 0;
  let stallDiagPtyAliveWhileQuiet = false;
  /** Last state.stoppedAt for which pendingHookToolIds was reconciled. */
  let lastClearedStopAt = 0;
  /** Hook-reported tools still executing: PreToolUse seen, no PostToolUse. */
  const pendingHookToolIds = new Set<string>();
  // Append-only tool-events log fed by PreToolUse / PostToolUse hooks. We
  // tail it with the same incremental reader the JSONL transcript uses, so
  // tool calls + plan changes surface live during the turn even while the
  // canonical JSONL stays empty (Claude Code 2.x buffers the whole transcript
  // until the Stop hook fires).
  let toolEventsReadOffset = 0;
  const drainToolEvents = (): boolean => {
    if (!fs.existsSync(toolEventsPath)) return false;
    const inc = readJsonlIncrement(toolEventsPath, toolEventsReadOffset);
    toolEventsReadOffset = inc.offset;
    let any = false;
    for (const line of inc.lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed[0] !== '{') continue;
      let ev: any;
      try { ev = JSON.parse(trimmed); } catch { continue; }
      // Stall-watchdog bookkeeping: any hook event is proof of life, and the
      // Pre/Post pairing tells the watchdog whether a tool is mid-execution
      // (which extends the stall threshold — long foreground commands are
      // legitimately silent).
      lastToolEventAt = Date.now();
      const hookToolId = typeof ev?.tool_use_id === 'string' ? ev.tool_use_id : '';
      if (hookToolId) {
        if (ev?.event === 'PreToolUse') pendingHookToolIds.add(hookToolId);
        else if (ev?.event === 'PostToolUse') pendingHookToolIds.delete(hookToolId);
      }
      // A Task PreToolUse and the first sub-agent tool PreToolUse can land in
      // the same tick batch. If the sub-agent's hook arrives before we've
      // discovered its sidecar (and thus before s.subAgentIdToParent knows
      // its agent_id), refresh discovery so the hook resolves its parent on
      // this pass instead of leaking through unattributed.
      const subAgentId = typeof ev?.agent_id === 'string' ? ev.agent_id : '';
      if (subAgentId && !s.subAgentIdToParent?.has(subAgentId)) tryDiscoverSubAgents();
      try { if (applyHookToolEvent(ev, s)) any = true; }
      catch (e: any) { agentWarn(`[claude-tui] hook tool event apply threw: ${e?.message || e}`); }
    }
    return any;
  };

  // Sub-agent (Task tool) tracking. Claude Code does NOT inline sub-agent
  // events into the main JSONL — they go to a sidecar at
  //   ~/.claude/projects/<encoded>/<sessionId>/subagents/agent-<sid>.jsonl
  // with an `agent-<sid>.meta.json` carrying `toolUseId` (the parent's Task
  // tool_use id). Print mode receives the same events on stdout tagged with
  // `parent_tool_use_id` so claudeParse routes them naturally. For TUI mode
  // we have to discover sidecars and tail them in parallel; once located,
  // each event gets a synthetic `parent_tool_use_id` injected so the existing
  // `routeClaudeSubAgentEvent` path in claudeParse populates `sub.model` and
  // `sub.tools` for the dashboard sub-agent card.
  interface SubAgentTail { sidecarPath: string; offset: number; parentToolUseId: string; }
  const trackedSubAgents = new Map<string, SubAgentTail>();
  const tryDiscoverSubAgents = (): void => {
    const sidecarDir = path.join(projectDir, activeSessionId, 'subagents');
    if (!fs.existsSync(sidecarDir)) return;
    let entries: string[];
    try { entries = fs.readdirSync(sidecarDir); } catch { return; }
    for (const name of entries) {
      if (!name.endsWith('.meta.json')) continue;
      const stem = name.slice(0, -'.meta.json'.length);
      if (trackedSubAgents.has(stem)) continue;
      let meta: any;
      try { meta = JSON.parse(fs.readFileSync(path.join(sidecarDir, name), 'utf8')); }
      catch { continue; }
      const parentToolUseId = typeof meta?.toolUseId === 'string' ? meta.toolUseId : '';
      if (!parentToolUseId) continue;
      // Only start tailing once the parent Task tool_use has been registered
      // in s.subAgents — otherwise routeClaudeSubAgentEvent silently drops
      // every event because it can't find the parent.
      if (!s.subAgents.has(parentToolUseId)) continue;
      const sidecarPath = path.join(sidecarDir, `${stem}.jsonl`);
      trackedSubAgents.set(stem, { sidecarPath, offset: 0, parentToolUseId });
      // `stem` is "agent-<id>"; Claude Code's hook payload `agent_id` carries
      // just the raw id. Keep both keys so applyHookToolEvent can attribute
      // sub-agent tool hooks to the parent's Task tool_use no matter which
      // form arrives.
      const rawAgentId = stem.startsWith('agent-') ? stem.slice('agent-'.length) : stem;
      if (!s.subAgentIdToParent) s.subAgentIdToParent = new Map<string, string>();
      s.subAgentIdToParent.set(rawAgentId, parentToolUseId);
      s.subAgentIdToParent.set(stem, parentToolUseId);
      // <task-notification> events identify background tasks by this raw id
      // (and only sometimes carry <tool-use-id>) — keep the mapping so
      // applyClaudeTaskNotification can resolve them either way.
      if (!s.bgTaskIdToToolUse) s.bgTaskIdToToolUse = new Map<string, string>();
      s.bgTaskIdToToolUse.set(rawAgentId, parentToolUseId);
      agentLog(`[claude-tui] subagent sidecar discovered ${stem} parent=${parentToolUseId.slice(0, 14)}`);
    }
  };
  const pumpSubAgentSidecars = (): boolean => {
    let any = false;
    for (const tail of trackedSubAgents.values()) {
      if (!fs.existsSync(tail.sidecarPath)) continue;
      const inc = readJsonlIncrement(tail.sidecarPath, tail.offset);
      tail.offset = inc.offset;
      for (const line of inc.lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed[0] !== '{') continue;
        let ev: any;
        try { ev = JSON.parse(trimmed); } catch { continue; }
        // Inject parent_tool_use_id so claudeParse routes via routeClaudeSubAgentEvent
        // → updates sub.model + sub.tools on the existing s.subAgents entry.
        const injected = { ...ev, parent_tool_use_id: tail.parentToolUseId };
        try { callClaudeParseForTui(injected, s); }
        catch (e: any) { agentWarn(`[claude-tui] subagent parse threw: ${e?.message || e}`); }
        any = true;
      }
    }
    // Stall-watchdog: live sub-agents count as turn progress even while the
    // parent thread is quietly waiting on them.
    if (any) lastSidecarEventAt = Date.now();
    return any;
  };

  const tick = () => {
    pollHandle = null;
    if (processExited) return;

    if (Date.now() > deadline) {
      if (!timedOut) {
        timedOut = true;
        s.stopReason = 'timeout';
        agentWarn(`[claude-tui] deadline exceeded mid-poll`);
        killProc('SIGTERM');
      }
      return;
    }

    // Hook state — pick up real session id / transcript path.
    const state = readHookState(statePath);
    if (state.sessionId && state.sessionId !== activeSessionId) {
      const prevId = activeSessionId;
      activeSessionId = state.sessionId;
      activeJsonlPath = state.transcriptPath || path.join(projectDir, `${activeSessionId}.jsonl`);
      // For forks Claude rotates to a fresh UUID — start reading the new file
      // from offset 0 since we haven't read any of it yet.
      if (!isResume) jsonlReadOffset = 0;
      emitSessionIdUpdate(s, activeSessionId);
      agentLog(`[claude-tui] session id resolved ${prevId} -> ${activeSessionId} transcript=${activeJsonlPath}`);
    } else if (state.transcriptPath && state.transcriptPath !== activeJsonlPath) {
      activeJsonlPath = state.transcriptPath;
    }

    // Submit nudge — only if UserPromptSubmit hook hasn't fired yet.
    if (!promptNudged && !state.promptSubmittedAt && Date.now() - start > PROMPT_SUBMIT_NUDGE_MS) {
      promptNudged = true;
      try { proc.write('\r'); } catch {}
      agentLog(`[claude-tui] prompt-submit nudge sent (no UserPromptSubmit after ${PROMPT_SUBMIT_NUDGE_MS}ms)`);
    }

    // JSONL tail.
    if (fs.existsSync(activeJsonlPath)) {
      const inc = readJsonlIncrement(activeJsonlPath, jsonlReadOffset);
      jsonlReadOffset = inc.offset;
      let touched = false;
      for (const line of inc.lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed[0] !== '{') continue;
        lineCount++;
        let ev: any;
        try { ev = JSON.parse(trimmed); } catch { continue; }
        // Ignore sub-agent sidecar events — they belong to a child agent's
        // stream and would re-enter the parent's accumulator. claudeParse's
        // own sub-agent routing handles them.
        const isSubAgentEvent = typeof ev.parent_tool_use_id === 'string' && ev.parent_tool_use_id;
        if (!isSubAgentEvent && ev.type === 'assistant') {
          const notice = detectClaudeTuiTerminalLimitNotice(ev.message);
          if (notice) {
            markTerminalLimitNotice(notice);
            touched = true;
            continue;
          }
          applyAssistantStreaming(s, ev.message, streamBuf);
          applyAssistantUsage(s, ev.message);
          if (ev.message?.model && ev.message.model !== '<synthetic>' && typeof ev.message.model === 'string') {
            s.model = ev.message.model;
            applyModelContextWindow(s);
          }
        }
        try { callClaudeParseForTui(ev, s); } catch (e: any) {
          agentWarn(`[claude-tui] claudeParse threw on line: ${e?.message || e}`);
        }
        touched = true;
        lastMainJsonlEventAt = Date.now();
        if (typeof ev.version === 'string' && ev.version) observedClaudeVersion = ev.version;
        if (!isSubAgentEvent) lastMainJsonlType = classifyClaudeJsonlEvent(ev);
      }
      if (touched) {
        // Emit immediately so non-text changes (tool_use, plan, activity,
        // thinking, usage) reach the dashboard without waiting for the
        // chunked stream tick. The streaming timer separately advances
        // s.text from the buffer over the next few ticks.
        emit();
        scheduleStreamTick();
      }
    }

    // Live tool-events stream — fed by Pre/PostToolUse hooks.  Order matters:
    // we drain hooks BEFORE the JSONL tail above already ran so any hook
    // events that beat their JSONL counterpart are recorded in
    // seenClaudeToolIds first; subsequent JSONL pass deduplicates naturally.
    // In practice JSONL doesn't land until Stop, so this is the only signal
    // that fires during a normal turn.
    if (drainToolEvents()) emit();

    // Sub-agent sidecar discovery + pump. Order matters: discovery first so a
    // newly-spawned sub-agent gets registered for tailing this same tick if
    // its events have already been written.
    tryDiscoverSubAgents();
    if (pumpSubAgentSidecars()) emit();

    // Stop hook handling. A Stop is NOT automatically the end of the turn:
    // Claude fires it per response segment, including the segment that merely
    // *launched* run_in_background agents. Those agents run inside the claude
    // process — terminating here would destroy them (the "进程退出把子代理
    // 打断" incident). Hold the PTY open until every launched background agent
    // has reported its <task-notification> AND the latest Stop is fresher than
    // the latest notification (i.e. the model's wrap-up segment finished).
    if (state.stoppedAt && !stopHookFired) {
      // A fired Stop means no foreground tool is genuinely mid-flight any
      // more. Surviving entries in pendingHookToolIds are lost PostToolUse
      // hook events (MCP flap / hook timeout ate them) — clearing here stops
      // them from silently pushing the stall watchdog onto the 30-minute
      // pending-tool threshold for the rest of the turn.
      if (state.stoppedAt !== lastClearedStopAt) {
        lastClearedStopAt = state.stoppedAt;
        if (pendingHookToolIds.size) {
          agentWarn(`[claude-tui] Stop fired with ${pendingHookToolIds.size} unmatched PreToolUse event(s) — clearing (lost PostToolUse hooks)`);
          pendingHookToolIds.clear();
        }
      }
      const pendingBg = pendingClaudeBackgroundAgentCount(s);
      const decision = decideClaudeTuiStop({
        stoppedAt: state.stoppedAt,
        pendingBackgroundAgents: pendingBg,
        lastTaskNotificationAt: s.lastTaskNotificationAt || 0,
        lastJsonlEventAt: lastMainJsonlEventAt,
        lastHookOrSidecarEventAt: Math.max(lastToolEventAt, lastSidecarEventAt),
        // Background *Bash* is silent by nature (no sidecar/hook traffic while
        // it runs) — give it the long pending-tool budget; agent-only holds
        // keep the default TTL (live agents emit sidecar events constantly).
        holdQuietTtlMs: pendingClaudeBackgroundBashCount(s) > 0
          ? CLAUDE_TUI_STALL_PENDING_TOOL_MS
          : undefined,
        now: Date.now(),
      });
      if (decision === 'terminate') {
        stopHookFired = true;
        stopHookSeenAt = Date.now();
        if (pendingBg > 0) {
          // 幽灵 hold 释放:计数说还有后台 agent,但所有通道静默已超 TTL。
          agentWarn(`[claude-tui] releasing phantom hold — ${pendingBg} background agent(s) still counted pending but every channel quiet past TTL; treating Stop as final`);
        }
        agentLog(`[claude-tui] Stop hook fired — draining JSONL for ${POST_STOP_DRAIN_MS}ms before SIGTERM`);
      } else if (decision === 'hold-background' && pendingBg !== lastLoggedPendingBg) {
        lastLoggedPendingBg = pendingBg;
        agentLog(`[claude-tui] Stop hook fired with ${pendingBg} background agent(s) still running — holding TUI alive until they finish`);
        pushRecentActivity(s.recentActivity, `Waiting for ${pendingBg} background agent(s) to finish`);
        s.activity = s.recentActivity.join('\n');
        emit();
      }
    }
    if (stopHookFired && !drainScheduled && Date.now() - stopHookSeenAt >= POST_STOP_DRAIN_MS) {
      drainScheduled = true;
      agentLog(`[claude-tui] drain complete, terminating TUI pid=${proc.pid}`);
      killProc('SIGTERM');
      // Continue polling so any post-Stop JSONL writes still get parsed; the
      // process will exit shortly and onExit will resolve the wait.
    }

    // Stall watchdog. claude CLI can freeze mid-turn (observed on 2.1.160):
    // a tool_result lands, then the next assistant segment never starts — the
    // process stays alive, every signal goes quiet, no Stop hook ever fires.
    // When ALL liveness signals have been silent past the threshold, declare
    // the turn stalled and SIGTERM; doClaudeWithRetry auto-resumes the session
    // once so the turn continues instead of spinning forever in the IM card.
    if (!stopHookFired && !timedOut && !interrupted && !stallKilled) {
      const lastProgressAt = Math.max(
        start, lastMainJsonlEventAt, lastToolEventAt, lastSidecarEventAt,
        state.stoppedAt || 0, state.promptSubmittedAt || 0,
      );
      // Pending background work (agents + bash) extends the stall budget the
      // same way a pending foreground tool does: a silent 15-minute background
      // build must not get shot by the 10-minute quiet threshold. The PTY
      // fast path still catches true process freezes within minutes.
      const pendingBgForStall = pendingClaudeBackgroundAgentCount(s);
      // PTY fast path is for *mid-turn* freezes only. While the TUI idles in a
      // post-Stop background hold it legitimately paints nothing — a static
      // screen there is healthy, not frozen. Stop being the freshest signal is
      // exactly that hold state → disarm the fast path (0 = unavailable).
      const nonStopProgressAt = Math.max(
        start, lastMainJsonlEventAt, lastToolEventAt, lastSidecarEventAt,
        state.promptSubmittedAt || 0,
      );
      const inPostStopHold = !!state.stoppedAt && state.stoppedAt >= nonStopProgressAt;
      // Stall diagnostics: sample the quiet lead-up so the watchdog can later be
      // tuned from data. Capture-only — changes no control flow.
      {
        const nowMs = Date.now();
        const quietMs = nowMs - lastProgressAt;
        if (quietMs >= STALL_DIAG_QUIET_THRESHOLD_MS && !inPostStopHold) {
          const ptyQuietMs = nowMs - lastPtyDataAt;
          stallDiagWentQuiet = true;
          if (quietMs > stallDiagMaxQuietMs) stallDiagMaxQuietMs = quietMs;
          // PTY still painting while every structured signal is silent = the
          // frozen-stream-behind-a-live-spinner case that defeats the fast path.
          if (ptyQuietMs < CLAUDE_TUI_STALL_PTY_DEAD_MS) stallDiagPtyAliveWhileQuiet = true;
          if (nowMs - lastStallDiagHeartbeatAt >= STALL_DIAG_HEARTBEAT_INTERVAL_MS) {
            lastStallDiagHeartbeatAt = nowMs;
            writeStallDiag({
              kind: 'quiet',
              sessionId: activeSessionId,
              version: observedClaudeVersion,
              model: s.model || null,
              elapsedTurnMs: nowMs - start,
              quietMs,
              ptyQuietMs,
              lastJsonlType: lastMainJsonlType,
              mainJsonlAgoMs: nowMs - lastMainJsonlEventAt,
              toolEventAgoMs: nowMs - lastToolEventAt,
              sidecarAgoMs: lastSidecarEventAt ? nowMs - lastSidecarEventAt : null,
              pendingHookTools: pendingHookToolIds.size,
              pendingBgAgents: pendingBgForStall,
              pendingBgBash: pendingClaudeBackgroundBashCount(s),
            });
          }
        }
      }
      const stallDecision = decideClaudeTuiStall({
        now: Date.now(),
        lastProgressAt,
        pendingToolCount: pendingHookToolIds.size + pendingBgForStall,
        lastPtyDataAt: inPostStopHold ? 0 : lastPtyDataAt,
      });
      if (stallDecision === 'stall') {
        stallKilled = true;
        const quietMin = Math.round((Date.now() - lastProgressAt) / 60_000);
        const ptyQuietS = Math.round((Date.now() - lastPtyDataAt) / 1000);
        s.stopReason = 'stalled';
        writeStallDiag({
          kind: 'stall',
          sessionId: activeSessionId,
          version: observedClaudeVersion,
          model: s.model || null,
          elapsedTurnMs: Date.now() - start,
          quietMs: Date.now() - lastProgressAt,
          ptyQuietMs: Date.now() - lastPtyDataAt,
          // True ⇒ the freeze kept the PTY painting, so this stall came via the
          // slow quiet threshold, not the 3-min PTY-dead fast path.
          ptyAliveWhileQuiet: stallDiagPtyAliveWhileQuiet,
          lastJsonlType: lastMainJsonlType,
          pendingHookTools: pendingHookToolIds.size,
          pendingBgAgents: pendingBgForStall,
        });
        if (!s.errors) {
          s.errors = [`Claude process went silent mid-turn for ${quietMin}m (no JSONL, hook, or sub-agent events; PTY quiet ${ptyQuietS}s) — known claude CLI freeze. Terminated for auto-resume.`];
        }
        agentWarn(`[claude-tui] stall detected: no progress for ${quietMin}m (pendingTools=${pendingHookToolIds.size}, ptyQuiet=${ptyQuietS}s) — terminating TUI pid=${proc.pid} for auto-resume`);
        pushRecentActivity(s.recentActivity, `Agent stalled (${quietMin}m silent) — restarting turn`);
        s.activity = s.recentActivity.join('\n');
        emit();
        killProc('SIGTERM');
        // Keep polling: onExit resolves the wait and the final drains pick up
        // whatever the dying process flushes.
      }
    }

    pollHandle = setTimeout(tick, POLL_INTERVAL_MS);
  };
  pollHandle = setTimeout(tick, POLL_INTERVAL_MS);

  // 10. Wait for process exit.
  await new Promise<void>(resolve => {
    proc.onExit(({ exitCode: code, signal }) => {
      processExited = true;
      exitCode = code;
      exitSignal = typeof signal === 'number' ? signal : null;
      if (pollHandle) { clearTimeout(pollHandle); pollHandle = null; }
      clearTimeout(hardTimer);
      agentLog(`[claude-tui] exit code=${code} signal=${signal ?? '-'} lines=${lineCount}`);
      resolve();
    });
  });
  opts.abortSignal?.removeEventListener('abort', abortStream);

  // 11. Final drain — pick up anything written between the last poll and
  // process exit. Claude flushes its remaining JSONL events on shutdown.
  if (fs.existsSync(activeJsonlPath)) {
    const inc = readJsonlIncrement(activeJsonlPath, jsonlReadOffset);
    jsonlReadOffset = inc.offset;
    let touched = false;
    for (const line of inc.lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed[0] !== '{') continue;
      lineCount++;
      let ev: any;
      try { ev = JSON.parse(trimmed); } catch { continue; }
      const isSubAgentEvent = typeof ev.parent_tool_use_id === 'string' && ev.parent_tool_use_id;
      if (!isSubAgentEvent && ev.type === 'assistant') {
        const notice = detectClaudeTuiTerminalLimitNotice(ev.message);
        if (notice) {
          markTerminalLimitNotice(notice);
          touched = true;
          continue;
        }
        applyAssistantStreaming(s, ev.message, streamBuf);
        applyAssistantUsage(s, ev.message);
        if (ev.message?.model && ev.message.model !== '<synthetic>' && typeof ev.message.model === 'string') {
          s.model = ev.message.model;
          applyModelContextWindow(s);
        }
      }
      try { callClaudeParseForTui(ev, s); } catch {}
      touched = true;
    }
    if (touched) emit();
  }
  // Final tool-events drain — any PreToolUse / PostToolUse hooks that fired
  // between the last poll tick and process exit.
  if (drainToolEvents()) emit();
  // Final sub-agent drain. The sub-agent's last events (closing tool_results)
  // may have landed after our last poll tick; mirror the main JSONL drain to
  // make sure sub.tools / sub.status carry the complete picture into the
  // final result.
  tryDiscoverSubAgents();
  if (pumpSubAgentSidecars()) emit();
  // Process has exited and final drain is done — promote whatever is left in
  // the stream buffer into `s.text` so the final result message carries the
  // complete reply (not a truncated mid-stream prefix).
  flushStream();

  // 12. Cleanup temp dir. Keep it around when debugging so users can inspect
  // the captured PTY bytes + state file.
  if (!dbg) {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
  } else {
    agentLog(`[claude-tui] debug artifacts retained in ${workDir}`);
  }

  // 13. Build the StreamResult — mirror the shape and semantics of
  // doClaudeInteractiveStream so downstream consumers (finalizeStreamResult,
  // dashboard rendering) cannot tell the two paths apart.
  const cleanStderr = stderrCapture.trim();
  // Detect Claude Code's synthetic "API Error: …" assistant reply (e.g.
  // 529 Overloaded). The text gets rewritten so the IM card doesn't surface
  // the raw "API Error: Overloaded" string to the user, and stopReason is
  // upgraded so the ClaudeDriver retry wrapper can decide to re-issue the
  // turn rather than letting the synthetic failure stick.
  const apiErrorReason = detectClaudeApiError(s.text);
  if (apiErrorReason) {
    agentWarn(`[claude-tui] upstream API error detected: ${apiErrorReason}`);
    s.stopReason = 'api_error';
    s.text = '';
    if (!s.errors) s.errors = [`Anthropic API error: ${apiErrorReason}`];
  }
  const errorText = joinErrorMessages(s.errors);
  // "ok" requires: process exited cleanly (or via our own SIGTERM after Stop
  // hook fired, which yields a non-zero exit), no errors from the parser, no
  // user abort, no timeout. SIGTERM-after-Stop is the normal happy path.
  const exitedViaStopHook = stopHookFired && !timedOut && !interrupted;
  const procOk = (exitCode === 0) || exitedViaStopHook;
  const ok = procOk && !s.errors && !timedOut && !interrupted && stopHookFired;
  const error = errorText
    || (interrupted ? 'Interrupted by user.' : null)
    || (timedOut ? `Timed out after ${opts.timeout}s before the agent reported completion.` : null)
    || (!stopHookFired
      ? (cleanStderr
        || `Claude TUI exited (code=${exitCode}, signal=${exitSignal ?? '-'}) without completing the turn.`)
      : null);
  const incomplete = !ok || s.stopReason === 'max_tokens' || s.stopReason === 'timeout';
  const elapsedS = (Date.now() - start) / 1000;
  agentLog(`[claude-tui] result ok=${ok} elapsed=${elapsedS.toFixed(1)}s text=${s.text.length}ch thinking=${s.thinking.length}ch session=${s.sessionId || '?'} stop=${stopHookFired}`);

  // Stall diagnostics: a turn that went quiet has now ended. Recording the
  // outcome separates benign long-thinking/long-tool (completed) from true
  // freezes the watchdog had to kill (stalled-killed) — the calibration the
  // threshold tuning needs.
  if (stallDiagWentQuiet) {
    writeStallDiag({
      kind: 'resolved',
      sessionId: activeSessionId,
      version: observedClaudeVersion,
      model: s.model || null,
      elapsedTurnMs: Date.now() - start,
      maxQuietMs: stallDiagMaxQuietMs,
      ptyAliveWhileQuiet: stallDiagPtyAliveWhileQuiet,
      lastJsonlType: lastMainJsonlType,
      outcome: stallKilled ? 'stalled-killed'
        : interrupted ? 'interrupted'
        : timedOut ? 'timeout'
        : stopHookFired ? 'completed'
        : 'exited-no-stop',
      stopReason: s.stopReason || null,
      ok,
    });
  }

  // Build the message body. Order:
  //   1. Any assistant text captured from JSONL (the canonical reply).
  //   2. Parser-surfaced errors.
  //   3. For interrupted runs with no text yet, a clear status — never the
  //      raw PTY scrape (it would be a half-rendered TUI screen with no value
  //      to the user, and pre-ANSI-strip used to render as garbled gibberish
  //      in IM).
  //   4. Fall back to ANSI-stripped stderrCapture for genuine startup
  //      failures like "claude: command not found".
  const messageBody = s.text.trim()
    || errorText
    || (interrupted ? '(Interrupted before any reply landed.)'
        : procOk ? '(no textual response)'
        : `Failed (exit=${exitCode}).\n\n${cleanStderr || '(no output)'}`);

  return {
    ok,
    sessionId: s.sessionId,
    workspacePath: null,
    model: s.model,
    thinkingEffort: s.thinkingEffort,
    message: messageBody,
    thinking: s.thinking.trim() || null,
    elapsedS,
    inputTokens: s.inputTokens,
    outputTokens: s.outputTokens,
    cachedInputTokens: s.cachedInputTokens,
    cacheCreationInputTokens: s.cacheCreationInputTokens,
    contextWindow: s.contextWindow,
    contextUsedTokens: s.contextUsedTokens,
    contextPercent: computeContext(s).contextPercent,
    codexCumulative: null,
    error,
    plan: s.plan,
    stopReason: s.stopReason,
    incomplete,
    activity: s.activity.trim() || null,
  };
}

function makeErrorResult(opts: StreamOpts, start: number, message: string): StreamResult {
  return {
    ok: false,
    sessionId: opts.sessionId,
    workspacePath: null,
    model: opts.model,
    thinkingEffort: opts.thinkingEffort,
    message,
    thinking: null,
    elapsedS: (Date.now() - start) / 1000,
    inputTokens: null,
    outputTokens: null,
    cachedInputTokens: null,
    cacheCreationInputTokens: null,
    contextWindow: null,
    contextUsedTokens: null,
    contextPercent: null,
    codexCumulative: null,
    error: message,
    plan: null,
    stopReason: null,
    incomplete: true,
    activity: null,
  };
}
