import { registerDriver, type AgentDriver } from '../driver.js';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { GEMINI_USAGE_TIMEOUTS } from '../../core/constants.js';
import {
  type StreamOpts, type StreamResult,
  type SessionListResult, type SessionInfo, type SessionTailOpts, type SessionTailResult,
  type SessionMessagesOpts, type SessionMessagesResult,
  type TailMessage, type RichMessage, type MessageBlock,
  type ModelListOpts, type ModelListResult,
  type UsageOpts, type UsageResult, type UsageWindowInfo,
} from '../types.js';
import { run } from '../stream.js';
import {
  listPikiloomSessions,
  mergeManagedAndNativeSessions, managedRecordToSessionInfo, applyTurnWindow,
} from '../session.js';
import {
  agentLog, emitSessionIdUpdate, isPendingSessionId, pushRecentActivity,
  appendSystemPrompt, firstNonEmptyLine, shortValue, normalizeErrorMessage,
  stripInjectedPrompts, roundPercent, emptyUsage, resolveAgyModelAndEffort, Q,
} from '../utils.js';
import { attachAgentImage } from '../images.js';
import { getHome } from '../../core/platform.js';

const nodeRequire = createRequire(import.meta.url);

function hasAgyFlag(args: string[] | undefined, names: string[]): boolean {
  if (!args?.length) return false;
  return args.some(arg => {
    const trimmed = String(arg || '').trim();
    if (!trimmed.startsWith('-')) return false;
    return names.some(name => trimmed === name || trimmed.startsWith(`${name}=`));
  });
}

export function buildAgyPromptText(prompt: string, attachments: string[]): string {
  if (!attachments.length) return prompt;
  const refs = attachments.map(p => /\s/.test(p) ? `@"${p}"` : `@${p}`).join(' ');
  return prompt ? `${refs}\n\n${prompt}` : refs;
}

export function agyCmd(o: StreamOpts): string[] {
  const args = ['agy', '--output-format', 'stream-json'];
  const extra = o.agyExtraArgs || o.geminiExtraArgs || [];

  if (!hasAgyFlag(extra, ['--dangerously-skip-permissions'])) {
    args.push('--dangerously-skip-permissions');
  }

  if (o.workdir) {
    args.push('--add-dir', path.resolve(o.workdir));
  }

  const rawModel = o.agyModel || o.geminiModel || o.model || '';
  const rawEffort = o.thinkingEffort || o.agyReasoningEffort || o.geminiReasoningEffort || '';
  const { model, effort } = resolveAgyModelAndEffort(rawModel, rawEffort);

  if (model) args.push('--model', model);

  if (o.sessionId && !isPendingSessionId(o.sessionId)) {
    args.push('--conversation', o.sessionId);
  }

  if (effort) {
    args.push('--effort', effort);
  }

  const sandbox = typeof o.agySandbox === 'boolean'
    ? o.agySandbox
    : (typeof o.geminiSandbox === 'boolean' ? o.geminiSandbox : false);
  if (sandbox && !hasAgyFlag(extra, ['--sandbox'])) {
    args.push('--sandbox');
  }

  if (extra.length) args.push(...extra);

  const userPrompt = buildAgyPromptText(o.prompt, o.attachments || []);
  const sysPrompt = o.agySystemInstruction || o.geminiSystemInstruction;
  const promptText = sysPrompt ? appendSystemPrompt(sysPrompt, userPrompt) : userPrompt;
  args.push('-p', promptText);
  return args;
}

function agyToolLabel(name: string): string {
  return name
    .replace(/^mcp_/, '')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || 'tool';
}

