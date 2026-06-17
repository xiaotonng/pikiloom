/**
 * Responses↔Chat bridge.
 *
 * Codex 0.140+ speaks ONLY the OpenAI Responses API (`wire_api = "chat"` was
 * removed). Many OpenAI-compatible providers — DeepSeek, Kimi/Moonshot,
 * MiniMax, 豆包/Doubao, Qwen/DashScope, Zhipu, … — implement ONLY the Chat
 * Completions API. This in-process HTTP server bridges the two so codex can
 * drive any chat-only provider:
 *
 *   codex ──(Responses API)──▶ bridge ──(Chat Completions)──▶ upstream provider
 *
 * One server instance routes every upstream: the upstream base URL is encoded
 * (base64url) into the request path (`/u/<token>/responses`). The caller's
 * Authorization header is forwarded verbatim, so the bridge never reads or
 * stores credentials — codex injects `Authorization: Bearer <key>` from the
 * provider's `env_key`, and we relay it upstream.
 *
 * Translation is intentionally NON-incremental: we call the upstream with
 * `stream:false`, then synthesise a complete, spec-shaped Responses SSE stream.
 * Codex rebuilds a turn from `response.output_item.done` items plus the final
 * `response.completed`, so a fully-populated terminal payload is authoritative;
 * this sidesteps fragile per-token delta bookkeeping while still surfacing
 * assistant text AND tool/function calls (apply_patch, shell, MCP tools).
 */

import http from 'node:http';
import { writeScopedLog } from '../core/logging.js';

const SCOPE = 'model-bridge';
const log = (m: string) => { writeScopedLog(SCOPE, m); };
const warn = (m: string) => { writeScopedLog(SCOPE, m, { level: 'warn', stream: 'stderr' }); };

let server: http.Server | null = null;
let listenPort = 0;
let starting: Promise<number> | null = null;
let idCounter = 0;

