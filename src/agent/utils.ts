import fs from 'node:fs';
import type {
  StreamPreviewMeta,
  StreamPreviewPlan,
  StreamPreviewPlanStep,
  StreamSubAgent,
  StreamToolCall,
  UsageResult,
  UsageWindowInfo,
  Agent,
  SessionInfo,
} from './types.js';
import { writeScopedLog, type LogLevel } from '../core/logging.js';

export const Q = (a: string) => {
  if (/[^a-zA-Z0-9_./:=@-]/.test(a)) {
    return process.platform === 'win32'
      ? `"${a.replace(/"/g, '""')}"`
      : `'${a.replace(/'/g, "'\\''")}'`;
  }
  return a;
};

export function agentLog(msg: string, level: LogLevel = 'debug') {
  writeScopedLog('agent', msg, { level });
}

export function agentWarn(msg: string) {
  agentLog(msg, 'warn');
}

export function agentError(msg: string) {
  agentLog(msg, 'error');
}

export function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const value of values) {
    const item = String(value || '').trim();
    if (!item || seen.has(item)) continue;
    seen.add(item);
    deduped.push(item);
  }
  return deduped;
}

export function numberOrNull(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

export function normalizeStreamPreviewPlan(value: unknown): StreamPreviewPlan | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const rawSteps = Array.isArray(record.steps)
    ? record.steps
    : Array.isArray(record.plan)
      ? record.plan
      : [];
  const steps = rawSteps
    .map((entry): StreamPreviewPlanStep | null => {
      if (!entry || typeof entry !== 'object') return null;
      const step = typeof (entry as any).step === 'string' ? (entry as any).step.trim() : '';
      if (!step) return null;
      const rawStatus = typeof (entry as any).status === 'string' ? (entry as any).status : 'pending';
      const status = rawStatus === 'completed' || rawStatus === 'inProgress' || rawStatus === 'pending'
        ? rawStatus
        : 'pending';
      return { step, status };
    })
    .filter((entry): entry is StreamPreviewPlanStep => !!entry);
  if (!steps.length) return null;
  return {
    explanation: typeof record.explanation === 'string' && record.explanation.trim() ? record.explanation.trim() : null,
    steps,
  };
}

export function parseTodoWriteAsPlan(input: any): StreamPreviewPlan | null {
  if (!input || typeof input !== 'object') return null;
  const rawTodos = Array.isArray(input.todos) ? input.todos : [];
  if (!rawTodos.length) return null;
  const steps: StreamPreviewPlanStep[] = [];
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

// Apply a TaskUpdate to a TodoWrite-produced plan positionally (taskId = 1-based item index).
// Used when the id isn't in the TaskCreate store, so an update issued AFTER a TodoWrite still
// lands on the displayed list — the plan card always reflects the state after the LAST change,
// whichever mechanism wrote it. Returns a fresh plan (never mutates) or null when inapplicable.
export function applyClaudeTaskUpdateToPlan(
  plan: StreamPreviewPlan | null | undefined,
  taskId: string,
  rawStatus: string,
): StreamPreviewPlan | null {
  if (!plan || !Array.isArray(plan.steps) || !plan.steps.length) return null;
  if (!/^\d+$/.test(taskId)) return null;
  const idx = Number(taskId) - 1;
  if (idx < 0 || idx >= plan.steps.length) return null;
  if (rawStatus === 'deleted') {
    const steps = plan.steps.filter((_, i) => i !== idx);
    return steps.length ? { explanation: plan.explanation ?? null, steps } : null;
  }
  const status = rawStatus === 'completed' ? 'completed'
    : rawStatus === 'in_progress' || rawStatus === 'inprogress' ? 'inProgress'
      : rawStatus === 'pending' ? 'pending' : null;
  if (!status) return null;
  const steps = plan.steps.map((step, i) => i === idx ? { ...step, status } : step);
  return { explanation: plan.explanation ?? null, steps };
}

export function normalizeActivityLine(text: string): string { return text.replace(/\s+/g, ' ').trim(); }

export function pushRecentActivity(lines: string[], line: string, maxLines = 80) {
  const cleaned = normalizeActivityLine(line);
  if (!cleaned) return;
  if (lines[lines.length - 1] === cleaned) return;
  lines.push(cleaned);
  if (lines.length > maxLines) lines.splice(0, lines.length - maxLines);
}

export function firstNonEmptyLine(text: string): string {
  for (const line of String(text || '').split('\n')) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

export function coerceToolResultText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .filter((c: any) => c && c.type === 'text' && typeof c.text === 'string')
      .map((c: any) => c.text)
      .join('\n');
  }
  return '';
}

