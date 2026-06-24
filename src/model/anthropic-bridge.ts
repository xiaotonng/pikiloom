import http from 'node:http';
import { writeScopedLog } from '../core/logging.js';

const SCOPE = 'anthropic-bridge';
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
function decodeUpstream(token: string): string | null {
  try { return Buffer.from(token, 'base64url').toString('utf8') || null; } catch { return null; }
}
function chatCompletionsUrl(base: string): string {
  const b = base.replace(/\/+$/, '');
  return b.endsWith('/chat/completions') ? b : `${b}/chat/completions`;
}

export async function ensureAnthropicBridge(): Promise<number> {
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

export function shutdownAnthropicBridge(): void {
  try { server?.close(); } catch {  }
  server = null;
  listenPort = 0;
}

function readBearer(req: http.IncomingMessage): string {
  const xkey = req.headers['x-api-key'];
  if (typeof xkey === 'string' && xkey) return xkey;
  const auth = req.headers['authorization'];
  const a = Array.isArray(auth) ? auth[0] : auth;
  if (typeof a === 'string') return a.replace(/^Bearer\s+/i, '');
  return '';
}

function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const m = url.pathname.match(/^\/u\/([^/]+)\/v1\/(messages|messages\/count_tokens|models)$/);
  if (!m) { res.writeHead(404).end('not found'); return; }
  const upstreamBase = decodeUpstream(m[1]);
  if (!upstreamBase) { res.writeHead(400).end('bad upstream token'); return; }
  const route = m[2];

  if (route === 'models') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [], has_more: false }));
    return;
  }
  if (req.method !== 'POST') { res.writeHead(405).end('method not allowed'); return; }

  const chunks: Buffer[] = [];
  req.on('data', c => chunks.push(c as Buffer));
  req.on('end', () => {
    let body: any = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { body = {}; }
    if (route === 'messages/count_tokens') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ input_tokens: estimateTokens(body) }));
      return;
    }
    handleMessages(req, res, upstreamBase, body).catch(err => {
      warn(`handler error: ${err?.message || err}`);
      sendError(res, `bridge error: ${err?.message || err}`);
    });
  });
}

async function handleMessages(
  req: http.IncomingMessage, res: http.ServerResponse,
  upstreamBase: string, body: any,
): Promise<void> {
  const wantStream = body.stream === true;
  const chatReq = anthropicToChatRequest(body, wantStream);
  const key = readBearer(req);
  const upstreamUrl = chatCompletionsUrl(upstreamBase);
  log(`-> ${upstreamUrl} model=${chatReq.model} msgs=${chatReq.messages.length} tools=${chatReq.tools?.length ?? 0} stream=${wantStream}`);

  let upstreamResp: Response;
  try {
    upstreamResp = await fetch(upstreamUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify(chatReq),
    });
  } catch (e: any) {
    sendError(res, `upstream fetch failed: ${e?.message || e}`);
    return;
  }

  if (!upstreamResp.ok || !upstreamResp.body) {
    const raw = await upstreamResp.text().catch(() => '');
    warn(`upstream ${upstreamResp.status}: ${raw.slice(0, 300)}`);
    sendError(res, `upstream ${upstreamResp.status}: ${raw.slice(0, 500)}`, upstreamResp.status >= 400 ? upstreamResp.status : 502);
    return;
  }

  if (!wantStream) {
    const data = await upstreamResp.json().catch(() => null);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(chatCompletionToAnthropic(data, chatReq.model)));
    return;
  }

  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  res.flushHeaders?.();
  const emit = (type: string, data: Record<string, unknown>) => {
    res.write(`event: ${type}\n`);
    res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
  };

  const msgId = genId('msg');
  emit('message_start', {
    message: {
      id: msgId, type: 'message', role: 'assistant', model: chatReq.model,
      content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });

  let textOpen = false;
  let textEver = false;
  const tools = new Map<number, { id: string; name: string; args: string }>();
  let usage: any = null;
  let finish: string | null = null;

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
        const dataStr = line.slice(5).trim();
        if (dataStr === '[DONE]') { buf = ''; break; }
        let chunk: any;
        try { chunk = JSON.parse(dataStr); } catch { continue; }
        if (chunk.usage) usage = chunk.usage;
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finish = choice.finish_reason;
        const delta = choice.delta || {};
        if (typeof delta.content === 'string' && delta.content) {
          if (!textOpen) {
            emit('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
            textOpen = true; textEver = true;
          }
          emit('content_block_delta', { index: 0, delta: { type: 'text_delta', text: delta.content } });
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const idx = typeof tc.index === 'number' ? tc.index : 0;
            let st = tools.get(idx);
            if (!st) { st = { id: tc.id || genId('toolu'), name: '', args: '' }; tools.set(idx, st); }
            if (tc.id) st.id = tc.id;
            if (tc.function?.name) st.name += tc.function.name;
            if (typeof tc.function?.arguments === 'string') st.args += tc.function.arguments;
          }
        }
      }
    }
  } catch (e: any) {
    warn(`stream read error: ${e?.message || e}`);
  }

  if (textOpen) emit('content_block_stop', { index: 0 });
  if (!textEver && tools.size === 0) {
    emit('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    emit('content_block_stop', { index: 0 });
    textEver = true;
  }
  let idx = textEver ? 1 : 0;
  for (const st of tools.values()) {
    emit('content_block_start', { index: idx, content_block: { type: 'tool_use', id: st.id, name: st.name, input: {} } });
    emit('content_block_delta', { index: idx, delta: { type: 'input_json_delta', partial_json: st.args.trim() ? st.args : '{}' } });
    emit('content_block_stop', { index: idx });
    idx += 1;
  }

  const stopReason = tools.size ? 'tool_use' : mapStop(finish);
  emit('message_delta', {
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { input_tokens: num(usage?.prompt_tokens), output_tokens: num(usage?.completion_tokens) },
  });
  emit('message_stop', {});
  res.end();
}

