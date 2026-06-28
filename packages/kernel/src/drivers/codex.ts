import { spawn, type ChildProcess } from 'node:child_process';
import type {
  AgentDriver, AgentTurnInput, DriverContext, DriverResult, TuiInput, TuiSpec,
} from '../contracts/driver.js';
import type { UniversalPlan, UniversalUsage, UniversalInteraction } from '../protocol/index.js';

type RpcMsg = { jsonrpc?: string; id?: number; method?: string; params?: any; result?: any; error?: any };

// Minimal newline-delimited JSON-RPC client for `codex app-server` (ported faithfully
// from pikiloom's CodexAppServer; trimmed to what the kernel needs).
class AppServer {
  private proc: ChildProcess | null = null;
  private buf = '';
  private nextId = 1;
  private readonly pending = new Map<number, (m: RpcMsg) => void>();
  private notify?: (method: string, params: any) => void;
  private requestResponder?: (method: string, params: any, id: number) => any | Promise<any>;

  constructor(private readonly bin: string, private readonly configOverrides: string[], private readonly env?: Record<string, string>) {}

  onNotification(cb: (method: string, params: any) => void) { this.notify = cb; }
  onServerRequest(cb: (method: string, params: any, id: number) => any | Promise<any>) { this.requestResponder = cb; }

  async start(): Promise<boolean> {
    const args = ['app-server'];
    const overrides = this.configOverrides.some(c => /^features\.goals\s*=/.test(c)) ? this.configOverrides : [...this.configOverrides, 'features.goals=true'];
    for (const c of overrides) args.push('-c', c);
    try {
      this.proc = spawn(this.bin, args, { stdio: ['pipe', 'pipe', 'pipe'], env: this.env ? { ...process.env, ...this.env } : process.env });
    } catch { return false; }
    this.proc.stdout!.on('data', (chunk: Buffer) => this.onData(chunk));
    this.proc.on('close', () => { for (const cb of this.pending.values()) cb({ error: { message: 'app-server exited' } }); this.pending.clear(); });
    this.proc.on('error', () => { /* surfaced via call timeouts */ });
    const init = await this.call('initialize', { clientInfo: { name: '@pikiloom/kernel', version: '0.1.0' }, capabilities: { experimentalApi: true } }, 15_000);
    return !init.error;
  }

  private onData(chunk: Buffer): void {
    this.buf += chunk.toString('utf8');
    const lines = this.buf.split('\n');
    this.buf = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let msg: RpcMsg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.method && msg.id != null) {                       // server -> client request
        const id = msg.id;
        Promise.resolve(this.requestResponder ? this.requestResponder(msg.method, msg.params ?? {}, id) : {})
          .then((result) => this.respond(id, result ?? {}))
          .catch(() => this.respond(id, {}));
      } else if (msg.id != null) {                              // response to our call
        const cb = this.pending.get(msg.id); if (cb) { this.pending.delete(msg.id); cb(msg); }
      } else if (msg.method) {                                  // notification
        this.notify?.(msg.method, msg.params ?? {});
      }
    }
  }

  call(method: string, params?: any, timeoutMs = 60_000): Promise<RpcMsg> {
    return new Promise((resolve) => {
      if (!this.proc || this.proc.killed) { resolve({ error: { message: 'not connected' } }); return; }
      const id = this.nextId++;
      const timer = setTimeout(() => { this.pending.delete(id); resolve({ error: { message: `RPC '${method}' timed out` } }); }, timeoutMs);
      this.pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
      const msg: RpcMsg = { jsonrpc: '2.0', id, method }; if (params !== undefined) msg.params = params;
      try { this.proc.stdin!.write(JSON.stringify(msg) + '\n'); } catch { clearTimeout(timer); this.pending.delete(id); resolve({ error: { message: 'write failed' } }); }
    });
  }

  private respond(id: number, result: any): void {
    try { this.proc?.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n'); } catch { /* closed */ }
  }

  kill(): void { try { this.proc?.kill('SIGTERM'); } catch { /* ignore */ } this.proc = null; }
}

function planFromUpdate(params: any): UniversalPlan | null {
  const rawSteps = Array.isArray(params?.plan?.steps) ? params.plan.steps : Array.isArray(params?.steps) ? params.steps : Array.isArray(params?.plan) ? params.plan : [];
  const steps = rawSteps.map((st: any) => {
    const text = typeof st?.step === 'string' ? st.step : typeof st?.text === 'string' ? st.text : '';
    const raw = String(st?.status || 'pending');
    const status = raw === 'completed' ? 'completed' : (raw === 'in_progress' || raw === 'inProgress') ? 'inProgress' : 'pending';
    return text ? { text, status } : null;
  }).filter(Boolean) as UniversalPlan['steps'];
  return steps.length ? { explanation: typeof params?.explanation === 'string' ? params.explanation : null, steps } : null;
}

function codexCommandPreview(command: any): string {
  const text = (Array.isArray(command) ? command.join(' ') : typeof command === 'string' ? command : '').replace(/\s+/g, ' ').trim();
  return text.length > 120 ? text.slice(0, 119).trimEnd() + '…' : text;
}

