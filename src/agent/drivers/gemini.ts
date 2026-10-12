import { registerDriver, type AgentDriver } from '../driver.js';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { GEMINI_USAGE_TIMEOUTS, SESSION_RUNNING_THRESHOLD_MS } from '../../core/constants.js';
import {
  type StreamOpts, type StreamResult,
  type SessionListResult, type SessionInfo, type SessionTailOpts, type SessionTailResult,
  type SessionMessagesOpts, type SessionMessagesResult,
  type TailMessage, type RichMessage, type MessageBlock,
  type ModelListOpts, type ModelListResult,
  type UsageOpts, type UsageResult, type UsageWindowInfo,
} from '../types.js';
import {
  listPikiloomSessions, findPikiloomSession,
  mergeManagedAndNativeSessions, managedRecordToSessionInfo, applyTurnWindow,
} from '../session.js';
import {
  agentLog, isPendingSessionId, shortValue,
  firstNonEmptyLine, normalizeErrorMessage,
  stripInjectedPrompts, roundPercent, emptyUsage, Q,
} from '../utils.js';
import { attachAgentImage } from '../images.js';
import { getHome } from '../../core/platform.js';
import {
  doAgyStream,
  getAgySessions,
  getAgySessionTail,
  getAgySessionMessages,
  deleteAgyNativeSession,
  getGoogleQuotaLive,
  getGoogleQuota,
} from './agy.js';

export function buildGeminiPromptText(prompt: string, attachments: string[]): string {
  if (!attachments.length) return prompt;
  const refs = attachments.map(p => /\s/.test(p) ? `@"${p}"` : `@${p}`).join(' ');
  return prompt ? `${refs}\n\n${prompt}` : refs;
}

export const doGeminiStream = doAgyStream;

// ---------------------------------------------------------------------------
// Legacy Gemini Project & Chat Paths
// ---------------------------------------------------------------------------

function geminiProjectName(workdir: string): string | null {
  const home = getHome();
  if (!home) return null;
  const projectsPath = path.join(home, '.gemini', 'projects.json');
  try {
    const raw = fs.readFileSync(projectsPath, 'utf8');
    const { projects } = JSON.parse(raw);
    if (!projects || typeof projects !== 'object') return null;
    const resolved = path.resolve(workdir);
    if (projects[resolved]) return projects[resolved];
    for (const [dir, name] of Object.entries(projects)) {
      if (path.resolve(dir) === resolved) return name as string;
    }
  } catch {  }
  return null;
}

function geminiChatsDir(workdir: string): string | null {
  const home = getHome();
  if (!home) return null;
  const projectName = geminiProjectName(workdir);
  if (!projectName) return null;
  return path.join(home, '.gemini', 'tmp', projectName, 'chats');
}

function extractGeminiText(content: any): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === 'string') {
      if (block.trim()) parts.push(block.trim());
      continue;
    }
    const text = typeof block?.text === 'string' ? block.text.trim() : '';
    if (text) parts.push(text);
  }
  return parts.join('\n').trim();
}

const GEMINI_SYSTEM_BLOCK_SENTINELS = [
  '[Artifact Return]',
  '[Asking the user]',
  '[Browser Automation]',
  '[Session Workspace]',
];

const GEMINI_REFERENCED_FILES_BLOCK_RE =
  /\n*--- Content from referenced files ---[\s\S]*?--- End of content ---\n*/g;

const GEMINI_FILE_REF_RE = /(^|\s)@(?:"([^"]+)"|([^\s"@]+))/g;

function stripGeminiSystemPreamble(text: string): string {
  let cur = text.replace(/^\s+/, '');
  while (true) {
    const sentinel = GEMINI_SYSTEM_BLOCK_SENTINELS.find(s => cur.startsWith(s));
    if (!sentinel) break;
    const blockEnd = cur.indexOf('\n\n');
    if (blockEnd < 0) return '';
    cur = cur.slice(blockEnd + 2).replace(/^\s+/, '');
  }
  return cur;
}

function cleanGeminiUserText(rawText: string): string {
  if (!rawText) return '';
  let text = stripInjectedPrompts(rawText);
  text = stripGeminiSystemPreamble(text);
  text = text.replace(GEMINI_REFERENCED_FILES_BLOCK_RE, '\n');
  return text.trim();
}