export function shortValue(value: unknown, max = 90): string {
  const text = typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
  if (!text) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}

export function normalizeErrorMessage(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (value instanceof Error) return value.message.trim();
  if (Array.isArray(value)) {
    return value.map(item => normalizeErrorMessage(item)).filter(Boolean).join('; ').trim();
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const preferred = normalizeErrorMessage(record.message)
      || normalizeErrorMessage(record.error)
      || normalizeErrorMessage(record.detail)
      || normalizeErrorMessage(record.type)
      || normalizeErrorMessage(record.code)
      || normalizeErrorMessage(record.status);
    if (preferred) return preferred;
    try { return JSON.stringify(value).trim(); } catch {}
  }
  return value == null ? '' : String(value).trim();
}

export function joinErrorMessages(errors: unknown[] | null | undefined): string {
  if (!errors?.length) return '';
  return errors.map(error => normalizeErrorMessage(error)).filter(Boolean).join('; ').trim();
}

export function detectClaudeApiError(text: string | null | undefined): string | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (trimmed.length > 200 || trimmed.includes('\n')) return null;
  const m = trimmed.match(/^API Error:\s*(.+)$/i);
  return m ? m[1].trim() : null;
}

export function isRetryableClaudeApiError(reason: string): boolean {
  const r = reason.toLowerCase();
  if (/rate limit|rate limited|quota|usage limit|session limit/i.test(r)) return false;
  return /overloaded|overload|timeout|timed out|500|502|503|504|529|temporar|gateway|connection|network|internal (server )?error/i.test(r);
}

export function detectClaudeModelError(text: string | null | undefined): boolean {
  if (!text) return false;
  const collapsed = text.replace(/\s+/g, '').toLowerCase();
  return collapsed.includes('issuewiththeselectedmodel')
    || collapsed.includes('maynotexistoryoumaynothaveaccess');
}

export function claudeModelErrorMessage(model: string | null | undefined): string {
  const id = (model || '').trim();
  return `The selected model${id ? ` (${id})` : ''} is unavailable — it may not exist, or this account doesn't have access to it. Switch to a different model in pikiloom settings.`;
}

export function appendSystemPrompt(base: string | undefined, extra: string): string {
  const lhs = String(base || '').trim();
  const rhs = String(extra || '').trim();
  if (!lhs) return rhs;
  if (!rhs) return lhs;
  return `${lhs}\n\n${rhs}`;
}

export function mimeForExt(ext: string): string {
  switch (ext) {
    case '.jpg': case '.jpeg': return 'image/jpeg';
    case '.png': return 'image/png';
    case '.gif': return 'image/gif';
    case '.webp': return 'image/webp';
    default: return 'application/octet-stream';
  }
}

export function computeContext(s: {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  cacheCreationInputTokens: number | null;
  contextWindow: number | null;
  contextUsedTokens?: number | null;
}) {
  const fallbackTotal = (s.inputTokens ?? 0) + (s.cachedInputTokens ?? 0) + (s.cacheCreationInputTokens ?? 0);
  const used = s.contextUsedTokens ?? (fallbackTotal > 0 ? fallbackTotal : null);
  const pct = used != null && s.contextWindow
    ? Math.min(99.9, Math.round(used / s.contextWindow * 1000) / 10)
    : null;
  return { contextUsedTokens: used, contextPercent: pct };
}

