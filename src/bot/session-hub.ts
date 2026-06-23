import path from 'node:path';
import {
  getSessions as _getSessions,
  getSessionTail as _getSessionTail,
  getSessionMessages as _getSessionMessages,
  classifySession as _classifySession,
  deriveUserStatus as _deriveStatusFromOutcome,
  exportSession as _exportSession,
  importSession as _importSession,
  findPikiloomSession,
  updateSessionMeta, resolveCanonicalSessionId, getSessionPromotions,
  deleteAgentSession as _deleteAgentSession,
  type DeleteAgentSessionOpts, type DeleteAgentSessionResult,
  collapseSkillPrompt,
  type Agent, type SessionInfo, type SessionListResult,
  type SessionTailResult, type SessionTailOpts,
  type SessionMessagesOpts, type SessionMessagesResult,
  type SessionClassification, type TailMessage, type RichMessage, type MessageBlock, type StreamResult,
  type ExportSessionOpts, type ExportSessionResult,
  type ImportSessionOpts, type ImportSessionResult,
  type MigrateSessionOpts, type SessionRunState,
} from '../agent/index.js';
import { allDriverIds, hasDriver } from '../agent/driver.js';
import {
  loadWorkspaces, addWorkspace, removeWorkspace, renameWorkspace,
  reorderWorkspaces, updateWorkspace, findWorkspace,
  type WorkspaceEntry,
} from '../core/config/user-config.js';

export type UserStatus = 'inbox' | 'active' | 'review' | 'done' | 'parked';

export interface SessionQueryOpts {
  workdir: string;
  agent?: Agent | Agent[];
  limit?: number;
  userStatus?: UserStatus[];
}

export interface SessionQueryResult {
  ok: boolean;
  workdir: string;
  workspaceName: string;
  sessions: WorkspaceSessionInfo[];
  statusCounts: Record<UserStatus | 'unknown', number>;
  total: number;
  errors: string[];
  promotions: Record<string, string>;
}

export interface WorkspaceSessionInfo extends SessionInfo {
  workspaceName: string;
}

export interface WorkspaceOverview {
  workspace: WorkspaceEntry;
  attentionCount: number;
  agentSummary: Array<{ agent: string; active: number; review: number; total: number }>;
  lastActivityAt: string | null;
}

export interface SessionPatch {
  userStatus?: UserStatus | null;
  userNote?: string | null;
  classification?: SessionClassification;
  migratedFrom?: { agent: Agent; sessionId: string };
  migratedTo?: { agent: Agent; sessionId: string };
  addLink?: { agent: Agent; sessionId: string };
}

export interface MigrateResult {
  ok: boolean;
  contextInjected: string;
  messageCount: number;
  error: string | null;
}

export type {
  Agent, SessionInfo, SessionClassification, TailMessage, RichMessage, MessageBlock,
  SessionTailResult, SessionMessagesOpts, SessionMessagesResult,
  ExportSessionOpts, ExportSessionResult, ImportSessionOpts, ImportSessionResult,
  MigrateSessionOpts, WorkspaceEntry, SessionListResult, SessionRunState,
};

export function resolveUserStatus(session: Pick<SessionInfo, 'userStatus' | 'classification'>): UserStatus {
  if (session.userStatus) return session.userStatus as UserStatus;
  if (session.classification) return _deriveStatusFromOutcome(session.classification.outcome);
  return 'inbox';
}

function normalizeAgents(agent?: Agent | Agent[]): Agent[] {
  if (!agent) return allDriverIds().filter(a => hasDriver(a));
  const list = Array.isArray(agent) ? agent : [agent];
  return list.filter(a => hasDriver(a));
}

export async function querySessions(opts: SessionQueryOpts): Promise<SessionQueryResult> {
  const resolvedWorkdir = path.resolve(opts.workdir);
  const ws = findWorkspace(resolvedWorkdir);
  const workspaceName = ws?.name || path.basename(resolvedWorkdir);
  const agents = normalizeAgents(opts.agent);

  const results = await Promise.all(
    agents.map(agent =>
      _getSessions({ agent, workdir: resolvedWorkdir }).catch((): SessionListResult => ({
        ok: false, sessions: [], error: `Failed to fetch ${agent} sessions`,
      })),
    ),
  );

  let allSessions: WorkspaceSessionInfo[] = [];
  const errors: string[] = [];
  let anyOk = false;

  for (const result of results) {
    if (result.ok) anyOk = true;
    if (result.error) errors.push(result.error);
    for (const session of result.sessions) {
      allSessions.push({ ...session, workspaceName });
    }
  }

  allSessions.sort((a, b) => {
    const aTime = a.runUpdatedAt || a.createdAt || '';
    const bTime = b.runUpdatedAt || b.createdAt || '';
    return Date.parse(bTime) - Date.parse(aTime);
  });

  if (opts.userStatus?.length) {
    const allowed = new Set<string>(opts.userStatus);
    allSessions = allSessions.filter(s => allowed.has(resolveUserStatus(s)));
  }

  if (opts.limit && opts.limit > 0) {
    allSessions = allSessions.slice(0, opts.limit);
  }

  const statusCounts: Record<string, number> = { inbox: 0, active: 0, review: 0, done: 0, parked: 0, unknown: 0 };
  for (const s of allSessions) {
    const status = resolveUserStatus(s);
    statusCounts[status] = (statusCounts[status] || 0) + 1;
  }

  return {
    ok: anyOk || agents.length === 0,
    workdir: resolvedWorkdir,
    workspaceName,
    sessions: allSessions,
    statusCounts: statusCounts as Record<UserStatus | 'unknown', number>,
    total: allSessions.length,
    errors,
    promotions: getSessionPromotions(resolvedWorkdir),
  };
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']);
const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml',
};

