import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname } from 'node:path';
import type {
  AgentDriver, AgentTurnInput, DriverContext, DriverResult, DriverEvent, McpServerSpec,
} from '../contracts/driver.js';
import type { UniversalUsage, UniversalPlan, UniversalInteraction } from '../protocol/index.js';

// ── Generic ACP (Agent Client Protocol) driver ────────────────────────────────
// Speaks the ACP ndjson JSON-RPC wire to ANY ACP-compatible agent CLI — OpenCode,
// Gemini, Hermes, claude-code-acp, … . One AcpDriver instance = one agent binary.
//
// Full client surface (vs. the previous hermes-only minimal client):
//   - MCP forwarding            session/new + session/load carry input.extraMcpServers
//   - HITL permissions          session/request_permission -> ctx.askUser (the kernel HITL seam)
//   - filesystem bridge         fs/read_text_file + fs/write_text_file served from disk
//   - model / mode selection    session/set_model + session/set_mode
//   - multimodal prompts        text + base64 image blocks
//   - usage + plan projection   usage_update -> context%, plan -> UniversalPlan
//   - cooperative cancel        session/cancel on abort, then kill
//
// It owns nothing above the agent axis (no IM/web/queue/persistence) — same contract as
// the Claude/Codex/Gemini drivers, so it plugs into createLoom({ drivers }) / registerDriver.

export interface AcpDriverConfig {
  id: string;                                          // pikiloom agent id (e.g. 'opencode', 'hermes')
  command: string;                                     // binary to spawn
  args?: string[];                                     // subcommand/flags (default ['acp'])
  env?: Record<string, string>;                        // static env, merged UNDER input.env (BYOK wins)
  fsAccess?: boolean;                                  // advertise + serve fs/read|write_text_file (default true)
  permissionFallback?: 'allow' | 'reject' | 'cancel';  // decision when no terminal answers HITL (default 'allow')
  protocolVersion?: number;                            // ACP initialize protocolVersion (default 1)
  promptTimeoutMs?: number;                            // session/prompt timeout (default 2h)
  capabilities?: AgentDriver['capabilities'];
}

type RpcMsg = { jsonrpc?: string; id?: number | string; method?: string; params?: any; result?: any; error?: any };

class AcpRpcError extends Error {
  constructor(readonly code: number, message: string) { super(message); }
}

// ── ACP JSON-RPC client over a child process' stdio (ndjson framing) ───────────
class AcpClient {
  private proc: ChildProcess | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, (m: RpcMsg) => void>();
  private notifyCb?: (method: string, params: any) => void;
  private requestCb?: (method: string, params: any) => Promise<any>;
  private readonly stderrTail: string[] = [];

  constructor(
    private readonly bin: string,
    private readonly args: string[],
    private readonly env: Record<string, string> | undefined,
    private readonly cwd: string,
  ) {}

  onNotification(cb: (method: string, params: any) => void): void { this.notifyCb = cb; }
  onRequest(cb: (method: string, params: any) => Promise<any>): void { this.requestCb = cb; }
  stderrText(): string { return this.stderrTail.join('\n'); }

  start(): boolean {
    try {
      this.proc = spawn(this.bin, this.args, {
        cwd: this.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: this.env ? { ...process.env, ...this.env } : process.env,
      });
    } catch { return false; }
    const rl = createInterface({ input: this.proc.stdout!, crlfDelay: Infinity });
    rl.on('line', (line) => this.onLine(line));
    this.proc.stderr!.on('data', (chunk: Buffer) => {
      for (const ln of chunk.toString('utf8').split('\n')) {
        const t = ln.trim();
        if (!t) continue;
        this.stderrTail.push(t.slice(0, 240));
        if (this.stderrTail.length > 20) this.stderrTail.shift();
      }
    });
    this.proc.on('close', () => { for (const cb of this.pending.values()) cb({ error: { message: 'acp process exited' } }); this.pending.clear(); });
    this.proc.on('error', () => { /* surfaced via request timeouts / start() false */ });
    return true;
  }