function agyToolSummary(name: unknown, parameters: any): string {
  const tool = typeof name === 'string' ? name.trim() : 'tool';
  const params = parameters && typeof parameters === 'object' ? parameters : {};
  switch (tool) {
    case 'read_file':
    case 'view_file': {
      const target = shortValue(params.AbsolutePath || params.file_path || params.path, 140);
      return target ? `Read ${target}` : 'Read file';
    }
    case 'write_file':
    case 'write_to_file': {
      const target = shortValue(params.TargetFile || params.file_path || params.path, 140);
      return target ? `Write ${target}` : 'Write file';
    }
    case 'replace_file_content':
    case 'replace': {
      const target = shortValue(params.TargetFile || params.file_path || params.path, 140);
      return target ? `Edit ${target}` : 'Edit file';
    }
    case 'list_dir':
    case 'list_directory': {
      const dir = shortValue(params.DirectoryPath || params.dir_path || params.path, 120);
      return dir ? `List files: ${dir}` : 'List files';
    }
    case 'find_by_name':
    case 'glob': {
      const pattern = shortValue(params.Pattern || params.pattern || params.glob, 120);
      return pattern ? `Find files: ${pattern}` : 'Find files';
    }
    case 'grep_search': {
      const pattern = shortValue(params.Query || params.pattern || params.query, 120);
      return pattern ? `Search text: ${pattern}` : 'Search text';
    }
    case 'run_command':
    case 'run_shell_command': {
      const command = shortValue(params.CommandLine || params.command, 120);
      return command ? `Run shell: ${command}` : 'Run shell';
    }
    case 'read_url_content':
    case 'web_fetch': {
      const target = shortValue(params.Url || params.url || params.prompt, 120);
      return target ? `Fetch ${target}` : 'Fetch web page';
    }
    case 'search_web':
    case 'google_web_search': {
      const query = shortValue(params.query, 120);
      return query ? `Search web: ${query}` : 'Search web';
    }
    default: {
      const detail = shortValue(
        params.CommandLine
        || params.AbsolutePath
        || params.TargetFile
        || params.Query
        || params.Pattern
        || params.file_path
        || params.path
        || params.command
        || params.url
        || params.name,
        120,
      );
      const label = shortValue(agyToolLabel(tool), 80);
      return detail ? `Use ${label}: ${detail}` : `Use ${label}`;
    }
  }
}

export function agyContextWindowFromModel(model?: string | null): number {
  return 1_000_000;
}

