import fs from 'node:fs';
import path from 'node:path';
import { execSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { registerDriver, type AgentDriver } from '../driver.js';
import {
  type StreamOpts, type StreamResult, type StreamPreviewPlan, type StreamPreviewPlanStep, type StreamPreviewMeta, type StreamSubAgent,
  type SessionListResult, type SessionTailOpts, type SessionTailResult,
  type SessionMessagesOpts, type SessionMessagesResult,
  type TailMessage, type RichMessage, type MessageBlock,
  type ModelListOpts, type ModelListResult, type ModelInfo,
  type UsageOpts, type UsageResult, type UsageWindowInfo,
  type SessionInfo,
  Q, run, agentError, agentLog, agentWarn,
  appendSystemPrompt, buildStreamPreviewMeta, computeContext, pushRecentActivity,
  summarizeClaudeToolUse, summarizeClaudeToolResult, joinErrorMessages, parseTodoWriteAsPlan,
  previewToolCallInput, previewToolCallResult,
  detectClaudeApiError, isRetryableClaudeApiError,
  detectClaudeModelError, claudeModelErrorMessage,
  emitSessionIdUpdate,
  IMAGE_EXTS, mimeForExt,
  listPikiloomSessions, findPikiloomSession, isPendingSessionId,
  mergeManagedAndNativeSessions, managedRecordToSessionInfo,
  readTailLines, stripInjectedPrompts, sanitizeSessionUserPreviewText, SESSION_PREVIEW_IMAGE_PLACEHOLDER_RE,
  CLAUDE_AT_MENTION_IMAGE_RE, extractClaudeAtMentionImagePaths, stripClaudeAtMentionImages,
  attachAgentImage,
  applyTurnWindow, shortValue,
  roundPercent, toIsoFromEpochSeconds, modelFamily, normalizeClaudeModelId, emptyUsage, normalizeUsageStatus,
  collapseSkillPrompt,
} from '../index.js';
import { AGENT_STREAM_HARD_KILL_GRACE_MS, AGENT_GRACEFUL_ABORT_GRACE_MS, SESSION_RUNNING_THRESHOLD_MS } from '../../core/constants.js';
import { terminateProcessTree } from '../../core/process-control.js';
import { getHome, IS_MAC, encodePathAsDirName } from '../../core/platform.js';

function buildClaudeUserMessage(prompt: string, attachments: string[]): string {
  const content: any[] = [];
  for (const filePath of attachments) {
    const ext = path.extname(filePath).toLowerCase();
    if (IMAGE_EXTS.has(ext)) {
      try {
        const data = fs.readFileSync(filePath);
        content.push({
          type: 'image',
          source: { type: 'base64', media_type: mimeForExt(ext), data: data.toString('base64') },
        });
      } catch (e: any) {
        agentWarn(`[attach] failed to read image ${filePath}: ${e.message}`);
      }
    } else {
      content.push({ type: 'text', text: `[Attached file: ${filePath}]` });
    }
  }
  content.push({ type: 'text', text: prompt });
  return JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n';
}

function claudeUsesStreamJsonInput(o: StreamOpts): boolean {
  return !!o.attachments?.length || !!o.onSteerReady;
}

const CLAUDE_STEER_IDLE_CLOSE_MS = 1200;

export function claudeEffortAndWorkflowArgs(
  o: Pick<StreamOpts, 'thinkingEffort' | 'claudeWorkflowEnabled'>,
): string[] {
  const args: string[] = [];
  const ultraEffort = o.thinkingEffort === 'ultra';
  if (o.thinkingEffort) args.push('--effort', ultraEffort ? 'max' : o.thinkingEffort);
  if (!o.claudeWorkflowEnabled && !ultraEffort) args.push('--disallowed-tools', 'Workflow');
  return args;
}

const CLAUDE_SESSION_CONTEXT_ENV_KEYS = [
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_EFFORT',
  'CLAUDE_PERMISSION_MODE',
];

export function scrubClaudeSessionContextEnv(env: Record<string, string | undefined>): void {
  for (const key of CLAUDE_SESSION_CONTEXT_ENV_KEYS) delete env[key];
}

function claudeCmd(o: StreamOpts): string[] {
  const args = ['claude', '-p', '--verbose', '--output-format', 'stream-json', '--include-partial-messages'];
  const model = normalizeClaudeModelId(o.claudeModel);
  if (model) args.push('--model', model);
  if (o.claudePermissionMode) args.push('--permission-mode', o.claudePermissionMode);
  if (o.forkOf) {
    args.push('--resume', o.forkOf.parentSessionId, '--fork-session');
  } else if (o.sessionId) {
    args.push('--resume', o.sessionId);
  }
  if (claudeUsesStreamJsonInput(o)) {
    args.push('--input-format', 'stream-json');
    if (o.onSteerReady) args.push('--replay-user-messages');
    if (o.attachments?.length) o._stdinOverride = buildClaudeUserMessage(o.prompt, o.attachments);
  }
  args.push(...claudeEffortAndWorkflowArgs(o));
  if (o.claudeAppendSystemPrompt) args.push('--append-system-prompt', o.claudeAppendSystemPrompt);
  if (o.mcpConfigPath) args.push('--mcp-config', o.mcpConfigPath);
  if (o.claudeExtraArgs?.length) args.push(...o.claudeExtraArgs);
  return args;
}

function routeClaudeSubAgentEvent(ev: any, t: string, parentToolUseId: string, s: any): void {
  const sub: StreamSubAgent | undefined = s.subAgents.get(parentToolUseId);
  if (!sub) return;

  if (t === 'system' || t === 'assistant') {
    const model = ev.model ?? ev.message?.model;
    if (typeof model === 'string' && model.trim()) sub.model = model;
  }
  if (t === 'assistant') {
    const contents = ev.message?.content || [];
    for (const block of contents) {
      if (block?.type !== 'tool_use') continue;
      const toolId = String(block?.id || '').trim();
      if (!toolId || s.seenClaudeToolIds.has(toolId)) continue;
      const toolName = String(block?.name || 'Tool').trim() || 'Tool';
      const summary = toolName === 'TodoWrite' ? 'Update plan' : summarizeClaudeToolUse(block?.name, block?.input || {});
      s.seenClaudeToolIds.add(toolId);
      s.claudeToolsById.set(toolId, { name: toolName, summary });
      sub.tools.push({ id: toolId, name: toolName, summary });
    }
  }
}

function buildClaudeTurnUsage(
  u: { input: number | null; output: number | null; cacheRead: number | null; cacheCreation: number | null; model: string | null },
  turnOutput?: number,
): StreamPreviewMeta | null {
  if (u.input == null && u.output == null && u.cacheRead == null && u.cacheCreation == null) return null;
  const ctxWindow = claudeEffectiveContextWindow(claudeContextWindowFromModel(u.model));
  const used = claudeContextUsedFromUsage({
    input: u.input, cached: u.cacheRead, cacheCreation: u.cacheCreation, output: u.output,
  });
  const contextPercent = ctxWindow && used > 0
    ? Math.min(99.9, Math.round(used / ctxWindow * 1000) / 10)
    : null;
  const meta: StreamPreviewMeta = {
    inputTokens: u.input,
    outputTokens: u.output,
    cachedInputTokens: u.cacheRead,
    contextUsedTokens: used > 0 ? used : null,
    contextPercent,
  };
  if (turnOutput && turnOutput > 0) meta.turnOutputTokens = turnOutput;
  return meta;
}

const CLAUDE_NATIVE_RUNNING_HARD_CAP_MS = 5 * 60 * 1000;

const CLAUDE_TURN_TERMINAL_STOP_REASONS = new Set(['end_turn', 'stop_sequence', 'max_tokens', 'refusal']);

function isClaudeNativeSessionRunning(filePath: string, mtimeMs: number): boolean {
  const age = Date.now() - mtimeMs;
  if (age < SESSION_RUNNING_THRESHOLD_MS) return true;
  if (age > CLAUDE_NATIVE_RUNNING_HARD_CAP_MS) return false;
  const tailLines = readTailLines(filePath, 64 * 1024);
  for (let i = tailLines.length - 1; i >= 0; i--) {
    const line = tailLines[i];
    if (!line || line[0] !== '{') continue;
    let ev: any;
    try { ev = JSON.parse(line); } catch { continue; }
    const t = ev?.type;
    if (t === 'ai-title' || t === 'system') continue;
    if (t === 'user') return true;
    if (t === 'assistant') {
      const stop = ev?.message?.stop_reason;
      return stop != null ? !CLAUDE_TURN_TERMINAL_STOP_REASONS.has(stop) : true;
    }
    return false;
  }
  return false;
}

export function claudeContextWindowFromModel(model: unknown): number | null {
  const id = normalizeClaudeModelId(model).toLowerCase();
  if (!id) return null;
  if (id === 'haiku' || /^claude-haiku-/.test(id)) return 200_000;
  if (id === 'opus' || id === 'sonnet' || id === 'fable') return 1_000_000;
  if (/^claude-(opus|sonnet)-/.test(id) || /^claude-fable-/.test(id)) return 1_000_000;
  return null;
}

const CLAUDE_MAX_OUTPUT_RESERVE = 20_000;
const CLAUDE_AUTOCOMPACT_BUFFER = 13_000;
const CLAUDE_USABLE_WINDOW_RESERVE = CLAUDE_MAX_OUTPUT_RESERVE + CLAUDE_AUTOCOMPACT_BUFFER;

export function claudeEffectiveContextWindow(advertised: number | null): number | null {
  if (advertised == null) return null;
  if (advertised <= CLAUDE_USABLE_WINDOW_RESERVE) return advertised;
  return advertised - CLAUDE_USABLE_WINDOW_RESERVE;
}

function claudeContextUsedFromUsage(u: {
  input?: number | null;
  cached?: number | null;
  cacheCreation?: number | null;
  output?: number | null;
}): number {
  return (u.input ?? 0) + (u.cached ?? 0) + (u.cacheCreation ?? 0) + (u.output ?? 0);
}

function recomputeClaudeContextUsed(s: any): void {
  const total = claudeContextUsedFromUsage({
    input: s.inputTokens,
    cached: s.cachedInputTokens,
    cacheCreation: s.cacheCreationInputTokens,
    // While a message is still streaming, the CLI's live thinking estimate is often the only
    // output signal (subscription accounts stream no plaintext thinking and no usage until the
    // message settles); the real output_tokens supersedes it at message_delta.
    output: Math.max(s.outputTokens ?? 0, s.thinkingEstTokens ?? 0),
  });
  s.contextUsedTokens = total > 0 ? total : null;
}

// Accumulate the CLI's live thinking-token estimate (system/thinking_tokens events). Prefer the
// per-event delta (correct whether the CLI's running total is per-message or per-turn); fall back
// to a monotonic max of the running total.
function applyClaudeThinkingEstimate(s: any, ev: any): void {
  const prev = s.thinkingEstTokens ?? 0;
  const delta = Number(ev?.estimated_tokens_delta);
  const total = Number(ev?.estimated_tokens);
  if (Number.isFinite(delta) && delta > 0) s.thinkingEstTokens = prev + delta;
  else if (Number.isFinite(total)) s.thinkingEstTokens = Math.max(prev, total);
}

const CLAUDE_FILE_READING_TOOLS = new Set(['Read']);

function isClaudeFileReadingTool(toolName: string | null | undefined): boolean {
  return !!toolName && CLAUDE_FILE_READING_TOOLS.has(toolName);
}

function accumulateClaudeImagesFromContent(content: any, s: any): void {
  if (!Array.isArray(content)) return;
  for (const entry of content) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.type === 'image') {
      const block = claudeImageBlockFromEntry(entry);
      if (!block) continue;
      const key = (entry.source?.data || '').slice(0, 64);
      if (key && s.seenImageKeys?.has(key)) continue;
      if (key) s.seenImageKeys?.add(key);
      s.imageBlocks?.push(block);
    } else if (entry.type === 'tool_result' && Array.isArray(entry.content)) {
      const toolName = entry.tool_use_id ? s.claudeToolsById?.get(entry.tool_use_id)?.name : null;
      if (isClaudeFileReadingTool(toolName)) continue;
      accumulateClaudeImagesFromContent(entry.content, s);
    }
  }
}

