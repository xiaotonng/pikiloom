import { spawn, type ChildProcess } from 'node:child_process';
import type {
  AgentDriver, AgentTurnInput, DriverContext, DriverEvent, DriverResult, TuiInput, TuiSpec,
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
    // Do NOT force model_reasoning_summary — codex reasoning summaries stay OFF by default
    // (respecting ~/.codex/config.toml, which is the original behavior). A caller that wants
    // thinking can pass `model_reasoning_summary=...` via configOverrides; we never inject it.
    const overrides = [...this.configOverrides];
    if (!overrides.some(c => /^features\.goals\s*=/.test(c))) overrides.push('features.goals=true');
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
// Only ACTUAL tool calls become Activity rows. agentMessage (the answer text) and reasoning
// (thinking) are CONTENT — they render below as message text / thinking, never as tools. The old
// fallback to `item.type` wrongly turned every item (incl. agentMessage/reasoning) into a bogus
// "tool" in the Activity card. Mirrors the legacy driver's isCodexToolCallItem whitelist.
const CODEX_TOOL_CALL_TYPES = new Set(['dynamicToolCall', 'mcpToolCall', 'collabAgentToolCall']);
export function codexToolSummary(item: any): { id: string; name: string; summary: string } | null {
  const id = String(item?.id || '');
  if (!id) return null;
  if (item.type === 'commandExecution') { const c = codexCommandPreview(item.command); return { id, name: 'shell', summary: c ? `Run shell: ${c}` : 'Run shell command' }; }
  if (item.type === 'fileChange' || item.type === 'patch') return { id, name: 'edit', summary: codexFileChangeSummary(item) };
  if (CODEX_TOOL_CALL_TYPES.has(item.type)) {
    const raw = typeof item.tool === 'string' && item.tool.trim() ? item.tool.trim()
      : typeof item.name === 'string' && item.name.trim() ? item.name.trim() : '';
    const name = raw ? (raw.split('.').pop() || raw) : 'tool';
    return { id, name, summary: raw ? `Use ${name}` : 'Use tool' };
  }
  return null;
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

// ── Completed-item fallback (parity with the legacy codex driver) ───────────────
// Codex streams the final answer and reasoning as deltas (item/agentMessage/delta,
// item/reasoning/*Delta) on the native path — but delivers them as *completed items*
// (item/completed, rawResponseItem/completed) when deltas are absent, which is common for
// Chat→Responses bridged third-party models (glm / deepseek / 豆包). The kernel previously
// only read the delta path, so those turns surfaced empty text/thinking. These helpers
// capture the completed-item form and stream it live, mirroring the legacy driver's
// s.msgs / s.thinkParts accumulators + end-of-turn fallback, and the claude driver's
// !streamedText / !streamedReasoning fallbacks.

export interface CodexContentState {
  text: string; reasoning: string; streamedReasoning: boolean;
  msgs: string[]; thinkParts: string[];
}

// Reasoning text from a completed `reasoning` item (item/completed or rawResponseItem/completed):
// summary/content arrays of plain strings or {text} objects.
export function codexReasoningItemText(item: any): string {
  const parts = [
    ...(Array.isArray(item?.summary) ? item.summary : []),
    ...(Array.isArray(item?.content) ? item.content : []),
  ];
  return parts.map((p: any) => (typeof p === 'string' ? p : p?.text || '')).filter(Boolean).join('\n').trim();
}

// A completed final_answer agentMessage that did NOT stream deltas: append + emit it live.
// deltaItems holds the ids already streamed, so a completed item echoing a streamed one is
// not double-counted (matches the legacy driver's deltaSeenForItem guard).
export function captureCodexAgentMessage(
  item: any, s: CodexContentState, deltaItems: Set<string>, phases: Map<string, string>,
  emit: (e: DriverEvent) => void,
): void {
  const phase = item?.phase || (item?.id ? phases.get(item.id) : null) || 'final_answer';
  if (phase !== 'final_answer') return;
  const text = typeof item?.text === 'string' ? item.text.trim() : '';
  if (!text) return;
  s.msgs.push(text);
  if (item.id && deltaItems.has(item.id)) return;
  const delta = s.text.trim() ? `\n\n${text}` : text;
  s.text += delta;
  emit({ type: 'text', delta });
}

// A completed reasoning item: keep it for the end-of-turn fallback, and stream it live only
// when nothing arrived as reasoning deltas (so the streamed path is never double-emitted).
export function captureCodexReasoning(text: string, s: CodexContentState, emit: (e: DriverEvent) => void): void {
  if (!text) return;
  s.thinkParts.push(text);
  if (s.streamedReasoning) return;
  const delta = s.reasoning.trim() ? `\n\n${text}` : text;
  s.reasoning += delta;
  emit({ type: 'reasoning', delta });
}

// End-of-turn finalizers: prefer streamed text/reasoning, fall back to completed-item parts.
export function codexFinalText(s: CodexContentState): string {
  return s.text.trim() ? s.text : s.msgs.join('\n\n');
}
export function codexFinalReasoning(s: CodexContentState): string {
  return s.reasoning.trim() ? s.reasoning : s.thinkParts.join('\n\n');
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
    const state = { text: '', reasoning: '', streamedReasoning: false, msgs: [] as string[], thinkParts: [] as string[], sessionId: input.sessionId ?? null, input: null as number | null, output: null as number | null, cached: null as number | null, contextUsed: null as number | null, contextWindow: null as number | null, status: null as string | null, error: null as string | null, turnId: null as string | null };
    const phases = new Map<string, string>();
    const toolSummaries = new Map<string, string>();
    const deltaItems = new Set<string>();
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
            if (phase === 'final_answer' && params?.delta) {
              state.text += params.delta;
              if (params.itemId) deltaItems.add(params.itemId);
              ctx.emit({ type: 'text', delta: params.delta });
            }
            break;
          }
          case 'item/reasoning/textDelta':
          case 'item/reasoning/summaryTextDelta':
            if (params?.delta) { state.reasoning += params.delta; state.streamedReasoning = true; ctx.emit({ type: 'reasoning', delta: params.delta }); }
            break;
          case 'item/completed': {
            const item = params?.item || {};
            // Final answer / reasoning delivered as a completed item (no preceding deltas).
            if (item.type === 'agentMessage') captureCodexAgentMessage(item, state, deltaItems, phases, ctx.emit);
            else if (item.type === 'reasoning') captureCodexReasoning(codexReasoningItemText(item), state, ctx.emit);
            const t = codexToolSummary(item);
            if (t && toolSummaries.has(t.id)) ctx.emit({ type: 'tool', call: { id: t.id, name: t.name, summary: toolSummaries.get(t.id) || t.summary, status: item.status === 'failed' ? 'failed' : 'done' } });
            break;
          }
          case 'rawResponseItem/completed': {
            const item = params?.item || {};
            if (item?.type === 'reasoning') captureCodexReasoning(codexReasoningItemText(item), state, ctx.emit);
            break;
          }
          case 'turn/plan/updated': { const plan = planFromUpdate(params); if (plan) ctx.emit({ type: 'plan', plan }); break; }
          case 'thread/tokenUsage/updated': {
            applyCodexTokenUsage(state, params?.tokenUsage || params?.usage);
            ctx.emit({ type: 'usage', usage: codexUsageOf(state) });
            break;
          }
          case 'turn/completed': {
            const turn = params?.turn || {};
            state.status = turn.status ?? 'completed';
            if (turn.error) state.error = turn.error.message || turn.error.code || 'turn error';
            applyCodexTokenUsage(state, params?.tokenUsage || turn.tokenUsage || turn.usage);
            ctx.emit({ type: 'usage', usage: codexUsageOf(state) });
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
      const usage: UniversalUsage = codexUsageOf(state);
      const ok2 = (state.status === 'completed' || state.status == null) && !state.error && !ctx.signal.aborted;
      const finalReasoning = codexFinalReasoning(state);
      return {
        ok: ok2,
        text: codexFinalText(state),
        reasoning: finalReasoning || undefined,
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

// ── Token usage / context projection (ported from pikiloom's codex driver) ──────
// Codex reports usage as a nested {info:{last, total, model_context_window}} (and
// sometimes a flat shape). The live UI wants contextUsedTokens / context% / this-turn
// output — none of which the raw input/output counts carry. This is the codex-side
// analog of the claude driver's claudeUsageOf; without it the kernel path shows no
// live token row for codex sessions.

export interface CodexUsageState {
  input: number | null; output: number | null; cached: number | null;
  contextUsed?: number | null; contextWindow?: number | null;
}

function codexNum(...vals: any[]): number | null {
  for (const v of vals) { const n = typeof v === 'number' ? v : Number(v); if (Number.isFinite(n)) return n; }
  return null;
}

// Context occupancy from one usage record: prefer total_tokens, else input(+output).
function codexContextUsed(raw: any): number | null {
  if (!raw || typeof raw !== 'object') return null;
  const total = codexNum(raw.total_tokens, raw.totalTokens);
  if (total != null && total >= 0) return total;
  const i = codexNum(raw.input_tokens, raw.inputTokens);
  const o = codexNum(raw.output_tokens, raw.outputTokens);
  if (i != null && o != null) return i + o;
  return i;
}

// Fold a codex tokenUsage payload into driver state: last-turn counts, context
// occupancy, and the model window. Tolerant of nested {info:{…}} and flat shapes.
export function applyCodexTokenUsage(s: CodexUsageState, rawUsage: any): void {
  if (!rawUsage || typeof rawUsage !== 'object') return;
  const info = rawUsage.info && typeof rawUsage.info === 'object' ? rawUsage.info : rawUsage;
  const last = info.last ?? info.lastTokenUsage ?? info.last_token_usage ?? rawUsage.last;
  const li = codexNum(last?.input_tokens, last?.inputTokens);
  const lo = codexNum(last?.output_tokens, last?.outputTokens);
  const lc = codexNum(last?.cached_input_tokens, last?.cachedInputTokens);
  if (li != null) s.input = li;
  if (lo != null) s.output = lo;
  if (lc != null) s.cached = lc;
  const used = codexContextUsed(last);
  if (used != null) s.contextUsed = used;
  // Cumulative total as fallback for the per-turn counts (the trailing `?? rawUsage`
  // also catches the flat shape, where there is no nested `last`).
  const total = info.total ?? info.totalTokenUsage ?? info.total_token_usage ?? rawUsage.total ?? rawUsage;
  if (total && typeof total === 'object') {
    const ti = codexNum(total.input_tokens, total.inputTokens);
    const to = codexNum(total.output_tokens, total.outputTokens);
    const tc = codexNum(total.cached_input_tokens, total.cachedInputTokens);
    if (li == null && ti != null) s.input = ti;
    if (lo == null && to != null) s.output = to;
    if (lc == null && tc != null) s.cached = tc;
  }
  const cw = codexNum(info.modelContextWindow, info.model_context_window, rawUsage.modelContextWindow, rawUsage.model_context_window);
  if (cw != null && cw > 0) s.contextWindow = cw;
}

export function codexUsageOf(s: CodexUsageState): UniversalUsage {
  const fallback = (s.input ?? 0) + (s.cached ?? 0);
  const used = s.contextUsed ?? (fallback > 0 ? fallback : null);
  const window = s.contextWindow ?? null;
  const contextPercent = used != null && window ? Math.min(99.9, Math.round((used / window) * 1000) / 10) : null;
  const turnOutput = s.output ?? 0;
  return {
    inputTokens: s.input,
    outputTokens: s.output,
    cachedInputTokens: s.cached,
    contextUsedTokens: used,
    contextPercent,
    turnOutputTokens: turnOutput > 0 ? turnOutput : null,
  };
}