export function parseAgyEvent(ev: any, s: any) {
  const eventType = ev.event || ev.type || '';

  if (eventType === 'init') {
    const sessId = ev.conversation_id || ev.session_id;
    emitSessionIdUpdate(s, sessId);
    s.model = ev.model ?? s.model;
    s.contextWindow = s.contextWindow || agyContextWindowFromModel(s.model);
    pushRecentActivity(s.recentActivity, 'Thinking...');
    s.activity = s.recentActivity.join('\n');
    return;
  }

  if (eventType === 'step_update' && ev.step_update) {
    const step = ev.step_update;
    if (step.conversation_id) emitSessionIdUpdate(s, step.conversation_id);

    if (step.step_type === 'agent_response') {
      if (step.text_delta) s.text += step.text_delta;
      if (step.usage) {
        s.inputTokens = step.usage.input_tokens ?? s.inputTokens;
        s.outputTokens = step.usage.output_tokens ?? s.outputTokens;
        s.cachedInputTokens = step.usage.cache_read_tokens ?? s.cachedInputTokens;
        if (s.inputTokens != null) s.contextUsedTokens = s.inputTokens;
      }
      return;
    }

    if (step.step_type === 'tool') {
      const name = String(step.tool_name || step.tool_info?.name || 'tool');
      const toolInfo = step.tool_info || {};
      const summary = agyToolSummary(name, toolInfo.parameters || {});
      const id = String(step.step_index ?? s.recentActivity.length);

      if (step.state === 'ACTIVE') {
        pushRecentActivity(s.recentActivity, summary);
        s.activity = s.recentActivity.join('\n');
      } else if (step.state === 'DONE') {
        const out = shortValue(firstNonEmptyLine(normalizeErrorMessage(toolInfo.error) || toolInfo.output || ''), 120);
        const doneSummary = out ? `${summary} -> ${out}` : `${summary} done`;
        pushRecentActivity(s.recentActivity, doneSummary);
        s.activity = s.recentActivity.join('\n');
      }
      return;
    }
    return;
  }

  // Legacy gemini format support
  if (eventType === 'message' && ev.role === 'assistant') {
    if (ev.delta) s.text += ev.content || '';
    else if (!s.text.trim()) s.text = ev.content || '';
    return;
  }

  if (eventType === 'tool_use' || eventType === 'tool_call') {
    const name = String(ev.tool_name || ev.name || ev.tool || 'tool');
    const summary = agyToolSummary(name, ev.parameters || ev.args || ev.input || {});
    if (ev.tool_id && s.geminiToolsById) {
      s.geminiToolsById.set(ev.tool_id, { name, summary });
    }
    pushRecentActivity(s.recentActivity, summary);
    s.activity = s.recentActivity.join('\n');
    return;
  }

  if (eventType === 'tool_result') {
    const prev = ev.tool_id && s.geminiToolsById ? s.geminiToolsById.get(ev.tool_id) : null;
    const prefix = prev?.summary || 'Tool done';
    const out = shortValue(firstNonEmptyLine(normalizeErrorMessage(ev.error) || ev.output || ev.message || ''), 120);
    pushRecentActivity(s.recentActivity, out ? `${prefix} -> ${out}` : `${prefix} done`);
    s.activity = s.recentActivity.join('\n');
    return;
  }

  if (eventType === 'error') {
    const message = normalizeErrorMessage(ev.message || ev.error) || 'Antigravity reported an error';
    if (ev.severity === 'error') {
      s.errors = [...(s.errors || []), message];
    } else {
      pushRecentActivity(s.recentActivity, message);
      s.activity = s.recentActivity.join('\n');
    }
    return;
  }

  if (eventType === 'result') {
    const res = ev.result || ev;
    const sessId = res.conversation_id || res.session_id;
    emitSessionIdUpdate(s, sessId);

    if (res.status === 'ERROR' || res.status === 'error' || res.status === 'failure') {
      let message = normalizeErrorMessage(res.error)
        || normalizeErrorMessage(res.errors)
        || normalizeErrorMessage(res.message)
        || `Antigravity returned status: ${res.status}`;
      if (/RESOURCE_EXHAUSTED/i.test(message) || /Individual quota reached/i.test(message)) {
        s.stopReason = 'quota_exhausted';
        if (!message.includes('New Session') && !message.includes('/new')) {
          message = `${message}\n\nTip: This conversation has grown too large for the model context (~9.4M tokens). Please start a fresh session (click "+ New Session" in the dashboard, or send /new in Telegram).`;
        }
      } else {
        s.stopReason = 'error';
      }
      s.errors = [message];
    } else {
      s.stopReason = 'end_turn';
    }

    if (!s.text.trim() && res.response) {
      s.text = res.response;
    }

    const u = res.usage || res.stats;
    if (u) {
      s.inputTokens = u.input_tokens ?? u.input ?? s.inputTokens;
      s.outputTokens = u.output_tokens ?? u.output ?? s.outputTokens;
      s.cachedInputTokens = u.cache_read_tokens ?? u.cached_tokens ?? u.cached ?? s.cachedInputTokens;
      if (s.inputTokens != null) s.contextUsedTokens = s.inputTokens;
    }
    s.contextWindow = s.contextWindow || agyContextWindowFromModel(s.model);
    return;
  }
}

export function parseAgyStderrLine(line: string, s: any): void {
  if (/RESOURCE_EXHAUSTED/i.test(line) || /Individual quota reached/i.test(line)) {
    let msg = line.replace(/^error:\s*/i, '').trim();
    if (!msg.includes('/new')) {
      msg = `${msg}\n\nTip: Send /new to start a clean session with fresh quota.`;
    }
    if (!s.errors) s.errors = [];
    if (!s.errors.includes(msg)) s.errors.push(msg);
    s.stopReason = 'quota_exhausted';
    return;
  }
  if (/No capacity available/i.test(line) || (/UNAVAILABLE/i.test(line) && /code 503/i.test(line))) {
    let msg = line.replace(/^error:\s*/i, '').trim();
    if (!msg.includes('/models')) {
      msg = `${msg}\n\nTip: Google capacity for this model is temporarily full. Use /models to switch to gemini-3.7-flash-high or claude-sonnet-4-6, or retry in a minute.`;
    }
    if (!s.errors) s.errors = [];
    if (!s.errors.includes(msg)) s.errors.push(msg);
  }
}

export async function doAgyStream(opts: StreamOpts): Promise<StreamResult> {
  const streamOpts = { ...opts, _stdinOverride: '' };
  return await run(agyCmd(opts), streamOpts, parseAgyEvent, parseAgyStderrLine);
}

// ---- Native Session Discovery ----

function agyDbPath(): string | null {
  const home = getHome();
  if (!home) return null;
  const p = path.join(home, '.gemini', 'antigravity-cli', 'conversation_summaries.db');
  return fs.existsSync(p) ? p : null;
}