const PREVIEW_TOOL_CALLS_MAX = 40;

export function buildStreamPreviewMeta(s: {
  inputTokens: number | null; outputTokens: number | null;
  cachedInputTokens: number | null; cacheCreationInputTokens: number | null;
  contextWindow: number | null; contextUsedTokens?: number | null;
  turnOutputTokensBase?: number | null;
  thinkingEstTokens?: number | null;
  byokProviderName?: string | null;
  byokProfileName?: string | null;
  subAgents?: ReadonlyMap<string, StreamSubAgent> | null;
  generatingImages?: number;
  claudeToolsById?: ReadonlyMap<string, { name: string; summary: string; input?: string | null; result?: string | null; status?: 'running' | 'done' | 'failed' }> | null;
  claudeToolCallOrder?: readonly string[] | null;
}): StreamPreviewMeta {
  const ctx = computeContext(s);
  const meta: StreamPreviewMeta = {
    inputTokens: s.inputTokens, outputTokens: s.outputTokens,
    cachedInputTokens: s.cachedInputTokens,
    contextUsedTokens: ctx.contextUsedTokens, contextPercent: ctx.contextPercent,
  };
  // The live thinking estimate stands in for output while a message is still streaming
  // (silent extended thinking); the real output_tokens supersedes it once reported.
  const turnOutput = (s.turnOutputTokensBase ?? 0) + Math.max(s.outputTokens ?? 0, s.thinkingEstTokens ?? 0);
  if (turnOutput > 0) meta.turnOutputTokens = turnOutput;
  if (s.byokProviderName) meta.providerName = s.byokProviderName;
  if (s.byokProfileName) meta.profileName = s.byokProfileName;
  if (s.subAgents && s.subAgents.size > 0) meta.subAgents = Array.from(s.subAgents.values());
  if (s.generatingImages && s.generatingImages > 0) meta.generatingImages = s.generatingImages;
  if (s.claudeToolCallOrder?.length && s.claudeToolsById) {
    const calls: StreamToolCall[] = [];
    for (const id of s.claudeToolCallOrder.slice(-PREVIEW_TOOL_CALLS_MAX)) {
      const tool = s.claudeToolsById.get(id);
      if (!tool) continue;
      calls.push({
        id,
        name: tool.name,
        summary: tool.summary,
        input: tool.input ?? null,
        result: tool.result ?? null,
        status: tool.status ?? 'running',
      });
    }
    if (calls.length) meta.toolCalls = calls;
  }
  return meta;
}

export function previewToolCallInput(name: string, input: any, max = 500): string | null {
  if (input == null) return null;
  if (String(name) === 'Bash') {
    const cmd = typeof input.command === 'string' ? input.command.trim() : '';
    return cmd ? clipText(cmd, max) : null;
  }
  try {
    const json = JSON.stringify(input, null, 1);
    if (!json || json === '{}' || json === 'null') return null;
    return clipText(json, max);
  } catch { return null; }
}

export function previewToolCallResult(content: any, max = 500): string | null {
  if (content == null) return null;
  if (typeof content === 'string') return clipText(content.trim(), max) || null;
  if (Array.isArray(content)) {
    const text = content
      .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
      .map((b: any) => b.text)
      .join('\n')
      .trim();
    return text ? clipText(text, max) : null;
  }
  if (typeof content === 'object') {
    if (content.content != null && content.content !== content) {
      const nested = previewToolCallResult(content.content, max);
      if (nested) return nested;
    }
    if (typeof content.result === 'string') return clipText(content.result.trim(), max) || null;
    try {
      const json = JSON.stringify(content, null, 1);
      if (!json || json === '{}') return null;
      return clipText(json, max);
    } catch { return null; }
  }
  return null;
}