function imageBlocksFromManagedRecord(record: { workspacePath: string; lastUserAttachments?: string[] }): MessageBlock[] {
  const attachments = record.lastUserAttachments;
  if (!attachments?.length) return [];
  const blocks: MessageBlock[] = [];
  for (const rel of attachments) {
    const ext = path.extname(rel).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(ext)) continue;
    const abs = path.isAbsolute(rel) ? rel : path.join(record.workspacePath, rel);
    blocks.push({
      type: 'image',
      content: `file://${abs}`,
      imagePath: abs,
      imageMime: MIME_BY_EXT[ext] || 'application/octet-stream',
    });
  }
  return blocks;
}

interface ManagedFallback {
  messages: TailMessage[];
  richMessages: RichMessage[];
}

function tailFallbackFromManagedRecord(opts: SessionTailOpts): SessionTailResult | null {
  const fb = managedFallbackContent(opts);
  if (!fb) return null;
  const limit = Math.max(1, opts.limit ?? fb.messages.length);
  return { ok: true, messages: fb.messages.slice(-limit), error: null };
}

function managedFallbackContent(opts: SessionTailOpts): ManagedFallback | null {
  const record = findPikiloomSession(opts.workdir, opts.agent, opts.sessionId);
  if (!record) return null;
  const messages: TailMessage[] = [];
  const richMessages: RichMessage[] = [];

  if (record.lastQuestion) {
    const text = record.lastQuestion;
    messages.push({ role: 'user', text });
    const blocks: MessageBlock[] = text ? [{ type: 'text', content: text }] : [];
    blocks.push(...imageBlocksFromManagedRecord(record));
    if (blocks.length) richMessages.push({ role: 'user', text, blocks, usage: null });
  }

  const failureText = record.lastAnswer
    || (record.runState === 'incomplete' ? record.runDetail : null);
  if (failureText) {
    messages.push({ role: 'assistant', text: failureText });
    richMessages.push({
      role: 'assistant',
      text: failureText,
      blocks: [{ type: 'text', content: failureText }],
      usage: null,
    });
  }

  if (!messages.length) return null;
  return { messages, richMessages };
}

export async function querySessionTail(opts: SessionTailOpts): Promise<SessionTailResult> {
  const opts2 = withCanonicalSessionId(opts);
  const result = await _getSessionTail(opts2);
  if (!result.ok || !result.messages.length) {
    const fallback = tailFallbackFromManagedRecord(opts2);
    if (fallback) return fallback;
  }
  return result;
}

function withCanonicalSessionId<T extends { agent: Agent; sessionId: string; workdir: string }>(opts: T): T {
  const canonical = resolveCanonicalSessionId(opts.workdir, opts.agent, opts.sessionId);
  return canonical === opts.sessionId ? opts : { ...opts, sessionId: canonical };
}

function collapseSkillPromptsInResult(result: SessionMessagesResult): SessionMessagesResult {
  if (!result.ok) return result;
  const messages = result.messages.map(m => {
    if (m.role !== 'user') return m;
    const collapsed = collapseSkillPrompt(m.text);
    return collapsed ? { ...m, text: collapsed } : m;
  });
  const richMessages = result.richMessages?.map(m => {
    if (m.role !== 'user') return m;
    const collapsed = collapseSkillPrompt(m.text);
    if (!collapsed) return m;
    const blocks = m.blocks.map(b => {
      if (b.type !== 'text') return b;
      const blockCollapsed = collapseSkillPrompt(b.content);
      return blockCollapsed ? { ...b, content: blockCollapsed } : b;
    });
    return { ...m, text: collapsed, blocks };
  });
  return { ...result, messages, richMessages };
}