function agyBrainDir(): string | null {
  const home = getHome();
  if (!home) return null;
  const p = path.join(home, '.gemini', 'antigravity-cli', 'brain');
  return fs.existsSync(p) ? p : null;
}

export function getNativeAgySessions(workdir: string): SessionInfo[] {
  const resolved = path.resolve(workdir);
  const targetUri = `file://${resolved}`;
  const dbFile = agyDbPath();
  if (!dbFile) return [];

  try {
    const { DatabaseSync } = nodeRequire('node:sqlite');
    const db = new DatabaseSync(dbFile, { open: true, readOnly: true });
    const rows = db.prepare(`
      SELECT conversation_id, title, preview, workspace_uris, last_modified_time, status, step_count
      FROM conversation_summaries
      ORDER BY last_modified_time DESC
    `).all() as any[];
    db.close();

    const out: SessionInfo[] = [];
    for (const row of rows) {
      const uris = String(row.workspace_uris || '');
      if (!uris.includes(targetUri) && !uris.includes(resolved)) continue;

      const sessionId = String(row.conversation_id || '');
      if (!sessionId) continue;

      const updatedAt = row.last_modified_time ? new Date(row.last_modified_time).toISOString() : null;
      const running = row.status === 'CASCADE_RUN_STATUS_RUNNING';

      out.push({
        sessionId,
        agent: 'agy',
        workdir: resolved,
        workspacePath: null,
        model: null,
        createdAt: updatedAt,
        title: row.title ? String(row.title) : null,
        running,
        runState: running ? 'running' : 'completed',
        runDetail: null,
        runUpdatedAt: updatedAt,
        classification: null,
        userStatus: null,
        userNote: null,
        lastQuestion: null,
        lastAnswer: null,
        lastMessageText: row.preview ? String(row.preview) : null,
        migratedFrom: null,
        migratedTo: null,
        linkedSessions: [],
        numTurns: typeof row.step_count === 'number' ? row.step_count : null,
      });
    }
    return out;
  } catch (e: any) {
    agentLog(`[sessions:agy] SQLite query error: ${e?.message || e}`);
    return [];
  }
}

export function getAgySessions(workdir: string, limit?: number): SessionListResult {
  const resolvedWorkdir = path.resolve(workdir);
  const pikiloomSessions = [
    ...listPikiloomSessions(resolvedWorkdir, 'agy').map(managedRecordToSessionInfo),
    ...listPikiloomSessions(resolvedWorkdir, 'gemini').map(managedRecordToSessionInfo),
  ];
  const nativeSessions = getNativeAgySessions(resolvedWorkdir);
  const merged = mergeManagedAndNativeSessions(pikiloomSessions, nativeSessions);
  const sessions = typeof limit === 'number' ? merged.slice(0, limit) : merged;
  agentLog(
    `[sessions:agy] workdir=${resolvedWorkdir} pikiloom=${pikiloomSessions.length} native=${nativeSessions.length} merged=${sessions.length}`
  );
  return { ok: true, sessions, error: null };
}

// ---- Session Messages & Tail ----

const AGY_USER_REQUEST_RE = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i;

function cleanAgyUserText(rawText: string): string {
  if (!rawText) return '';
  let text = rawText;
  const match = AGY_USER_REQUEST_RE.exec(rawText);
  if (match && match[1]) text = match[1];
  text = stripInjectedPrompts(text);
  return text.trim();
}

const AGY_FILE_REF_RE = /(^|\s)@(?:"([^"]+)"|([^\s"@]+))/g;

function dropAgyFileRefs(text: string): string {
  return text.replace(AGY_FILE_REF_RE, '$1').trim();
}

function buildAgyUserMessageContent(
  rawText: string,
  workdir: string,
): { text: string; blocks: MessageBlock[] } {
  const cleaned = cleanAgyUserText(rawText);
  if (!cleaned) return { text: '', blocks: [] };
  const blocks: MessageBlock[] = [];
  const textOnly = cleaned.replace(AGY_FILE_REF_RE, (match, lead, quoted, bare) => {
    const ref = String(quoted || bare || '').trim();
    if (!ref) return match;
    const abs = path.isAbsolute(ref) ? ref : path.resolve(workdir, ref);
    const block = attachAgentImage({ imagePath: abs });
    if (block) {
      blocks.push(block);
      return lead || '';
    }
    return match;
  });
  return { text: textOnly.replace(/\n{3,}/g, '\n\n').trim(), blocks };
}

