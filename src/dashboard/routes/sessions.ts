import { Hono } from 'hono';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { loadUserConfig } from '../../core/config/user-config.js';
import {
  listAgents, listSkills,
  decodeAttachmentPathParam, resolveAllowedAttachmentPath, rewriteAttachmentBlocksForTransport,
  deliveredArtifactBlocks, mimeForArtifact,
  type Agent, type SessionInfo, type SessionMessagesResult, type RichMessage, type MessageBlock,
} from '../../agent/index.js';
import { getSessionStatusForBot } from '../../bot/session-status.js';
import { findPikiloomSession } from '../../agent/session.js';
import { readAwaitResume } from '../../agent/await-resume.js';
import {
  cancelSessionTask,
  stopSessionTasks,
  getSessionStreamState,
  queueDashboardSessionTask,
  forkDashboardSessionTask,
  steerSessionTask,
  interactionSelectOption,
  interactionSubmitText,
  interactionSkip,
  interactionCancel,
  getInteractionPrompt,
} from '../session-control.js';
import {
  querySessions, querySessionTail, querySessionMessages,
  getWorkspaceOverviews,
  updateSession, linkSessions,
  buildMigrationContext,
  exportSession, importSession,
  deleteSession,
  loadWorkspaces, addWorkspace, removeWorkspace, updateWorkspace,
  resolveUserStatus,
  type UserStatus, type SessionQueryResult,
} from '../../bot/session-hub.js';
import { DASHBOARD_PAGINATION } from '../../core/constants.js';
import { runtime } from '../runtime.js';
import type { Bot } from '../../bot/bot.js';

const DEFAULT_SESSION_PAGE_SIZE = DASHBOARD_PAGINATION.defaultPageSize;
const MAX_SESSION_PAGE_SIZE = DASHBOARD_PAGINATION.maxPageSize;

