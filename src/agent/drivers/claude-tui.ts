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
  detectClaudeApiError, detectClaudeModelError, claudeModelErrorMessage,
} from '../utils.js';
import { encodePathAsDirName, getHome, whichSync } from '../../core/platform.js';
import { createRetainedLogSink } from '../../core/logging.js';
import { stripAnsiEscapes } from '../../core/utils.js';
import {
  AGENT_STREAM_HARD_KILL_GRACE_MS,
  CLAUDE_TUI_STALL_QUIET_MS, CLAUDE_TUI_STALL_PENDING_TOOL_MS,
  CLAUDE_TUI_STALL_PTY_DEAD_MS, CLAUDE_TUI_STOP_HOLD_QUIET_TTL_MS,
  CLAUDE_TUI_MODEL_ERROR_SETTLE_MS,
} from '../../core/constants.js';
import {
  claudeParse, createClaudeStreamState,
  claudeContextWindowFromModel, claudeEffectiveContextWindow,
  registerClaudeBackgroundAgentLaunch, pendingClaudeBackgroundAgentCount,
  registerClaudeBackgroundBashLaunch, pendingClaudeBackgroundBashCount,
  extractClaudeBackgroundTaskId, extractClaudeWorkflowRunId,
  claudeEffortAndWorkflowArgs, scrubClaudeSessionContextEnv,
} from './claude.js';

const STALL_DIAG_QUIET_THRESHOLD_MS = 45_000;
const STALL_DIAG_HEARTBEAT_INTERVAL_MS = 30_000;