function readClaudeTaskCreateId(ev: any, block: any): string | null {
  const structured = ev?.toolUseResult?.task?.id;
  if (structured != null && String(structured).trim()) return String(structured).trim();
  const content = block?.content;
  if (typeof content === 'string') {
    const match = content.match(/Task #(\d+)/);
    if (match) return match[1];
  }
  return null;
}

function rebuildClaudePlanFromTasks(s: any): void {
  if (!s.claudeTaskOrder?.length) {
    return;
  }
  const steps: StreamPreviewPlanStep[] = [];
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

export interface ClaudeTaskNotification {
  taskId: string | null;
  toolUseId: string | null;
  status: string | null;
}

function ensureClaudeBgAgentState(s: any): void {
  if (!s.bgAgentLaunchedToolUseIds) s.bgAgentLaunchedToolUseIds = new Set<string>();
  if (!s.bgAgentCompletedToolUseIds) s.bgAgentCompletedToolUseIds = new Set<string>();
  if (!s.bgBashToolUseIds) s.bgBashToolUseIds = new Set<string>();
  if (!s.bgTaskIdToToolUse) s.bgTaskIdToToolUse = new Map<string, string>();
  if (typeof s.lastTaskNotificationAt !== 'number') s.lastTaskNotificationAt = 0;
}

export function registerClaudeBackgroundAgentLaunch(s: any, toolUseId: string): void {
  const id = String(toolUseId || '').trim();
  if (!id) return;
  ensureClaudeBgAgentState(s);
  s.bgAgentLaunchedToolUseIds.add(id);
}

export function registerClaudeBackgroundBashLaunch(s: any, toolUseId: string): void {
  const id = String(toolUseId || '').trim();
  if (!id) return;
  ensureClaudeBgAgentState(s);
  s.bgAgentLaunchedToolUseIds.add(id);
  s.bgBashToolUseIds.add(id);
}

export function pendingClaudeBackgroundAgentCount(s: any): number {
  const launched: Set<string> | undefined = s?.bgAgentLaunchedToolUseIds;
  if (!launched?.size) return 0;
  const completed: Set<string> | undefined = s?.bgAgentCompletedToolUseIds;
  let pending = 0;
  for (const id of launched) {
    if (!completed?.has(id)) pending++;
  }
  return pending;
}

export function pendingClaudeBackgroundBashCount(s: any): number {
  const bash: Set<string> | undefined = s?.bgBashToolUseIds;
  if (!bash?.size) return 0;
  const completed: Set<string> | undefined = s?.bgAgentCompletedToolUseIds;
  let pending = 0;
  for (const id of bash) {
    if (!completed?.has(id)) pending++;
  }
  return pending;
}

export function extractClaudeBackgroundTaskId(content: any): string | null {
  let text = '';
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    text = content
      .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
      .map((b: any) => b.text)
      .join('\n');
  } else if (content && typeof content === 'object') {
    try { text = JSON.stringify(content); } catch { return null; }
  }
  if (!text || !/background/i.test(text)) return null;
  const m = text.match(/\b(?:ID|id)\s*[:：]?\s*[`"']?([A-Za-z0-9][A-Za-z0-9_-]{1,63})/);
  return m ? m[1] : null;
}

export function extractClaudeWorkflowRunId(content: any): string | null {
  let text = '';
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    text = content
      .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
      .map((b: any) => b.text)
      .join('\n');
  } else if (content && typeof content === 'object') {
    try { text = JSON.stringify(content); } catch { return null; }
  }
  if (!text) return null;
  const m = text.match(/\bwf_[a-z0-9][a-z0-9-]{4,}\b/i);
  return m ? m[0] : null;
}

export function extractClaudeTaskNotification(content: any): ClaudeTaskNotification | null {
  let text = '';
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    text = content
      .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
      .map((b: any) => b.text)
      .join('\n');
  }
  if (!text || !text.includes('<task-notification>')) return null;
  const tag = (name: string): string | null => {
    const m = text.match(new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`));
    return m ? (m[1].trim() || null) : null;
  };
  return { taskId: tag('task-id'), toolUseId: tag('tool-use-id'), status: tag('status') };
}

export function applyClaudeTaskNotification(s: any, notification: ClaudeTaskNotification, eventAtMs?: number | null): void {
  ensureClaudeBgAgentState(s);
  s.lastTaskNotificationAt = eventAtMs && Number.isFinite(eventAtMs) ? eventAtMs : Date.now();
  const toolUseId = notification.toolUseId
    || (notification.taskId ? s.bgTaskIdToToolUse.get(notification.taskId) : undefined)
    || null;
  if (!toolUseId) return;
  if (!s.bgAgentLaunchedToolUseIds.has(toolUseId) || s.bgAgentCompletedToolUseIds.has(toolUseId)) return;
  s.bgAgentCompletedToolUseIds.add(toolUseId);
  const sub = s.subAgents?.get(toolUseId);
  if (sub && sub.status === 'running') {
    const failed = /^(fail|kill|cancel|stop|abort|error)/i.test(notification.status || '');
    sub.status = failed ? 'failed' : 'done';
  }
  const left = pendingClaudeBackgroundAgentCount(s);
  pushRecentActivity(s.recentActivity, left > 0
    ? `Background agent finished (${left} still running)`
    : 'All background agents finished');
  s.activity = s.recentActivity.join('\n');
}

export function claudeParse(ev: any, s: any) {
  const t = ev.type || '';
  const parentToolUseId: string | null = (typeof ev.parent_tool_use_id === 'string' && ev.parent_tool_use_id)
    ? ev.parent_tool_use_id : null;
  if (parentToolUseId) {
    routeClaudeSubAgentEvent(ev, t, parentToolUseId, s);
    return;
  }
  if (t === 'system') {
    emitSessionIdUpdate(s, ev.session_id);
    s.model = ev.model ?? s.model;
    s.thinkingEffort = ev.thinking_level ?? s.thinkingEffort;
    if (!s.byokContextWindow) {
      const advertised = claudeContextWindowFromModel(s.model);
      s.contextWindow = claudeEffectiveContextWindow(advertised) ?? s.contextWindow;
    }
    // Live thinking progress: during extended thinking a subscription account streams no
    // plaintext (signature_delta only) and no usage until the message settles — these estimates
    // are the only sign the model is working.
    if (ev.subtype === 'thinking_tokens') {
      applyClaudeThinkingEstimate(s, ev);
      recomputeClaudeContextUsed(s);
    }
  }

  if (t === 'stream_event') {
    const inner = ev.event || {};
    if (inner.type === 'message_start') {
      const u = inner.message?.usage;
      // A message that never delivered real output_tokens keeps its thinking estimate as the carry.
      s.turnOutputTokensBase = (s.turnOutputTokensBase ?? 0) + Math.max(s.outputTokens ?? 0, s.thinkingEstTokens ?? 0);
      s.inputTokens = u?.input_tokens ?? 0;
      s.cachedInputTokens = u?.cache_read_input_tokens ?? 0;
      s.cacheCreationInputTokens = u?.cache_creation_input_tokens ?? 0;
      s.outputTokens = 0;
      s.thinkingEstTokens = 0;
      recomputeClaudeContextUsed(s);
    }
    if (inner.type === 'content_block_start') {
      const blockType = inner.content_block?.type;
      if (blockType === 'text' && s.text && !s.text.endsWith('\n\n')) {
        s.text += s.text.endsWith('\n') ? '\n' : '\n\n';
      } else if (blockType === 'thinking' && s.thinking && !s.thinking.endsWith('\n\n')) {
        s.thinking += s.thinking.endsWith('\n') ? '\n' : '\n\n';
      }
    }
    if (inner.type === 'content_block_delta') {
      const d = inner.delta || {};
      if (d.type === 'thinking_delta') s.thinking += d.thinking || '';
      else if (d.type === 'text_delta') s.text += d.text || '';
    }
    if (inner.type === 'message_delta') {
      const d = inner.delta || {};
      s.stopReason = d.stop_reason ?? s.stopReason;
      const u = inner.usage;
      if (u) {
        if (u.input_tokens != null) s.inputTokens = u.input_tokens;
        if (u.cache_read_input_tokens != null) s.cachedInputTokens = u.cache_read_input_tokens;
        if (u.cache_creation_input_tokens != null) s.cacheCreationInputTokens = u.cache_creation_input_tokens;
        // Real reported output supersedes the live thinking estimate for this message.
        if (u.output_tokens != null) { s.outputTokens = u.output_tokens; s.thinkingEstTokens = 0; }
        recomputeClaudeContextUsed(s);
      }
    }
    emitSessionIdUpdate(s, ev.session_id);
    s.model = ev.model ?? s.model;
    if (!s.byokContextWindow) {
      const advertised = claudeContextWindowFromModel(s.model);
      s.contextWindow = claudeEffectiveContextWindow(advertised) ?? s.contextWindow;
    }
  }

  if (t === 'assistant') {
    const msg = ev.message || {};
    if (msg.model === '<synthetic>') {
      if (!s.errors) {
        const synthText = (msg.content || [])
          .filter((b: any) => b?.type === 'text').map((b: any) => b.text || '').join(' ');
        if (ev.error === 'model_not_found' || detectClaudeModelError(synthText)) {
          s.stopReason = 'model_error';
          s.errors = [claudeModelErrorMessage(s.model)];
        }
      }
      return;
    }
    const contents = msg.content || [];
    const th = contents.filter((b: any) => b?.type === 'thinking').map((b: any) => b.thinking || '').join('\n\n');
    const tx = contents.filter((b: any) => b?.type === 'text').map((b: any) => b.text || '').join('\n\n');
    const toolUses = contents.filter((b: any) => b?.type === 'tool_use');
    accumulateClaudeImagesFromContent(contents, s);
    if (th && !s.thinking.trim()) s.thinking = th;
    if (tx && !s.text.trim()) s.text = tx;
    for (const block of toolUses) {
      const toolId = String(block?.id || '').trim();
      if (!toolId || s.seenClaudeToolIds.has(toolId)) continue;
      const toolName = String(block?.name || 'Tool').trim() || 'Tool';
      if (toolName === 'TodoWrite') {
        const plan = parseTodoWriteAsPlan(block?.input);
        if (plan) s.plan = plan;
        s.seenClaudeToolIds.add(toolId);
        s.claudeToolsById.set(toolId, { name: toolName, summary: 'Update plan' });
        continue;
      }
      if (toolName === 'TaskCreate') {
        const subject = typeof block?.input?.subject === 'string' ? block.input.subject.trim() : '';
        if (subject) s.pendingClaudeTaskCreates.set(toolId, { subject });
        s.seenClaudeToolIds.add(toolId);
        s.claudeToolsById.set(toolId, { name: toolName, summary: subject ? `Create task: ${subject}` : 'Create task' });
        continue;
      }
      if (toolName === 'TaskUpdate') {
        const taskId = String(block?.input?.taskId ?? '').trim();
        const rawStatus = String(block?.input?.status ?? '').trim().toLowerCase();
        if (taskId) {
          if (rawStatus === 'deleted') {
            s.claudeTaskList.delete(taskId);
            s.claudeTaskOrder = s.claudeTaskOrder.filter((id: string) => id !== taskId);
          } else if (rawStatus) {
            const existing = s.claudeTaskList.get(taskId);
            if (existing) existing.status = rawStatus;
          }
          rebuildClaudePlanFromTasks(s);
        }
        s.seenClaudeToolIds.add(toolId);
        s.claudeToolsById.set(toolId, { name: toolName, summary: `Update task ${taskId || '?'} → ${rawStatus || 'unknown'}` });
        continue;
      }
      if (toolName === 'Task' || toolName === 'Agent') {
        const input = block?.input || {};
        const subAgent: StreamSubAgent = {
          id: toolId,
          kind: typeof input.subagent_type === 'string' ? input.subagent_type : null,
          description: typeof input.description === 'string' ? input.description : null,
          model: null,
          tools: [],
          status: 'running',
        };
        s.subAgents.set(toolId, subAgent);
        if (input.run_in_background === true) registerClaudeBackgroundAgentLaunch(s, toolId);
        s.seenClaudeToolIds.add(toolId);
        s.claudeToolsById.set(toolId, { name: toolName, summary: subAgent.description || 'Run task' });
        continue;
      }
      if (toolName === 'Bash' && block?.input?.run_in_background === true) {
        registerClaudeBackgroundBashLaunch(s, toolId);
      }
      if (toolName === 'Workflow') {
        registerClaudeBackgroundAgentLaunch(s, toolId);
      }
      const tool = {
        name: toolName,
        summary: summarizeClaudeToolUse(block?.name, block?.input || {}),
        input: previewToolCallInput(toolName, block?.input),
        status: 'running' as const,
      };
      s.seenClaudeToolIds.add(toolId);
      s.claudeToolsById.set(toolId, tool);
      if (!s.claudeToolCallOrder) s.claudeToolCallOrder = [];
      s.claudeToolCallOrder.push(toolId);
      pushRecentActivity(s.recentActivity, tool.summary);
    }
    s.activity = s.recentActivity.join('\n');
    s.stopReason = msg.stop_reason ?? s.stopReason;
  }

  if (t === 'user') {
    const msg = ev.message || {};
    const contents = Array.isArray(msg.content) ? msg.content : [];
    const notification = extractClaudeTaskNotification(msg.content);
    if (notification) {
      const eventAtMs = typeof ev.timestamp === 'string' ? Date.parse(ev.timestamp) : NaN;
      applyClaudeTaskNotification(s, notification, Number.isFinite(eventAtMs) ? eventAtMs : null);
    }
    const toolResults = contents.filter((b: any) => b?.type === 'tool_result');
    for (const block of toolResults) {
      const toolId = String(block?.tool_use_id || '').trim();
      if (toolId && s.seenClaudeToolResultIds?.has(toolId)) continue;
      if (toolId) {
        if (!s.seenClaudeToolResultIds) s.seenClaudeToolResultIds = new Set<string>();
        s.seenClaudeToolResultIds.add(toolId);
      }
      const tool = toolId ? s.claudeToolsById.get(toolId) : undefined;
      if (tool?.name === 'TodoWrite') continue;
      if (tool?.name === 'TaskCreate') {
        const pending = toolId ? s.pendingClaudeTaskCreates.get(toolId) : undefined;
        const assignedId = readClaudeTaskCreateId(ev, block);
        if (pending && assignedId) {
          s.pendingClaudeTaskCreates.delete(toolId);
          if (!s.claudeTaskList.has(assignedId)) s.claudeTaskOrder.push(assignedId);
          s.claudeTaskList.set(assignedId, { subject: pending.subject, status: 'pending' });
          rebuildClaudePlanFromTasks(s);
        }
        continue;
      }
      if (tool?.name === 'TaskUpdate') continue;
      if (tool?.name === 'Task' || tool?.name === 'Agent') {
        const sub = s.subAgents.get(toolId);
        if (sub) {
          const isBgLaunchAck = !block?.is_error
            && s.bgAgentLaunchedToolUseIds?.has(toolId)
            && !s.bgAgentCompletedToolUseIds?.has(toolId);
          if (!isBgLaunchAck) sub.status = block?.is_error ? 'failed' : 'done';
        }
        continue;
      }
      if (tool) {
        tool.result = previewToolCallResult(block?.content);
        tool.status = block?.is_error ? 'failed' : 'done';
      }
      if (tool?.name === 'Bash' && s.bgBashToolUseIds?.has(toolId)
          && !s.bgAgentCompletedToolUseIds?.has(toolId)) {
        const taskId = extractClaudeBackgroundTaskId(block?.content);
        if (taskId && !s.bgTaskIdToToolUse.has(taskId)) s.bgTaskIdToToolUse.set(taskId, toolId);
      }
      if (tool?.name === 'Workflow' && s.bgAgentLaunchedToolUseIds?.has(toolId)
          && !s.bgAgentCompletedToolUseIds?.has(toolId)) {
        const runId = extractClaudeWorkflowRunId(block?.content);
        if (runId && !s.bgTaskIdToToolUse.has(runId)) s.bgTaskIdToToolUse.set(runId, toolId);
      }
      pushRecentActivity(s.recentActivity, summarizeClaudeToolResult(tool, block, ev.tool_use_result));
      if (Array.isArray(block.content) && !isClaudeFileReadingTool(tool?.name)) {
        accumulateClaudeImagesFromContent(block.content, s);
      }
    }
    s.activity = s.recentActivity.join('\n');
  }

  if (t === 'result') {
    emitSessionIdUpdate(s, ev.session_id);
    s.model = ev.model ?? s.model;
    if (ev.is_error && ev.errors?.length) s.errors = ev.errors;
    if (ev.result && !s.text.trim()) s.text = ev.result;
    if (s.stopReason !== 'model_error') s.stopReason = ev.stop_reason ?? s.stopReason;
    const u = ev.usage;
    if (u) {
      const cached = u.cache_read_input_tokens ?? u.cached_input_tokens;
      if (s.inputTokens == null && u.input_tokens != null) s.inputTokens = u.input_tokens;
      if (s.cachedInputTokens == null && cached != null) s.cachedInputTokens = cached;
      if (s.cacheCreationInputTokens == null && u.cache_creation_input_tokens != null) {
        s.cacheCreationInputTokens = u.cache_creation_input_tokens;
      }
      if (s.outputTokens == null && u.output_tokens != null) s.outputTokens = u.output_tokens;
      recomputeClaudeContextUsed(s);
    }
    const mu = ev.modelUsage;
    if (mu && typeof mu === 'object' && !s.byokContextWindow) {
      for (const info of Object.values(mu) as any[]) {
        if (info?.contextWindow > 0) {
          s.contextWindow = claudeEffectiveContextWindow(info.contextWindow) ?? info.contextWindow;
          break;
        }
      }
    }
  }
}