function parsePageNumber(value: string | null | undefined, fallback = 0): number {
  const parsed = Number.parseInt(value || '', 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

function parsePageSize(value: string | null | undefined, fallback = DEFAULT_SESSION_PAGE_SIZE): number {
  const parsed = Number.parseInt(value || '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, MAX_SESSION_PAGE_SIZE);
}

type DashboardSessionInfo = SessionInfo & { isCurrent?: boolean; workspaceName?: string };

function paginateSessionResult<T>(items: T[], page: number, limit: number) {
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const safePage = Math.min(page, totalPages - 1);
  const start = safePage * limit;
  return {
    sessions: items.slice(start, start + limit),
    page: safePage,
    limit,
    total,
    totalPages,
    hasMore: safePage + 1 < totalPages,
  };
}

function enrichWithRuntimeStatus(sessions: SessionInfo[], bot: Bot | null): DashboardSessionInfo[] {
  return sessions.map(session => {
    const status = bot ? getSessionStatusForBot(bot, session) : null;
    const isRunning = status ? status.isRunning : !!session.running;
    const awaiting = !isRunning && session.workdir && session.sessionId
      ? readAwaitResume(session.workdir, session.agent, session.sessionId)
      : null;
    return {
      ...session,
      running: isRunning,
      runState: isRunning ? 'running' as const : (session.runState === 'running' ? 'incomplete' : session.runState),
      awaiting,
      isCurrent: status?.isCurrent ?? false,
    };
  });
}

const LIST_PREVIEW_FIELD_CAP = 2048;

function capPreviewField<T extends string | null | undefined>(value: T): T | string {
  return typeof value === 'string' && value.length > LIST_PREVIEW_FIELD_CAP
    ? value.slice(0, LIST_PREVIEW_FIELD_CAP)
    : value;
}

export function projectSessionForList(session: DashboardSessionInfo): DashboardSessionInfo {
  return {
    ...session,
    lastQuestion: capPreviewField(session.lastQuestion),
    lastAnswer: capPreviewField(session.lastAnswer),
    lastMessageText: capPreviewField(session.lastMessageText),
    runDetail: capPreviewField(session.runDetail),
  };
}

function readStringField(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isUploadFile(value: unknown): value is {
  name?: string;
  type?: string;
  arrayBuffer: () => Promise<ArrayBuffer>;
} {
  return !!value
    && typeof value === 'object'
    && typeof (value as any).arrayBuffer === 'function';
}

function extensionForMimeType(mimeType: string): string {
  switch (mimeType.toLowerCase()) {
    case 'image/png': return '.png';
    case 'image/jpeg': return '.jpg';
    case 'image/webp': return '.webp';
    case 'image/gif': return '.gif';
    case 'image/svg+xml': return '.svg';
    default: return '';
  }
}

function sanitizeUploadFileName(rawName: string, mimeType: string, index: number): string {
  const baseName = path.basename(rawName || `attachment-${index + 1}`);
  const parsed = path.parse(baseName);
  const safeStem = (parsed.name || `attachment-${index + 1}`)
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || `attachment-${index + 1}`;
  const ext = parsed.ext || extensionForMimeType(mimeType) || '.bin';
  return `${safeStem}${ext.toLowerCase()}`;
}

async function materializeUploadedFiles(entries: unknown[]): Promise<{ attachments: string[]; cleanup: () => Promise<void> }> {
  const files = entries.filter(isUploadFile);
  if (!files.length) {
    return { attachments: [], cleanup: async () => {} };
  }

  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pikiloom-dashboard-upload-'));
  try {
    const attachments: string[] = [];
    for (const [index, file] of files.entries()) {
      const filename = sanitizeUploadFileName(String(file.name || ''), String(file.type || ''), index);
      const filePath = path.join(tempDir, filename);
      await fs.promises.writeFile(filePath, Buffer.from(await file.arrayBuffer()));
      attachments.push(filePath);
    }
    return {
      attachments,
      cleanup: async () => {
        await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      },
    };
  } catch (error) {
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function parseSessionSendRequest(c: any): Promise<{
  workdir: string;
  agent: string;
  sessionId: string;
  prompt: string;
  model: string;
  effort: string;
  workflow: boolean;
  attachments: string[];
  previousAgent: string;
  previousSessionId: string;
  cleanup: () => Promise<void>;
}> {
  const contentType = String(c.req.header('content-type') || '').toLowerCase();
  if (contentType.includes('multipart/form-data')) {
    const form = await c.req.formData();
    const uploads = await materializeUploadedFiles(form.getAll('attachments'));
    return {
      workdir: readStringField(form.get('workdir')),
      agent: readStringField(form.get('agent')),
      sessionId: readStringField(form.get('sessionId')),
      prompt: readStringField(form.get('prompt')),
      model: readStringField(form.get('model')),
      effort: readStringField(form.get('effort')).toLowerCase(),
      workflow: readStringField(form.get('workflow')) === '1',
      attachments: uploads.attachments,
      previousAgent: readStringField(form.get('previousAgent')),
      previousSessionId: readStringField(form.get('previousSessionId')),
      cleanup: uploads.cleanup,
    };
  }

  const body = await c.req.json();
  return {
    workdir: readStringField(body?.workdir),
    agent: readStringField(body?.agent),
    sessionId: readStringField(body?.sessionId),
    prompt: readStringField(body?.prompt),
    model: readStringField(body?.model),
    effort: readStringField(body?.effort).toLowerCase(),
    workflow: body?.workflow === true,
    attachments: [],
    previousAgent: readStringField(body?.previousAgent),
    previousSessionId: readStringField(body?.previousSessionId),
    cleanup: async () => {},
  };
}

const app = new Hono();

app.get('/api/sessions/:agent', async (c) => {
  const agent = c.req.param('agent') as Agent;
  const config = loadUserConfig();
  const workdir = runtime.getRequestWorkdir(config);
  const page = parsePageNumber(c.req.query('page'));
  const limit = parsePageSize(c.req.query('limit'));
  const botRef = runtime.getBotRef();

  runtime.debug(
    `[sessions] endpoint=single agent=${agent} resolvedWorkdir=${workdir} exists=${fs.existsSync(workdir)} ` +
    `page=${page} limit=${limit}`,
  );

  const result = await querySessions({ workdir, agent });
  const enriched = enrichWithRuntimeStatus(result.sessions, botRef);
  const paged = paginateSessionResult(enriched, page, limit);
  paged.sessions = paged.sessions.map(projectSessionForList);

  runtime.debug(
    `[sessions] endpoint=single agent=${agent} ok=${result.ok} total=${result.total} ` +
    `returned=${paged.sessions.length} error=${result.errors.join('; ') || '(none)'}`,
  );

  return c.json({
    ok: result.ok,
    error: result.errors[0] || null,
    ...paged,
  });
});

app.get('/api/sessions', async (c) => {
  const config = loadUserConfig();
  const workdir = runtime.getRequestWorkdir(config);
  const page = parsePageNumber(c.req.query('page'));
  const limit = parsePageSize(c.req.query('limit'));
  const botRef = runtime.getBotRef();

  runtime.debug(
    `[sessions] endpoint=all resolvedWorkdir=${workdir} exists=${fs.existsSync(workdir)} ` +
    `page=${page} limit=${limit}`,
  );

  const agents = listAgents().agents.filter(a => a.installed);
  const swimLane: Record<string, any> = {};

  await Promise.all(agents.map(async a => {
    const result = await querySessions({ workdir, agent: a.agent });
    const enriched = enrichWithRuntimeStatus(result.sessions, botRef);
    const paged = paginateSessionResult(enriched, page, limit);
    paged.sessions = paged.sessions.map(projectSessionForList);

    swimLane[a.agent] = {
      ok: result.ok,
      error: result.errors[0] || null,
      ...paged,
    };

    runtime.debug(
      `[sessions] endpoint=all agent=${a.agent} ok=${result.ok} total=${result.total} ` +
      `returned=${paged.sessions.length} error=${result.errors.join('; ') || '(none)'}`,
    );
  }));

  return c.json(swimLane);
});

app.get('/api/session-detail/:agent/:id', async (c) => {
  const agent = c.req.param('agent') as Agent;
  const sessionId = decodeURIComponent(c.req.param('id'));
  const config = loadUserConfig();
  const workdir = runtime.getRequestWorkdir(config);
  const limit = parseInt(c.req.query('limit') || '6', 10);

  runtime.debug(
    `[sessions] endpoint=detail agent=${agent} session=${sessionId} limit=${limit} resolvedWorkdir=${workdir} ` +
    `exists=${fs.existsSync(workdir)}`,
  );

  const tail = await querySessionTail({ agent, sessionId, workdir, limit });

  runtime.debug(
    `[sessions] endpoint=detail agent=${agent} session=${sessionId} ok=${tail.ok} ` +
    `messages=${tail.messages.length} error=${tail.error || '(none)'}`,
  );

  return c.json(tail);
});

app.get('/api/workspaces', (c) => {
  const workspaces = loadWorkspaces();
  const config = loadUserConfig();
  const rwd = runtime.getRuntimeWorkdir(config);
  if (rwd && !workspaces.some(w => w.path === rwd)) {
    workspaces.unshift({
      path: rwd,
      name: path.basename(rwd),
      order: -1,
      addedAt: new Date().toISOString(),
    });
  }
  return c.json({ ok: true, workspaces });
});

app.post('/api/workspaces', async (c) => {
  try {
    const body = await c.req.json();
    const wsPath = typeof body?.path === 'string' ? body.path.trim() : '';
    if (!wsPath) return c.json({ ok: false, error: 'path is required' }, 400);
    const entry = addWorkspace(wsPath, body?.name);
    return c.json({ ok: true, workspace: entry });
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

app.delete('/api/workspaces', async (c) => {
  try {
    const body = await c.req.json();
    const wsPath = typeof body?.path === 'string' ? body.path.trim() : '';
    if (!wsPath) return c.json({ ok: false, error: 'path is required' }, 400);
    const removed = removeWorkspace(wsPath);
    return c.json({ ok: true, removed });
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

app.patch('/api/workspaces', async (c) => {
  try {
    const body = await c.req.json();
    const wsPath = typeof body?.path === 'string' ? body.path.trim() : '';
    if (!wsPath) return c.json({ ok: false, error: 'path is required' }, 400);
    const updated = updateWorkspace(wsPath, body);
    return c.json({ ok: true, workspace: updated });
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

app.get('/api/workspace-overviews', async (c) => {
  try {
    const overviews = await getWorkspaceOverviews();
    return c.json({ ok: true, overviews });
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

app.post('/api/session-hub/sessions', async (c) => {
  try {
    const body = await c.req.json();
    const workdir = typeof body?.workdir === 'string' ? body.workdir.trim() : '';
    if (!workdir) return c.json({ ok: false, error: 'workdir is required' }, 400);
    const botRef = runtime.getBotRef();
    const result = await querySessions({
      workdir,
      agent: body?.agents,
      userStatus: body?.userStatus,
      limit: body?.limit,
    });
    return c.json({
      ...result,
      sessions: enrichWithRuntimeStatus(result.sessions, botRef),
    });
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

app.post('/api/session-hub/session/status', async (c) => {
  try {
    const body = await c.req.json();
    const { workdir, agent, sessionId, status } = body || {};
    if (!workdir || !agent || !sessionId || !status) {
      return c.json({ ok: false, error: 'workdir, agent, sessionId, and status are required' }, 400);
    }
    const updated = updateSession(workdir, agent, sessionId, { userStatus: status as UserStatus });
    return c.json({ ok: true, updated });
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

app.post('/api/session-hub/session/note', async (c) => {
  try {
    const body = await c.req.json();
    const { workdir, agent, sessionId, note } = body || {};
    if (!workdir || !agent || !sessionId) {
      return c.json({ ok: false, error: 'workdir, agent, and sessionId are required' }, 400);
    }
    const updated = updateSession(workdir, agent, sessionId, { userNote: note ?? null });
    return c.json({ ok: true, updated });
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

app.post('/api/session-hub/session/delete', async (c) => {
  try {
    const body = await c.req.json();
    const workdir = typeof body?.workdir === 'string' ? body.workdir.trim() : '';
    const agent = typeof body?.agent === 'string' ? body.agent.trim() : '';
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : '';
    const purgeNative = body?.purgeNative === true;
    if (!workdir || !agent || !sessionId) {
      return c.json({ ok: false, error: 'workdir, agent, and sessionId are required' }, 400);
    }
    if (!runtime.isAgent(agent)) {
      return c.json({ ok: false, error: `Unknown agent: ${agent}` }, 400);
    }
    runtime.debug(
      `[sessions] endpoint=delete agent=${agent} session=${sessionId} workdir=${workdir} purgeNative=${purgeNative}`,
    );
    const result = await deleteSession({ workdir, agent: agent as Agent, sessionId, purgeNative });
    if (result.refusedReason === 'session-running') {
      return c.json({ ok: false, error: 'session is still running — stop it first' }, 409);
    }
    return c.json({
      ok: true,
      recordRemoved: result.recordRemoved,
      pikiloomPathsRemoved: result.pikiloomPathsRemoved,
      nativePathsRemoved: result.nativePathsRemoved,
    });
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

app.post('/api/session-hub/session/link', async (c) => {
  try {
    const body = await c.req.json();
    if (!body?.a || !body?.b || !body?.workdir) {
      return c.json({ ok: false, error: 'workdir, a: {agent, sessionId}, b: {agent, sessionId} required' }, 400);
    }
    const linked = linkSessions(body.workdir, body.a, body.b);
    return c.json({ ok: true, linked });
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

app.post('/api/session-hub/session/messages', async (c) => {
  try {
    const body = await c.req.json();
    const { workdir, agent, sessionId, lastNTurns, turnOffset, turnLimit } = body || {};
    if (!workdir || !agent || !sessionId) {
      return c.json({ ok: false, error: 'workdir, agent, and sessionId are required' }, 400);
    }
    const rich = body?.rich !== false;
    const result = await querySessionMessages({
      agent,
      sessionId,
      workdir,
      lastNTurns: Number.isFinite(lastNTurns) ? lastNTurns : undefined,
      turnOffset: Number.isFinite(turnOffset) ? turnOffset : undefined,
      turnLimit: Number.isFinite(turnLimit) ? turnLimit : undefined,
      rich,
    });
    return c.json(prepareSessionMessagesForDashboard(result, agent, sessionId));
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

function prepareSessionMessagesForDashboard(
  result: SessionMessagesResult,
  agent: Agent,
  sessionId: string,
): SessionMessagesResult {
  if (result.richMessages === undefined) return result;

  const richMessages: RichMessage[] = result.richMessages.map(message => ({
    ...message,
    blocks: rewriteAttachmentBlocksForTransport(message.blocks, { agent, sessionId }),
  }));

  const includesTail = !result.window || !result.window.hasNewer;
  if (includesTail) {
    const delivered = rewriteAttachmentBlocksForTransport(
      deliveredArtifactBlocks(agent, sessionId),
      { agent, sessionId },
    );
    if (delivered.length) {
      const text = deliveredSummaryText(delivered);
      richMessages.push({ role: 'assistant', text, blocks: delivered });
    }
  }

  if (!richMessages.length) return result;
  return { ...result, richMessages };
}

function deliveredSummaryText(blocks: MessageBlock[]): string {
  const names = blocks
    .map(b => b.fileName || (b.type === 'image' ? 'image' : 'file'))
    .filter(Boolean);
  if (!names.length) return '';
  return names.length === 1 ? `Delivered: ${names[0]}` : `Delivered ${names.length} files: ${names.join(', ')}`;
}

app.get('/api/sessions/:agent/:id/attachment', async (c) => {
  const agent = c.req.param('agent') as Agent;
  const sessionId = decodeURIComponent(c.req.param('id'));
  const token = c.req.query('p') || '';
  if (!token) return c.json({ ok: false, error: 'missing path parameter' }, 400);

  let requestedPath: string;
  try { requestedPath = decodeAttachmentPathParam(token); } catch {
    return c.json({ ok: false, error: 'invalid path token' }, 400);
  }
  if (!requestedPath || requestedPath.includes('\0')) {
    return c.json({ ok: false, error: 'invalid path' }, 400);
  }

  const config = loadUserConfig();
  const fallbackWorkdir = runtime.getRequestWorkdir(config);
  const managed = findPikiloomSession(fallbackWorkdir, agent, sessionId);
  const workdirs = [
    ...(managed?.workdir ? [managed.workdir] : []),
    fallbackWorkdir,
    ...loadWorkspaces().map(ws => ws.path),
  ];

  const resolved = resolveAllowedAttachmentPath(requestedPath, workdirs);
  if (!resolved) return c.json({ ok: false, error: 'forbidden' }, 403);

  let stat: fs.Stats;
  try { stat = fs.statSync(resolved); } catch {
    return c.json({ ok: false, error: 'not found' }, 404);
  }
  if (!stat.isFile()) return c.json({ ok: false, error: 'not a file' }, 400);

  const mime = mimeForArtifact(resolved);
  const downloadName = sanitizeDownloadName(c.req.query('n'), resolved);
  const disposition = mime.startsWith('image/') ? 'inline' : 'attachment';
  const asciiName = downloadName.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, "'");
  const contentDisposition = `${disposition}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(downloadName)}`;

  const baseHeaders: Record<string, string> = {
    'Content-Type': mime,
    'Content-Disposition': contentDisposition,
    'Cache-Control': 'private, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
    'Accept-Ranges': 'bytes',
  };

  const range = parseByteRange(c.req.header('range'), stat.size);
  if (range) {
    const nodeStream = fs.createReadStream(resolved, { start: range.start, end: range.end });
    return c.body(Readable.toWeb(nodeStream) as ReadableStream, 206, {
      ...baseHeaders,
      'Content-Range': `bytes ${range.start}-${range.end}/${stat.size}`,
      'Content-Length': String(range.end - range.start + 1),
    });
  }

  const nodeStream = fs.createReadStream(resolved);
  return c.body(Readable.toWeb(nodeStream) as ReadableStream, 200, {
    ...baseHeaders,
    'Content-Length': String(stat.size),
  });
});

function sanitizeDownloadName(raw: string | undefined, resolved: string): string {
  const candidate = (raw || '').trim();
  const name = candidate || path.basename(resolved);
  return name.replace(/[/\\\0\r\n]+/g, '_').replace(/^\.+/, '').slice(0, 200) || 'download';
}

function parseByteRange(header: string | undefined, size: number): { start: number; end: number } | null {
  if (!header || size <= 0) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const hasStart = m[1] !== '';
  const hasEnd = m[2] !== '';
  let start: number;
  let end: number;
  if (hasStart) {
    start = parseInt(m[1], 10);
    end = hasEnd ? parseInt(m[2], 10) : size - 1;
  } else if (hasEnd) {
    const suffix = parseInt(m[2], 10);
    if (suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    return null;
  }
  end = Math.min(end, size - 1);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start < 0) return null;
  return { start, end };
}

app.post('/api/session-hub/migrate', async (c) => {
  try {
    const body = await c.req.json();
    if (!body?.source || !body?.target) {
      return c.json({ ok: false, error: 'source and target are required' }, 400);
    }
    const result = await buildMigrationContext({
      source: body.source,
      target: body.target,
      lastNTurns: body.lastNTurns,
    });
    return c.json(result);
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

app.post('/api/session-hub/export', async (c) => {
  try {
    const body = await c.req.json();
    if (!body?.workdir || !body?.agent || !body?.sessionId) {
      return c.json({ ok: false, error: 'workdir, agent, sessionId are required' }, 400);
    }
    const result = await exportSession({
      workdir: body.workdir,
      agent: body.agent,
      sessionId: body.sessionId,
      format: body.format || 'markdown',
      lastNTurns: body.lastNTurns,
    });
    return c.json(result);
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

app.post('/api/session-hub/import', async (c) => {
  try {
    const body = await c.req.json();
    if (!body?.workdir || !body?.agent || !body?.content) {
      return c.json({ ok: false, error: 'workdir, agent, and content are required' }, 400);
    }
    const result = importSession({
      workdir: body.workdir,
      agent: body.agent,
      content: body.content,
      format: body.format,
    });
    return c.json(result);
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

app.get('/api/session-hub/skills', (c) => {
  const workdir = c.req.query('workdir') || '';
  if (!workdir) return c.json({ ok: false, error: 'workdir query param required' }, 400);
  try {
    const result = listSkills(workdir);
    return c.json({ ok: true, skills: result.skills });
  } catch (e: any) {
    return c.json({ ok: false, skills: [], error: e.message }, 500);
  }
});

app.post('/api/session-hub/session/send', async (c) => {
  try {
    const { workdir, agent, sessionId, prompt, model, effort, workflow, attachments, previousAgent, previousSessionId, cleanup } = await parseSessionSendRequest(c);
    const queued = await queueDashboardSessionTask({
      workdir,
      agent,
      sessionId,
      prompt,
      model,
      effort,
      workflow,
      attachments,
      previousAgent: previousAgent || null,
      previousSessionId: previousSessionId || null,
    });
    await cleanup();
    if (!queued.ok) {
      const status = queued.error === 'Bot is not running' ? 503 : 400;
      return c.json(queued, status);
    }
    runtime.debug(
      `[session-send] queued task=${queued.taskId} session=${queued.sessionKey} attachments=${attachments.length} ` +
      `prompt="${(prompt || '[attachments only]').slice(0, 80)}"`,
    );
    return c.json(queued);
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

app.get('/api/session-hub/session/stream-state', (c) => {
  const agent = c.req.query('agent') || '';
  const sessionId = c.req.query('sessionId') || '';
  if (!agent || !sessionId) {
    return c.json({ ok: false, error: 'agent and sessionId query params required' }, 400);
  }
  return c.json(getSessionStreamState(agent, sessionId));
});

app.post('/api/session-hub/session/fork', async (c) => {
  try {
    const body = await c.req.json();
    const { workdir, agent, sessionId, atTurn, prompt, model, effort, attachments } = body || {};
    if (!workdir || !agent || !sessionId || typeof atTurn !== 'number' || !prompt) {
      return c.json({ ok: false, error: 'workdir, agent, sessionId, atTurn (number), and prompt are required' }, 400);
    }
    const queued = forkDashboardSessionTask({
      workdir,
      agent,
      parentSessionId: sessionId,
      atTurn,
      prompt,
      model: model || null,
      effort: effort || null,
      attachments: Array.isArray(attachments) ? attachments : [],
    });
    if (!queued.ok) {
      const status = queued.error === 'Bot is not running' ? 503 : 400;
      return c.json(queued, status);
    }
    runtime.debug(
      `[session-fork] queued task=${queued.taskId} parent=${agent}:${sessionId} child=${queued.sessionKey} atTurn=${atTurn}`
    );
    return c.json(queued);
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

app.post('/api/session-hub/session/recall', async (c) => {
  try {
    const body = await c.req.json();
    const { taskId } = body || {};
    if (!taskId) {
      return c.json({ ok: false, error: 'taskId is required' }, 400);
    }
    const result = cancelSessionTask(taskId);
    return c.json(result, result.ok ? 200 : 503);
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

app.post('/api/session-hub/session/stop', async (c) => {
  try {
    const body = await c.req.json();
    const { agent, sessionId } = body || {};
    if (!agent || !sessionId) {
      return c.json({ ok: false, error: 'agent and sessionId are required' }, 400);
    }
    const result = stopSessionTasks(agent, sessionId);
    return c.json(result, result.ok ? 200 : 503);
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

app.post('/api/session-hub/session/steer', async (c) => {
  try {
    const body = await c.req.json();
    const { taskId } = body || {};
    if (!taskId) {
      return c.json({ ok: false, error: 'taskId is required' }, 400);
    }
    const result = await steerSessionTask(taskId);
    return c.json(result, result.ok ? 200 : 503);
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

app.get('/api/session-hub/session/goal', async (c) => {
  const workdir = c.req.query('workdir') || '';
  const agent = c.req.query('agent') || '';
  const sessionId = c.req.query('sessionId') || '';
  if (!workdir || !agent || !sessionId) {
    return c.json({ ok: false, error: 'workdir, agent, and sessionId query params required' }, 400);
  }
  const bot = runtime.getBotRef();
  if (!bot) return c.json({ ok: false, error: 'bot not attached' }, 503);
  try {
    const goal = await bot.getSessionGoal(workdir, agent as Agent, sessionId);
    return c.json({ ok: true, goal });
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

app.post('/api/session-hub/session/goal', async (c) => {
  try {
    const body = await c.req.json();
    const { workdir, agent, sessionId, objective, tokenBudget, modelId, thinkingEffort } = body || {};
    if (!workdir || !agent || !sessionId || typeof objective !== 'string' || !objective.trim()) {
      return c.json({ ok: false, error: 'workdir, agent, sessionId, and objective are required' }, 400);
    }
    const bot = runtime.getBotRef();
    if (!bot) return c.json({ ok: false, error: 'bot not attached' }, 503);
    const goal = await bot.setSessionGoal(workdir, agent as Agent, sessionId, {
      objective,
      tokenBudget: typeof tokenBudget === 'number' ? tokenBudget : null,
      modelId: typeof modelId === 'string' ? modelId : undefined,
      thinkingEffort: typeof thinkingEffort === 'string' ? thinkingEffort : undefined,
    });
    return c.json({ ok: true, goal });
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

app.post('/api/session-hub/session/goal/pause', async (c) => {
  try {
    const body = await c.req.json();
    const { workdir, agent, sessionId } = body || {};
    if (!workdir || !agent || !sessionId) {
      return c.json({ ok: false, error: 'workdir, agent, and sessionId are required' }, 400);
    }
    const bot = runtime.getBotRef();
    if (!bot) return c.json({ ok: false, error: 'bot not attached' }, 503);
    const goal = await bot.pauseSessionGoal(workdir, agent as Agent, sessionId);
    return c.json({ ok: true, goal });
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

app.post('/api/session-hub/session/goal/resume', async (c) => {
  try {
    const body = await c.req.json();
    const { workdir, agent, sessionId, modelId, thinkingEffort } = body || {};
    if (!workdir || !agent || !sessionId) {
      return c.json({ ok: false, error: 'workdir, agent, and sessionId are required' }, 400);
    }
    const bot = runtime.getBotRef();
    if (!bot) return c.json({ ok: false, error: 'bot not attached' }, 503);
    const goal = await bot.resumeSessionGoal(workdir, agent as Agent, sessionId, {
      modelId: typeof modelId === 'string' ? modelId : undefined,
      thinkingEffort: typeof thinkingEffort === 'string' ? thinkingEffort : undefined,
    });
    return c.json({ ok: true, goal });
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

app.post('/api/session-hub/session/goal/clear', async (c) => {
  try {
    const body = await c.req.json();
    const { workdir, agent, sessionId } = body || {};
    if (!workdir || !agent || !sessionId) {
      return c.json({ ok: false, error: 'workdir, agent, and sessionId are required' }, 400);
    }
    const bot = runtime.getBotRef();
    if (!bot) return c.json({ ok: false, error: 'bot not attached' }, 503);
    await bot.clearSessionGoal(workdir, agent as Agent, sessionId);
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

app.get('/api/interaction/:promptId', (c) => {
  const { promptId } = c.req.param();
  const result = getInteractionPrompt(promptId);
  return c.json(result, result.ok ? 200 : 503);
});

app.post('/api/interaction/:promptId/select', async (c) => {
  try {
    const { promptId } = c.req.param();
    const body = await c.req.json();
    const { value, requestFreeform } = body || {};
    if (!value && !requestFreeform) {
      return c.json({ ok: false, error: 'value is required' }, 400);
    }
    const result = interactionSelectOption(promptId, value || '__other__', { requestFreeform: !!requestFreeform });
    return c.json(result, result.ok ? 200 : (result.error === 'Bot is not running' ? 503 : 404));
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

app.post('/api/interaction/:promptId/text', async (c) => {
  try {
    const { promptId } = c.req.param();
    const body = await c.req.json();
    const { text } = body || {};
    if (typeof text !== 'string') {
      return c.json({ ok: false, error: 'text is required' }, 400);
    }
    const result = interactionSubmitText(promptId, text);
    return c.json(result, result.ok ? 200 : (result.error === 'Bot is not running' ? 503 : 404));
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

app.post('/api/interaction/:promptId/skip', async (c) => {
  try {
    const { promptId } = c.req.param();
    const result = interactionSkip(promptId);
    return c.json(result, result.ok ? 200 : (result.error === 'Bot is not running' ? 503 : 404));
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

app.post('/api/interaction/:promptId/cancel', async (c) => {
  try {
    const { promptId } = c.req.param();
    const result = interactionCancel(promptId);
    return c.json(result, result.ok ? 200 : (result.error === 'Bot is not running' ? 503 : 404));
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

export default app;