let stallDiagSink: ((chunk: string) => void) | null | undefined;
function writeStallDiag(record: Record<string, unknown>): void {
  if (stallDiagSink === null) return;
  try {
    if (stallDiagSink === undefined) {
      const file = path.join(getHome(), '.pikiloom', 'diagnostics', 'claude-tui-stall.jsonl');
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
  const specifier = 'node-pty';
  const mod: any = await import(/* @vite-ignore */ specifier);
  const api = mod?.default ?? mod;
  if (!api?.spawn) throw new Error('node-pty loaded but spawn() is missing');
  await preflightSpawnHelper();
  return api as PtyModule;
}

let spawnHelperPreflightDone = false;
async function preflightSpawnHelper(): Promise<void> {
  if (spawnHelperPreflightDone || process.platform === 'win32') {
    spawnHelperPreflightDone = true;
    return;
  }
  spawnHelperPreflightDone = true;
  try {
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
      segments.pop();
      return { offset: stat.size, lines: segments };
    }
    const lastLine = segments.pop() || '';
    const consumed = stat.size - Buffer.byteLength(lastLine, 'utf8');
    return { offset: consumed, lines: segments };
  } catch { return { offset: fromOffset, lines: [] }; }
}

interface TuiStreamBuffer {
  trueText: string;
  displayedLen: number;
  timer: NodeJS.Timeout | null;
}

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

export function resolveClaudeTuiLimitOutcome(input: {
  noticeText: string | null;
  noticeAt: number;
  lastSubstantiveEventAt: number;
  hasOutputText: boolean;
}): 'none' | 'info' | 'fatal' {
  if (!input.noticeText) return 'none';
  if (input.hasOutputText || input.lastSubstantiveEventAt > input.noticeAt) return 'info';
  return 'fatal';
}

export function detectClaudeBypassPrompt(screen: any): boolean {
  if (typeof screen !== 'string' || !screen) return false;
  const t = stripAnsiEscapes(screen).replace(/\s+/g, '').toLowerCase();
  return t.includes('bypasspermissionsmode')
    && t.includes('yes,iaccept')
    && t.includes('no,exit');
}

export function detectClaudeProceedPrompt(screen: any): boolean {
  return classifyClaudeScreen(screen).state === 'confirm-prompt';
}

export type ClaudeScreenState =
  | 'confirm-prompt'
  | 'plan-approval'
  | 'bypass-startup'
  | 'idle-repl'
  | 'model-error'
  | 'unknown';

export interface ClaudeScreenInfo {
  state: ClaudeScreenState;
  affirmativeKey: string | null;
  sample: string;
}

/**
 * Read what determinate state Claude's TUI is in from a slice of (ANSI-stripped) PTY screen
 * output. This is the single source of truth consumed by BOTH the in-flight auto-answer (onData)
 * and the stall watchdog: when a turn goes quiet we cannot tell from timing alone whether the TUI
 * is (a) frozen mid-turn (the known CLI freeze — PTY dead), (b) thinking for a long time (PTY
 * repaints a spinner), (c) blocked on an interactive confirm bypass mode does NOT suppress
 * (ask-rule "Do you want to proceed?", trust-a-new-folder), (d) sitting back at the idle REPL
 * (turn finished but the Stop hook was missed/held), or (e) showing a model-unavailable banner.
 *
 * Keys on STRUCTURAL invariants, not exact footers — Claude lays words out with cursor-move
 * escapes so the despaced screen runs together ("doyouwanttoproceed"), and footers TRUNCATE at the
 * 200-col edge ("Esc to cancel" → "sctocancel"). So the footer is corroborating, never required;
 * the load-bearing signals are the cursor'd numbered select (`❯`+`1.`) plus the proceed/confirm
 * question, and the persistent idle mode-line. Robust to claude version churn for the same reason.
 *
 * Default-deny: anything not high-confidence returns 'unknown', because mislabelling a real freeze
 * as a clearable/idle state would convert a self-healing stall (auto-resume) into a silently
 * dropped turn — ambiguity must bias to the freeze path.
 */
export function classifyClaudeScreen(screen: any): ClaudeScreenInfo {
  if (typeof screen !== 'string' || !screen) return { state: 'unknown', affirmativeKey: null, sample: '' };
  const stripped = stripAnsiEscapes(screen);
  const sample = stripped.replace(/\s+/g, ' ').trim().slice(-400);
  const ds = stripped.replace(/\s+/g, '').toLowerCase();

  if (ds.includes('bypasspermissionsmode') && ds.includes('yes,iaccept') && ds.includes('no,exit')) {
    return { state: 'bypass-startup', affirmativeKey: '2', sample };
  }

  if (detectClaudeModelError(ds)) return { state: 'model-error', affirmativeKey: null, sample };

  const asksProceed = ds.includes('doyouwanttoproceed') || ds.includes('wouldyouliketoproceed');
  const hasCursorSelect = ds.includes('❯') && ds.includes('1.');

  if ((asksProceed || ds.includes('readytoexecute'))
      && (ds.includes('manuallyapproveedits') || ds.includes('yes,andbypasspermissions'))) {
    return { state: 'plan-approval', affirmativeKey: null, sample };
  }

  if ((asksProceed || ds.includes('requiresconfirmation')) && hasCursorSelect) {
    return { state: 'confirm-prompt', affirmativeKey: '1', sample };
  }
  if (ds.includes('trustthisfolder')) return { state: 'confirm-prompt', affirmativeKey: '1', sample };
  if ((asksProceed || ds.includes('doyouwant')) && ds.includes('(y/n)')) {
    return { state: 'confirm-prompt', affirmativeKey: 'y', sample };
  }

  if (ds.includes('bypasspermissionson')
      && (ds.includes('shift+tabtocycle') || ds.includes('foragents') || ds.includes('tomanage'))
      && !ds.includes('esctointerrupt')) {
    return { state: 'idle-repl', affirmativeKey: null, sample };
  }

  return { state: 'unknown', affirmativeKey: null, sample };
}

export function classifyStallScreen(screen: any): { looksLikePrompt: boolean; sample: string } {
  const info = classifyClaudeScreen(screen);
  const looksLikePrompt = info.state === 'confirm-prompt'
    || info.state === 'plan-approval' || info.state === 'bypass-startup';
  return { looksLikePrompt, sample: info.sample };
}

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

export function applyHookToolEvent(ev: any, s: any): boolean {
  const toolUseId = String(ev?.tool_use_id || '').trim();
  const toolName = String(ev?.tool_name || '').trim();
  if (!toolName || !toolUseId) return false;

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
      if (input.run_in_background === true) registerClaudeBackgroundAgentLaunch(s, toolUseId);
      s.seenClaudeToolIds.add(toolUseId);
      s.claudeToolsById.set(toolUseId, { name: toolName, summary: desc || kind || 'Sub-agent' });
      return true;
    }
    if (toolName === 'Bash' && ev.tool_input?.run_in_background === true) {
      registerClaudeBackgroundBashLaunch(s, toolUseId);
    }
    if (toolName === 'Workflow') {
      registerClaudeBackgroundAgentLaunch(s, toolUseId);
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
    if (toolName === 'Bash' && s.bgBashToolUseIds?.has(toolUseId)
        && !s.bgAgentCompletedToolUseIds?.has(toolUseId)) {
      const taskId = extractClaudeBackgroundTaskId(ev.tool_response);
      if (taskId && !s.bgTaskIdToToolUse.has(taskId)) s.bgTaskIdToToolUse.set(taskId, toolUseId);
    }
    if (toolName === 'Workflow' && s.bgAgentLaunchedToolUseIds?.has(toolUseId)
        && !s.bgAgentCompletedToolUseIds?.has(toolUseId)) {
      const runId = extractClaudeWorkflowRunId(ev.tool_response);
      if (runId && !s.bgTaskIdToToolUse.has(runId)) s.bgTaskIdToToolUse.set(runId, toolUseId);
    }
    s.seenClaudeToolResultIds.add(toolUseId);
    return true;
  }

  return false;
}

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

function applyModelContextWindow(s: any): void {
  if (s.byokContextWindow) return;
  const advertised = claudeContextWindowFromModel(s.model);
  const effective = claudeEffectiveContextWindow(advertised);
  if (effective != null) s.contextWindow = effective;
}