function findAgyTranscriptFile(sessionId: string): string | null {
  const brainDir = agyBrainDir();
  if (!brainDir) return null;
  const sessDir = path.join(brainDir, sessionId, '.system_generated', 'logs');
  const transcriptPath = path.join(sessDir, 'transcript.jsonl');
  if (fs.existsSync(transcriptPath)) return transcriptPath;
  const fullPath = path.join(sessDir, 'transcript_full.jsonl');
  if (fs.existsSync(fullPath)) return fullPath;
  return null;
}

export function isAgySessionOversized(sessionId: string | null | undefined): boolean {
  if (!sessionId || isPendingSessionId(sessionId)) return false;
  const home = getHome();
  if (!home) return false;

  // 1. Check conversation SQLite DB size (sessions > 3 MB carry excessive prompt context)
  const convDb = path.join(home, '.gemini', 'antigravity-cli', 'conversations', `${sessionId}.db`);
  try {
    if (fs.existsSync(convDb)) {
      const stat = fs.statSync(convDb);
      if (stat.size > 3 * 1024 * 1024) return true;
    }
  } catch {}

  // 2. Check JSONL transcript size (> 1.5 MB transcript will exhaust per-minute tokens)
  const transcriptPath = findAgyTranscriptFile(sessionId);
  try {
    if (transcriptPath && fs.existsSync(transcriptPath)) {
      const stat = fs.statSync(transcriptPath);
      if (stat.size > 1.5 * 1024 * 1024) return true;
    }
  } catch {}

  // 3. Check step_count in conversation_summaries.db (each tool call is an execution step, so >250 steps indicates a genuinely massive session)
  const summariesDb = agyDbPath();
  if (summariesDb) {
    try {
      const { DatabaseSync } = nodeRequire('node:sqlite');
      const db = new DatabaseSync(summariesDb, { open: true, readOnly: true });
      const row = db.prepare('SELECT step_count FROM conversation_summaries WHERE conversation_id = ?').get(sessionId) as any;
      db.close();
      if (row && typeof row.step_count === 'number' && row.step_count > 250) {
        return true;
      }
    } catch {}
  }

  return false;
}

export function getAgySessionTail(opts: SessionTailOpts): SessionTailResult {
  const limit = opts.limit ?? 4;
  const filePath = findAgyTranscriptFile(opts.sessionId);
  if (!filePath) return { ok: false, messages: [], error: 'Session transcript not found' };

  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    const allMsgs: { role: 'user' | 'assistant'; text: string }[] = [];

    for (const line of lines) {
      if (!line.trim() || line[0] !== '{') continue;
      try {
        const entry = JSON.parse(line);
        if (entry.type === 'USER_INPUT') {
          const text = dropAgyFileRefs(cleanAgyUserText(entry.content || ''));
          if (text) allMsgs.push({ role: 'user', text });
        } else if (entry.type === 'PLANNER_RESPONSE' && (!entry.status || entry.status === 'DONE')) {
          const text = typeof entry.content === 'string' ? entry.content.trim() : '';
          if (text) allMsgs.push({ role: 'assistant', text });
        }
      } catch {}
    }
    return { ok: true, messages: allMsgs.slice(-limit), error: null };
  } catch (e: any) {
    return { ok: false, messages: [], error: e.message };
  }
}

export function getAgySessionMessages(opts: SessionMessagesOpts): SessionMessagesResult {
  const filePath = findAgyTranscriptFile(opts.sessionId);
  if (!filePath) return { ok: false, messages: [], totalTurns: 0, error: 'Session transcript not found' };

  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    const allMsgs: TailMessage[] = [];
    const richMsgs: RichMessage[] = [];

    for (const line of lines) {
      if (!line.trim() || line[0] !== '{') continue;
      try {
        const entry = JSON.parse(line);
        if (entry.type === 'USER_INPUT') {
          const rawText = entry.content || '';
          const { text, blocks: imageBlocks } = buildAgyUserMessageContent(rawText, opts.workdir);
          if (!text && !imageBlocks.length) continue;
          allMsgs.push({ role: 'user', text });
          const blocks: MessageBlock[] = [];
          if (text) blocks.push({ type: 'text', content: text });
          blocks.push(...imageBlocks);
          richMsgs.push({ role: 'user', text, blocks });
        } else if (entry.type === 'PLANNER_RESPONSE' && (!entry.status || entry.status === 'DONE')) {
          const rawText = typeof entry.content === 'string' ? entry.content.trim() : '';
          if (!rawText) continue;
          allMsgs.push({ role: 'assistant', text: rawText });
          richMsgs.push({ role: 'assistant', text: rawText, blocks: [{ type: 'text', content: rawText }] });
        }
      } catch {}
    }
    return applyTurnWindow(allMsgs, opts, opts.rich ? richMsgs : undefined);
  } catch (e: any) {
    return { ok: false, messages: [], totalTurns: 0, error: e.message };
  }
}