export function createClaudeStreamState(opts: StreamOpts) {
  const byokWindow = opts.byokContextWindow && opts.byokContextWindow > 0
    ? opts.byokContextWindow
    : null;
  const byokProvider = opts.byokProviderName || null;
  return {
    sessionId: opts.sessionId,
    text: '',
    thinking: '',
    msgs: [] as string[],
    thinkParts: [] as string[],
    model: opts.model,
    thinkingEffort: opts.thinkingEffort,
    errors: null as unknown[] | null,
    inputTokens: null as number | null,
    outputTokens: null as number | null,
    cachedInputTokens: null as number | null,
    cacheCreationInputTokens: null as number | null,
    turnOutputTokensBase: 0 as number,
    thinkingEstTokens: 0 as number,
    turnUsageMsgId: null as string | null,
    contextWindow: byokWindow as number | null,
    byokContextWindow: byokWindow as number | null,
    byokProviderName: byokProvider as string | null,
    contextUsedTokens: null as number | null,
    codexCumulative: null,
    stopReason: null as string | null,
    activity: '',
    recentActivity: [] as string[],
    plan: null as StreamPreviewPlan | null,
    claudeTaskList: new Map<string, { subject: string; status: string }>(),
    claudeTaskOrder: [] as string[],
    pendingClaudeTaskCreates: new Map<string, { subject: string }>(),
    claudeToolsById: new Map<string, { name: string; summary: string; input?: string | null; result?: string | null; status?: 'running' | 'done' | 'failed' }>(),
    claudeToolCallOrder: [] as string[],
    seenClaudeToolIds: new Set<string>(),
    subAgents: new Map<string, StreamSubAgent>(),
    bgAgentLaunchedToolUseIds: new Set<string>(),
    bgAgentCompletedToolUseIds: new Set<string>(),
    bgTaskIdToToolUse: new Map<string, string>(),
    lastTaskNotificationAt: 0 as number,
    imageBlocks: [] as MessageBlock[],
    seenImageKeys: new Set<string>(),
    _emitSessionId: opts.onSessionId ?? null,
  };
}

function resetClaudeTurnState(s: ReturnType<typeof createClaudeStreamState>, note?: string) {
  s.text = '';
  s.thinking = '';
  s.msgs = [];
  s.thinkParts = [];
  s.errors = null;
  s.inputTokens = null;
  s.outputTokens = null;
  s.turnOutputTokensBase = 0;
  s.thinkingEstTokens = 0;
  s.turnUsageMsgId = null;
  s.cachedInputTokens = null;
  s.cacheCreationInputTokens = null;
  s.contextUsedTokens = null;
  s.stopReason = null;
  s.activity = '';
  s.recentActivity = [];
  s.claudeToolsById = new Map();
  s.claudeToolCallOrder = [];
  s.subAgents = new Map();
  s.seenClaudeToolIds = new Set();
  s.bgAgentLaunchedToolUseIds = new Set();
  s.bgAgentCompletedToolUseIds = new Set();
  s.bgTaskIdToToolUse = new Map();
  s.lastTaskNotificationAt = 0;
  s.imageBlocks = [];
  s.seenImageKeys = new Set();
  if (note) {
    pushRecentActivity(s.recentActivity, note);
    s.activity = s.recentActivity.join('\n');
  }
}