function applyAssistantUsage(s: any, msg: any): void {
  const u = msg?.usage;
  if (!u || typeof u !== 'object') return;
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

const BG_RESETTLE_QUIET_MS = 30_000;

export type ClaudeTuiStopDecision = 'terminate' | 'hold-background' | 'hold-resettle';

export function decideClaudeTuiStop(input: {
  stoppedAt: number;
  pendingBackgroundAgents: number;
  lastTaskNotificationAt: number;
  lastJsonlEventAt: number;
  now: number;
  resettleQuietMs?: number;
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
    if (input.now - lastActivityAt > ttl) return 'terminate';
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

export type ClaudeTuiStallDecision = 'wait' | 'stall';

export function isAskUserToolName(name: unknown): boolean {
  if (typeof name !== 'string' || !name) return false;
  return name === 'im_ask_user' || name.endsWith('__im_ask_user');
}

export function decideClaudeTuiStall(input: {
  now: number;
  lastProgressAt: number;
  pendingToolCount: number;
  awaitingUserReply?: boolean;
  quietMs?: number;
  pendingToolMs?: number;
  lastPtyDataAt?: number;
  ptyDeadMs?: number;
}): ClaudeTuiStallDecision {
  if (input.awaitingUserReply) return 'wait';
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

export type ClaudeStallAction =
  | 'answer-retry'
  | 'terminate-clean'
  | 'terminate-prompt-unanswered'
  | 'model-error'
  | 'terminate-stalled';

export function decideStallAction(input: {
  state: ClaudeScreenState;
  affirmativeKey: string | null;
  pendingBgAgents: number;
  alreadyTriedAnswer: boolean;
}): ClaudeStallAction {
  if (input.state === 'model-error') return 'model-error';
  if (input.state === 'confirm-prompt' || input.state === 'plan-approval' || input.state === 'bypass-startup') {
    if (input.affirmativeKey && !input.alreadyTriedAnswer) return 'answer-retry';
    return 'terminate-prompt-unanswered';
  }
  if (input.state === 'idle-repl') {
    return input.pendingBgAgents > 0 ? 'terminate-stalled' : 'terminate-clean';
  }
  return 'terminate-stalled';
}

export async function doClaudeTuiStream(opts: StreamOpts): Promise<StreamResult> {
  const start = Date.now();
  const deadline = start + opts.timeout * 1000;

  const pty: PtyModule = await loadPty();

  const isFork = !!opts.forkOf;
  const isResume = !isFork && !!opts.sessionId;
  const newSessionId = (isFork || !isResume) ? randomUUID() : opts.sessionId!;

  const home = getHome();
  const projectDir = path.join(home, '.claude', 'projects', encodePathAsDirName(opts.workdir));
  let activeSessionId = isResume ? opts.sessionId! : newSessionId;
  let activeJsonlPath = path.join(projectDir, `${activeSessionId}.jsonl`);
  let jsonlReadOffset = 0;
  if (isResume) {
    try { jsonlReadOffset = fs.statSync(activeJsonlPath).size; } catch {}
  }

  let workDir: string;
  try {
    workDir = fs.mkdtempSync(path.join(tmpdir(), 'pikiloom-claude-tui-'));
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
    const nodeBin = Q(process.execPath);
    const hookCmd = (event: string) => `${nodeBin} ${Q(hookPath)} ${event} ${Q(statePath)} ${Q(toolEventsPath)}`;
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
  claudeArgs.push(...claudeEffortAndWorkflowArgs(opts));
  if (opts.claudeAppendSystemPrompt) claudeArgs.push('--append-system-prompt', opts.claudeAppendSystemPrompt);
  if (opts.mcpConfigPath) claudeArgs.push('--mcp-config', opts.mcpConfigPath);
  if (opts.claudeExtraArgs?.length) claudeArgs.push(...opts.claudeExtraArgs);

  let fullPrompt = opts.prompt;
  if (opts.attachments?.length) {
    const refs = opts.attachments.map(p => `@${p}`).join(' ');
    fullPrompt = `${refs}\n\n${opts.prompt}`;
  }
  claudeArgs.push('--', fullPrompt);

  try {
    opts.onSteerReady?.(async () => {
      agentWarn('[claude-tui] steer requested but TUI mode does not support mid-turn input — ignored');
      return false;
    });
  } catch (e: any) {
    agentWarn(`[claude-tui] onSteerReady callback raised: ${e?.message || e}`);
  }

  const s: any = createClaudeStreamState(opts);
  if (isResume || isFork) s.sessionId = activeSessionId;
  if (!s.model && (opts.claudeModel || opts.model)) {
    s.model = opts.claudeModel || opts.model;
  }
  applyModelContextWindow(s);
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
  let terminalLimitNoticeAt = 0;
  let terminalModelError: string | null = null;
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

  const sendConfirmAnswer = (key: string, settleMs: number, confirmDelayMs: number, onConfirmed?: () => void): void => {
    setTimeout(() => {
      if (processExited) return;
      try { proc.write(key); } catch {}
      setTimeout(() => {
        if (processExited) return;
        try { proc.write('\r'); } catch {}
        screenTail = '';
        onConfirmed?.();
      }, confirmDelayMs);
    }, settleMs);
  };

  const noteTerminalLimitNotice = (notice: string): void => {
    if (terminalLimitNotice) return;
    terminalLimitNotice = notice;
    terminalLimitNoticeAt = Date.now();
    agentWarn(`[claude-tui] limit notice observed (watching turn liveness): ${notice}`);
    pushRecentActivity(s.recentActivity, `Claude usage notice: ${notice}`);
    s.activity = s.recentActivity.join('\n');
    emit();
  };

  const noteTerminalModelError = (notice: string): void => {
    if (terminalModelError) return;
    terminalModelError = notice;
    agentWarn(`[claude-tui] model unavailable observed (settling before terminate): ${notice}`);
    pushRecentActivity(s.recentActivity, notice);
    s.activity = s.recentActivity.join('\n');
    emit();
    setTimeout(() => {
      if (processExited || interrupted) return;
      const hadOutput = !!s.text.trim()
        || lastAssistantEventAt > 0 || lastSidecarEventAt > 0 || lastToolEventAt > start;
      if (hadOutput) {
        agentWarn('[claude-tui] model-unavailable banner was followed by real output — not terminating');
        return;
      }
      agentWarn('[claude-tui] model unavailable confirmed (no JSONL/tool/Stop activity) — terminating turn');
      killProc('SIGTERM');
    }, CLAUDE_TUI_MODEL_ERROR_SETTLE_MS);
  };

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

  const spawnEnv: { [key: string]: string } = { TERM: 'xterm-256color' };
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') spawnEnv[k] = v;
  }
  for (const [k, v] of Object.entries(opts.extraEnv || {})) {
    if (typeof v === 'string') spawnEnv[k] = v;
  }
  scrubClaudeSessionContextEnv(spawnEnv);
  if (process.env.PIKILOOM_CLAUDE_TUI_KEEP_API_KEY !== '1') {
    delete spawnEnv.ANTHROPIC_API_KEY;
    delete spawnEnv.ANTHROPIC_AUTH_TOKEN;
  }

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
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
    throw new Error(`pty.spawn failed (bin=${claudeBin}): ${e?.message || e}`);
  }
  agentLog(`[claude-tui] pid=${proc.pid}`);

  const dbg = process.env.PIKILOOM_CLAUDE_TUI_DEBUG === '1';
  let lastPtyDataAt = Date.now();
  const SCREEN_TAIL_MAX = 8192;
  const BYPASS_ACCEPT_MAX_ATTEMPTS = 3;
  const BYPASS_SETTLE_MS = 500;
  const BYPASS_CONFIRM_DELAY_MS = 600;
  const BYPASS_DIALOG_ACTIVE_WINDOW_MS = 2000;
  const PROCEED_SETTLE_MS = 500;
  const PROCEED_CONFIRM_DELAY_MS = 600;
  const PROCEED_REARM_MS = 1000;
  const PROCEED_ANSWER_MAX = 40;
  let screenTail = '';
  let bypassPromptLastSeenAt = 0;
  let bypassAcceptAttempts = 0;
  let bypassPhase: 'idle' | 'armed' | 'confirmed' = 'idle';
  let proceedAnswerCount = 0;
  let proceedPhase: 'idle' | 'armed' = 'idle';
  proc.onData((data: string) => {
    lastPtyDataAt = Date.now();
    if (dbg) {
      try { fs.appendFileSync(ptyLogPath, data); } catch {}
    }
    screenTail = (screenTail + stripAnsiEscapes(data)).slice(-SCREEN_TAIL_MAX);
    if (detectClaudeBypassPrompt(screenTail)) {
      bypassPromptLastSeenAt = Date.now();
      if (bypassPhase === 'idle' && bypassAcceptAttempts < BYPASS_ACCEPT_MAX_ATTEMPTS) {
        bypassAcceptAttempts++;
        bypassPhase = 'armed';
        agentLog(`[claude-tui] bypass-permissions prompt — auto-accepting "Yes, I accept" (attempt ${bypassAcceptAttempts}/${BYPASS_ACCEPT_MAX_ATTEMPTS})`);
        setTimeout(() => {
          if (processExited) return;
          try { proc.write('2'); } catch {}
          setTimeout(() => {
            if (processExited) return;
            try { proc.write('\r'); } catch {}
            bypassPhase = 'confirmed';
            agentLog('[claude-tui] bypass-permissions — confirm Enter sent');
            screenTail = '';
            setTimeout(() => {
              if (!processExited && detectClaudeBypassPrompt(screenTail)) bypassPhase = 'idle';
            }, 1200);
          }, BYPASS_CONFIRM_DELAY_MS);
        }, BYPASS_SETTLE_MS);
      }
    }
    else {
      const screenInfo = classifyClaudeScreen(screenTail);
      if (screenInfo.state === 'confirm-prompt' && screenInfo.affirmativeKey
          && proceedPhase === 'idle' && proceedAnswerCount < PROCEED_ANSWER_MAX) {
        proceedAnswerCount++;
        proceedPhase = 'armed';
        const key = screenInfo.affirmativeKey;
        agentLog(`[claude-tui] mid-turn permission prompt — auto-selecting "${key}" (answer ${proceedAnswerCount}/${PROCEED_ANSWER_MAX})`);
        sendConfirmAnswer(key, PROCEED_SETTLE_MS, PROCEED_CONFIRM_DELAY_MS, () => {
          agentLog('[claude-tui] permission prompt — confirm Enter sent');
          setTimeout(() => { if (!processExited) proceedPhase = 'idle'; }, PROCEED_REARM_MS);
        });
      }
    }
    if (stderrCapture.length < 4096) {
      stderrCapture += stripAnsiEscapes(data);
      if (stderrCapture.length > 4096) stderrCapture = stderrCapture.slice(0, 4096);
      const notice = detectClaudeTuiTerminalLimitNotice(stderrCapture);
      if (notice) noteTerminalLimitNotice(notice);
    }
    if (!terminalModelError && detectClaudeModelError(screenTail)) {
      noteTerminalModelError(claudeModelErrorMessage(s.model || opts.claudeModel || null));
    }
  });

  const abortStream = () => {
    if (interrupted || processExited) return;
    interrupted = true;
    s.stopReason = 'interrupted';
    agentWarn(`[claude-tui] abort requested pid=${proc.pid}`);
    killProc('SIGTERM');
  };
  if (opts.abortSignal?.aborted) abortStream();
  opts.abortSignal?.addEventListener('abort', abortStream, { once: true });

  const hardTimer = setTimeout(() => {
    if (processExited) return;
    timedOut = true;
    s.stopReason = 'timeout';
    agentWarn(`[claude-tui] hard deadline reached (${opts.timeout}s) pid=${proc.pid}`);
    killProc('SIGTERM');
  }, opts.timeout * 1000 + AGENT_STREAM_HARD_KILL_GRACE_MS);

  const POLL_INTERVAL_MS = 200;
  const POST_STOP_DRAIN_MS = 600;
  const PROMPT_SUBMIT_NUDGE_MS = 1500;
  const CHOKEPOINT_ANSWER_GRACE_MS = 5000;
  let promptNudged = false;
  let pollHandle: NodeJS.Timeout | null = null;
  let drainScheduled = false;
  let lastMainJsonlEventAt = start;
  let lastLoggedPendingBg = -1;
  let lastToolEventAt = start;
  let lastSidecarEventAt = 0;
  let lastAssistantEventAt = 0;
  let stallKilled = false;
  let stallAnswerTried = false;
  let stallAnswerSentAt = 0;
  let observedClaudeVersion = '';
  let lastMainJsonlType = '';
  let lastStallDiagHeartbeatAt = 0;
  let stallDiagWentQuiet = false;
  let stallDiagMaxQuietMs = 0;
  let stallDiagPtyAliveWhileQuiet = false;
  let lastClearedStopAt = 0;
  const pendingHookToolIds = new Set<string>();
  const pendingAskUserToolIds = new Set<string>();
  let loggedAwaitingUser = false;

  const drainMainJsonl = (): boolean => {
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
          noteTerminalLimitNotice(notice);
          touched = true;
          continue;
        }
        applyAssistantStreaming(s, ev.message, streamBuf);
        applyAssistantUsage(s, ev.message);
        if (ev.message?.model && ev.message.model !== '<synthetic>' && typeof ev.message.model === 'string') {
          lastAssistantEventAt = Date.now();
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
    return touched;
  };
  let toolEventsReadOffset = 0;
  const drainToolEvents = (): boolean => {
    const inc = readJsonlIncrement(toolEventsPath, toolEventsReadOffset);
    toolEventsReadOffset = inc.offset;
    let any = false;
    for (const line of inc.lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed[0] !== '{') continue;
      let ev: any;
      try { ev = JSON.parse(trimmed); } catch { continue; }
      lastToolEventAt = Date.now();
      const hookToolId = typeof ev?.tool_use_id === 'string' ? ev.tool_use_id : '';
      if (hookToolId) {
        if (ev?.event === 'PreToolUse') {
          pendingHookToolIds.add(hookToolId);
          if (isAskUserToolName(ev?.tool_name)) pendingAskUserToolIds.add(hookToolId);
        } else if (ev?.event === 'PostToolUse') {
          pendingHookToolIds.delete(hookToolId);
          pendingAskUserToolIds.delete(hookToolId);
        }
      }
      const subAgentId = typeof ev?.agent_id === 'string' ? ev.agent_id : '';
      if (subAgentId && !s.subAgentIdToParent?.has(subAgentId)) tryDiscoverSubAgents();
      try { if (applyHookToolEvent(ev, s)) any = true; }
      catch (e: any) { agentWarn(`[claude-tui] hook tool event apply threw: ${e?.message || e}`); }
    }
    return any;
  };

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
      if (!s.subAgents.has(parentToolUseId)) continue;
      const sidecarPath = path.join(sidecarDir, `${stem}.jsonl`);
      trackedSubAgents.set(stem, { sidecarPath, offset: 0, parentToolUseId });
      const rawAgentId = stem.startsWith('agent-') ? stem.slice('agent-'.length) : stem;
      if (!s.subAgentIdToParent) s.subAgentIdToParent = new Map<string, string>();
      s.subAgentIdToParent.set(rawAgentId, parentToolUseId);
      s.subAgentIdToParent.set(stem, parentToolUseId);
      if (!s.bgTaskIdToToolUse) s.bgTaskIdToToolUse = new Map<string, string>();
      s.bgTaskIdToToolUse.set(rawAgentId, parentToolUseId);
      agentLog(`[claude-tui] subagent sidecar discovered ${stem} parent=${parentToolUseId.slice(0, 14)}`);
    }
  };
  const pumpSubAgentSidecars = (): boolean => {
    let any = false;
    for (const tail of trackedSubAgents.values()) {
      const inc = readJsonlIncrement(tail.sidecarPath, tail.offset);
      tail.offset = inc.offset;
      for (const line of inc.lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed[0] !== '{') continue;
        let ev: any;
        try { ev = JSON.parse(trimmed); } catch { continue; }
        const injected = { ...ev, parent_tool_use_id: tail.parentToolUseId };
        try { callClaudeParseForTui(injected, s); }
        catch (e: any) { agentWarn(`[claude-tui] subagent parse threw: ${e?.message || e}`); }
        any = true;
      }
    }
    if (any) lastSidecarEventAt = Date.now();
    return any;
  };

  const terminatePromptUnanswered = (screenState: ClaudeScreenState, sample: string): void => {
    stallKilled = true;
    const nowMs = Date.now();
    const progressAt = Math.max(start, lastMainJsonlEventAt, lastToolEventAt, lastSidecarEventAt);
    writeStallDiag({
      kind: 'stall', sessionId: activeSessionId, version: observedClaudeVersion, model: s.model || null,
      elapsedTurnMs: nowMs - start, quietMs: nowMs - progressAt, ptyQuietMs: nowMs - lastPtyDataAt,
      ptyAliveWhileQuiet: stallDiagPtyAliveWhileQuiet, lastJsonlType: lastMainJsonlType,
      pendingHookTools: pendingHookToolIds.size, pendingBgAgents: pendingClaudeBackgroundAgentCount(s),
      looksLikePrompt: true, screenState, action: 'terminate-prompt-unanswered', screenSample: sample,
    });
    s.stopReason = 'prompt_unanswered';
    if (!s.errors) s.errors = ['Claude paused for a confirmation pikiloom could not auto-approve. Your session is intact — re-send your message (or reply "continue") to proceed.'];
    agentWarn(`[claude-tui] confirm dialog (${screenState}) did not clear after auto-answer — ending turn without auto-resume pid=${proc.pid}`);
    pushRecentActivity(s.recentActivity, 'Waiting on a confirmation pikiloom could not auto-approve — re-send to continue');
    s.activity = s.recentActivity.join('\n');
    emit();
    killProc('SIGTERM');
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

    const state = readHookState(statePath);
    if (state.sessionId && state.sessionId !== activeSessionId) {
      const prevId = activeSessionId;
      activeSessionId = state.sessionId;
      activeJsonlPath = state.transcriptPath || path.join(projectDir, `${activeSessionId}.jsonl`);
      if (!isResume) jsonlReadOffset = 0;
      emitSessionIdUpdate(s, activeSessionId);
      agentLog(`[claude-tui] session id resolved ${prevId} -> ${activeSessionId} transcript=${activeJsonlPath}`);
    } else if (state.transcriptPath && state.transcriptPath !== activeJsonlPath) {
      activeJsonlPath = state.transcriptPath;
    }

    const bypassDialogActive = bypassPromptLastSeenAt > 0
      && Date.now() - bypassPromptLastSeenAt < BYPASS_DIALOG_ACTIVE_WINDOW_MS;
    if (!promptNudged && !state.promptSubmittedAt && !bypassDialogActive
        && Date.now() - start > PROMPT_SUBMIT_NUDGE_MS) {
      promptNudged = true;
      try { proc.write('\r'); } catch {}
      agentLog(`[claude-tui] prompt-submit nudge sent (no UserPromptSubmit after ${PROMPT_SUBMIT_NUDGE_MS}ms)`);
    }

    if (drainMainJsonl()) {
      emit();
      scheduleStreamTick();
    }

    if (drainToolEvents()) emit();

    if (s.subAgents.size > 0) tryDiscoverSubAgents();
    if (pumpSubAgentSidecars()) emit();

    if (state.stoppedAt && !stopHookFired) {
      if (state.stoppedAt !== lastClearedStopAt) {
        lastClearedStopAt = state.stoppedAt;
        if (pendingHookToolIds.size) {
          agentWarn(`[claude-tui] Stop fired with ${pendingHookToolIds.size} unmatched PreToolUse event(s) — clearing (lost PostToolUse hooks)`);
          pendingHookToolIds.clear();
        }
        pendingAskUserToolIds.clear();
      }
      const pendingBg = pendingClaudeBackgroundAgentCount(s);
      const decision = decideClaudeTuiStop({
        stoppedAt: state.stoppedAt,
        pendingBackgroundAgents: pendingBg,
        lastTaskNotificationAt: s.lastTaskNotificationAt || 0,
        lastJsonlEventAt: lastMainJsonlEventAt,
        lastHookOrSidecarEventAt: Math.max(lastToolEventAt, lastSidecarEventAt),
        holdQuietTtlMs: pendingClaudeBackgroundBashCount(s) > 0
          ? CLAUDE_TUI_STALL_PENDING_TOOL_MS
          : undefined,
        now: Date.now(),
      });
      if (decision === 'terminate') {
        stopHookFired = true;
        stopHookSeenAt = Date.now();
        if (pendingBg > 0) {
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
    }

    if (!stopHookFired && !timedOut && !interrupted && !stallKilled) {
      const lastProgressAt = Math.max(
        start, lastMainJsonlEventAt, lastToolEventAt, lastSidecarEventAt,
        state.stoppedAt || 0, state.promptSubmittedAt || 0,
      );
      const pendingBgForStall = pendingClaudeBackgroundAgentCount(s);
      const nonStopProgressAt = Math.max(
        start, lastMainJsonlEventAt, lastToolEventAt, lastSidecarEventAt,
        state.promptSubmittedAt || 0,
      );
      const inPostStopHold = !!state.stoppedAt && state.stoppedAt >= nonStopProgressAt;
      const awaitingUserReply = pendingAskUserToolIds.size > 0;
      if (awaitingUserReply !== loggedAwaitingUser) {
        loggedAwaitingUser = awaitingUserReply;
        if (awaitingUserReply) {
          agentLog(`[claude-tui] im_ask_user in flight — stall watchdog disarmed until the user replies pid=${proc.pid}`);
        }
      }
      if (stallAnswerSentAt > 0 && Date.now() - stallAnswerSentAt > CHOKEPOINT_ANSWER_GRACE_MS) {
        const after = classifyClaudeScreen(screenTail);
        const stillBlocking = after.state === 'confirm-prompt'
          || after.state === 'plan-approval' || after.state === 'bypass-startup';
        if (stillBlocking) {
          terminatePromptUnanswered(after.state, after.sample);
        } else {
          agentLog(`[claude-tui] chokepoint answer cleared the dialog (now ${after.state}) — turn continues`);
          stallAnswerSentAt = 0;
          stallAnswerTried = false;
        }
      }
      if (!stallKilled) {
        const nowMs = Date.now();
        const quietMs = nowMs - lastProgressAt;
        if (quietMs >= STALL_DIAG_QUIET_THRESHOLD_MS && !inPostStopHold && !awaitingUserReply) {
          const ptyQuietMs = nowMs - lastPtyDataAt;
          stallDiagWentQuiet = true;
          if (quietMs > stallDiagMaxQuietMs) stallDiagMaxQuietMs = quietMs;
          if (ptyQuietMs < CLAUDE_TUI_STALL_PTY_DEAD_MS) stallDiagPtyAliveWhileQuiet = true;
          if (nowMs - lastStallDiagHeartbeatAt >= STALL_DIAG_HEARTBEAT_INTERVAL_MS) {
            lastStallDiagHeartbeatAt = nowMs;
            const screenInfo = classifyClaudeScreen(screenTail);
            const looksLikePrompt = screenInfo.state === 'confirm-prompt'
              || screenInfo.state === 'plan-approval' || screenInfo.state === 'bypass-startup';
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
              looksLikePrompt,
              screenState: screenInfo.state,
              screenSample: screenInfo.sample,
            });
          }
        }
      }
      if (!stallKilled) {
        const stallDecision = decideClaudeTuiStall({
          now: Date.now(),
          lastProgressAt,
          pendingToolCount: pendingHookToolIds.size + pendingBgForStall,
          awaitingUserReply,
          lastPtyDataAt: inPostStopHold ? 0 : lastPtyDataAt,
        });
        if (stallDecision === 'stall') {
          const quietMin = Math.round((Date.now() - lastProgressAt) / 60_000);
          const ptyQuietS = Math.round((Date.now() - lastPtyDataAt) / 1000);
          const screen = classifyClaudeScreen(screenTail);
          const action = decideStallAction({
            state: screen.state,
            affirmativeKey: screen.affirmativeKey,
            pendingBgAgents: pendingBgForStall,
            alreadyTriedAnswer: stallAnswerTried,
          });
          const looksLikePrompt = screen.state === 'confirm-prompt'
            || screen.state === 'plan-approval' || screen.state === 'bypass-startup';
          const writeStallRecord = () => writeStallDiag({
            kind: 'stall', sessionId: activeSessionId, version: observedClaudeVersion, model: s.model || null,
            elapsedTurnMs: Date.now() - start, quietMs: Date.now() - lastProgressAt, ptyQuietMs: Date.now() - lastPtyDataAt,
            ptyAliveWhileQuiet: stallDiagPtyAliveWhileQuiet, lastJsonlType: lastMainJsonlType,
            pendingHookTools: pendingHookToolIds.size, pendingBgAgents: pendingBgForStall,
            looksLikePrompt, screenState: screen.state, action, screenSample: screen.sample,
          });

          if (action === 'answer-retry' && screen.affirmativeKey) {
            stallAnswerTried = true;
            stallAnswerSentAt = Date.now();
            agentWarn(`[claude-tui] watchdog hit a ${screen.state} after ${quietMin}m quiet — auto-answering "${screen.affirmativeKey}" against the stable dialog (no kill yet) pid=${proc.pid}`);
            sendConfirmAnswer(screen.affirmativeKey, 0, PROCEED_CONFIRM_DELAY_MS);
          } else if (action === 'terminate-clean') {
            writeStallRecord();
            stopHookFired = true;
            stopHookSeenAt = Date.now();
            agentLog(`[claude-tui] watchdog saw an idle REPL with no pending work after ${quietMin}m — treating as a finished turn (clean end, no resume) pid=${proc.pid}`);
          } else if (action === 'terminate-prompt-unanswered') {
            writeStallRecord();
            terminatePromptUnanswered(screen.state, screen.sample);
          } else if (action === 'model-error') {
            stallKilled = true;
            if (!terminalModelError) terminalModelError = claudeModelErrorMessage(s.model || opts.claudeModel || null);
            writeStallRecord();
            s.stopReason = 'model_error';
            if (!s.errors) s.errors = [terminalModelError];
            agentWarn(`[claude-tui] watchdog hit a model-unavailable banner after ${quietMin}m — ending turn (model_error, no resume) pid=${proc.pid}`);
            pushRecentActivity(s.recentActivity, 'Selected model unavailable — stopping');
            s.activity = s.recentActivity.join('\n');
            emit();
            killProc('SIGTERM');
          } else {
            stallKilled = true;
            s.stopReason = 'stalled';
            writeStallRecord();
            if (!s.errors) {
              if (terminalModelError && !s.text.trim()) {
                s.stopReason = 'model_error';
                s.errors = [terminalModelError];
              } else {
                const limitOutcome = resolveClaudeTuiLimitOutcome({
                  noticeText: terminalLimitNotice,
                  noticeAt: terminalLimitNoticeAt,
                  lastSubstantiveEventAt: Math.max(lastAssistantEventAt, lastToolEventAt, lastSidecarEventAt),
                  hasOutputText: !!s.text.trim(),
                });
                if (limitOutcome === 'fatal') {
                  s.stopReason = 'rate_limit';
                  s.errors = [terminalLimitNotice!];
                } else {
                  s.errors = [`Claude process went silent mid-turn for ${quietMin}m (no JSONL, hook, or sub-agent events; PTY quiet ${ptyQuietS}s) — known claude CLI freeze. Terminated for auto-resume.`];
                }
              }
            }
            agentWarn(`[claude-tui] stall detected: no progress for ${quietMin}m (state=${screen.state}, pendingTools=${pendingHookToolIds.size}, pendingBg=${pendingBgForStall}, ptyQuiet=${ptyQuietS}s) — terminating TUI pid=${proc.pid}${s.stopReason === 'rate_limit' ? ' (usage limit)' : s.stopReason === 'model_error' ? ' (model unavailable)' : ' for auto-resume'}`);
            pushRecentActivity(s.recentActivity, s.stopReason === 'rate_limit'
              ? 'Usage limit blocked the turn — stopping'
              : s.stopReason === 'model_error'
                ? 'Selected model unavailable — stopping'
                : `Agent stalled (${quietMin}m silent) — restarting turn`);
            s.activity = s.recentActivity.join('\n');
            emit();
            killProc('SIGTERM');
          }
        }
      }
    }

    pollHandle = setTimeout(tick, POLL_INTERVAL_MS);
  };
  pollHandle = setTimeout(tick, POLL_INTERVAL_MS);

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

  if (drainMainJsonl()) emit();
  if (drainToolEvents()) emit();
  if (s.subAgents.size > 0) tryDiscoverSubAgents();
  if (pumpSubAgentSidecars()) emit();
  flushStream();

  if (!dbg) {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
  } else {
    agentLog(`[claude-tui] debug artifacts retained in ${workDir}`);
  }

  const cleanStderr = stderrCapture.trim();
  const apiErrorReason = detectClaudeApiError(s.text);
  if (apiErrorReason) {
    agentWarn(`[claude-tui] upstream API error detected: ${apiErrorReason}`);
    s.stopReason = 'api_error';
    s.text = '';
    if (!s.errors) s.errors = [`Anthropic API error: ${apiErrorReason}`];
  }
  if (!interrupted && !s.errors && terminalModelError && !s.text.trim()) {
    s.stopReason = 'model_error';
    s.errors = [terminalModelError];
  }
  if (!interrupted && !timedOut && !s.errors) {
    const limitOutcome = resolveClaudeTuiLimitOutcome({
      noticeText: terminalLimitNotice,
      noticeAt: terminalLimitNoticeAt,
      lastSubstantiveEventAt: Math.max(lastAssistantEventAt, lastToolEventAt, lastSidecarEventAt),
      hasOutputText: !!s.text.trim(),
    });
    if (limitOutcome === 'fatal') {
      s.stopReason = 'rate_limit';
      s.errors = [terminalLimitNotice!];
    }
  }
  const errorText = joinErrorMessages(s.errors);
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