// ---- Model Catalog ----

const DEFAULT_AGY_MODELS = [
  { id: 'gemini-3.8-flash-high', alias: '3.8-flash' },
  { id: 'gemini-3.8-flash-medium', alias: null },
  { id: 'gemini-3.8-flash-low', alias: null },
  { id: 'gemini-3.7-flash-high', alias: '3.7-flash' },
  { id: 'gemini-3.7-flash-medium', alias: null },
  { id: 'gemini-3.7-flash-low', alias: null },
  { id: 'gemini-3.6-flash-high', alias: '3.6-flash' },
  { id: 'gemini-3.6-flash-medium', alias: null },
  { id: 'gemini-3.6-flash-low', alias: null },
  { id: 'gemini-3.1-pro-high', alias: '3.1-pro' },
  { id: 'gemini-3.1-pro-low', alias: null },
  { id: 'claude-sonnet-4-6', alias: 'sonnet-4.6' },
  { id: 'claude-opus-4-6-thinking', alias: 'opus-4.6' },
  { id: 'gpt-oss-120b-medium', alias: 'gpt-oss-120b' },
];

let cachedAgyModels: { expiresAt: number; models: typeof DEFAULT_AGY_MODELS } | null = null;

function fetchAgyModels(): typeof DEFAULT_AGY_MODELS {
  if (cachedAgyModels && cachedAgyModels.expiresAt > Date.now()) {
    return cachedAgyModels.models;
  }
  try {
    const raw = execFileSync('agy', ['models'], { encoding: 'utf8', timeout: 5000 });
    const lines = raw.split('\n');
    const discovered: { id: string; alias: string | null }[] = [];
    for (const line of lines) {
      const match = /^([a-zA-Z0-9._-]+)\s+(.*)$/.exec(line.trim());
      if (match) {
        discovered.push({ id: match[1], alias: null });
      }
    }
    if (discovered.length > 0) {
      cachedAgyModels = { expiresAt: Date.now() + 60_000, models: discovered };
      return discovered;
    }
  } catch {}
  return DEFAULT_AGY_MODELS;
}

// ---------------------------------------------------------------------------
// Quota & Usage (Google Cloud Code API)
// ---------------------------------------------------------------------------

const GOOGLE_USAGE_TIMEOUT_MS = GEMINI_USAGE_TIMEOUTS.request;
const GOOGLE_USAGE_URL = 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota';
const lastGoogleUsage = new Map<string, UsageResult>();

function cachedGoogleUsage(agent: 'gemini' | 'agy', error: string): UsageResult {
  const cached = lastGoogleUsage.get(agent);
  return cached?.ok ? cached : emptyUsage(agent, error);
}

export function getGoogleOAuthToken(): string | null {
  const home = getHome();
  if (!home) return null;
  // Check ~/.gemini/antigravity-cli/oauth_creds.json first, then ~/.gemini/oauth_creds.json
  const candidates = [
    path.join(home, '.gemini', 'antigravity-cli', 'oauth_creds.json'),
    path.join(home, '.gemini', 'oauth_creds.json'),
  ];
  for (const credsPath of candidates) {
    try {
      if (!fs.existsSync(credsPath)) continue;
      const raw = fs.readFileSync(credsPath, 'utf-8').trim();
      if (!raw || raw[0] !== '{') continue;
      const parsed = JSON.parse(raw);
      const token = typeof parsed?.access_token === 'string' ? parsed.access_token.trim() : '';
      if (token) return token;
    } catch {}
  }
  return null;
}

