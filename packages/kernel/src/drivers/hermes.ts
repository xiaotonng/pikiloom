import { spawn, type ChildProcess } from 'node:child_process';
import type { AgentDriver, AgentTurnInput, DriverContext, DriverResult, DriverEvent } from '../contracts/driver.js';
import type { UniversalUsage } from '../protocol/index.js';

type RpcMsg = { jsonrpc?: string; id?: number; method?: string; params?: any; result?: any; error?: any };

// Minimal ACP (Agent Client Protocol) ndjson JSON-RPC client — same wire as codex
// app-server. Used by the Hermes driver to drive any-model agents over ACP.
class AcpClient {
  private proc: ChildProcess | null = null;
  private buf = '';
  private nextId = 1;
  private readonly pending = new Map<number, (m: RpcMsg) => void>();
  private notify?: (method: string, params: any) => void;

  constructor(private readonly bin: string, private readonly args: string[], private readonly env?: Record<string, string>) {}
  onNotification(cb: (method: string, params: any) => void) { this.notify = cb; }

  start(): boolean {
    try { this.proc = spawn(this.bin, this.args, { stdio: ['pipe', 'pipe', 'pipe'], env: this.env ? { ...process.env, ...this.env } : process.env }); }
    catch { return false; }
    this.proc.stdout!.on('data', (chunk: Buffer) => this.onData(chunk));
    this.proc.on('close', () => { for (const cb of this.pending.values()) cb({ error: { message: 'acp exited' } }); this.pending.clear(); });
    this.proc.on('error', () => { /* surfaced via timeouts */ });
    return true;
  }
  private onData(chunk: Buffer): void {
    this.buf += chunk.toString('utf8');
    const lines = this.buf.split('\n'); this.buf = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let m: RpcMsg; try { m = JSON.parse(line); } catch { continue; }
      if (m.method && m.id != null) { this.respond(m.id, {}); }          // agent->client request: ack
      else if (m.id != null) { const cb = this.pending.get(m.id); if (cb) { this.pending.delete(m.id); cb(m); } }
      else if (m.method) this.notify?.(m.method, m.params ?? {});
    }
  }
  request(method: string, params?: any, timeoutMs = 60_000): Promise<RpcMsg> {
    return new Promise((resolve) => {
      if (!this.proc || this.proc.killed) { resolve({ error: { message: 'not connected' } }); return; }
      const id = this.nextId++;
      const timer = setTimeout(() => { this.pending.delete(id); resolve({ error: { message: `ACP '${method}' timed out` } }); }, timeoutMs);
      this.pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
      try { this.proc.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); }
      catch { clearTimeout(timer); this.pending.delete(id); resolve({ error: { message: 'write failed' } }); }
    });
  }
  private respond(id: number, result: any) { try { this.proc?.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n'); } catch { /* closed */ } }
  kill() { try { this.proc?.kill('SIGTERM'); } catch { /* ignore */ } this.proc = null; }
}

export class HermesDriver implements AgentDriver {
  readonly id = 'hermes';
  readonly capabilities = { steer: false, interact: false, resume: true, tui: false };

  constructor(private readonly bin: string = 'hermes') {}

  async run(input: AgentTurnInput, ctx: DriverContext): Promise<DriverResult> {
    const client = new AcpClient(this.bin, ['acp'], input.env);
    const s = { text: '', reasoning: '', sessionId: input.sessionId ?? null, contextWindow: null as number | null, contextUsed: null as number | null, error: null as string | null };
    const tools = new Set<string>();
    if (!client.start()) return { ok: false, text: '', error: 'failed to start hermes acp', stopReason: 'error' };

    const onAbort = () => { try { client.request('session/cancel', { sessionId: s.sessionId }); } catch { /* ignore */ } client.kill(); };
    if (ctx.signal.aborted) onAbort(); else ctx.signal.addEventListener('abort', onAbort, { once: true });

    client.onNotification((method, params) => {
      if (method !== 'session/update') return;
      applyHermesUpdate(params?.update ?? params, s, tools, ctx.emit);
    });

    try {
      const init = await client.request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } });
      if (init.error) return { ok: false, text: '', error: init.error.message || 'initialize failed', stopReason: 'error' };

      if (!s.sessionId) {
        const ns = await client.request('session/new', { cwd: input.workdir, mcpServers: [] });
        if (ns.error) return { ok: false, text: '', error: ns.error.message || 'session/new failed', stopReason: 'error' };
        s.sessionId = ns.result?.sessionId || ns.result?.session_id || null;
        if (s.sessionId) ctx.emit({ type: 'session', sessionId: s.sessionId });
      } else {
        await client.request('session/load', { sessionId: s.sessionId, cwd: input.workdir, mcpServers: [] }, 30_000).catch(() => ({}));
      }
      if (!s.sessionId) return { ok: false, text: '', error: 'hermes returned no session id', stopReason: 'error' };

      if (input.model) await client.request('session/set_model', { sessionId: s.sessionId, modelId: input.model }, 15_000).catch(() => ({}));

      const promptResp = await client.request('session/prompt', {
        sessionId: s.sessionId,
        prompt: [{ type: 'text', text: input.prompt }],
      }, 7_200_000);
      const usage: UniversalUsage = { inputTokens: null, outputTokens: null, cachedInputTokens: null, contextUsedTokens: s.contextUsed, contextPercent: null };
      if (ctx.signal.aborted) return { ok: false, text: s.text, error: 'Interrupted by user.', stopReason: 'interrupted', sessionId: s.sessionId, usage };
      if (promptResp.error) return { ok: false, text: s.text, error: promptResp.error.message || 'session/prompt failed', stopReason: 'error', sessionId: s.sessionId, usage };
      const stopReason = promptResp.result?.stopReason ?? 'end_turn';
      return { ok: !s.error, text: s.text, reasoning: s.reasoning || undefined, error: s.error, stopReason, sessionId: s.sessionId, usage };
    } finally {
      client.kill();
    }
  }
}

export function applyHermesUpdate(u: any, s: any, tools: Set<string>, emit: (e: DriverEvent) => void): void {
  if (!u) return;
  switch (u.sessionUpdate) {
    case 'agent_message_chunk': { const t = u.content?.text; if (typeof t === 'string' && t) { s.text += t; emit({ type: 'text', delta: t }); } return; }
    case 'agent_thought_chunk': { const t = u.content?.text; if (typeof t === 'string' && t) { s.reasoning += t; emit({ type: 'reasoning', delta: t }); } return; }
    case 'tool_call': {
      const id = typeof u.toolCallId === 'string' ? u.toolCallId : '';
      const title = (typeof u.title === 'string' && u.title.trim()) || 'tool';
      if (id && !tools.has(id)) { tools.add(id); emit({ type: 'tool', call: { id, name: title, summary: title, status: 'running' } }); }
      return;
    }
    case 'tool_call_update': {
      const id = typeof u.toolCallId === 'string' ? u.toolCallId : '';
      const title = (typeof u.title === 'string' && u.title.trim()) || 'tool';
      if (id && (u.status === 'completed' || u.status === 'failed')) emit({ type: 'tool', call: { id, name: title, summary: title, status: u.status === 'failed' ? 'failed' : 'done' } });
      return;
    }
    case 'usage_update': {
      if (typeof u.used === 'number') { s.contextUsed = u.used; emit({ type: 'usage', usage: { inputTokens: null, outputTokens: null, cachedInputTokens: null, contextUsedTokens: u.used, contextPercent: null } }); }
      return;
    }
  }
}