async function doClaudeInteractiveStream(opts: StreamOpts): Promise<StreamResult> {
  const start = Date.now();
  const deadline = start + opts.timeout * 1000;
  let stderr = '';
  let lineCount = 0;
  let timedOut = false;
  let interrupted = false;
  let stdinClosed = false;
  let steerQueued = false;
  let awaitingSteeredResponseStart = false;
  let idleCloseTimer: NodeJS.Timeout | null = null;
  const s = createClaudeStreamState(opts);

  const cmd = claudeCmd(opts);
  const shellCmd = cmd.map(Q).join(' ');
  agentLog(`[spawn] full command: cd ${Q(opts.workdir)} && ${shellCmd}`);
  agentLog(`[spawn] timeout: ${opts.timeout}s session: ${opts.sessionId || '(new)'}`);
  agentLog(`[spawn] prompt (stdin): "${opts.prompt.slice(0, 300)}${opts.prompt.length > 300 ? '…' : ''}"`);

  const spawnEnv = { ...process.env, ...(opts.extraEnv || {}) };
  scrubClaudeSessionContextEnv(spawnEnv);
  const proc = spawn(shellCmd, {
    cwd: opts.workdir,
    env: spawnEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: true,
    detached: process.platform !== 'win32',
  });
  agentLog(`[spawn] pid=${proc.pid}`);

  const closeInput = () => {
    if (idleCloseTimer) {
      clearTimeout(idleCloseTimer);
      idleCloseTimer = null;
    }
    if (stdinClosed) return;
    stdinClosed = true;
    try { proc.stdin?.end(); } catch {}
  };

  const PRINT_STREAM_CHUNK_CHARS = 20;
  const PRINT_STREAM_CHUNK_INTERVAL_MS = 20;
  let displayedLen = 0;
  let streamTickTimer: ReturnType<typeof setTimeout> | null = null;
  const rawEmit = () => {
    opts.onText(s.text.slice(0, displayedLen), s.thinking, s.activity, buildStreamPreviewMeta(s), s.plan);
  };
  const scheduleStreamTick = () => {
    if (streamTickTimer || displayedLen >= s.text.length) return;
    streamTickTimer = setTimeout(() => {
      streamTickTimer = null;
      if (displayedLen >= s.text.length) return;
      displayedLen = Math.min(s.text.length, displayedLen + PRINT_STREAM_CHUNK_CHARS);
      rawEmit();
      scheduleStreamTick();
    }, PRINT_STREAM_CHUNK_INTERVAL_MS);
  };
  const flushDisplay = () => {
    if (streamTickTimer) { clearTimeout(streamTickTimer); streamTickTimer = null; }
    displayedLen = s.text.length;
    rawEmit();
  };
  const emit = () => { rawEmit(); scheduleStreamTick(); };

  const abortStream = () => {
    if (interrupted || proc.killed) return;
    interrupted = true;
    s.stopReason = 'interrupted';
    closeInput();
    agentWarn(`[abort] user interrupt, closing stdin for graceful shutdown pid=${proc.pid}`);
    const sessionFile = s.sessionId
      ? path.join(getHome(), '.claude', 'projects', claudeProjectDirName(opts.workdir), `${s.sessionId}.jsonl`)
      : null;
    const FILE_STABLE_MS = 600;
    const POLL_MS = 100;
    const MAX_WAIT_MS = 6000;
    const startedAt = Date.now();
    let lastSize = -1;
    let lastChangedAt = startedAt;
    const tick = () => {
      if (proc.exitCode != null || proc.killed) return;
      let curSize = lastSize;
      if (sessionFile) {
        try { curSize = fs.statSync(sessionFile).size; } catch {  }
      }
      if (curSize !== lastSize) {
        lastSize = curSize;
        lastChangedAt = Date.now();
      }
      const stableFor = Date.now() - lastChangedAt;
      const totalElapsed = Date.now() - startedAt;
      const shouldKill = !sessionFile
        ? totalElapsed >= AGENT_GRACEFUL_ABORT_GRACE_MS
        : (stableFor >= FILE_STABLE_MS || totalElapsed >= MAX_WAIT_MS);
      if (shouldKill) {
        const reason = !sessionFile
          ? `no JSONL, fixed grace ${totalElapsed}ms`
          : (stableFor >= FILE_STABLE_MS ? `JSONL stable ${stableFor}ms` : `max wait ${totalElapsed}ms`);
        agentWarn(`[abort] ${reason}, killing process tree pid=${proc.pid}`);
        terminateProcessTree(proc, { signal: 'SIGTERM', forceSignal: 'SIGKILL', forceAfterMs: 5000 });
        return;
      }
      setTimeout(tick, POLL_MS);
    };
    setTimeout(tick, POLL_MS);
  };
  if (opts.abortSignal?.aborted) abortStream();
  opts.abortSignal?.addEventListener('abort', abortStream, { once: true });

  const scheduleIdleClose = () => {
    if (idleCloseTimer) clearTimeout(idleCloseTimer);
    idleCloseTimer = setTimeout(() => {
      idleCloseTimer = null;
      if (stdinClosed || interrupted || timedOut || proc.killed || proc.exitCode != null) return;
      agentLog(`[stdin] closing Claude input after ${CLAUDE_STEER_IDLE_CLOSE_MS}ms idle result window`);
      closeInput();
    }, CLAUDE_STEER_IDLE_CLOSE_MS);
  };

  const startsClaudeFollowup = (ev: any): boolean => {
    const evType = ev?.type || '';
    if (evType === 'assistant') return true;
    if (evType !== 'stream_event') return false;
    const innerType = ev?.event?.type || '';
    return innerType === 'message_start' || innerType === 'content_block_delta';
  };

  const sendInput = (
    prompt: string,
    attachments: string[] = [],
    note?: string,
    kind: 'initial' | 'steer' = 'steer',
  ): boolean => {
    if (stdinClosed || interrupted || timedOut || proc.killed || proc.exitCode != null) return false;
    try {
      proc.stdin?.write(buildClaudeUserMessage(prompt, attachments));
      if (kind === 'steer') {
        steerQueued = true;
        if (idleCloseTimer) {
          clearTimeout(idleCloseTimer);
          idleCloseTimer = null;
        }
      }
      if (note) {
        pushRecentActivity(s.recentActivity, note);
        s.activity = s.recentActivity.join('\n');
        emit();
      }
      return true;
    } catch (error: any) {
      agentWarn(`[stdin] failed to write Claude input: ${error?.message || error}`);
      return false;
    }
  };

  if (!sendInput(opts.prompt, opts.attachments || [], undefined, 'initial')) {
    closeInput();
  }
  try {
    opts.onSteerReady?.(async (prompt: string, attachments: string[] = []) => {
      if (!sendInput(prompt, attachments, 'Queued steer input', 'steer')) return false;
      return true;
    });
  } catch (error: any) {
    agentWarn(`[stdin] onSteerReady error: ${error?.message || error}`);
  }

  proc.stderr?.on('data', (c: Buffer) => {
    const chunk = c.toString();
    stderr += chunk;
    agentLog(`[stderr] ${chunk.trim().slice(0, 200)}`);
  });

  const rl = createInterface({ input: proc.stdout!, crlfDelay: Infinity });
  rl.on('line', raw => {
    if (Date.now() > deadline) {
      timedOut = true;
      s.stopReason = 'timeout';
      closeInput();
      agentWarn('[timeout] deadline exceeded, killing process tree');
      terminateProcessTree(proc, { signal: 'SIGKILL' });
      return;
    }
    const line = raw.trim();
    if (!line || line[0] !== '{') return;
    lineCount++;
    try {
      const ev = JSON.parse(line);
      const evType = ev.type || '?';
      if (evType !== 'result' && idleCloseTimer) {
        clearTimeout(idleCloseTimer);
        idleCloseTimer = null;
      }
      if (awaitingSteeredResponseStart && startsClaudeFollowup(ev)) {
        awaitingSteeredResponseStart = false;
        steerQueued = false;
        resetClaudeTurnState(s);
        displayedLen = 0;
        if (streamTickTimer) { clearTimeout(streamTickTimer); streamTickTimer = null; }
      }
      if (evType === 'system' || evType === 'result' || evType === 'assistant') {
        agentLog(`[event] type=${evType} session=${ev.session_id || s.sessionId || '?'} model=${ev.model || s.model || '?'}`);
      }
      if (evType === 'stream_event') {
        const inner = ev.event || {};
        if (inner.type === 'message_start' || inner.type === 'message_delta') {
          agentLog(`[event] stream_event/${inner.type} session=${ev.session_id || s.sessionId || '?'}`);
        }
      }
      claudeParse(ev, s);
      if (evType === 'result') {
        const hasError = !!ev.is_error || (Array.isArray(ev.errors) && ev.errors.length > 0);
        if (hasError) {
          awaitingSteeredResponseStart = false;
          steerQueued = false;
          closeInput();
        } else if (steerQueued) {
          awaitingSteeredResponseStart = true;
          scheduleIdleClose();
        } else {
          closeInput();
        }
        flushDisplay();
      }
      emit();
    } catch {}
  });

  const hardTimer = setTimeout(() => {
    timedOut = true;
    s.stopReason = 'timeout';
    closeInput();
    agentWarn(`[timeout] hard deadline reached (${opts.timeout}s), killing process tree pid=${proc.pid}`);
    terminateProcessTree(proc, { signal: 'SIGTERM', forceSignal: 'SIGKILL', forceAfterMs: 5000 });
  }, opts.timeout * 1000 + AGENT_STREAM_HARD_KILL_GRACE_MS);

  const [procOk, code] = await new Promise<[boolean, number | null]>(resolve => {
    proc.on('close', code => {
      clearTimeout(hardTimer);
      if (idleCloseTimer) {
        clearTimeout(idleCloseTimer);
        idleCloseTimer = null;
      }
      agentLog(`[exit] code=${code} lines_parsed=${lineCount}`);
      resolve([code === 0, code]);
    });
    proc.on('error', e => {
      clearTimeout(hardTimer);
      if (idleCloseTimer) {
        clearTimeout(idleCloseTimer);
        idleCloseTimer = null;
      }
      agentError(`[error] ${e.message}`);
      stderr += e.message;
      resolve([false, -1]);
    });
  });
  opts.abortSignal?.removeEventListener('abort', abortStream);

  if (!s.text.trim() && s.msgs.length) s.text = s.msgs.join('\n\n');
  if (!s.thinking.trim() && s.thinkParts.length) s.thinking = s.thinkParts.join('\n\n');
  flushDisplay();

  const apiErrorReason = detectClaudeApiError(s.text);
  if (apiErrorReason) {
    agentWarn(`[claude] upstream API error detected: ${apiErrorReason}`);
    s.stopReason = 'api_error';
    s.text = '';
    if (!s.errors) s.errors = [`Anthropic API error: ${apiErrorReason}`];
  }

  const errorText = joinErrorMessages(s.errors);
  const ok = procOk && !s.errors && !timedOut && !interrupted;
  const error = errorText
    || (interrupted ? 'Interrupted by user.' : null)
    || (timedOut ? `Timed out after ${opts.timeout}s before the agent reported completion.` : null)
    || (!procOk ? (stderr.trim() || `Failed (exit=${code}).`) : null);
  const incomplete = !ok || s.stopReason === 'max_tokens' || s.stopReason === 'timeout';
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  agentLog(`[result] ok=${ok && !s.errors} elapsed=${elapsed}s text=${s.text.length}chars thinking=${s.thinking.length}chars session=${s.sessionId || '?'}`);
  if (errorText) agentWarn(`[result] errors: ${errorText}`);
  if (s.stopReason) agentLog(`[result] stop_reason=${s.stopReason}`);
  if (stderr.trim() && !procOk) agentWarn(`[result] stderr: ${stderr.trim().slice(0, 300)}`);

  return {
    ok,
    sessionId: s.sessionId,
    workspacePath: null,
    model: s.model,
    thinkingEffort: s.thinkingEffort,
    message: s.text.trim() || errorText || (procOk ? '(no textual response)' : `Failed (exit=${code}).\n\n${stderr.trim() || '(no output)'}`),
    thinking: s.thinking.trim() || null,
    elapsedS: (Date.now() - start) / 1000,
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
    assistantBlocks: s.imageBlocks.length ? [...s.imageBlocks] : undefined,
  };
}

export async function doClaudeStream(opts: StreamOpts): Promise<StreamResult> {
  const result = opts.onSteerReady
    ? await doClaudeInteractiveStream(opts)
    : await run(claudeCmd(opts), opts, claudeParse);
  const retryText = `${result.error || ''}\n${result.message}`;
  if (!result.ok && opts.sessionId && /no conversation found/i.test(retryText)) {
    return doClaudeStream({ ...opts, sessionId: null });
  }
  return result;
}

export const claudeProjectDirName = encodePathAsDirName;

export function normalizeClaudeSessionEntrypoint(workdir: string, sessionId: string | null | undefined): void {
  if (!sessionId) return;
  const home = getHome();
  if (!home) return;
  const file = path.join(home, '.claude', 'projects', claudeProjectDirName(workdir), `${sessionId}.jsonl`);
  try {
    const data = fs.readFileSync(file, 'utf-8');
    if (!data.includes('"entrypoint":"sdk-cli"')) return;
    fs.writeFileSync(file, data.split('"entrypoint":"sdk-cli"').join('"entrypoint":"cli"'));
  } catch {}
}

function extractClaudeTailQA(filePath: string): { lastQuestion: string | null; lastAnswer: string | null; lastMessageText: string | null } {
  const lines = readTailLines(filePath, 1024 * 1024);
  let lastQuestion: string | null = null;
  let lastAnswer: string | null = null;
  let lastMessageText: string | null = null;
  for (const raw of lines) {
    if (!raw || raw[0] !== '{') continue;
    try {
      const ev = JSON.parse(raw);
      if (ev.type === 'user' && ev.isMeta !== true) {
        const text = sanitizeSessionUserPreviewText(extractClaudeText(ev.message?.content, true));
        if (text) {
          lastQuestion = shortValue(text, 500);
          lastMessageText = shortValue(text, 500);
        }
      } else if (ev.type === 'assistant') {
        const text = extractClaudeText(ev.message?.content).trim();
        if (text) {
          lastAnswer = shortValue(text, 500);
          lastMessageText = shortValue(text, 500);
        }
      }
    } catch {  }
  }
  return { lastQuestion, lastAnswer, lastMessageText };
}

interface NativeClaudeContent {
  title: string | null;
  model: string | null;
  numTurns: number | null;
  createdAt: string;
  lastQuestion: string | null;
  lastAnswer: string | null;
  lastMessageText: string | null;
}

const nativeClaudeContentCache = new Map<string, { mtimeMs: number; size: number; content: NativeClaudeContent }>();