function clipText(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

export function summarizeClaudeToolUse(name: string, input: any): string {
  const tool = String(name || '').trim() || 'Tool';
  const description = shortValue(input?.description, 120);
  switch (tool) {
    case 'Read': { const t = shortValue(input?.file_path || input?.path, 140); return t ? `Read ${t}` : 'Read file'; }
    case 'Edit': { const t = shortValue(input?.file_path || input?.path, 140); return t ? `Edit ${t}` : 'Edit file'; }
    case 'Write': { const t = shortValue(input?.file_path || input?.path, 140); return t ? `Write ${t}` : 'Write file'; }
    case 'Glob': { const p = shortValue(input?.pattern || input?.glob, 120); return p ? `List files: ${p}` : 'List files'; }
    case 'Grep': { const p = shortValue(input?.pattern || input?.query, 120); return p ? `Search text: ${p}` : 'Search text'; }
    case 'WebFetch': { const u = shortValue(input?.url, 120); return u ? `Fetch ${u}` : 'Fetch web page'; }
    case 'WebSearch': { const q = shortValue(input?.query, 120); return q ? `Search web: ${q}` : 'Search web'; }
    case 'TodoWrite': return 'Update plan';
    case 'TaskCreate': { const subject = shortValue(input?.subject, 120); return subject ? `Create task: ${subject}` : 'Create task'; }
    case 'TaskUpdate': {
      const taskId = shortValue(input?.taskId, 24);
      const status = shortValue(input?.status, 24);
      return taskId ? `Update task ${taskId}${status ? ` → ${status}` : ''}` : 'Update task';
    }
    case 'AskUserQuestion': {
      const qs = Array.isArray(input?.questions) ? input.questions : [];
      const first = qs[0];
      const q = shortValue(first?.question || input?.question, 120);
      return q ? `Ask user: ${q}` : 'Ask user';
    }
    case 'Task': { const p = shortValue(input?.description || input?.prompt, 120); return p ? `Run task: ${p}` : 'Run task'; }
    case 'Bash': {
      if (description) return `Run shell: ${description}`;
      const c = shortValue(input?.command, 120);
      return c ? `Run shell: ${c}` : 'Run shell command';
    }
    default: {
      const mcpMatch = tool.match(/^mcp__[^_]+__(.+)$/);
      const bare = mcpMatch ? mcpMatch[1] : tool;
      if (bare === 'im_send_file') {
        const p = shortValue(input?.path, 120);
        return p ? `Send file: ${p}` : 'Send file';
      }
      if (bare === 'im_list_files') return 'List workspace files';
      if (bare === 'im_ask_user') {
        const q = shortValue(input?.question, 120);
        return q ? `Ask user: ${q}` : 'Ask user';
      }
      if (description) return `${tool}: ${description}`;
      const d = shortValue(input?.file_path || input?.path || input?.command || input?.query || input?.pattern || input?.url, 120);
      return d ? `${tool}: ${d}` : tool;
    }
  }
}

export function summarizeClaudeToolResult(
  tool: { name: string; summary: string } | undefined,
  block: any, toolUseResult: any,
): string {
  const summary = tool?.summary || shortValue(tool?.name || 'Tool', 120) || 'Tool';
  const isError = !!block?.is_error;
  const contentText = coerceToolResultText(block?.content);
  if (isError) {
    const detail = firstNonEmptyLine(toolUseResult?.stderr || toolUseResult?.stdout || contentText);
    return detail ? `${summary} failed: ${shortValue(detail, 120)}` : `${summary} failed`;
  }
  const toolName = tool?.name || '';
  if (toolName === 'Read' || toolName === 'Edit' || toolName === 'Write' || toolName === 'TodoWrite') return `${summary} done`;
  const detail = firstNonEmptyLine(toolUseResult?.stdout || contentText || toolUseResult?.stderr || '');
  if (!detail) return `${summary} done`;
  return `${summary} -> ${shortValue(detail, 120)}`;
}

export function roundPercent(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n * 10) / 10));
}

export function toIsoFromEpochSeconds(value: unknown): string | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n * 1000).toISOString();
}