  private onLine(line: string): void {
    const t = line.trim();
    if (!t) return;
    let m: RpcMsg;
    try { m = JSON.parse(t); } catch { return; }            // non-JSON stdout noise
    if (m.method && m.id != null) { void this.handleRequest(m); return; }   // agent -> client request
    if (m.id != null) {                                      // response to one of our requests
      const cb = this.pending.get(m.id as number);
      if (cb) { this.pending.delete(m.id as number); cb(m); }
      return;
    }
    if (m.method) this.notifyCb?.(m.method, m.params ?? {});  // notification (session/update)
  }

  private async handleRequest(m: RpcMsg): Promise<void> {
    const id = m.id!;
    if (!this.requestCb) { this.respondError(id, -32601, `Method not implemented: ${m.method}`); return; }
    try {
      const result = await this.requestCb(m.method!, m.params ?? {});
      this.respond(id, result ?? null);
    } catch (e: any) {
      const code = e instanceof AcpRpcError ? e.code : -32603;
      this.respondError(id, code, e?.message || 'handler error');
    }
  }

  request(method: string, params?: any, timeoutMs = 60_000): Promise<RpcMsg> {
    return new Promise((resolve) => {
      if (!this.proc || this.proc.killed) { resolve({ error: { message: 'not connected' } }); return; }
      const id = this.nextId++;
      const timer = setTimeout(() => { this.pending.delete(id); resolve({ error: { message: `ACP '${method}' timed out` } }); }, timeoutMs);
      this.pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params?: any): void { this.write({ jsonrpc: '2.0', method, params }); }
  private respond(id: number | string, result: any): void { this.write({ jsonrpc: '2.0', id, result }); }
  private respondError(id: number | string, code: number, message: string): void { this.write({ jsonrpc: '2.0', id, error: { code, message } }); }
  private write(msg: unknown): void {
    if (!this.proc || this.proc.killed) return;
    try { this.proc.stdin!.write(JSON.stringify(msg) + '\n'); } catch { /* stream closed */ }
  }
  kill(): void { try { this.proc?.kill('SIGTERM'); } catch { /* ignore */ } this.proc = null; }
}

// ── pikiloom McpServerSpec[] -> ACP mcpServers[] ───────────────────────────────
export function toAcpMcpServers(servers?: McpServerSpec[]): any[] {
  if (!servers || !servers.length) return [];
  const out: any[] = [];
  for (const s of servers) {
    if (!s || !s.name) continue;
    if (s.type === 'http' && s.url) {
      out.push({ type: 'http', name: s.name, url: s.url, headers: Object.entries(s.headers || {}).map(([name, value]) => ({ name, value: String(value) })) });
      continue;
    }
    if (s.command) {
      out.push({ name: s.name, command: s.command, args: Array.isArray(s.args) ? s.args.map(String) : [], env: Object.entries(s.env || {}).map(([name, value]) => ({ name, value: String(value) })) });
    }
  }
  return out;
}

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
function mimeForExt(ext: string): string {
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.webp') return 'image/webp';
  return 'image/png';
}

// ACP prompt content blocks: text + inline base64 images; other attachments noted as text.
export function buildAcpPromptBlocks(prompt: string, attachments: string[]): any[] {
  const blocks: any[] = [];
  for (const f of attachments) {
    const ext = extname(f).toLowerCase();
    if (IMAGE_EXTS.has(ext)) {
      try { blocks.push({ type: 'image', mimeType: mimeForExt(ext), data: readFileSync(f).toString('base64') }); continue; }
      catch { /* fall through to a text note */ }
    }
    blocks.push({ type: 'text', text: `[Attached file: ${f}]` });
  }
  blocks.push({ type: 'text', text: prompt });
  return blocks;
}

function acpContentText(content: any): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(acpContentText).filter(Boolean).join('\n');
  if (typeof content === 'object') {
    if (typeof content.text === 'string') return content.text;
    if (content.type === 'content' && content.content) return acpContentText(content.content);
    if (content.type === 'diff' && typeof content.path === 'string') return `[diff ${content.path}]`;
  }
  return '';
}

function acpToolStatus(status: any, dflt: 'running' | 'done' | 'failed'): 'running' | 'done' | 'failed' {
  if (status === 'completed') return 'done';
  if (status === 'failed') return 'failed';
  if (status === 'pending' || status === 'in_progress') return 'running';
  return dflt;
}

function safeJson(v: any): string | null {
  try { return typeof v === 'string' ? v : JSON.stringify(v); } catch { return null; }
}
function truncate(s: string, n: number): string { return s.length > n ? s.slice(0, n) + '…' : s; }

// session/update -> normalized DriverEvents. Exported (and aliased as applyHermesUpdate)
// so it can be unit-tested against the raw ACP wire without spawning a process.
export function applyAcpUpdate(update: any, s: any, tools: Set<string>, emit: (e: DriverEvent) => void): void {
  if (!update) return;
  switch (update.sessionUpdate) {
    case 'agent_message_chunk': {
      const t = acpContentText(update.content);
      if (t) { s.text = (s.text || '') + t; emit({ type: 'text', delta: t }); }
      return;
    }
    case 'agent_thought_chunk': {
      const t = acpContentText(update.content);
      if (t) { s.reasoning = (s.reasoning || '') + t; emit({ type: 'reasoning', delta: t }); }
      return;
    }
    case 'tool_call': {
      const id = typeof update.toolCallId === 'string' ? update.toolCallId : '';
      if (!id) return;
      const name = (typeof update.title === 'string' && update.title.trim()) || (typeof update.kind === 'string' && update.kind) || 'tool';
      tools.add(id);
      emit({ type: 'tool', call: { id, name, summary: name, input: update.rawInput != null ? truncate(safeJson(update.rawInput) || '', 2000) : null, status: acpToolStatus(update.status, 'running') } });
      return;
    }
    case 'tool_call_update': {
      const id = typeof update.toolCallId === 'string' ? update.toolCallId : '';
      if (!id) return;
      const name = (typeof update.title === 'string' && update.title.trim()) || 'tool';
      const status = acpToolStatus(update.status, 'running');
      const result = update.content != null ? truncate(acpContentText(update.content), 2000) : null;
      emit({ type: 'tool', call: { id, name, summary: name, result: result || null, status } });
      return;
    }
    case 'plan': {
      const entries = Array.isArray(update.entries) ? update.entries : [];
      const steps = entries
        .map((e: any) => ({ text: String(e?.content ?? '').trim(), status: e?.status === 'in_progress' ? 'inProgress' : e?.status === 'completed' ? 'completed' : 'pending' }))
        .filter((st: any) => st.text);
      if (steps.length) emit({ type: 'plan', plan: { explanation: null, steps } as UniversalPlan });
      return;
    }
    case 'usage_update': {
      if (typeof update.size === 'number') s.contextWindow = update.size;
      if (typeof update.used === 'number') s.contextUsed = update.used;
      if (typeof update.used === 'number') {
        const window = s.contextWindow;
        const contextPercent = window && update.used > 0 ? Math.min(99.9, Math.round((update.used / window) * 1000) / 10) : null;
        emit({ type: 'usage', usage: { inputTokens: null, outputTokens: null, cachedInputTokens: null, contextUsedTokens: update.used, contextPercent } });
      }
      return;
    }
  }
}

// session/request_permission params -> a normalized UniversalInteraction (kind 'permission').
// Each choice's `value` IS the ACP optionId, so the answer maps straight back to an outcome.
function permissionToInteraction(params: any, promptId: string): UniversalInteraction | null {
  const options = Array.isArray(params?.options) ? params.options : [];
  if (!options.length) return null;
  const tc = params?.toolCall || {};
  const what = (typeof tc.title === 'string' && tc.title.trim()) || (typeof tc.kind === 'string' && tc.kind) || 'this action';
  return {
    promptId,
    kind: 'permission',
    title: 'Permission required',
    hint: `The agent wants to: ${what}`,
    questions: [{
      id: 'choice',
      header: 'Permission',
      text: `Allow the agent to ${what}?`,
      type: 'select',
      choices: options.map((o: any) => ({ label: String(o?.name || o?.optionId || 'option'), value: String(o?.optionId || ''), description: String(o?.kind || '') })),
      allowFreeform: false,
      allowEmpty: true,
    }],
  };
}

function pickOptionId(answers: Record<string, string[]>, options: any[]): string | null {
  const vals = Object.values(answers || {}).flat().map(String);
  for (const v of vals) {
    const byId = options.find((o) => String(o?.optionId) === v);
    if (byId) return String(byId.optionId);
    const byName = options.find((o) => String(o?.name) === v);
    if (byName) return String(byName.optionId);
  }
  return null;
}

function fallbackOptionId(options: any[], fallback: 'allow' | 'reject' | 'cancel'): string | null {
  if (fallback === 'cancel') return null;
  const order = fallback === 'allow' ? ['allow_once', 'allow_always', 'allow'] : ['reject_once', 'reject_always', 'reject'];
  for (const k of order) {
    const o = options.find((x: any) => String(x?.kind) === k);
    if (o) return String(o.optionId);
  }
  return fallback === 'allow' && options[0] ? String(options[0].optionId) : null;
}

function readAcpTextFile(params: any): { content: string } {
  const p = String(params?.path || '');
  if (!p || !existsSync(p)) throw new AcpRpcError(-32602, `file not found: ${p}`);
  let content = readFileSync(p, 'utf8');
  const line = typeof params?.line === 'number' ? params.line : null;
  const limit = typeof params?.limit === 'number' ? params.limit : null;
  if (line != null || limit != null) {
    const lines = content.split('\n');
    const start = line != null ? Math.max(0, line - 1) : 0;
    content = lines.slice(start, limit != null ? start + limit : undefined).join('\n');
  }
  return { content };
}

function writeAcpTextFile(params: any): null {
  const p = String(params?.path || '');
  if (!p) throw new AcpRpcError(-32602, 'path required');
  try { mkdirSync(dirname(p), { recursive: true }); } catch { /* parent may exist */ }
  writeFileSync(p, String(params?.content ?? ''), 'utf8');
  return null;
}

function acpUsage(s: { contextWindow: number | null; contextUsed: number | null }, raw?: any): UniversalUsage {
  let input: number | null = null, output: number | null = null, cached: number | null = null;
  if (raw && typeof raw === 'object') {
    const n = (v: any) => (typeof v === 'number' ? v : null);
    input = n(raw.inputTokens ?? raw.input_tokens);
    output = n(raw.outputTokens ?? raw.output_tokens);
    cached = n(raw.cachedReadTokens ?? raw.cached_read_tokens ?? raw.cachedInputTokens);
  }
  const window = s.contextWindow, used = s.contextUsed;
  const contextPercent = window && used ? Math.min(99.9, Math.round((used / window) * 1000) / 10) : null;
  return { inputTokens: input, outputTokens: output, cachedInputTokens: cached, contextUsedTokens: used, contextPercent, turnOutputTokens: output };
}

export class AcpDriver implements AgentDriver {
  readonly id: string;
  readonly capabilities: NonNullable<AgentDriver['capabilities']>;
  protected readonly cfg: Required<Omit<AcpDriverConfig, 'capabilities' | 'env'>> & Pick<AcpDriverConfig, 'env' | 'capabilities'>;