function readNativeClaudeContent(filePath: string, stat: fs.Stats): NativeClaudeContent | null {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(65536);
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const head = buf.toString('utf8', 0, bytesRead);
    const lines = head.split('\n');

    let title: string | null = null;
    let model: string | null = null;
    for (const line of lines) {
      if (!line || line[0] !== '{') continue;
      try {
        const ev = JSON.parse(line);
        if (!title && ev.type === 'user' && ev.isMeta !== true) {
          const text = sanitizeSessionUserPreviewText(extractClaudeText(ev.message?.content, true));
          if (text) {
            const display = collapseSkillPrompt(text) ?? text;
            title = display.length <= 120 ? display : `${display.slice(0, 117).trimEnd()}...`;
          }
        }
        if (!model && ev.type === 'assistant' && ev.message?.model && ev.message.model !== '<synthetic>') {
          model = ev.message.model;
        }
        if (title && model) break;
      } catch {  }
    }
    if (!title) {
      let scanStr = head;
      if (stat.size > 65536) {
        try {
          const fd2 = fs.openSync(filePath, 'r');
          const bigBuf = Buffer.alloc(Math.min(10 * 1024 * 1024, stat.size));
          const bigRead = fs.readSync(fd2, bigBuf, 0, bigBuf.length, 0);
          fs.closeSync(fd2);
          scanStr = bigBuf.toString('utf8', 0, bigRead);
        } catch {  }
      }
      const re = /"type":"text","text":"((?:[^"\\]|\\.)*)"/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(scanStr)) !== null) {
        let raw = m[1]
          .replace(/\\n/g, ' ').replace(/\\t/g, ' ')
          .replace(/\\"/g, '"').replace(/\\\\/g, '\\')
          .replace(/\s+/g, ' ').trim();
        if (!raw || raw.startsWith('<') || raw.startsWith('[Image:')) continue;
        raw = stripInjectedPrompts(raw);
        if (!raw) continue;
        const display = collapseSkillPrompt(raw) ?? raw;
        title = display.length <= 120 ? display : `${display.slice(0, 117).trimEnd()}...`;
        break;
      }
    }

    let numTurns = 0;
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const rawLines = raw.split('\n');
      for (const rl of rawLines) {
        if (rl.length <= 2 || !rl.includes('"type":"user"')) continue;
        if (rl.includes('"tool_result"') || rl.includes('"isMeta":true')) continue;
        numTurns++;
      }
    } catch {  }

    const tailQA = extractClaudeTailQA(filePath);
    return {
      title,
      model,
      numTurns: numTurns || null,
      createdAt: stat.birthtime.toISOString(),
      lastQuestion: tailQA.lastQuestion,
      lastAnswer: tailQA.lastAnswer,
      lastMessageText: tailQA.lastMessageText,
    };
  } catch {
    return null;
  }
}

function getNativeClaudeSessions(workdir: string, limit?: number): SessionInfo[] {
  const home = getHome();
  if (!home) return [];
  const projectDir = path.join(home, '.claude', 'projects', claudeProjectDirName(workdir));
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(projectDir, { withFileTypes: true }); } catch { return []; }

  const files: { sessionId: string; filePath: string; stat: fs.Stats }[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    const filePath = path.join(projectDir, entry.name);
    try { files.push({ sessionId: entry.name.slice(0, -6), filePath, stat: fs.statSync(filePath) }); } catch {  }
  }
  files.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  const selected = typeof limit === 'number' ? files.slice(0, Math.max(0, limit)) : files;

  const sessions: SessionInfo[] = [];
  for (const { sessionId, filePath, stat } of selected) {
    const cached = nativeClaudeContentCache.get(filePath);
    let content: NativeClaudeContent;
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      content = cached.content;
    } else {
      const parsed = readNativeClaudeContent(filePath, stat);
      if (!parsed) continue;
      content = parsed;
      nativeClaudeContentCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, content });
    }
    const isRunning = isClaudeNativeSessionRunning(filePath, stat.mtimeMs);
    sessions.push({
      sessionId,
      agent: 'claude',
      workdir,
      workspacePath: null,
      model: content.model,
      createdAt: content.createdAt,
      title: content.title,
      running: isRunning,
      runState: isRunning ? 'running' : 'completed',
      runDetail: null,
      runUpdatedAt: stat.mtime.toISOString(),
      classification: null,
      userStatus: null,
      userNote: null,
      lastQuestion: content.lastQuestion,
      lastAnswer: content.lastAnswer,
      lastMessageText: content.lastMessageText,
      migratedFrom: null,
      migratedTo: null,
      linkedSessions: [],
      numTurns: content.numTurns,
    });
  }
  return sessions;
}

function getClaudeSessions(workdir: string, limit?: number): SessionListResult {
  const resolvedWorkdir = path.resolve(workdir);
  const pikiloomSessions = listPikiloomSessions(resolvedWorkdir, 'claude').map(managedRecordToSessionInfo);
  const nativeSessions = getNativeClaudeSessions(resolvedWorkdir, limit);
  const merged = mergeManagedAndNativeSessions(pikiloomSessions, nativeSessions);
  const sessions = typeof limit === 'number' ? merged.slice(0, limit) : merged;
  const projectDir = path.join(getHome(), '.claude', 'projects', claudeProjectDirName(resolvedWorkdir));
  agentLog(
    `[sessions:claude] workdir=${resolvedWorkdir} projectDir=${projectDir} projectDirExists=${fs.existsSync(projectDir)} ` +
    `pikiloom=${pikiloomSessions.length} native=${nativeSessions.length} merged=${sessions.length}`
  );
  return { ok: true, sessions, error: null };
}

function extractClaudeText(content: any, skipSystemBlocks = false): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      if (skipSystemBlocks && block.text.startsWith('<')) continue;
      parts.push(block.text);
    }
  }
  return parts.join('\n\n');
}

function getClaudeSessionTail(opts: SessionTailOpts): SessionTailResult {
  const limit = opts.limit ?? 4;
  const projectDir = path.join(getHome(), '.claude', 'projects', claudeProjectDirName(opts.workdir));
  const filePath = path.join(projectDir, `${opts.sessionId}.jsonl`);

  if (!fs.existsSync(filePath)) {
    return { ok: false, messages: [], error: 'Session file not found' };
  }

  try {
    const lines = readTailLines(filePath);
    const allMsgs: { role: 'user' | 'assistant'; text: string }[] = [];
    for (const raw of lines) {
      if (!raw || raw[0] !== '{') continue;
      try {
        const ev = JSON.parse(raw);
        if (ev.type === 'user') {
          const text = stripInjectedPrompts(extractClaudeText(ev.message?.content, true));
          if (text) allMsgs.push({ role: 'user', text });
        } else if (ev.type === 'assistant') {
          const text = extractClaudeText(ev.message?.content, true);
          if (text) allMsgs.push({ role: 'assistant', text });
        }
      } catch {  }
    }
    return { ok: true, messages: allMsgs.slice(-limit), error: null };
  } catch (e: any) {
    return { ok: false, messages: [], error: e.message };
  }
}

function claudeImageBlockFromEntry(entry: any): MessageBlock | null {
  if (!entry || entry.type !== 'image' || !entry.source) return null;
  const source = entry.source;
  if (source.type !== 'base64' || typeof source.data !== 'string') return null;
  if (source.data.length > 12 * 1024 * 1024) return null;
  const mime = (source.media_type || 'image/png').toLowerCase();
  return { type: 'image', content: `data:${mime};base64,${source.data}`, imageMime: mime };
}

function extractClaudeBlocks(
  content: any,
  skipSystemBlocks = false,
  todoWriteToolIds?: Set<string>,
  toolNamesByUseId?: ReadonlyMap<string, string>,
): MessageBlock[] {
  if (typeof content === 'string') return [{ type: 'text', content }];
  if (!Array.isArray(content)) return [];
  const blocks: MessageBlock[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      if (skipSystemBlocks && block.text.startsWith('<')) continue;
      blocks.push({ type: 'text', content: block.text });
    } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
      blocks.push({ type: 'thinking', content: block.thinking });
    } else if (block.type === 'tool_use') {
      if (block.name === 'TodoWrite' && todoWriteToolIds) {
        const plan = parseTodoWriteAsPlan(block.input);
        if (plan) {
          todoWriteToolIds.add(block.id);
          blocks.push({ type: 'plan', content: '', plan, toolId: block.id });
          continue;
        }
      }
      const inputStr = block.input ? JSON.stringify(block.input, null, 2) : '';
      blocks.push({ type: 'tool_use', content: inputStr, toolName: block.name || 'unknown', toolId: block.id });
    } else if (block.type === 'tool_result') {
      const resultText = typeof block.content === 'string'
        ? block.content
        : Array.isArray(block.content)
          ? block.content.filter((c: any) => c?.type === 'text').map((c: any) => c.text).join('\n')
          : '';
      blocks.push({ type: 'tool_result', content: resultText, toolId: block.tool_use_id });
      const toolName = block.tool_use_id ? toolNamesByUseId?.get(block.tool_use_id) : undefined;
      if (Array.isArray(block.content) && !isClaudeFileReadingTool(toolName)) {
        for (const inner of block.content) {
          const img = claudeImageBlockFromEntry(inner);
          if (img) blocks.push(img);
        }
      }
    } else if (block.type === 'image') {
      const img = claudeImageBlockFromEntry(block);
      if (img) blocks.push(img);
    }
  }
  return blocks;
}

const SYSTEM_INJECTED_USER_TAGS = new Set([
  'task-notification',
  'system-reminder',
  'persisted-output',
  'local-command-stdout',
  'local-command-caveat',
  'local-command-stderr',
  'ide_opened_file',
  'ide_diagnostics',
  'ide_selection',
  'event',
  'analysis',
  'case_id',
  'tool-use-id',
  'output-file',
]);

function isClaudeSyntheticResumeNoise(text: string): boolean {
  const t = (text || '').trim().toLowerCase();
  if (!t) return true;
  return t === 'no response requested.' || t === 'no response requested';
}

function isSystemInjectedUserEvent(text: string): boolean {
  const trimmed = (text || '').trim();
  if (!trimmed) return true;
  if (/^\[Request interrupted by user(?: for tool use)?\]$/i.test(trimmed)) return true;
  const leading = trimmed.match(/^<([a-z][a-z0-9_-]*)\b/i);
  if (leading && SYSTEM_INJECTED_USER_TAGS.has(leading[1].toLowerCase())) return true;
  const lower = trimmed.toLowerCase();
  const markers = ['continued from a previous', 'summary below covers', 'earlier portion of the conversation', 'here is a summary of', 'conversation summary'];
  return markers.some(m => lower.includes(m));
}