function codexFileChangeSummary(item: any): string {
  const changes = Array.isArray(item?.changes) ? item.changes : [];
  const paths = changes.map((c: any) => (typeof c?.path === 'string' ? c.path.split('/').filter(Boolean).slice(-2).join('/') : '')).filter(Boolean);
  if (paths.length === 1) return `Edit ${paths[0]}`;
  if (paths.length > 1) return `Edit ${paths.length} files`;
  return 'Edit files';
}

// Normalize a codex app-server item -> {id, name, summary}. The summary mirrors pikiloom's
// vocabulary ("Run shell: <cmd>", "Edit <path>") so the activity projection reads naturally.
function codexToolSummary(item: any): { id: string; name: string; summary: string } | null {
  const id = String(item?.id || '');
  if (!id) return null;
  if (item.type === 'commandExecution') { const c = codexCommandPreview(item.command); return { id, name: 'shell', summary: c ? `Run shell: ${c}` : 'Run shell command' }; }
  if (item.type === 'fileChange' || item.type === 'patch') return { id, name: 'edit', summary: codexFileChangeSummary(item) };
  const tool = typeof item?.tool === 'string' ? item.tool : typeof item?.name === 'string' ? item.name : item?.type;
  return tool ? { id, name: String(tool), summary: String(tool) } : null;
}

// codex `item/tool/requestUserInput` params -> a normalized UniversalInteraction
// (faithful to the legacy codex driver's toAgentInteraction shape).
function codexUserInputToInteraction(params: any, promptId: string): UniversalInteraction | null {
  const raw = Array.isArray(params?.questions) ? params.questions : [];
  const questions = raw.map((q: any) => {
    const opts = Array.isArray(q?.options) ? q.options : [];
    const hasOpts = opts.length > 0;
    return {
      id: String(q?.id || ''),
      header: String(q?.header || '') || 'Question',
      text: String(q?.question || ''),
      type: (hasOpts ? 'select' : 'text') as 'select' | 'text',
      choices: hasOpts ? opts.map((o: any) => ({ label: String(o?.label || ''), description: String(o?.description || ''), value: String(o?.label || '') })) : undefined,
      allowFreeform: !!q?.isOther || !hasOpts,
      allowEmpty: true,
    };
  }).filter((q: any) => q.id && q.text);
  if (!questions.length) return null;
  return { promptId, kind: 'user-input', title: 'User Input Required', hint: 'Use the buttons when available, or reply with text.', questions };
}

export class CodexDriver implements AgentDriver {
  readonly id = 'codex';
  readonly capabilities = { steer: true, interact: false, resume: true, tui: true };

  constructor(private readonly bin: string = 'codex') {}