export function normalizeUsageStatus(value: unknown): string | null {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!raw) return null;
  const normalized = raw.replace(/[\s-]+/g, '_');
  if (normalized === 'limit_reached' || normalized === 'warning' || normalized === 'allowed') return normalized;
  if (normalized.includes('limit') || normalized.includes('exceeded') || normalized.includes('denied')) return 'limit_reached';
  if (normalized.includes('warning') || normalized.includes('warn')) return 'warning';
  if (normalized.includes('allowed') || normalized === 'ok' || normalized === 'healthy' || normalized === 'ready' || normalized === 'normal') return 'allowed';
  return normalized;
}

export function labelFromWindowMinutes(value: unknown, fallback: string): string {
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes <= 0) return fallback;
  const roundedMinutes = Math.round(minutes);
  if (Math.abs(roundedMinutes - 300) <= 2) return '5h';
  if (Math.abs(roundedMinutes - 10080) <= 5) return '7d';
  // Codex team/enterprise plans meter on a monthly window reported as the average month
  // length (365d/12 = 43800min = 730h) — without this branch it renders as "730h".
  if (Math.abs(roundedMinutes - 43800) <= 60) return '1mo';

  const roundedDays = Math.round(roundedMinutes / 1440);
  if (roundedDays >= 1 && Math.abs(roundedMinutes - roundedDays * 1440) <= 5) return `${roundedDays}d`;

  const roundedHours = Math.round(roundedMinutes / 60);
  if (roundedHours >= 1 && Math.abs(roundedMinutes - roundedHours * 60) <= 2) return `${roundedHours}h`;

  return `${roundedMinutes}m`;
}

export function usageWindowFromRateLimit(fallback: string, limit: any): UsageWindowInfo | null {
  if (!limit || typeof limit !== 'object') return null;
  const usedPercent = roundPercent(limit.used_percent);
  const remainingPercent = usedPercent == null ? null : Math.max(0, Math.round((100 - usedPercent) * 10) / 10);
  const resetAt = toIsoFromEpochSeconds(limit.reset_at ?? limit.resets_at);
  let resetAfterSeconds: number | null = null;
  const directResetAfter = Number(limit.reset_after_seconds);
  if (Number.isFinite(directResetAfter) && directResetAfter >= 0) resetAfterSeconds = Math.round(directResetAfter);
  else if (resetAt) {
    const resetAtMs = Date.parse(resetAt);
    if (Number.isFinite(resetAtMs)) resetAfterSeconds = Math.max(0, Math.round((resetAtMs - Date.now()) / 1000));
  }
  return {
    label: labelFromWindowMinutes(limit.window_minutes, fallback),
    usedPercent, remainingPercent, resetAt, resetAfterSeconds,
    status: normalizeUsageStatus(limit.status),
  };
}

export function parseJsonTail(raw: string): any | null {
  const start = raw.indexOf('{');
  if (start < 0) return null;
  try { return JSON.parse(raw.slice(start)); } catch { return null; }
}

export function modelFamily(model: string | null | undefined): string | null {
  const lower = model?.toLowerCase() || '';
  if (!lower) return null;
  if (lower.includes('fable')) return 'fable';
  if (lower.includes('opus')) return 'opus';
  if (lower.includes('sonnet')) return 'sonnet';
  return null;
}

export function normalizeClaudeModelId(model: unknown): string {
  return typeof model === 'string' ? model.trim() : '';
}

export function emptyUsage(agent: Agent, error: string): UsageResult {
  return { ok: false, agent, source: null, capturedAt: null, status: null, windows: [], error };
}

export function readTailLines(filePath: string, maxBytes = 256 * 1024): string[] {
  try {
    const stat = fs.statSync(filePath);
    const readSize = Math.min(maxBytes, stat.size);
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(readSize);
    fs.readSync(fd, buf, 0, readSize, stat.size - readSize);
    fs.closeSync(fd);
    return buf.toString('utf-8').split('\n').filter(l => l.trim());
  } catch { return []; }
}