function getClaudeSessionMessages(opts: SessionMessagesOpts): SessionMessagesResult {
  const projectDir = path.join(getHome(), '.claude', 'projects', claudeProjectDirName(opts.workdir));
  const filePath = path.join(projectDir, `${opts.sessionId}.jsonl`);

  if (!fs.existsSync(filePath)) {
    return { ok: false, messages: [], totalTurns: 0, error: 'Session file not found' };
  }

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());

    const allMsgs: TailMessage[] = [];
    const richMsgs: RichMessage[] = [];

    let pendingRole: 'user' | 'assistant' | null = null;
    let pendingTextParts: string[] = [];
    let pendingBlocks: MessageBlock[] = [];
    let pendingUsage: { input: number | null; output: number | null; cacheRead: number | null; cacheCreation: number | null; model: string | null } | null = null;
    let pendingCallOutputs = new Map<string, number>();
    const todoWriteToolIds = new Set<string>();
    const subAgentBlocksById = new Map<string, MessageBlock>();
    const subAgentToolIds = new Set<string>();
    const toolNamesByUseId = new Map<string, string>();

    const flush = () => {
      if (!pendingRole) return;
      const text = pendingTextParts.join('\n\n');
      if (text || pendingBlocks.length) {
        allMsgs.push({ role: pendingRole, text });
        let turnOutput = 0;
        for (const v of pendingCallOutputs.values()) turnOutput += v;
        const usage = pendingRole === 'assistant' && pendingUsage
          ? buildClaudeTurnUsage(pendingUsage, turnOutput)
          : null;
        richMsgs.push({ role: pendingRole, text, blocks: [...pendingBlocks], usage });
      }
      pendingRole = null;
      pendingTextParts = [];
      pendingBlocks = [];
      pendingUsage = null;
      pendingCallOutputs = new Map();
      subAgentBlocksById.clear();
      subAgentToolIds.clear();
      toolNamesByUseId.clear();
    };

    for (const raw of lines) {
      if (!raw || raw[0] !== '{') continue;
      try {
        const ev = JSON.parse(raw);
        const parentToolUseId: string | null = (typeof ev.parent_tool_use_id === 'string' && ev.parent_tool_use_id) ? ev.parent_tool_use_id : null;

        if (parentToolUseId) {
          const block = subAgentBlocksById.get(parentToolUseId);
          if (!block?.subAgent) continue;
          const sub = block.subAgent;
          if (ev.type === 'assistant') {
            const model = ev.model ?? ev.message?.model;
            if (typeof model === 'string' && model.trim()) sub.model = model;
            const contents = Array.isArray(ev.message?.content) ? ev.message.content : [];
            for (const inner of contents) {
              if (inner?.type !== 'tool_use') continue;
              const toolId = String(inner?.id || '').trim();
              if (!toolId) continue;
              const toolName = String(inner?.name || 'Tool').trim() || 'Tool';
              subAgentToolIds.add(toolId);
              const summary = toolName === 'TodoWrite' ? 'Update plan' : summarizeClaudeToolUse(inner?.name, inner?.input || {});
              if (!sub.tools.some(t => t.id === toolId)) {
                sub.tools.push({ id: toolId, name: toolName, summary });
              }
            }
          }
          continue;
        }

        if (ev.type === 'user') {
          if (ev.isMeta === true) {
            if (pendingRole === 'assistant') {
              const toolUseId = typeof ev.sourceToolUseID === 'string' ? ev.sourceToolUseID : '';
              if (toolUseId && !todoWriteToolIds.has(toolUseId) && !subAgentToolIds.has(toolUseId)) {
                const text = extractClaudeText(ev.message?.content, false);
                if (text) {
                  pendingBlocks.push({ type: 'tool_result', content: text, toolId: toolUseId });
                }
              }
            }
            continue;
          }

          const contentArr = ev.message?.content;
          const isToolResult = Array.isArray(contentArr)
            && contentArr.length > 0
            && contentArr.every((b: any) => b?.type === 'tool_result');

          if (isToolResult) {
            if (pendingRole === 'assistant') {
              for (const block of contentArr) {
                const toolUseId = block.tool_use_id;
                if (todoWriteToolIds.has(toolUseId)) continue;
                if (subAgentToolIds.has(toolUseId)) continue;
                const subBlock = subAgentBlocksById.get(toolUseId);
                if (subBlock?.subAgent) {
                  subBlock.subAgent.status = block?.is_error ? 'failed' : 'done';
                  const resultText = typeof block.content === 'string'
                    ? block.content
                    : Array.isArray(block.content)
                      ? block.content.filter((c: any) => c?.type === 'text').map((c: any) => c.text).join('\n')
                      : '';
                  if (resultText) subBlock.content = resultText;
                  continue;
                }
                const resultText = typeof block.content === 'string'
                  ? block.content
                  : Array.isArray(block.content)
                    ? block.content.filter((c: any) => c?.type === 'text').map((c: any) => c.text).join('\n')
                    : '';
                if (resultText) {
                  pendingBlocks.push({ type: 'tool_result', content: resultText, toolId: toolUseId });
                }
                const toolName = toolNamesByUseId.get(toolUseId);
                if (Array.isArray(block.content) && !isClaudeFileReadingTool(toolName)) {
                  for (const inner of block.content) {
                    const img = claudeImageBlockFromEntry(inner);
                    if (img) pendingBlocks.push(img);
                  }
                }
              }
            }
            continue;
          }

          if (pendingRole === 'assistant') {
            const probe = extractClaudeText(ev.message?.content, true);
            if (isSystemInjectedUserEvent(probe)) continue;
          }

          flush();
          const rawText = stripInjectedPrompts(extractClaudeText(ev.message?.content, true));
          const userBlocks = extractClaudeBlocks(ev.message?.content, true);
          const imageBlocks: MessageBlock[] = userBlocks.filter(b => b.type === 'image');
          let displayText = rawText;
          if (typeof ev.message?.content === 'string' && imageBlocks.length === 0) {
            const recoveredPaths = new Set<string>();
            for (const absPath of extractClaudeAtMentionImagePaths(rawText)) {
              const block = attachAgentImage({ imagePath: absPath });
              if (!block) continue;
              imageBlocks.push(block);
              recoveredPaths.add(absPath);
            }
            if (recoveredPaths.size) {
              displayText = rawText.replace(
                CLAUDE_AT_MENTION_IMAGE_RE,
                (full, leading, p) => recoveredPaths.has(p) ? (leading || '') : full,
              );
            }
          }
          // Preserve the user's line breaks: this is the actual message body shown in the bubble
          // (whitespace-pre-wrap), not a one-line preview. Collapsing \s+ here flattened multi-line
          // prompts into a single run once the turn hit the transcript. Session-list titles/previews
          // are sanitized separately via sanitizeSessionUserPreviewText.
          const text = displayText.replace(SESSION_PREVIEW_IMAGE_PLACEHOLDER_RE, '').replace(/\r\n?/g, '\n').trim();
          if (text || imageBlocks.length) {
            pendingRole = 'user';
            pendingTextParts = text ? [text] : [];
            pendingBlocks = text ? [{ type: 'text', content: text }, ...imageBlocks] : [...imageBlocks];
          }
        } else if (ev.type === 'assistant') {
          if (ev.message?.model === '<synthetic>') {
            const noticeText = extractClaudeText(ev.message?.content, true).trim();
            if (isClaudeSyntheticResumeNoise(noticeText)) continue;
            if (pendingRole === 'user') flush();
            pendingRole = 'assistant';
            if (noticeText) pendingBlocks.push({ type: 'system_notice', content: noticeText });
            continue;
          }
          if (pendingRole === 'user') flush();
          pendingRole = 'assistant';
          const u = ev.message?.usage;
          if (u && typeof u === 'object') {
            const numOrNull = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : null;
            const prevModel: string | null = pendingUsage ? pendingUsage.model : null;
            pendingUsage = {
              input: numOrNull(u.input_tokens),
              output: numOrNull(u.output_tokens),
              cacheRead: numOrNull(u.cache_read_input_tokens),
              cacheCreation: numOrNull(u.cache_creation_input_tokens),
              model: typeof ev.message?.model === 'string' ? ev.message.model : prevModel,
            };
            const output = numOrNull(u.output_tokens);
            if (output != null) {
              const msgId = typeof ev.message?.id === 'string' && ev.message.id ? ev.message.id : '(no-id)';
              pendingCallOutputs.set(msgId, output);
            }
          }
          const text = extractClaudeText(ev.message?.content, true);
          if (text) pendingTextParts.push(text);
          const assistantContents = Array.isArray(ev.message?.content) ? ev.message.content : [];
          for (const inner of assistantContents) {
            if (inner?.type === 'tool_use' && typeof inner.id === 'string' && typeof inner.name === 'string') {
              toolNamesByUseId.set(inner.id, inner.name);
            }
          }
          const blocks = extractClaudeBlocks(ev.message?.content, true, todoWriteToolIds, toolNamesByUseId);
          const contents = Array.isArray(ev.message?.content) ? ev.message.content : [];
          for (let i = 0; i < blocks.length; i++) {
            const block = blocks[i];
            if (block.type !== 'tool_use') continue;
            if (block.toolName !== 'Task' && block.toolName !== 'Agent') continue;
            const raw = contents.find((c: any) => c?.type === 'tool_use' && c?.id === block.toolId);
            const input = raw?.input || {};
            const subAgent: StreamSubAgent = {
              id: block.toolId || '',
              kind: typeof input.subagent_type === 'string' ? input.subagent_type : null,
              description: typeof input.description === 'string' ? input.description : null,
              model: null,
              tools: [],
              status: 'running',
            };
            const subBlock: MessageBlock = { type: 'sub_agent', content: '', toolId: block.toolId, subAgent };
            blocks[i] = subBlock;
            if (subAgent.id) subAgentBlocksById.set(subAgent.id, subBlock);
          }
          pendingBlocks.push(...blocks);
        }
      } catch {  }
    }
    flush();

    const subAgentsDir = path.join(projectDir, opts.sessionId, 'subagents');
    if (fs.existsSync(subAgentsDir)) hydrateSubAgentBlocksFromSidecar(richMsgs, subAgentsDir);

    return applyTurnWindow(allMsgs, opts, opts.rich ? richMsgs : undefined);
  } catch (e: any) {
    return { ok: false, messages: [], totalTurns: 0, error: e.message };
  }
}

function hydrateSubAgentBlocksFromSidecar(richMsgs: RichMessage[], subAgentsDir: string): void {
  let entries: string[];
  try { entries = fs.readdirSync(subAgentsDir); } catch { return; }
  const sidecars = new Map<string, { kind: string | null; tools: Array<{ id: string; name: string; summary: string }>; model: string | null }>();
  for (const name of entries) {
    if (!name.endsWith('.jsonl')) continue;
    const id = name.replace(/\.jsonl$/, '');
    const metaPath = path.join(subAgentsDir, `${id}.meta.json`);
    let metaKind: string | null = null;
    let metaDescription: string | null = null;
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
      metaKind = typeof meta?.agentType === 'string' ? meta.agentType : null;
      metaDescription = typeof meta?.description === 'string' ? meta.description : null;
    } catch {  }
    const tools: Array<{ id: string; name: string; summary: string }> = [];
    let model: string | null = null;
    try {
      const content = fs.readFileSync(path.join(subAgentsDir, name), 'utf-8');
      for (const raw of content.split('\n')) {
        if (!raw || raw[0] !== '{') continue;
        let ev: any;
        try { ev = JSON.parse(raw); } catch { continue; }
        if (ev.type !== 'assistant') continue;
        const msg = ev.message || {};
        if (typeof msg.model === 'string' && msg.model.trim()) model = msg.model;
        const contents = Array.isArray(msg.content) ? msg.content : [];
        for (const block of contents) {
          if (block?.type !== 'tool_use') continue;
          const toolId = String(block?.id || '').trim();
          if (!toolId || tools.some(t => t.id === toolId)) continue;
          const toolName = String(block?.name || 'Tool').trim() || 'Tool';
          const summary = toolName === 'TodoWrite' ? 'Update plan' : summarizeClaudeToolUse(block?.name, block?.input || {});
          tools.push({ id: toolId, name: toolName, summary });
        }
      }
    } catch { continue; }
    if (metaDescription) {
      sidecars.set(metaDescription, { kind: metaKind, tools, model });
    }
  }
  if (sidecars.size === 0) return;
  for (const msg of richMsgs) {
    for (const block of msg.blocks) {
      if (block.type !== 'sub_agent' || !block.subAgent || !block.subAgent.description) continue;
      const sidecar = sidecars.get(block.subAgent.description);
      if (!sidecar) continue;
      if (!block.subAgent.kind && sidecar.kind) block.subAgent.kind = sidecar.kind;
      if (!block.subAgent.model && sidecar.model) block.subAgent.model = sidecar.model;
      if (block.subAgent.tools.length === 0 && sidecar.tools.length > 0) block.subAgent.tools = sidecar.tools;
    }
  }
}

const CLAUDE_MODELS: ModelInfo[] = [
  { id: 'claude-fable-5', alias: 'fable' },
  { id: 'claude-opus-4-8', alias: 'opus' },
  { id: 'claude-sonnet-5', alias: 'sonnet' },
  { id: 'claude-haiku-4-5-20251001', alias: 'haiku' },
];