function buildGeminiUserMessageContent(
  rawText: string,
  workdir: string,
): { text: string; blocks: MessageBlock[] } {
  const cleaned = cleanGeminiUserText(rawText);
  if (!cleaned) return { text: '', blocks: [] };
  const blocks: MessageBlock[] = [];
  const textOnly = cleaned.replace(GEMINI_FILE_REF_RE, (match, lead, quoted, bare) => {
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

function dropGeminiFileRefs(text: string): string {
  return text.replace(GEMINI_FILE_REF_RE, '$1');
}

function flattenGeminiUserText(rawText: string): string {
  return dropGeminiFileRefs(cleanGeminiUserText(rawText)).replace(/\s+/g, ' ').trim();
}

function normalizeGeminiSessionTitle(value: unknown): string | null {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length <= 120 ? text : `${text.slice(0, 117).trimEnd()}...`;
}

function findGeminiSessionFile(workdir: string, sessionId: string): string | null {
  const chatsDir = geminiChatsDir(workdir);
  if (!chatsDir || !fs.existsSync(chatsDir)) return null;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(chatsDir, { withFileTypes: true }); } catch { return null; }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith('session-')) continue;
    if (!entry.name.endsWith('.json') && !entry.name.endsWith('.jsonl')) continue;
    const filePath = path.join(chatsDir, entry.name);
    try {
      const data = loadGeminiSessionData(filePath);
      if (data?.sessionId === sessionId) return filePath;
    } catch {  }
  }
  return null;
}

function loadGeminiSessionData(filePath: string): any {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    if (filePath.endsWith('.json')) return JSON.parse(content);

    const lines = content.split('\n');
    let data: any = {};
    const messages: any[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.sessionId && !data.sessionId) {
          data = { ...obj };
        } else if (obj.type === 'user' || obj.type === 'gemini' || obj.type === 'model' || obj.type === 'assistant') {
          messages.push(obj);
        }
      } catch {  }
    }
    data.messages = messages;
    return data;
  } catch {
    return null;
  }
}

interface GeminiNativeContent {
  sessionId: string;
  title: string | null;
  lastQuestion: string | null;
  lastAnswer: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  mtimeMs: number;
  model: string | null;
  numTurns: number | null;
}

const nativeGeminiContentCache = new Map<string, { mtimeMs: number; size: number; content: GeminiNativeContent | null }>();

function readNativeGeminiContent(filePath: string): GeminiNativeContent | null {
  const data = loadGeminiSessionData(filePath);
  if (!data?.sessionId) return null;

  const messages = Array.isArray(data.messages) ? data.messages : [];
  if (messages.length === 0) return null;

  let title: string | null = null;
  let lastQuestion: string | null = null;
  let lastAnswer: string | null = null;
  let numTurns = 0;

  for (const msg of messages) {
    const isUser = msg.type === 'user';
    const isAssistant = msg.type === 'gemini' || msg.type === 'model' || msg.type === 'assistant';
    const text = extractGeminiText(msg.content);
    if (!text) continue;

    if (isUser) {
      const userText = flattenGeminiUserText(text);
      if (userText) {
        if (!title) title = userText;
        lastQuestion = userText;
        numTurns++;
      }
    } else if (isAssistant) {
      lastAnswer = shortValue(firstNonEmptyLine(text), 140) || null;
    }
  }

  let stat: fs.Stats | null = null;
  try { stat = fs.statSync(filePath); } catch {  }

  return {
    sessionId: data.sessionId,
    title: normalizeGeminiSessionTitle(title),
    lastQuestion,
    lastAnswer,
    createdAt: data.startTime || (stat ? stat.birthtime.toISOString() : null),
    updatedAt: data.lastUpdated || (stat ? stat.mtime.toISOString() : null),
    mtimeMs: stat ? stat.mtimeMs : 0,
    model: data.model || null,
    numTurns: numTurns > 0 ? numTurns : null,
  };
}