function genId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36)}`;
}
function num(v: unknown): number { return typeof v === 'number' && Number.isFinite(v) ? v : 0; }

/** base64url-encode an upstream base URL so it survives as a single path segment. */
export function upstreamToken(baseURL: string): string {
  return Buffer.from(baseURL, 'utf8').toString('base64url');
}
function decodeUpstream(token: string): string | null {
  try { return Buffer.from(token, 'base64url').toString('utf8') || null; } catch { return null; }
}

/** Start (or reuse) the singleton bridge server; resolves to its localhost port. */
export async function ensureResponsesBridge(): Promise<number> {
  if (server && listenPort) return listenPort;
  if (starting) return starting;
  starting = new Promise<number>((resolve, reject) => {
    const srv = http.createServer(handleRequest);
    srv.on('error', err => { warn(`server error: ${(err as any)?.message || err}`); reject(err); });
    srv.listen(0, '127.0.0.1', () => {
      server = srv;
      const addr = srv.address();
      listenPort = typeof addr === 'object' && addr ? addr.port : 0;
      log(`listening on 127.0.0.1:${listenPort}`);
      resolve(listenPort);
    });
  });
  try { return await starting; } finally { starting = null; }
}

export function shutdownResponsesBridge(): void {
  try { server?.close(); } catch { /* ignore */ }
  server = null;
  listenPort = 0;
}

// ---------------------------------------------------------------------------
// HTTP handling
// ---------------------------------------------------------------------------

function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const m = url.pathname.match(/^\/u\/([^/]+)\/(responses|models)$/);
  if (!m) { res.writeHead(404).end('not found'); return; }
  const upstreamBase = decodeUpstream(m[1]);
  if (!upstreamBase) { res.writeHead(400).end('bad upstream token'); return; }

  if (m[2] === 'models') {
    // Codex's model-catalog refresh is best-effort; an empty list keeps it quiet
    // and never blocks the turn.
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [], models: [] }));
    return;
  }

  if (req.method !== 'POST') { res.writeHead(405).end('method not allowed'); return; }

  const chunks: Buffer[] = [];
  req.on('data', c => chunks.push(c as Buffer));
  req.on('end', () => {
    let body: any = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { body = {}; }
    handleResponses(req, res, upstreamBase, body).catch(err => {
      warn(`handler error: ${err?.message || err}`);
      sendResponsesError(res, `bridge error: ${err?.message || err}`);
    });
  });
}

async function handleResponses(
  req: http.IncomingMessage, res: http.ServerResponse,
  upstreamBase: string, body: any,
): Promise<void> {
  const chatReq = toChatRequest(body);
  const auth = req.headers['authorization'];
  const upstreamUrl = chatCompletionsUrl(upstreamBase);
  log(`-> ${upstreamUrl} model=${chatReq.model} msgs=${chatReq.messages.length} tools=${chatReq.tools?.length ?? 0}`);

  let upstreamResp: Response;
  try {
    upstreamResp = await fetch(upstreamUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(auth ? { authorization: Array.isArray(auth) ? auth[0] : auth } : {}),
      },
      body: JSON.stringify(chatReq),
    });
  } catch (e: any) {
    sendResponsesError(res, `upstream fetch failed: ${e?.message || e}`);
    return;
  }

  const raw = await upstreamResp.text();
  if (!upstreamResp.ok) {
    warn(`upstream ${upstreamResp.status}: ${raw.slice(0, 300)}`);
    sendResponsesError(res, `upstream ${upstreamResp.status}: ${raw.slice(0, 500)}`);
    return;
  }

  let chat: any;
  try { chat = JSON.parse(raw); } catch { sendResponsesError(res, `bad upstream JSON: ${raw.slice(0, 200)}`); return; }

  const events = buildResponsesEvents(chat, chatReq.model);
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  for (const ev of events) {
    res.write(`event: ${ev.type}\n`);
    res.write(`data: ${JSON.stringify(ev)}\n\n`);
  }
  res.end();
}

function sendResponsesError(res: http.ServerResponse, message: string): void {
  if (res.headersSent) { try { res.end(); } catch { /* ignore */ } return; }
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const id = genId('resp');
  let seq = 0;
  const emit = (e: any) => { res.write(`event: ${e.type}\n`); res.write(`data: ${JSON.stringify({ ...e, sequence_number: seq++ })}\n\n`); };
  emit({ type: 'response.created', response: { id, object: 'response', status: 'in_progress', output: [] } });
  emit({ type: 'response.failed', response: { id, object: 'response', status: 'failed', error: { code: 'bridge_error', message }, output: [] } });
  res.end();
}

// ---------------------------------------------------------------------------
// Request translation: Responses → Chat Completions
// ---------------------------------------------------------------------------

function asText(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c: any) => (typeof c === 'string' ? c : (typeof c?.text === 'string' ? c.text : '')))
      .join('');
  }
  return '';
}

function toChatRequest(body: any): any {
  const messages: any[] = [];
  if (typeof body.instructions === 'string' && body.instructions.trim()) {
    messages.push({ role: 'system', content: body.instructions });
  }
  const input = Array.isArray(body.input) ? body.input : (body.input != null ? [body.input] : []);
  for (const item of input) {
    if (typeof item === 'string') { messages.push({ role: 'user', content: item }); continue; }
    const type = item?.type;
    if (type === 'message' || (!type && item?.role)) {
      const role = item.role === 'assistant' ? 'assistant' : item.role === 'system' ? 'system' : 'user';
      messages.push({ role, content: asText(item.content) });
    } else if (type === 'function_call') {
      messages.push({
        role: 'assistant',
        content: typeof item.text === 'string' ? item.text : null,
        tool_calls: [{
          id: item.call_id || item.id,
          type: 'function',
          function: {
            name: item.name,
            arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {}),
          },
        }],
      });
    } else if (type === 'function_call_output') {
      const out = item.output;
      messages.push({
        role: 'tool',
        tool_call_id: item.call_id,
        content: typeof out === 'string' ? out : JSON.stringify(out ?? ''),
      });
    } else if (type === 'reasoning') {
      // Chat models cannot ingest prior reasoning items — drop.
    }
  }

  const tools = Array.isArray(body.tools)
    ? body.tools.map(toChatTool).filter((t: any) => t)
    : undefined;

  const req: any = { model: body.model, messages, stream: false };
  if (tools && tools.length) req.tools = tools;
  if (body.tool_choice != null) req.tool_choice = toChatToolChoice(body.tool_choice);
  if (typeof body.temperature === 'number') req.temperature = body.temperature;
  if (typeof body.top_p === 'number') req.top_p = body.top_p;
  if (typeof body.max_output_tokens === 'number') req.max_tokens = body.max_output_tokens;
  if (typeof body.parallel_tool_calls === 'boolean' && req.tools) req.parallel_tool_calls = body.parallel_tool_calls;
  return req;
}

function toChatTool(t: any): any {
  if (!t) return null;
  if (t.type === 'function') {
    if (t.function && typeof t.function === 'object') return { type: 'function', function: t.function };
    return {
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters || { type: 'object', properties: {} },
      },
    };
  }
  // Codex built-in custom tools (e.g. local_shell) and web_search aren't
  // expressible as chat functions — drop; codex falls back to its function tools.
  return null;
}

function toChatToolChoice(tc: any): any {
  if (typeof tc === 'string') return tc; // auto | none | required
  if (tc?.type === 'function' && tc.name) return { type: 'function', function: { name: tc.name } };
  if (tc?.type === 'function' && tc.function) return tc;
  return 'auto';
}

// ---------------------------------------------------------------------------
// Response synthesis: Chat Completion → Responses SSE events
// ---------------------------------------------------------------------------

function buildResponsesEvents(chat: any, model: string): any[] {
  const choice = chat?.choices?.[0] || {};
  const msg = choice.message || {};

  const items: any[] = [];
  const text = typeof msg.content === 'string'
    ? msg.content
    : (Array.isArray(msg.content) ? msg.content.map((c: any) => c?.text || '').join('') : '');
  if (text && text.trim()) {
    items.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
  }
  const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
  for (const tc of toolCalls) {
    const fn = tc.function || {};
    items.push({
      type: 'function_call',
      name: fn.name,
      arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
      call_id: tc.id || genId('call'),
    });
  }
  // Always emit at least one item so codex sees a well-formed turn.
  if (!items.length) items.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '' }] });

  const respId = genId('resp');
  const usage = chat?.usage || {};
  const usageOut = {
    input_tokens: num(usage.prompt_tokens),
    output_tokens: num(usage.completion_tokens),
    total_tokens: num(usage.total_tokens) || (num(usage.prompt_tokens) + num(usage.completion_tokens)),
  };
  const responseObj = (status: string, output: any[]) => ({
    id: respId, object: 'response', created_at: Math.floor(Date.now() / 1000),
    status, model, output, usage: usageOut,
  });

  let seq = 0;
  const events: any[] = [];
  const push = (e: any) => { events.push({ ...e, sequence_number: seq++ }); };

  push({ type: 'response.created', response: responseObj('in_progress', []) });
  push({ type: 'response.in_progress', response: responseObj('in_progress', []) });

  const finalItems: any[] = [];
  items.forEach((item, idx) => {
    const id = genId(item.type === 'function_call' ? 'fc' : 'msg');
    const full = { ...item, id };
    finalItems.push(full);
    push({ type: 'response.output_item.added', output_index: idx, item: skeleton(full) });
    if (item.type === 'message') {
      const t = item.content?.[0]?.text || '';
      if (t) {
        push({ type: 'response.output_text.delta', item_id: id, output_index: idx, content_index: 0, delta: t });
        push({ type: 'response.output_text.done', item_id: id, output_index: idx, content_index: 0, text: t });
      }
    } else if (item.type === 'function_call') {
      push({ type: 'response.function_call_arguments.delta', item_id: id, output_index: idx, delta: item.arguments });
      push({ type: 'response.function_call_arguments.done', item_id: id, output_index: idx, arguments: item.arguments });
    }
    push({ type: 'response.output_item.done', output_index: idx, item: full });
  });

  push({ type: 'response.completed', response: responseObj('completed', finalItems) });
  return events;
}

function skeleton(item: any): any {
  if (item.type === 'message') return { id: item.id, type: 'message', role: item.role, content: [], status: 'in_progress' };
  if (item.type === 'function_call') return { id: item.id, type: 'function_call', name: item.name, arguments: '', call_id: item.call_id, status: 'in_progress' };
  return item;
}

function chatCompletionsUrl(base: string): string {
  const b = base.replace(/\/+$/, '');
  return b.endsWith('/chat/completions') ? b : `${b}/chat/completions`;
}