const CLAUDE_USAGE_QUERY_TTL_MS = 5 * 60_000;
const claudeUsageCache: { lastGood: UsageResult | null; lastAttemptAt: number } = { lastGood: null, lastAttemptAt: 0 };

function getClaudeOAuthToken(): string | null {
  if (!IS_MAC) return null;
  try {
    const raw = execSync('security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null', {
      encoding: 'utf-8', timeout: 3000,
    }).trim();
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed?.claudeAiOauth?.accessToken || null;
  } catch { return null; }
}

// Shape the `/api/oauth/usage` JSON into a UsageResult (shared by the sync curl probe and the
// async fetch probe). Returns null on an API error payload or when no usable window is present.
function buildClaudeOAuthUsage(data: any): UsageResult | null {
  const apiError = data?.error;
  if (apiError && typeof apiError === 'object') return null;

  const makeWindow = (label: string, entry: any): UsageWindowInfo | null => {
    if (!entry || typeof entry !== 'object') return null;
    const usedPercent = roundPercent(entry.utilization);
    if (usedPercent == null) return null;
    const remainingPercent = Math.max(0, Math.round((100 - usedPercent) * 10) / 10);
    const resetAt = typeof entry.resets_at === 'string' ? entry.resets_at : null;
    let resetAfterSeconds: number | null = null;
    if (resetAt) {
      const resetAtMs = Date.parse(resetAt);
      if (Number.isFinite(resetAtMs)) resetAfterSeconds = Math.max(0, Math.round((resetAtMs - Date.now()) / 1000));
    }
    return {
      label, usedPercent, remainingPercent, resetAt, resetAfterSeconds,
      status: usedPercent >= 100 ? 'limit_reached' : usedPercent >= 80 ? 'warning' : 'allowed',
    };
  };

  const windows: UsageWindowInfo[] = [];
  for (const [label, key] of [['5h', 'five_hour'], ['7d', 'seven_day'], ['7d Opus', 'seven_day_opus'], ['7d Sonnet', 'seven_day_sonnet'], ['Extra', 'extra_usage']] as const) {
    const w = makeWindow(label, (data as any)[key]);
    if (w) windows.push(w);
  }
  if (!windows.length) return null;

  const overallStatus = windows.some(w => w.status === 'limit_reached') ? 'limit_reached'
    : windows.some(w => w.status === 'warning') ? 'warning' : 'allowed';

  return { ok: true, agent: 'claude', source: 'oauth-api', capturedAt: new Date().toISOString(), status: overallStatus, windows, error: null };
}

function getClaudeUsageFromOAuth(tokenOverride?: string): UsageResult | null {
  const token = tokenOverride || getClaudeOAuthToken();
  if (!token) return null;
  try {
    const raw = execSync(
      `curl -s --max-time 5 -H "Authorization: Bearer ${token}" -H "anthropic-beta: oauth-2025-04-20" -H "Content-Type: application/json" "https://api.anthropic.com/api/oauth/usage"`,
      { encoding: 'utf-8', timeout: 8000 },
    ).trim();
    if (!raw || raw[0] !== '{') return null;
    return buildClaudeOAuthUsage(JSON.parse(raw));
  } catch { return null; }
}

// Non-blocking variant for the live (getUsageLive) path — execSync would stall the event loop.
async function fetchClaudeUsageFromOAuth(tokenOverride?: string): Promise<UsageResult | null> {
  const token = tokenOverride || getClaudeOAuthToken();
  if (!token) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: {
        authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'content-type': 'application/json',
      },
      signal: controller.signal,
    });
    const data = await res.json().catch(() => null);
    return data ? buildClaudeOAuthUsage(data) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Single read channel for the native / default-login quota (`/api/oauth/usage` with the keychain
// token). The read costs no inference tokens but the endpoint RATE-LIMITS aggressive polling
// (observed: `rate_limit_error` payloads, which parse to null) — so `fresh` re-reads only after
// 15s, and a failed read backs off 60s serving the last good result. Concurrent callers share
// one request.
const NATIVE_USAGE_FRESH_TTL_MS = 15_000;
const NATIVE_USAGE_RETRY_TTL_MS = 60_000;
const claudeNativeUsageLive: { at: number; failedAt: number; inflight: Promise<UsageResult | null> | null } = { at: 0, failedAt: 0, inflight: null };

export function claudeNativeUsage(opts?: { fresh?: boolean }): Promise<UsageResult | null> {
  const maxAge = opts?.fresh ? NATIVE_USAGE_FRESH_TTL_MS : CLAUDE_USAGE_QUERY_TTL_MS;
  const now = Date.now();
  if (claudeUsageCache.lastGood && now - claudeNativeUsageLive.at < maxAge) {
    return Promise.resolve(claudeUsageCache.lastGood);
  }
  if (now - claudeNativeUsageLive.failedAt < NATIVE_USAGE_RETRY_TTL_MS) {
    return Promise.resolve(claudeUsageCache.lastGood);
  }
  if (claudeNativeUsageLive.inflight) return claudeNativeUsageLive.inflight;
  const p = fetchClaudeUsageFromOAuth()
    .then(fresh => {
      if (fresh) {
        claudeUsageCache.lastGood = fresh;
        claudeUsageCache.lastAttemptAt = Date.now();
        claudeNativeUsageLive.at = Date.now();
        claudeNativeUsageLive.failedAt = 0;
      } else {
        claudeNativeUsageLive.failedAt = Date.now();
      }
      return fresh ?? claudeUsageCache.lastGood;
    })
    .finally(() => { claudeNativeUsageLive.inflight = null; });
  claudeNativeUsageLive.inflight = p;
  return p;
}

// Per-account usage for a specific account's `claude setup-token`.
//
// IMPORTANT: setup-tokens are minted with the `user:inference` scope only — they do NOT carry
// `user:profile`, so the read-only OAuth usage endpoint (`/api/oauth/usage`) rejects them with
// `permission_error … scope requirement user:profile`. The native/default-login token works
// there because it's a full login. So for account tokens we read the limit state from the
// `anthropic-ratelimit-unified-*` *response headers* of a tiny inference call instead — those
// headers come back on every `/v1/messages` response regardless of scope, and are exactly what
// Claude Code itself uses to learn 5h / 7d limits. Cost is ~1 output token per probe, so reads
// are tiered by how fresh the caller needs to be:
//   default -> 5min TTL (background warmers, non-interactive surfaces)
//   fresh   -> 20s min re-probe interval (user is actively looking at the numbers)
//   force   -> bypass everything (identity just changed, e.g. account switch)
// Failures back off 60s on the default/fresh tiers (force still retries), and in-flight de-dup
// makes concurrent surfaces (cards + header + IM) share one probe.
const TOKEN_USAGE_OK_TTL_MS = CLAUDE_USAGE_QUERY_TTL_MS;
const TOKEN_USAGE_FRESH_TTL_MS = 20_000;
const TOKEN_USAGE_RETRY_TTL_MS = 60_000;
const CLAUDE_USAGE_PROBE_MODEL = 'claude-haiku-4-5-20251001';
const claudeTokenUsageCache = new Map<string, { value: UsageResult | null; at: number; ok: boolean }>();
const claudeTokenUsageInflight = new Map<string, Promise<UsageResult | null>>();

function usageFromRatelimitHeaders(h: Headers): UsageResult | null {
  const makeWindow = (label: string, prefix: string): UsageWindowInfo | null => {
    const raw = h.get(`anthropic-ratelimit-unified-${prefix}-utilization`);
    if (raw == null || raw === '') return null;
    const usedPercent = roundPercent(Number(raw) * 100);
    if (usedPercent == null) return null;
    const remainingPercent = Math.max(0, Math.round((100 - usedPercent) * 10) / 10);
    const resetAt = toIsoFromEpochSeconds(h.get(`anthropic-ratelimit-unified-${prefix}-reset`));
    let resetAfterSeconds: number | null = null;
    if (resetAt) {
      const resetAtMs = Date.parse(resetAt);
      if (Number.isFinite(resetAtMs)) resetAfterSeconds = Math.max(0, Math.round((resetAtMs - Date.now()) / 1000));
    }
    return {
      label, usedPercent, remainingPercent, resetAt, resetAfterSeconds,
      status: usedPercent >= 100 ? 'limit_reached' : usedPercent >= 80 ? 'warning' : 'allowed',
    };
  };
  // Only 5h + 7d are real here. The inference headers expose an overage (Extra) on/off STATUS
  // but never a utilization number, and `/api/oauth/usage` (which returns the actual extra_usage
  // figure) is scope-blocked for setup-tokens — so we deliberately do NOT synthesize an "Extra"
  // window for token accounts. Showing a fabricated 0% misrepresents real Extra spend.
  const windows = [makeWindow('5h', '5h'), makeWindow('7d', '7d')].filter((w): w is UsageWindowInfo => w != null);
  if (!windows.length) return null;
  const overallStatus = windows.some(w => w.status === 'limit_reached') ? 'limit_reached'
    : windows.some(w => w.status === 'warning') ? 'warning' : 'allowed';
  return { ok: true, agent: 'claude', source: 'ratelimit-headers', capturedAt: new Date().toISOString(), status: overallStatus, windows, error: null };
}

async function claudeUsageFromInferenceHeaders(token: string): Promise<UsageResult | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: CLAUDE_USAGE_PROBE_MODEL, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
      signal: controller.signal,
    });
    // The unified rate-limit headers ride on every response (incl. 429), so parse them before
    // worrying about the status code. Drain the body so the socket can be reused/closed.
    const usage = usageFromRatelimitHeaders(res.headers);
    void res.text().catch(() => {});
    return usage;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function claudeUsageForToken(token: string, opts?: { force?: boolean; fresh?: boolean }): Promise<UsageResult | null> {
  const t = String(token || '');
  if (!t) return Promise.resolve(null);
  const now = Date.now();
  const cached = claudeTokenUsageCache.get(t);
  if (cached && !opts?.force) {
    const ttl = cached.ok
      ? (opts?.fresh ? TOKEN_USAGE_FRESH_TTL_MS : TOKEN_USAGE_OK_TTL_MS)
      : TOKEN_USAGE_RETRY_TTL_MS;
    if (now - cached.at < ttl) return Promise.resolve(cached.value);
  }
  const inflight = claudeTokenUsageInflight.get(t);
  if (inflight) return inflight;
  const p = (async () => {
    const fresh = await claudeUsageFromInferenceHeaders(t);
    const at = Date.now();
    if (fresh) {
      claudeTokenUsageCache.set(t, { value: fresh, at, ok: true });
      return fresh;
    }
    // Probe failed (network / transient): keep serving last-good, but back off retries.
    const value = claudeTokenUsageCache.get(t)?.value ?? null;
    claudeTokenUsageCache.set(t, { value, at, ok: false });
    return value;
  })().finally(() => claudeTokenUsageInflight.delete(t));
  claudeTokenUsageInflight.set(t, p);
  return p;
}