function getNativeGeminiSessionsFromFiles(workdir: string): SessionInfo[] {
  const chatsDir = geminiChatsDir(workdir);
  if (!chatsDir || !fs.existsSync(chatsDir)) return [];

  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(chatsDir, { withFileTypes: true }); } catch { return []; }

  const sessionsById = new Map<string, SessionInfo>();

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith('session-')) continue;
    if (!entry.name.endsWith('.json') && !entry.name.endsWith('.jsonl')) continue;
    const filePath = path.join(chatsDir, entry.name);

    let stat: fs.Stats;
    try { stat = fs.statSync(filePath); } catch { continue; }

    let cached = nativeGeminiContentCache.get(filePath);
    if (!cached || cached.mtimeMs !== stat.mtimeMs || cached.size !== stat.size) {
      cached = { mtimeMs: stat.mtimeMs, size: stat.size, content: readNativeGeminiContent(filePath) };
      nativeGeminiContentCache.set(filePath, cached);
    }

    const content = cached.content;
    if (!content) continue;

    const existing = sessionsById.get(content.sessionId);
    if (existing && content.updatedAt && existing.runUpdatedAt && Date.parse(content.updatedAt) <= Date.parse(existing.runUpdatedAt)) {
      continue;
    }

    const running = content.mtimeMs > 0 && (Date.now() - content.mtimeMs) < SESSION_RUNNING_THRESHOLD_MS;
    sessionsById.set(content.sessionId, {
      sessionId: content.sessionId,
      agent: 'gemini',
      workdir: path.resolve(workdir),
      workspacePath: null,
      createdAt: content.createdAt,
      title: content.title,
      lastQuestion: content.lastQuestion,
      lastAnswer: content.lastAnswer,
      lastMessageText: content.lastQuestion,
      running,
      runState: running ? 'running' : 'completed',
      runDetail: null,
      runUpdatedAt: content.updatedAt,
      classification: null,
      userStatus: null,
      userNote: null,
      migratedFrom: null,
      migratedTo: null,
      linkedSessions: [],
      model: content.model,
      numTurns: content.numTurns,
    });
  }

  return [...sessionsById.values()];
}

function getNativeGeminiSessions(workdir: string): SessionInfo[] {
  return getNativeGeminiSessionsFromFiles(workdir);
}

export function getGeminiSessions(workdir: string, limit?: number): SessionListResult {
  const resolvedWorkdir = path.resolve(workdir);
  const pikiloomSessions = listPikiloomSessions(resolvedWorkdir, 'gemini').map(managedRecordToSessionInfo);
  const nativeSessions = getNativeGeminiSessions(resolvedWorkdir);
  const merged = mergeManagedAndNativeSessions(pikiloomSessions, nativeSessions);
  const sessions = typeof limit === 'number' ? merged.slice(0, limit) : merged;
  return { ok: true, sessions, error: null };
}

export function getGeminiSessionTail(opts: SessionTailOpts): SessionTailResult {
  const filePath = findGeminiSessionFile(opts.workdir, opts.sessionId);
  if (!filePath) return { ok: false, messages: [], error: 'Session file not found' };

  try {
    const data = loadGeminiSessionData(filePath);
    if (!data?.messages || !Array.isArray(data.messages)) {
      return { ok: true, messages: [], error: null };
    }

    const messages: TailMessage[] = [];
    for (const msg of data.messages) {
      const isUser = msg.type === 'user';
      const isGemini = msg.type === 'gemini' || msg.type === 'model' || msg.type === 'assistant';
      if (!isUser && !isGemini) continue;

      const text = extractGeminiText(msg.content);
      if (!text) continue;

      if (isUser) {
        const cleaned = cleanGeminiUserText(text);
        if (cleaned) messages.push({ role: 'user', text: cleaned });
      } else {
        messages.push({ role: 'assistant', text });
      }
    }

    const { messages: sliced } = applyTurnWindow(messages, { turnLimit: opts.limit ?? 4 });
    return { ok: true, messages: sliced, error: null };
  } catch (e: any) {
    return { ok: false, messages: [], error: e.message };
  }
}

