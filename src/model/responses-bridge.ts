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

export function upstreamToken(baseURL: string): string {
  return Buffer.from(baseURL, 'utf8').toString('base64url');
}
function decodeUpstream(token: string): string | null {
  try { return Buffer.from(token, 'base64url').toString('utf8') || null; } catch { return null; }
}

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
  try { server?.close(); } catch {  }
  server = null;
  listenPort = 0;
}

function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const m = url.pathname.match(/^\/u\/([^/]+)\/(responses|models)$/);
  if (!m) { res.writeHead(404).end('not found'); return; }
  const upstreamBase = decodeUpstream(m[1]);
  if (!upstreamBase) { res.writeHead(400).end('bad upstream token'); return; }

  if (m[2] === 'models') {
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

  if (!upstreamResp.ok || !upstreamResp.body) {
    const raw = await upstreamResp.text().catch(() => '');
    warn(`upstream ${upstreamResp.status}: ${raw.slice(0, 300)}`);
    sendResponsesError(res, `upstream ${upstreamResp.status}: ${raw.slice(0, 500)}`);
    return;
  }

  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  res.flushHeaders?.();
  let seq = 0;
  const emit = (type: string, extra: Record<string, unknown>) => {
    res.write(`event: ${type}\n`);
    res.write(`data: ${JSON.stringify({ type, sequence_number: seq++, ...extra })}\n\n`);
  };
  const respId = genId('resp');
  const model = chatReq.model;
  const ZERO = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  const baseResp = (status: string, output: any[], usageOut: any) => ({
    id: respId, object: 'response', created_at: Math.floor(Date.now() / 1000), status, model, output, usage: usageOut,
  });
  emit('response.created', { response: baseResp('in_progress', [], ZERO) });
  emit('response.in_progress', { response: baseResp('in_progress', [], ZERO) });

  let nextIndex = 0;
  let msgOpen = false, msgId = '', msgIndex = 0, msgText = '';
  const tools = new Map<number, { id: string; name: string; args: string; index: number; itemId: string; opened: boolean }>();
  let usage: any = null;
  const finalItems: any[] = [];

  // Reasoning ("thinking") from chat-only providers arrives as delta.reasoning_content
  // (DeepSeek / 豆包) or delta.reasoning (GLM / OpenRouter). Translate it to the Responses
  // reasoning-summary stream so codex surfaces item/reasoning/summaryTextDelta live; without
  // this the entire thinking phase is silent and the answer looks like it appears all at once.
  let reasoningOpen = false, reasoningDone = false, reasoningId = '', reasoningIndex = 0, reasoningText = '';
  const openReasoning = () => {
    if (reasoningOpen || reasoningDone) return;
    reasoningOpen = true; reasoningId = genId('rs'); reasoningIndex = nextIndex++;
    emit('response.output_item.added', { output_index: reasoningIndex, item: { id: reasoningId, type: 'reasoning', summary: [] } });
    emit('response.reasoning_summary_part.added', { item_id: reasoningId, output_index: reasoningIndex, summary_index: 0, part: { type: 'summary_text', text: '' } });
  };
  const closeReasoning = () => {
    if (!reasoningOpen) return;
    reasoningOpen = false; reasoningDone = true;
    emit('response.reasoning_summary_text.done', { item_id: reasoningId, output_index: reasoningIndex, summary_index: 0, text: reasoningText });
    emit('response.reasoning_summary_part.done', { item_id: reasoningId, output_index: reasoningIndex, summary_index: 0, part: { type: 'summary_text', text: reasoningText } });
    const item = { id: reasoningId, type: 'reasoning', summary: reasoningText ? [{ type: 'summary_text', text: reasoningText }] : [] };
    emit('response.output_item.done', { output_index: reasoningIndex, item });
    finalItems.push(item);
  };

  const openMsg = () => {
    closeReasoning();  // a reasoning item must finish before the message item opens (ordered output)
    if (msgOpen) return;
    msgOpen = true; msgId = genId('msg'); msgIndex = nextIndex++;
    emit('response.output_item.added', { output_index: msgIndex, item: { id: msgId, type: 'message', role: 'assistant', content: [], status: 'in_progress' } });
  };

  const reader = (upstreamResp.body as any).getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') { buf = ''; break; }
        let chunk: any;
        try { chunk = JSON.parse(data); } catch { continue; }
        if (chunk.usage) usage = chunk.usage;
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta || {};
        const reasoningChunk = typeof delta.reasoning_content === 'string' ? delta.reasoning_content
          : typeof delta.reasoning === 'string' ? delta.reasoning : '';
        if (reasoningChunk && !msgOpen && tools.size === 0) {
          openReasoning();
          if (reasoningOpen) {
            reasoningText += reasoningChunk;
            emit('response.reasoning_summary_text.delta', { item_id: reasoningId, output_index: reasoningIndex, summary_index: 0, delta: reasoningChunk });
          }
        }
        if (typeof delta.content === 'string' && delta.content) {
          openMsg();
          msgText += delta.content;
          emit('response.output_text.delta', { item_id: msgId, output_index: msgIndex, content_index: 0, delta: delta.content });
        }
        if (Array.isArray(delta.tool_calls)) {
          closeReasoning();  // tool calls follow the thinking phase; close the reasoning item first
          for (const tc of delta.tool_calls) {
            const idx = typeof tc.index === 'number' ? tc.index : 0;
            let st = tools.get(idx);
            if (!st) { st = { id: tc.id || genId('call'), name: '', args: '', index: -1, itemId: genId('fc'), opened: false }; tools.set(idx, st); }
            if (tc.id) st.id = tc.id;
            if (tc.function?.name) st.name += tc.function.name;
            if (!st.opened && st.name) {
              st.opened = true; st.index = nextIndex++;
              emit('response.output_item.added', { output_index: st.index, item: { id: st.itemId, type: 'function_call', name: st.name, arguments: '', call_id: st.id, status: 'in_progress' } });
            }
            if (typeof tc.function?.arguments === 'string' && tc.function.arguments) {
              st.args += tc.function.arguments;
              if (st.opened) emit('response.function_call_arguments.delta', { item_id: st.itemId, output_index: st.index, delta: tc.function.arguments });
            }
          }
        }
      }
    }
  } catch (e: any) {
    warn(`stream read error: ${e?.message || e}`);
  }

  closeReasoning();  // reasoning-only turn (no content/tools followed): finish the reasoning item

  if (msgOpen) {
    emit('response.output_text.done', { item_id: msgId, output_index: msgIndex, content_index: 0, text: msgText });
    const item = { id: msgId, type: 'message', role: 'assistant', content: [{ type: 'output_text', text: msgText }] };
    emit('response.output_item.done', { output_index: msgIndex, item });
    finalItems.push(item);
  }
  for (const st of tools.values()) {
    if (!st.opened) {
      st.index = nextIndex++;
      emit('response.output_item.added', { output_index: st.index, item: { id: st.itemId, type: 'function_call', name: st.name, arguments: '', call_id: st.id, status: 'in_progress' } });
      if (st.args) emit('response.function_call_arguments.delta', { item_id: st.itemId, output_index: st.index, delta: st.args });
    }
    emit('response.function_call_arguments.done', { item_id: st.itemId, output_index: st.index, arguments: st.args });
    const item = { id: st.itemId, type: 'function_call', name: st.name, arguments: st.args || '{}', call_id: st.id };
    emit('response.output_item.done', { output_index: st.index, item });
    finalItems.push(item);
  }
  if (!finalItems.length) {
    const id = genId('msg');
    emit('response.output_item.added', { output_index: 0, item: { id, type: 'message', role: 'assistant', content: [], status: 'in_progress' } });
    const item = { id, type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '' }] };
    emit('response.output_item.done', { output_index: 0, item });
    finalItems.push(item);
  }
  const usageOut = usage
    ? { input_tokens: num(usage.prompt_tokens), output_tokens: num(usage.completion_tokens), total_tokens: num(usage.total_tokens) || (num(usage.prompt_tokens) + num(usage.completion_tokens)) }
    : ZERO;
  emit('response.completed', { response: baseResp('completed', finalItems, usageOut) });
  res.end();
}