function getClaudeUsageFromTelemetry(home: string, model?: string | null): UsageResult | null {
  const telemetryRoot = path.join(home, '.claude', 'telemetry');
  if (!fs.existsSync(telemetryRoot)) return null;

  const preferredFamily = modelFamily(model);
  type Candidate = { capturedAtMs: number; capturedAt: string; status: string | null; hoursTillReset: number | null; model: string | null };
  let bestAny: Candidate | null = null;
  let bestMatch: Candidate | null = null;

  try {
    const files = fs.readdirSync(telemetryRoot)
      .filter(name => name.endsWith('.json'))
      .map(name => ({ full: path.join(telemetryRoot, name), mtime: fs.statSync(path.join(telemetryRoot, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 50);

    for (const file of files) {
      const lines = fs.readFileSync(file.full, 'utf-8').trim().split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const raw = lines[i];
        if (!raw || raw[0] !== '{' || !raw.includes('tengu_claudeai_limits_status_changed')) continue;
        let parsed: any;
        try { parsed = JSON.parse(raw); } catch { continue; }
        const data = parsed?.event_data;
        if (data?.event_name !== 'tengu_claudeai_limits_status_changed') continue;
        const capturedAtMs = Date.parse(data.client_timestamp || '');
        if (!Number.isFinite(capturedAtMs)) continue;
        let meta = data.additional_metadata;
        if (typeof meta === 'string') { try { meta = JSON.parse(meta); } catch { meta = null; } }
        const hoursTillReset = Number(meta?.hoursTillReset);
        const candidate: Candidate = {
          capturedAtMs, capturedAt: new Date(capturedAtMs).toISOString(),
          status: typeof meta?.status === 'string' ? meta.status : null,
          hoursTillReset: Number.isFinite(hoursTillReset) ? hoursTillReset : null,
          model: typeof data.model === 'string' ? data.model : null,
        };
        if (!bestAny || candidate.capturedAtMs > bestAny.capturedAtMs) bestAny = candidate;
        if (preferredFamily && candidate.model?.toLowerCase().includes(preferredFamily)) {
          if (!bestMatch || candidate.capturedAtMs > bestMatch.capturedAtMs) bestMatch = candidate;
        }
      }
    }
  } catch { return null; }

  const chosen = bestMatch || bestAny;
  if (!chosen) return null;

  const status = normalizeUsageStatus(chosen.status);
  const resetAfterSeconds = chosen.hoursTillReset == null ? null : Math.max(0, Math.round(chosen.hoursTillReset * 3600));
  const resetAt = resetAfterSeconds == null ? null : new Date(chosen.capturedAtMs + resetAfterSeconds * 1000).toISOString();
  const ageMs = Date.now() - chosen.capturedAtMs;
  const ageMins = Math.round(ageMs / 60_000);
  const ageLabel = ageMins < 1 ? '<1m ago' : ageMins < 60 ? `${ageMins}m ago` : ageMins < 1440 ? `${Math.round(ageMins / 60)}h ago` : `${Math.round(ageMins / 1440)}d ago`;
  const windows: UsageWindowInfo[] = [{ label: ageLabel, usedPercent: null, remainingPercent: null, resetAt, resetAfterSeconds, status }];

  return { ok: true, agent: 'claude', source: 'telemetry', capturedAt: chosen.capturedAt, status, windows, error: null };
}

export type ClaudeNativeGoalStatus = 'active' | 'complete';

export interface ClaudeNativeGoal {
  condition: string;
  status: ClaudeNativeGoalStatus;
  met: boolean;
  updatedAtMs: number;
}

function claudeSessionTranscriptPath(workdir: string, sessionId: string): string {
  const home = getHome();
  if (!home || !workdir || !sessionId) return '';
  return path.join(home, '.claude', 'projects', encodePathAsDirName(workdir), `${sessionId}.jsonl`);
}

export function getClaudeNativeGoal(workdir: string, sessionId: string): ClaudeNativeGoal | null {
  const file = claudeSessionTranscriptPath(workdir, sessionId);
  if (!file || !fs.existsSync(file)) return null;
  const lines = readTailLines(file, 1024 * 1024);
  let latest: ClaudeNativeGoal | null = null;
  for (const raw of lines) {
    if (!raw || raw[0] !== '{') continue;
    if (!raw.includes('"goal_status"')) continue;
    try {
      const ev = JSON.parse(raw);
      const att = ev?.attachment;
      if (!att || att.type !== 'goal_status') continue;
      const condition = typeof att.condition === 'string' ? att.condition : '';
      const met = !!att.met;
      const ts = typeof ev.timestamp === 'string' ? Date.parse(ev.timestamp) : NaN;
      latest = {
        condition,
        met,
        status: met || !condition ? 'complete' : 'active',
        updatedAtMs: Number.isFinite(ts) ? ts : Date.now(),
      };
    } catch {  }
  }
  if (latest && latest.met) return null;
  return latest;
}

export function buildClaudeSetGoalPrompt(objective: string): string {
  return `/goal ${objective.trim()}`;
}

export function buildClaudeClearGoalPrompt(): string {
  return '/goal clear';
}

export function isClaudePrintModeForced(): boolean {
  const print = (process.env.PIKILOOM_CLAUDE_PRINT ?? '').trim().toLowerCase();
  if (print === '1' || print === 'true' || print === 'yes' || print === 'on') return true;
  const tui = (process.env.PIKILOOM_CLAUDE_TUI ?? '').trim().toLowerCase();
  if (tui === '0' || tui === 'false' || tui === 'no' || tui === 'off') return true;
  return false;
}

async function doClaudeStreamOnce(opts: StreamOpts): Promise<StreamResult> {
  const printMode = opts.claudeAccessMode
    ? opts.claudeAccessMode === 'api'
    : isClaudePrintModeForced();
  if (printMode) {
    agentLog(`[claude] print mode (-p) — ${opts.claudeAccessMode === 'api' ? 'access mode: api (Agent SDK credits)' : 'forced via env'}`);
    return doClaudeStream(opts);
  }
  try {
    const mod = await import('./claude-tui.js');
    return await mod.doClaudeTuiStream(opts);
  } catch (err: any) {
    agentWarn(`[claude] TUI unavailable (${err?.message || err}); falling back to -p — this turn bills the Agent SDK credit pool`);
    return doClaudeStream(opts);
  }
}

const CLAUDE_API_RETRY_BACKOFFS_MS = [4000, 12000];

function makeOverloadFriendlyResult(result: StreamResult, reason: string, attempts: number): StreamResult {
  const wait = CLAUDE_API_RETRY_BACKOFFS_MS.slice(0, attempts).reduce((sum, ms) => sum + ms, 0);
  const elapsedNote = wait > 0 ? ` (retried ${attempts}× over ${Math.round(wait / 1000)}s)` : '';
  const message = [
    `Anthropic API temporarily overloaded${elapsedNote}.`,
    `Reason from upstream: ${reason}.`,
    'Please re-send your last message in a moment — your session is intact and will resume from where it stopped.',
  ].join(' ');
  return {
    ...result,
    ok: false,
    incomplete: true,
    stopReason: 'api_error',
    message,
    error: `Anthropic API error: ${reason}`,
  };
}

const CLAUDE_STALL_RESUME_PROMPT =
  '[pikiloom] The previous agent process stalled mid-turn and was restarted. '
  + 'Continue the task from where it left off — do not start over or repeat work that already completed.';

const CLAUDE_STALL_RESUME_LIMIT = 1;

async function doClaudeWithRetry(opts: StreamOpts): Promise<StreamResult> {
  let lastResult = await doClaudeStreamOnce(opts);
  let stallResumes = 0;
  while (
    lastResult.stopReason === 'stalled'
    && stallResumes < CLAUDE_STALL_RESUME_LIMIT
    && !opts.abortSignal?.aborted
  ) {
    const stalledSessionId = lastResult.sessionId || opts.sessionId;
    if (!stalledSessionId) break;
    stallResumes++;
    agentWarn(`[claude] turn stalled mid-flight; auto-resuming session ${stalledSessionId.slice(0, 8)} (${stallResumes}/${CLAUDE_STALL_RESUME_LIMIT})`);
    lastResult = await doClaudeStreamOnce({
      ...opts,
      sessionId: stalledSessionId,
      forkOf: undefined,
      prompt: CLAUDE_STALL_RESUME_PROMPT,
      attachments: undefined,
    });
  }
  if (lastResult.stopReason === 'stalled') {
    return {
      ...lastResult,
      ok: false,
      incomplete: true,
      message: [
        'The agent process stalled mid-turn and could not be auto-recovered (a known claude CLI mid-turn freeze).',
        'Your session is intact — re-send your message (or say "continue") to pick up where it stopped.',
      ].join(' '),
    };
  }
  let attempts = 0;
  const reasonOf = (r: StreamResult): string | null => {
    if (r.stopReason !== 'api_error') return null;
    const m = (r.error || '').match(/^Anthropic API error:\s*(.+)$/i);
    return m ? m[1].trim() : null;
  };
  while (attempts < CLAUDE_API_RETRY_BACKOFFS_MS.length) {
    const reason = reasonOf(lastResult);
    if (!reason || !isRetryableClaudeApiError(reason)) break;
    const wait = CLAUDE_API_RETRY_BACKOFFS_MS[attempts];
    attempts++;
    agentWarn(`[claude] API error "${reason}", retry ${attempts}/${CLAUDE_API_RETRY_BACKOFFS_MS.length} after ${wait}ms`);
    if (opts.abortSignal?.aborted) {
      agentWarn('[claude] retry skipped — abort signal already fired');
      break;
    }
    await new Promise(r => setTimeout(r, wait));
    if (opts.abortSignal?.aborted) {
      agentWarn('[claude] retry skipped after backoff — abort signal fired');
      break;
    }
    const nextOpts: StreamOpts = {
      ...opts,
      sessionId: lastResult.sessionId || opts.sessionId,
    };
    lastResult = await doClaudeStreamOnce(nextOpts);
  }
  const finalReason = reasonOf(lastResult);
  if (finalReason) {
    return makeOverloadFriendlyResult(lastResult, finalReason, attempts);
  }
  return lastResult;
}

class ClaudeDriver implements AgentDriver {
  readonly id = 'claude';
  readonly cmd = 'claude';
  readonly thinkLabel = 'Thinking';
  readonly capabilities = { fork: true, modelSwitch: true, workflow: true };
  readonly acceptedProviderKinds = ['anthropic', 'openai-compatible'] as const;

  async doStream(opts: StreamOpts): Promise<StreamResult> {
    const result = await doClaudeWithRetry(opts);
    normalizeClaudeSessionEntrypoint(opts.workdir, result.sessionId);
    return result;
  }

  async getSessions(workdir: string, limit?: number): Promise<SessionListResult> {
    return getClaudeSessions(workdir, limit);
  }

  async getSessionTail(opts: SessionTailOpts): Promise<SessionTailResult> {
    return getClaudeSessionTail(opts);
  }

  async getSessionMessages(opts: SessionMessagesOpts): Promise<SessionMessagesResult> {
    return getClaudeSessionMessages(opts);
  }

  async listModels(_opts: ModelListOpts): Promise<ModelListResult> {
    return { agent: 'claude', models: [...CLAUDE_MODELS], sources: [], note: null };
  }

  getUsage(opts: UsageOpts): UsageResult {
    const home = getHome();
    if (!home) return emptyUsage('claude', 'HOME is not set.');
    const telemetry = () => getClaudeUsageFromTelemetry(home, opts.model)
      || emptyUsage('claude', 'No recent Claude usage data found.');

    const now = Date.now();
    if (now - claudeUsageCache.lastAttemptAt < CLAUDE_USAGE_QUERY_TTL_MS) {
      return claudeUsageCache.lastGood ?? telemetry();
    }
    claudeUsageCache.lastAttemptAt = now;
    const oauth = getClaudeUsageFromOAuth();
    if (oauth) {
      claudeUsageCache.lastGood = oauth;
      return oauth;
    }
    return claudeUsageCache.lastGood ?? telemetry();
  }

  // Live usage for the agent-status surface. Unlike getUsage it ignores the 5-min query TTL
  // (modulo the short fresh window that coalesces bursts), so a freshly-switched login (the
  // keychain default-login token changed) is reflected promptly instead of serving the previous
  // account's frozen `lastGood`. Bounded by the caller's usage timeout, cached value as fallback.
  async getUsageLive(opts: UsageOpts): Promise<UsageResult> {
    const home = getHome();
    if (!home) return emptyUsage('claude', 'HOME is not set.');
    const fresh = await claudeNativeUsage({ fresh: true });
    return fresh
      ?? getClaudeUsageFromTelemetry(home, opts.model)
      ?? emptyUsage('claude', 'No recent Claude usage data found.');
  }

  async deleteNativeSession(workdir: string, sessionId: string): Promise<string[]> {
    const file = claudeSessionTranscriptPath(workdir, sessionId);
    if (!file || !fs.existsSync(file)) return [];
    try { fs.rmSync(file, { force: true }); return [file]; } catch { return []; }
  }

  shutdown() {}
}

registerDriver(new ClaudeDriver());