export function getGeminiSessionMessages(opts: SessionMessagesOpts): SessionMessagesResult {
  const filePath = findGeminiSessionFile(opts.workdir, opts.sessionId);
  if (!filePath) return { ok: false, messages: [], totalTurns: 0, error: 'Session file not found' };

  try {
    const data = loadGeminiSessionData(filePath);
    if (!data?.messages || !Array.isArray(data.messages)) {
      return { ok: true, messages: [], totalTurns: 0, error: null };
    }

    const messages: TailMessage[] = [];
    const richMessages: RichMessage[] = [];
    for (const msg of data.messages) {
      const isUser = msg.type === 'user';
      const isGemini = msg.type === 'gemini' || msg.type === 'model' || msg.type === 'assistant';
      if (!isUser && !isGemini) continue;

      const raw = extractGeminiText(msg.content);
      if (!raw) continue;

      if (isUser) {
        const { text, blocks: imageBlocks } = buildGeminiUserMessageContent(raw, opts.workdir);
        if (!text && !imageBlocks.length) continue;
        messages.push({ role: 'user', text });
        const blocks: MessageBlock[] = [];
        if (text) blocks.push({ type: 'text', content: text });
        blocks.push(...imageBlocks);
        richMessages.push({ role: 'user', text, blocks });
      } else {
        messages.push({ role: 'assistant', text: raw });
        richMessages.push({ role: 'assistant', text: raw, blocks: [{ type: 'text', content: raw }] });
      }
    }

    return applyTurnWindow(messages, opts, richMessages);
  } catch (e: any) {
    return { ok: false, messages: [], totalTurns: 0, error: e.message };
  }
}

export const getGeminiUsageLive = (agent: 'gemini' | 'agy' = 'gemini') => getGoogleQuotaLive(agent);
export const getGeminiUsage = (agent: 'gemini' | 'agy' = 'gemini') => getGoogleQuota(agent);

const GEMINI_MODELS = [
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

export class GeminiDriver implements AgentDriver {
  readonly id = 'gemini';
  readonly cmd = 'agy';
  readonly thinkLabel = 'Thinking';
  readonly hidden = true;
  readonly acceptedProviderKinds = ['google'] as const;

  async doStream(opts: StreamOpts): Promise<StreamResult> {
    return doAgyStream({
      ...opts,
      agyModel: opts.agyModel || opts.geminiModel,
      agyReasoningEffort: opts.agyReasoningEffort || opts.geminiReasoningEffort,
      agyExtraArgs: opts.agyExtraArgs || opts.geminiExtraArgs,
    });
  }

  async getSessions(workdir: string, limit?: number): Promise<SessionListResult> {
    const agyRes = await getAgySessions(workdir, limit);
    if (agyRes.ok && agyRes.sessions.length > 0) {
      return agyRes;
    }
    return getGeminiSessions(workdir, limit);
  }

  async getSessionTail(opts: SessionTailOpts): Promise<SessionTailResult> {
    const agyRes = await getAgySessionTail(opts);
    if (agyRes.ok && agyRes.messages.length > 0) {
      return agyRes;
    }
    return getGeminiSessionTail(opts);
  }

  async getSessionMessages(opts: SessionMessagesOpts): Promise<SessionMessagesResult> {
    const agyRes = await getAgySessionMessages(opts);
    if (agyRes.ok && agyRes.messages.length > 0) {
      return agyRes;
    }
    return getGeminiSessionMessages(opts);
  }

  async listModels(_opts: ModelListOpts): Promise<ModelListResult> {
    return { agent: 'gemini', models: [...GEMINI_MODELS], sources: [], note: null };
  }

  getUsage(_opts: UsageOpts): UsageResult {
    return getGeminiUsage();
  }

  async getUsageLive(_opts: UsageOpts): Promise<UsageResult> {
    return getGeminiUsageLive('gemini');
  }

  async deleteNativeSession(workdir: string, sessionId: string): Promise<string[]> {
    const deleted = await deleteAgyNativeSession(workdir, sessionId);
    const file = findGeminiSessionFile(workdir, sessionId);
    if (file) {
      try { fs.rmSync(file, { force: true }); deleted.push(file); } catch {}
    }
    return deleted;
  }

  shutdown() {}
}

registerDriver(new GeminiDriver());