function sendError(res: http.ServerResponse, message: string, status = 502): void {
  if (res.headersSent) {
    try {
      res.write(`event: error\n`);
      res.write(`data: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message } })}\n\n`);
      res.end();
    } catch {  }
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message } }));
}

function blockText(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b: any) => (typeof b === 'string' ? b : (b?.type === 'text' && typeof b.text === 'string' ? b.text : '')))
      .join('');
  }
  return '';
}

function anthropicToChatRequest(body: any, wantStream: boolean): any {
  const messages: any[] = [];
  if (body.system) {
    const sys = typeof body.system === 'string' ? body.system : blockText(body.system);
    if (sys.trim()) messages.push({ role: 'system', content: sys });
  }
  for (const m of (Array.isArray(body.messages) ? body.messages : [])) {
    const role = m?.role;
    const content = m?.content;
    if (typeof content === 'string') {
      messages.push({ role: role === 'assistant' ? 'assistant' : 'user', content });
      continue;
    }
    if (!Array.isArray(content)) continue;
    if (role === 'assistant') {
      let text = '';
      const toolCalls: any[] = [];
      for (const b of content) {
        if (b?.type === 'text') text += b.text || '';
        else if (b?.type === 'tool_use') {
          toolCalls.push({
            id: b.id,
            type: 'function',
            function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
          });
        }
      }
      const msg: any = { role: 'assistant', content: text || null };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      messages.push(msg);
    } else {
      const toolMsgs: any[] = [];
      const parts: any[] = [];
      for (const b of content) {
        if (b?.type === 'text') parts.push({ type: 'text', text: b.text || '' });
        else if (b?.type === 'image' && b.source) {
          const src = b.source;
          let url = '';
          if (src.type === 'base64' && src.data) url = `data:${src.media_type || 'image/png'};base64,${src.data}`;
          else if (src.type === 'url' && src.url) url = src.url;
          if (url) parts.push({ type: 'image_url', image_url: { url } });
        } else if (b?.type === 'tool_result') {
          const trText = typeof b.content === 'string' ? b.content : blockText(b.content);
          toolMsgs.push({ role: 'tool', tool_call_id: b.tool_use_id, content: trText });
        }
      }
      for (const tm of toolMsgs) messages.push(tm);
      if (parts.length) {
        const onlyText = parts.every(p => p.type === 'text');
        messages.push({ role: 'user', content: onlyText ? parts.map(p => p.text).join('') : parts });
      }
    }
  }

  const tools = Array.isArray(body.tools) ? body.tools.map(anthropicToolToChat).filter(Boolean) : undefined;
  const req: any = { model: body.model, messages, stream: wantStream };
  if (wantStream) req.stream_options = { include_usage: true };
  if (tools && tools.length) req.tools = tools;
  if (body.tool_choice) {
    const tc = anthropicToolChoiceToChat(body.tool_choice);
    if (tc) req.tool_choice = tc;
  }
  if (typeof body.max_tokens === 'number') req.max_tokens = body.max_tokens;
  if (typeof body.temperature === 'number') req.temperature = body.temperature;
  if (typeof body.top_p === 'number') req.top_p = body.top_p;
  return req;
}

function anthropicToolToChat(t: any): any {
  if (!t || typeof t.name !== 'string' || !t.name) return null;
  return {
    type: 'function',
    function: {
      name: t.name,
      description: typeof t.description === 'string' ? t.description : '',
      parameters: t.input_schema && typeof t.input_schema === 'object' ? t.input_schema : { type: 'object', properties: {} },
    },
  };
}

function anthropicToolChoiceToChat(tc: any): any {
  if (!tc || typeof tc !== 'object') return undefined;
  if (tc.type === 'auto') return 'auto';
  if (tc.type === 'any') return 'required';
  if (tc.type === 'tool' && tc.name) return { type: 'function', function: { name: tc.name } };
  return 'auto';
}

function chatCompletionToAnthropic(data: any, model: string): any {
  const choice = data?.choices?.[0];
  const msg = choice?.message || {};
  const content: any[] = [];
  if (typeof msg.content === 'string' && msg.content) content.push({ type: 'text', text: msg.content });
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      let input: any = {};
      try { input = JSON.parse(tc.function?.arguments || '{}'); } catch { input = {}; }
      content.push({ type: 'tool_use', id: tc.id || genId('toolu'), name: tc.function?.name || '', input });
    }
  }
  if (!content.length) content.push({ type: 'text', text: '' });
  const stop = msg.tool_calls?.length ? 'tool_use' : mapStop(choice?.finish_reason || 'stop');
  return {
    id: genId('msg'), type: 'message', role: 'assistant', model,
    content, stop_reason: stop, stop_sequence: null,
    usage: { input_tokens: num(data?.usage?.prompt_tokens), output_tokens: num(data?.usage?.completion_tokens) },
  };
}

function mapStop(finish: string | null): string {
  switch (finish) {
    case 'length': return 'max_tokens';
    case 'tool_calls': return 'tool_use';
    case 'content_filter': return 'end_turn';
    default: return 'end_turn';
  }
}

function estimateTokens(body: any): number {
  let chars = 0;
  if (body?.system) chars += (typeof body.system === 'string' ? body.system : blockText(body.system)).length;
  for (const m of (Array.isArray(body?.messages) ? body.messages : [])) {
    chars += blockText(m?.content).length;
  }
  return Math.max(1, Math.ceil(chars / 4));
}