export function stripInjectedPrompts(text: string): string {
  const markers = ['\n[Session Workspace]'];
  for (const m of markers) {
    const idx = text.indexOf(m);
    if (idx >= 0) text = text.slice(0, idx).trim();
  }
  if (text.startsWith('# Context from')) {
    const tag = '## My request for Codex:\n';
    const idx = text.indexOf(tag);
    if (idx >= 0) return text.slice(idx + tag.length).trim();
    return '';
  }
  return text;
}

export const SESSION_PREVIEW_IGNORED_USER_PATTERNS = [
  /^\[Request interrupted by user(?: for tool use)?\]$/i,
];

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
  // Kernel claude driver's in-process truncated-turn recovery prompt (see packages/kernel
  // drivers/claude.ts): injected on the CLI's stdin, so it lands in the jsonl as a real user
  // message — hide it from the transcript like other system-injected turns.
  'pikiloom-recover',
]);

export function isSystemInjectedUserText(text: string): boolean {
  const trimmed = (text || '').trim();
  if (!trimmed) return true;
  if (/^\[Request interrupted by user(?: for tool use)?\]$/i.test(trimmed)) return true;
  const leading = trimmed.match(/^<([a-z][a-z0-9_-]*)\b/i);
  if (leading && SYSTEM_INJECTED_USER_TAGS.has(leading[1].toLowerCase())) return true;
  const lower = trimmed.toLowerCase();
  const markers = ['continued from a previous', 'summary below covers', 'earlier portion of the conversation', 'here is a summary of', 'conversation summary'];
  return markers.some(m => lower.includes(m));
}

export const SESSION_PREVIEW_IMAGE_PLACEHOLDER_RE = /\[Image:[^\]]+\]/gi;
export const SESSION_PREVIEW_FILE_PLACEHOLDER_RE = /\[Attached file:[^\]]+\]/gi;

export const CLAUDE_AT_MENTION_IMAGE_RE = /(^|\s)@(\/[^\s@\n]+\.(?:png|jpe?g|gif|webp|svg))(?=\s|$)/gi;

export function extractClaudeAtMentionImagePaths(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const m of text.matchAll(CLAUDE_AT_MENTION_IMAGE_RE)) out.push(m[2]);
  return out;
}

export function stripClaudeAtMentionImages(text: string): string {
  if (!text) return text;
  return text.replace(CLAUDE_AT_MENTION_IMAGE_RE, (_full, leading) => leading || '');
}

export function sanitizeSessionUserPreviewText(text: string): string {
  const cleaned = stripInjectedPrompts(text)
    .replace(SESSION_PREVIEW_IMAGE_PLACEHOLDER_RE, ' ')
    .replace(SESSION_PREVIEW_FILE_PLACEHOLDER_RE, ' ')
    .replace(CLAUDE_AT_MENTION_IMAGE_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';
  if (SESSION_PREVIEW_IGNORED_USER_PATTERNS.some(pattern => pattern.test(cleaned))) return '';
  return cleaned;
}

export function isPendingSessionId(sessionId: string | null | undefined): boolean {
  return typeof sessionId === 'string' && sessionId.startsWith('pending_');
}

export function emitSessionIdUpdate(
  s: { sessionId: any; _emitSessionId?: ((id: string) => void) | null },
  rawId: unknown,
): void {
  if (typeof rawId !== 'string') return;
  const trimmed = rawId.trim();
  if (!trimmed || trimmed === s.sessionId) return;
  s.sessionId = trimmed;
  try { s._emitSessionId?.(trimmed); } catch {  }
}

export function sessionListDisplayTitle(
  session: Pick<SessionInfo, 'title' | 'lastQuestion' | 'sessionId'>,
): string {
  const title = sanitizeSessionUserPreviewText(String(session.title || ''));
  if (title) return title;
  const question = sanitizeSessionUserPreviewText(String(session.lastQuestion || ''));
  if (question) return question;
  return session.sessionId || '';
}