function sendResponsesError(res: http.ServerResponse, message: string): void {
  if (res.headersSent) { try { res.end(); } catch {  } return; }
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

function asText(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c: any) => (typeof c === 'string' ? c : (typeof c?.text === 'string' ? c.text : '')))
      .join('');
  }
  return '';
}

export function toChatRequest(body: any): any {
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
    }
  }

  const tools = Array.isArray(body.tools) ? flattenResponsesTools(body.tools) : undefined;

  const req: any = { model: body.model, messages, stream: true, stream_options: { include_usage: true } };
  if (tools && tools.length) req.tools = tools;
  if (body.tool_choice != null) req.tool_choice = toChatToolChoice(body.tool_choice);
  if (typeof body.temperature === 'number') req.temperature = body.temperature;
  if (typeof body.top_p === 'number') req.top_p = body.top_p;
  if (typeof body.max_output_tokens === 'number') req.max_tokens = body.max_output_tokens;
  if (typeof body.parallel_tool_calls === 'boolean' && req.tools) req.parallel_tool_calls = body.parallel_tool_calls;
  return req;
}

function flattenResponsesTools(rawTools: any[]): any[] | undefined {
  const out: any[] = [];
  const seen = new Set<string>();
  const push = (t: any) => {
    const chat = toChatTool(t);
    if (!chat) return;
    const name = chat.function?.name;
    if (typeof name === 'string') {
      if (seen.has(name)) return;
      seen.add(name);
    }
    out.push(chat);
  };
  for (const t of rawTools) {
    if (!t || typeof t !== 'object') continue;
    if (t.type === 'namespace' && Array.isArray(t.tools)) {
      for (const nested of t.tools) push(nested);
      continue;
    }
    push(t);
  }
  return out.length ? out : undefined;
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
  return null;
}

function toChatToolChoice(tc: any): any {
  if (typeof tc === 'string') return tc;
  if (tc?.type === 'function' && tc.name) return { type: 'function', function: { name: tc.name } };
  if (tc?.type === 'function' && tc.function) return tc;
  return 'auto';
}

function chatCompletionsUrl(base: string): string {
  const b = base.replace(/\/+$/, '');
  return b.endsWith('/chat/completions') ? b : `${b}/chat/completions`;
}