  async run(input: AgentTurnInput, ctx: DriverContext): Promise<DriverResult> {
    // BYOK provider routing arrives as `-c key=value` overrides; pass them through so the
    // kernel path keeps third-party models (e.g. glm via OpenRouter) instead of falling back
    // to the native account.
    const config: string[] = [...(input.configOverrides || [])];
    const srv = new AppServer(this.bin, config, input.env);
    const state = { text: '', reasoning: '', sessionId: input.sessionId ?? null, input: null as number | null, output: null as number | null, cached: null as number | null, status: null as string | null, error: null as string | null, turnId: null as string | null };
    const phases = new Map<string, string>();
    const toolSummaries = new Map<string, string>();
    let steerRegistered = false;

    const ok = await srv.start();
    if (!ok) return { ok: false, text: '', error: 'failed to start codex app-server', stopReason: 'error' };

    const onAbort = () => srv.kill();
    if (ctx.signal.aborted) onAbort(); else ctx.signal.addEventListener('abort', onAbort, { once: true });

    try {
      const threadParams: any = { cwd: input.workdir, model: input.model || null };
      if (input.systemPrompt) threadParams.developerInstructions = input.systemPrompt;
      if (input.fullAccess) { threadParams.approvalPolicy = 'never'; threadParams.sandbox = 'danger-full-access'; }
      const threadResp = input.sessionId
        ? await srv.call('thread/resume', { threadId: input.sessionId, ...threadParams })
        : await srv.call('thread/start', threadParams);
      if (threadResp.error) return { ok: false, text: '', error: threadResp.error.message || 'thread/start failed', stopReason: 'error' };
      const threadId = threadResp.result?.thread?.id ?? input.sessionId ?? null;
      if (threadId && threadId !== state.sessionId) { state.sessionId = threadId; ctx.emit({ type: 'session', sessionId: threadId }); }

      let settle: () => void = () => {};
      const turnDone = new Promise<void>((res) => { settle = res; });

      srv.onNotification((method, params) => {
        if (params?.threadId && params.threadId !== state.sessionId && method !== 'turn/started') return;
        switch (method) {
          case 'turn/started':
            state.turnId = params?.turn?.id ?? null;
            if (!steerRegistered && state.turnId) {
              steerRegistered = true;
              ctx.registerSteer(async (prompt: string, attachments: string[] = []) => {
                if (!state.sessionId || !state.turnId) return false;
                const r = await srv.call('turn/steer', { threadId: state.sessionId, expectedTurnId: state.turnId, input: buildTurnInput(prompt, attachments) }, 30_000);
                if (r.error) return false;
                state.turnId = r.result?.turnId ?? state.turnId;
                return true;
              });
            }
            break;
          case 'item/started': {
            const item = params?.item || {};
            if (item.type === 'agentMessage' && item.id) phases.set(item.id, item.phase || 'final_answer');
            const t = codexToolSummary(item);
            if (t && !toolSummaries.has(t.id)) { toolSummaries.set(t.id, t.summary); ctx.emit({ type: 'tool', call: { id: t.id, name: t.name, summary: t.summary, status: 'running' } }); }
            break;
          }
          case 'item/agentMessage/delta': {
            const phase = params?.itemId ? (phases.get(params.itemId) || 'final_answer') : 'final_answer';
            if (phase === 'final_answer' && params?.delta) { state.text += params.delta; ctx.emit({ type: 'text', delta: params.delta }); }
            break;
          }
          case 'item/reasoning/textDelta':
          case 'item/reasoning/summaryTextDelta':
            if (params?.delta) { state.reasoning += params.delta; ctx.emit({ type: 'reasoning', delta: params.delta }); }
            break;
          case 'item/completed': {
            const item = params?.item || {};
            const t = codexToolSummary(item);
            if (t && toolSummaries.has(t.id)) ctx.emit({ type: 'tool', call: { id: t.id, name: t.name, summary: toolSummaries.get(t.id) || t.summary, status: item.status === 'failed' ? 'failed' : 'done' } });
            break;
          }
          case 'turn/plan/updated': { const plan = planFromUpdate(params); if (plan) ctx.emit({ type: 'plan', plan }); break; }
          case 'thread/tokenUsage/updated': {
            const u = params?.tokenUsage || params?.usage || {};
            if (u.input_tokens != null || u.inputTokens != null) state.input = u.input_tokens ?? u.inputTokens;
            if (u.output_tokens != null || u.outputTokens != null) state.output = u.output_tokens ?? u.outputTokens;
            if (u.cached_input_tokens != null || u.cachedInputTokens != null) state.cached = u.cached_input_tokens ?? u.cachedInputTokens;
            ctx.emit({ type: 'usage', usage: { inputTokens: state.input, outputTokens: state.output, cachedInputTokens: state.cached, contextPercent: null } });
            break;
          }
          case 'turn/completed': {
            const turn = params?.turn || {};
            state.status = turn.status ?? 'completed';
            if (turn.error) state.error = turn.error.message || turn.error.code || 'turn error';
            settle();
            break;
          }
        }
      });
      // Codex server->client requests: route user-input to the HITL seam (ctx.askUser),
      // accept approvals by default (parity with the legacy codex driver).
      srv.onServerRequest(async (method, params, id) => {
        if (method === 'item/tool/requestUserInput') {
          const interaction = codexUserInputToInteraction(params, `codex-input-${id}`);
          if (!interaction) return { answers: {} };
          const answers = await ctx.askUser(interaction);
          return { answers: Object.fromEntries(Object.entries(answers).map(([qid, vals]) => [qid, { answers: vals }])) };
        }
        if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') return { decision: 'accept' };
        if (method === 'item/permissions/requestApproval') return { permissions: {}, scope: 'turn' };
        return {};
      });

      const turnResp = await srv.call('turn/start', {
        threadId: state.sessionId,
        input: buildTurnInput(input.prompt, input.attachments || []),
        model: input.model || undefined,
        effort: input.effort || undefined,
      });
      if (turnResp.error) return { ok: false, text: state.text, error: turnResp.error.message || 'turn/start failed', stopReason: 'error', sessionId: state.sessionId };

      await turnDone;
      const usage: UniversalUsage = { inputTokens: state.input, outputTokens: state.output, cachedInputTokens: state.cached, contextPercent: null };
      const ok2 = (state.status === 'completed' || state.status == null) && !state.error && !ctx.signal.aborted;
      return {
        ok: ok2,
        text: state.text,
        reasoning: state.reasoning || undefined,
        error: state.error || (ctx.signal.aborted ? 'Interrupted by user.' : null),
        stopReason: ctx.signal.aborted ? 'interrupted' : (state.status || 'end_turn'),
        sessionId: state.sessionId,
        usage,
      };
    } finally {
      srv.kill();
    }
  }

  tui(input: TuiInput): TuiSpec {
    const args: string[] = [];
    if (input.model) args.push('-m', input.model);
    if (input.extraArgs?.length) args.push(...input.extraArgs);
    return { command: this.bin, args, cwd: input.workdir, env: input.env };
  }
}

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
function buildTurnInput(prompt: string, attachments: string[]): any[] {
  const input: any[] = [];
  for (const f of attachments) {
    const ext = f.slice(f.lastIndexOf('.')).toLowerCase();
    input.push(IMAGE_EXTS.has(ext) ? { type: 'localImage', path: f } : { type: 'text', text: `[Attached file: ${f}]` });
  }
  input.push({ type: 'text', text: prompt });
  return input;
}