  constructor(config: AcpDriverConfig) {
    this.id = config.id;
    this.cfg = {
      id: config.id,
      command: config.command,
      args: config.args ?? ['acp'],
      env: config.env,
      fsAccess: config.fsAccess ?? true,
      permissionFallback: config.permissionFallback ?? 'allow',
      protocolVersion: config.protocolVersion ?? 1,
      promptTimeoutMs: config.promptTimeoutMs ?? 7_200_000,
      capabilities: config.capabilities,
    };
    this.capabilities = config.capabilities ?? { steer: false, interact: true, resume: true, tui: false };
  }

  async run(input: AgentTurnInput, ctx: DriverContext): Promise<DriverResult> {
    const env = { ...(this.cfg.env || {}), ...(input.env || {}) };
    const client = new AcpClient(this.cfg.command, this.cfg.args, env, input.workdir);
    const state = { text: '', reasoning: '', contextWindow: null as number | null, contextUsed: null as number | null };
    const tools = new Set<string>();
    let sessionId = input.sessionId ?? null;
    let permSeq = 0;

    if (!client.start()) return { ok: false, text: '', error: `failed to start ${this.cfg.command}`, stopReason: 'error' };

    const onAbort = () => { if (sessionId) client.notify('session/cancel', { sessionId }); client.kill(); };
    if (ctx.signal.aborted) onAbort(); else ctx.signal.addEventListener('abort', onAbort, { once: true });

    client.onNotification((method, params) => {
      if (method === 'session/update') applyAcpUpdate(params?.update ?? params, state, tools, ctx.emit);
    });
    client.onRequest(async (method, params) => {
      switch (method) {
        case 'session/request_permission': return this.resolvePermission(params, ctx, `${this.id}-perm-${++permSeq}`);
        case 'fs/read_text_file':
          if (!this.cfg.fsAccess) throw new AcpRpcError(-32601, 'fs/read_text_file not supported');
          return readAcpTextFile(params);
        case 'fs/write_text_file':
          if (!this.cfg.fsAccess) throw new AcpRpcError(-32601, 'fs/write_text_file not supported');
          return writeAcpTextFile(params);
        default:
          throw new AcpRpcError(-32601, `Method not implemented: ${method}`);
      }
    });

    try {
      const init = await client.request('initialize', {
        protocolVersion: this.cfg.protocolVersion,
        clientCapabilities: { fs: { readTextFile: !!this.cfg.fsAccess, writeTextFile: !!this.cfg.fsAccess }, terminal: false },
      });
      if (init.error) return { ok: false, text: '', error: this.startupError(client, init.error.message || 'initialize failed'), stopReason: 'error' };

      const mcpServers = toAcpMcpServers(input.extraMcpServers);
      if (!sessionId) {
        const ns = await client.request('session/new', { cwd: input.workdir, mcpServers });
        if (ns.error) return { ok: false, text: '', error: ns.error.message || 'session/new failed', stopReason: 'error' };
        sessionId = ns.result?.sessionId ?? ns.result?.session_id ?? null;
        if (sessionId) ctx.emit({ type: 'session', sessionId });
      } else {
        await client.request('session/load', { sessionId, cwd: input.workdir, mcpServers }, 30_000).catch(() => ({}));
        ctx.emit({ type: 'session', sessionId });
      }
      if (!sessionId) return { ok: false, text: '', error: `${this.id} returned no session id`, stopReason: 'error' };

      if (input.model) await client.request('session/set_model', { sessionId, modelId: input.model }, 15_000).catch(() => ({}));
      if (input.effort) await client.request('session/set_mode', { sessionId, modeId: input.effort }, 15_000).catch(() => ({}));

      const promptResp = await client.request('session/prompt', {
        sessionId,
        prompt: buildAcpPromptBlocks(input.prompt, input.attachments || []),
      }, this.cfg.promptTimeoutMs);

      const usage = acpUsage(state, promptResp.result?.usage);
      if (ctx.signal.aborted) return { ok: false, text: state.text, error: 'Interrupted by user.', stopReason: 'interrupted', sessionId, usage };
      if (promptResp.error) return { ok: false, text: state.text, error: promptResp.error.message || 'session/prompt failed', stopReason: 'error', sessionId, usage };
      const stopReason = promptResp.result?.stopReason ?? 'end_turn';
      return { ok: true, text: state.text, reasoning: state.reasoning || undefined, error: null, stopReason, sessionId, usage };
    } finally {
      ctx.signal.removeEventListener('abort', onAbort);
      client.kill();
    }
  }

  private async resolvePermission(params: any, ctx: DriverContext, promptId: string): Promise<any> {
    const options = Array.isArray(params?.options) ? params.options : [];
    if (!options.length) return { outcome: { outcome: 'cancelled' } };
    const interaction = permissionToInteraction(params, promptId);
    let answers: Record<string, string[]> = {};
    if (interaction) { try { answers = (await ctx.askUser(interaction)) || {}; } catch { answers = {}; } }
    if (ctx.signal.aborted) return { outcome: { outcome: 'cancelled' } };
    const picked = pickOptionId(answers, options) ?? fallbackOptionId(options, this.cfg.permissionFallback);
    return picked ? { outcome: { outcome: 'selected', optionId: picked } } : { outcome: { outcome: 'cancelled' } };
  }

  private startupError(client: AcpClient, base: string): string {
    const tail = client.stderrText().trim();
    return tail ? `${base} — ${truncate(tail, 300)}` : base;
  }
}