export async function querySessionMessages(opts: SessionMessagesOpts & { agent: Agent }): Promise<SessionMessagesResult> {
  const opts2 = withCanonicalSessionId(opts);
  const result = await _getSessionMessages(opts2);
  if (!result.ok || !result.messages.length) {
    const fb = managedFallbackContent({
      agent: opts2.agent,
      sessionId: opts2.sessionId,
      workdir: opts2.workdir,
    });
    if (fb) {
      const totalTurns = fb.messages.filter(m => m.role === 'user').length;
      return collapseSkillPromptsInResult({
        ok: true,
        messages: fb.messages.map(m => ({ role: m.role, text: m.text })),
        richMessages: fb.richMessages,
        totalTurns,
        error: null,
      });
    }
  }
  return collapseSkillPromptsInResult(result);
}

export async function getWorkspaceOverviews(): Promise<WorkspaceOverview[]> {
  const workspaces = loadWorkspaces();
  const agents = allDriverIds().filter(a => hasDriver(a));

  return Promise.all(workspaces.map(async (ws): Promise<WorkspaceOverview> => {
    const summaries = await Promise.all(agents.map(async (agent) => {
      try {
        const result = await _getSessions({ agent, workdir: ws.path });
        let active = 0;
        let review = 0;
        let lastTs: string | null = null;
        for (const session of result.sessions) {
          const status = resolveUserStatus(session);
          if (status === 'active' || session.running) active++;
          else if (status === 'review') review++;
          const ts = session.runUpdatedAt || session.createdAt || '';
          if (ts && (!lastTs || ts > lastTs)) lastTs = ts;
        }
        return { agent, active, review, total: result.sessions.length, lastTs };
      } catch {
        return { agent, active: 0, review: 0, total: 0, lastTs: null as string | null };
      }
    }));

    const agentSummary: WorkspaceOverview['agentSummary'] = [];
    let attentionCount = 0;
    let lastActivityAt: string | null = null;
    for (const s of summaries) {
      agentSummary.push({ agent: s.agent, active: s.active, review: s.review, total: s.total });
      attentionCount += s.active + s.review;
      if (s.lastTs && (!lastActivityAt || s.lastTs > lastActivityAt)) lastActivityAt = s.lastTs;
    }

    return { workspace: ws, attentionCount, agentSummary, lastActivityAt };
  }));
}

export function updateSession(workdir: string, agent: Agent, sessionId: string, patch: SessionPatch): boolean {
  return updateSessionMeta(workdir, agent, sessionId, patch);
}

export function deleteSession(opts: DeleteAgentSessionOpts): Promise<DeleteAgentSessionResult> {
  return _deleteAgentSession(opts);
}

export function linkSessions(
  workdir: string,
  a: { agent: Agent; sessionId: string },
  b: { agent: Agent; sessionId: string },
): boolean {
  const updatedA = updateSessionMeta(workdir, a.agent, a.sessionId, {
    addLink: { agent: b.agent, sessionId: b.sessionId },
  });
  const updatedB = updateSessionMeta(workdir, b.agent, b.sessionId, {
    addLink: { agent: a.agent, sessionId: a.sessionId },
  });
  return updatedA || updatedB;
}

export function classifySession(
  result: Pick<StreamResult, 'ok' | 'incomplete' | 'error' | 'stopReason' | 'message' | 'activity'>,
): SessionClassification {
  return _classifySession(result);
}

export function exportSession(opts: ExportSessionOpts): Promise<ExportSessionResult> {
  return _exportSession(opts);
}

export function importSession(opts: ImportSessionOpts): ImportSessionResult {
  return _importSession(opts);
}

export async function buildMigrationContext(opts: MigrateSessionOpts): Promise<MigrateResult> {
  try {
    const messagesResult = await _getSessionMessages({
      agent: opts.source.agent,
      sessionId: opts.source.sessionId,
      workdir: opts.source.workdir,
      lastNTurns: opts.lastNTurns,
    });

    if (!messagesResult.ok) {
      return { ok: false, contextInjected: '', messageCount: 0, error: messagesResult.error };
    }

    const messages = messagesResult.messages;
    if (!messages.length) {
      return { ok: false, contextInjected: '', messageCount: 0, error: 'No messages to migrate' };
    }

    const contextLines: string[] = [
      `[Migrated from ${opts.source.agent} session, ${messages.length} messages]`,
      '',
    ];
    for (const msg of messages) {
      contextLines.push(`[${msg.role === 'user' ? 'User' : 'Assistant'}]:`);
      contextLines.push(msg.text);
      contextLines.push('');
    }
    const contextInjected = contextLines.join('\n');

    updateSessionMeta(opts.source.workdir, opts.source.agent, opts.source.sessionId, {
      migratedTo: { agent: opts.target.agent, sessionId: '' },
    });

    return { ok: true, contextInjected, messageCount: messages.length, error: null };
  } catch (e: any) {
    return { ok: false, contextInjected: '', messageCount: 0, error: e.message };
  }
}

export { loadWorkspaces, addWorkspace, removeWorkspace, renameWorkspace, reorderWorkspaces, updateWorkspace, findWorkspace };