function googleUsageLabel(modelId: unknown): string {
  const raw = typeof modelId === 'string' ? modelId.trim() : '';
  const lower = raw.toLowerCase();
  if (!lower) return 'Gemini';
  if (lower.includes('flash-lite')) return 'Flash Lite';
  if (lower.includes('flash')) return 'Flash';
  if (lower.includes('pro')) return 'Pro';
  return raw
    .replace(/^gemini-/i, '')
    .replace(/[-_]+/g, ' ')
    .trim() || 'Gemini';
}

function googleUsageStatus(usedPercent: number | null): string | null {
  if (usedPercent == null) return null;
  if (usedPercent >= 100) return 'limit_reached';
  if (usedPercent >= 80) return 'warning';
  return 'allowed';
}

function googleResetAt(value: unknown): string | null {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function googleResetAtMs(value: string | null): number {
  if (!value) return Number.POSITIVE_INFINITY;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
}

function googleUsageWindowSort(label: string): number {
  switch (label) {
    case 'Pro': return 0;
    case 'Flash': return 1;
    case 'Flash Lite': return 2;
    default: return 10;
  }
}

export function parseGoogleUsageResponse(data: any, capturedAt: string, agent: 'gemini' | 'agy' = 'agy'): UsageResult | null {
  const buckets = Array.isArray(data?.buckets) ? data.buckets : [];
  const grouped = new Map<string, { label: string; remainingFraction: number; resetAt: string | null }>();

  for (const bucket of buckets) {
    const remainingFraction = Number(bucket?.remainingFraction);
    if (!Number.isFinite(remainingFraction)) continue;
    const label = googleUsageLabel(bucket?.modelId);
    const resetAt = googleResetAt(bucket?.resetTime);
    const prev = grouped.get(label);
    if (!prev
      || remainingFraction < prev.remainingFraction
      || (remainingFraction === prev.remainingFraction && googleResetAtMs(resetAt) < googleResetAtMs(prev.resetAt))) {
      grouped.set(label, { label, remainingFraction, resetAt });
    }
  }

  const windows: UsageWindowInfo[] = [...grouped.values()]
    .map(entry => {
      const usedPercent = roundPercent((1 - entry.remainingFraction) * 100);
      const remainingPercent = roundPercent(entry.remainingFraction * 100);
      let resetAfterSeconds: number | null = null;
      if (entry.resetAt) {
        const resetAtMs = Date.parse(entry.resetAt);
        if (Number.isFinite(resetAtMs)) resetAfterSeconds = Math.max(0, Math.round((resetAtMs - Date.now()) / 1000));
      }
      return {
        label: entry.label,
        usedPercent,
        remainingPercent,
        resetAt: entry.resetAt,
        resetAfterSeconds,
        status: googleUsageStatus(usedPercent),
      };
    })
    .sort((a, b) => {
      const byLabel = googleUsageWindowSort(a.label) - googleUsageWindowSort(b.label);
      return byLabel || a.label.localeCompare(b.label);
    });

  if (!windows.length) return null;

  const status = windows.some(window => window.status === 'limit_reached') ? 'limit_reached'
    : windows.some(window => window.status === 'warning') ? 'warning'
    : 'allowed';

  return { ok: true, agent, source: 'quota-api', capturedAt, status, windows, error: null };
}

function googleUsageError(agent: 'gemini' | 'agy', status: number, bodyText: string): UsageResult {
  let detail = '';
  const trimmed = String(bodyText || '').trim();
  if (trimmed && trimmed[0] === '{') {
    try {
      const parsed = JSON.parse(trimmed);
      detail = normalizeErrorMessage(parsed?.error?.message)
        || normalizeErrorMessage(parsed?.error)
        || normalizeErrorMessage(parsed?.message)
        || '';
    } catch {}
  }
  return cachedGoogleUsage(agent, `HTTP ${status}${detail ? `: ${detail}` : ''}`);
}

export async function getGoogleQuotaLive(agent: 'gemini' | 'agy' = 'agy'): Promise<UsageResult> {
  const token = getGoogleOAuthToken();
  if (!token) return cachedGoogleUsage(agent, `${agent === 'agy' ? 'Antigravity' : 'Gemini'} OAuth token not found.`);

  try {
    const raw = execSync(
      `curl -sS --max-time ${Math.ceil(GOOGLE_USAGE_TIMEOUT_MS / 1000)} -w '\\n%{http_code}' -H ${Q(`Authorization: Bearer ${token}`)} -H 'Content-Type: application/json' -d '{}' ${Q(GOOGLE_USAGE_URL)}`,
      { encoding: 'utf-8', timeout: GOOGLE_USAGE_TIMEOUT_MS + GEMINI_USAGE_TIMEOUTS.execSyncBuffer },
    );
    const trimmed = raw.trimEnd();
    const sep = trimmed.lastIndexOf('\n');
    const bodyText = sep >= 0 ? trimmed.slice(0, sep) : '';
    const status = Number(sep >= 0 ? trimmed.slice(sep + 1).trim() : '');
    if (!Number.isFinite(status)) return cachedGoogleUsage(agent, 'Quota query returned an invalid HTTP status.');
    if (status < 200 || status >= 300) return googleUsageError(agent, status, bodyText);
    if (!bodyText.trim() || bodyText.trim()[0] !== '{') return cachedGoogleUsage(agent, 'Quota query returned an invalid response.');
    const usage = parseGoogleUsageResponse(JSON.parse(bodyText), new Date().toISOString(), agent)
      || cachedGoogleUsage(agent, 'No quota buckets returned.');
    if (usage.ok) lastGoogleUsage.set(agent, usage);
    return usage;
  } catch (err: any) {
    const detail = normalizeErrorMessage(err?.message || err) || 'Usage query failed.';
    return cachedGoogleUsage(agent, detail);
  }
}

export function getGoogleQuota(agent: 'gemini' | 'agy' = 'agy'): UsageResult {
  return cachedGoogleUsage(agent, `No recent ${agent === 'agy' ? 'Antigravity' : 'Gemini'} usage data found.`);
}

export class AgyDriver implements AgentDriver {
  readonly id = 'agy';
  readonly cmd = 'agy';
  readonly thinkLabel = 'Thinking';
  readonly acceptedProviderKinds = ['google'] as const;

  async doStream(opts: StreamOpts): Promise<StreamResult> {
    return doAgyStream(opts);
  }

  async getSessions(workdir: string, limit?: number): Promise<SessionListResult> {
    return getAgySessions(workdir, limit);
  }

  async getSessionTail(opts: SessionTailOpts): Promise<SessionTailResult> {
    return getAgySessionTail(opts);
  }

  async getSessionMessages(opts: SessionMessagesOpts): Promise<SessionMessagesResult> {
    return getAgySessionMessages(opts);
  }

  async listModels(_opts: ModelListOpts): Promise<ModelListResult> {
    return { agent: 'agy', models: fetchAgyModels(), sources: [], note: null };
  }



  getUsage(_opts: UsageOpts): UsageResult {
    return getGoogleQuota('agy');
  }

  async getUsageLive(_opts: UsageOpts): Promise<UsageResult> {
    return getGoogleQuotaLive('agy');
  }

  async deleteNativeSession(workdir: string, sessionId: string): Promise<string[]> {
    return deleteAgyNativeSession(workdir, sessionId);
  }

  shutdown() {}
}

export async function deleteAgyNativeSession(_workdir: string, sessionId: string): Promise<string[]> {
  const deleted: string[] = [];
  const home = getHome();
  if (!home) return deleted;

  const brainSessionDir = path.join(home, '.gemini', 'antigravity-cli', 'brain', sessionId);
  if (fs.existsSync(brainSessionDir)) {
    try {
      fs.rmSync(brainSessionDir, { recursive: true, force: true });
      deleted.push(brainSessionDir);
    } catch {}
  }

  const convDb = path.join(home, '.gemini', 'antigravity-cli', 'conversations', `${sessionId}.db`);
  if (fs.existsSync(convDb)) {
    try {
      fs.rmSync(convDb, { force: true });
      try { fs.rmSync(`${convDb}-shm`, { force: true }); } catch {}
      try { fs.rmSync(`${convDb}-wal`, { force: true }); } catch {}
      deleted.push(convDb);
    } catch {}
  }

  const summariesDb = agyDbPath();
  if (summariesDb) {
    try {
      const { DatabaseSync } = nodeRequire('node:sqlite');
      const db = new DatabaseSync(summariesDb);
      db.prepare('DELETE FROM conversation_summaries WHERE conversation_id = ?').run(sessionId);
      db.close();
    } catch {}
  }

  return deleted;
}

registerDriver(new AgyDriver());
