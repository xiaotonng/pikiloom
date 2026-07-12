import type {
  AgentDriver, AgentTurnInput, DriverContext, DriverEvent, DriverResult, TuiInput, TuiSpec, NativeSessionInfo,
} from '../contracts/driver.js';
import type { UniversalPlan, UniversalUsage, UniversalInteraction, UniversalToolCall } from '../protocol/index.js';
import { discoverCodexNativeSessions } from './native.js';
import { StdioRpcClient } from './rpc.js';
import { attachedFileNote, contextPercent, imageMimeForFile, wireAbort } from './shared.js';

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
// Field-less placeholder summaries — a completed item with only one of these never overrides
// a more specific summary cached at item/started.
const CODEX_GENERIC_TOOL_SUMMARIES = new Set(['Search web', 'Run shell command', 'Edit files', 'Use tool']);
const CODEX_TOOL_INPUT_MAX = 4 * 1024;
const CODEX_TOOL_RESULT_MAX = 12 * 1024;

function codexToolText(value: unknown, max: number): string | null {
  if (value == null) return null;
  let text: string;
  if (typeof value === 'string') text = value;
  else {
    try { text = JSON.stringify(value, null, 2); }
    catch { text = String(value); }
  }
  text = text.replace(/\r\n/g, '\n').trim();
  if (!text) return null;
  return text.length <= max ? text : `${text.slice(0, max).trimEnd()}\n… (truncated)`;
}

function codexToolInput(item: any): string | null {
  switch (item?.type) {
    case 'commandExecution': {
      const command = Array.isArray(item.command) ? item.command.join(' ') : item.command;
      if (!command) return null;
      const detail: Record<string, unknown> = { command };
      if (typeof item.cwd === 'string' && item.cwd.trim()) detail.cwd = item.cwd;
      return codexToolText(detail, CODEX_TOOL_INPUT_MAX);
    }
    case 'fileChange':
    case 'patch':
      return codexToolText(item.changes ?? item.patch ?? item.diff, CODEX_TOOL_INPUT_MAX);
    case 'mcpToolCall':
    case 'dynamicToolCall':
      return codexToolText(item.arguments ?? item.input, CODEX_TOOL_INPUT_MAX);
    case 'collabAgentToolCall':
      return codexToolText({
        prompt: item.prompt ?? undefined,
        model: item.model ?? undefined,
        reasoningEffort: item.reasoningEffort ?? item.reasoning_effort ?? undefined,
        receiverThreadIds: item.receiverThreadIds ?? item.receiver_thread_ids ?? undefined,
      }, CODEX_TOOL_INPUT_MAX);
    case 'webSearch':
      return codexToolText(item.action ?? item.query, CODEX_TOOL_INPUT_MAX);
    default:
      return null;
  }
}

function codexToolResult(item: any): string | null {
  if (item?.type === 'commandExecution') {
    const output = codexToolText(item.aggregatedOutput ?? item.aggregated_output, CODEX_TOOL_RESULT_MAX);
    const exitCode = item.exitCode ?? item.exit_code;
    if (output && typeof exitCode === 'number' && exitCode !== 0) return `${output}\n\n(exit code ${exitCode})`;
    if (output) return output;
    return typeof exitCode === 'number' && exitCode !== 0 ? `exit code ${exitCode}` : null;
  }
  if (item?.type === 'mcpToolCall') {
    const error = item.error?.message ?? item.error;
    if (error) return codexToolText(error, CODEX_TOOL_RESULT_MAX);
    return codexToolText(item.result, CODEX_TOOL_RESULT_MAX);
  }
  if (item?.type === 'dynamicToolCall') {
    return codexToolText(item.contentItems ?? item.content_items, CODEX_TOOL_RESULT_MAX);
  }
  if (item?.type === 'collabAgentToolCall') {
    return codexToolText(item.agentsStates ?? item.agents_states, CODEX_TOOL_RESULT_MAX);
  }
  return null;
}

function codexToolStatus(item: any, fallback: UniversalToolCall['status']): UniversalToolCall['status'] {
  const raw = String(item?.status || '').toLowerCase();
  if (raw === 'failed' || raw === 'declined' || item?.success === false || item?.error) return 'failed';
  if (raw === 'completed' || raw === 'done' || item?.success === true) return 'done';
  return fallback;
}

export function codexToolSummary(item: any): { id: string; name: string; summary: string } | null {
  const id = String(item?.id || '');
  if (!id) return null;
  if (item.type === 'commandExecution') { const c = codexCommandPreview(item.command); return { id, name: 'shell', summary: c ? `Run shell: ${c}` : 'Run shell command' }; }
  if (item.type === 'fileChange' || item.type === 'patch') return { id, name: 'edit', summary: codexFileChangeSummary(item) };
  if (item.type === 'webSearch') {
    // v2 webSearch items carry the query at top level and (on newer servers) an action
    // (search / openPage / findInPage, snake_case on older ones). The query is often only
    // known at item/completed — item/started may arrive query-less.
    const action = item.action || {};
    const kind = String(action.type || '');
    const url = codexCommandPreview(action.url);
    if ((kind === 'openPage' || kind === 'open_page') && url) return { id, name: 'web_search', summary: `Open ${url}` };
    if ((kind === 'findInPage' || kind === 'find_in_page') && url) return { id, name: 'web_search', summary: `Find in ${url}` };
    const query = codexCommandPreview(typeof item.query === 'string' && item.query.trim() ? item.query : action.query);
    return { id, name: 'web_search', summary: query ? `Search web: ${query}` : 'Search web' };
  }
  if (CODEX_TOOL_CALL_TYPES.has(item.type)) {
    const raw = typeof item.tool === 'string' && item.tool.trim() ? item.tool.trim()
      : typeof item.name === 'string' && item.name.trim() ? item.name.trim() : '';
    const name = raw ? (raw.split('.').pop() || raw) : 'tool';
    return { id, name, summary: raw ? `Use ${name}` : 'Use tool' };
  }
  return null;
}

/** Project one app-server item into the kernel's rich, expandable tool-call shape. */
export function codexToolCall(item: any, fallbackStatus: UniversalToolCall['status']): UniversalToolCall | null {
  const base = codexToolSummary(item);
  if (!base) return null;
  return {
    ...base,
    input: codexToolInput(item),
    result: codexToolResult(item),
    status: codexToolStatus(item, fallbackStatus),
  };
}

function appendCodexToolOutput(previous: string | null | undefined, delta: unknown): string | null {
  if (typeof delta !== 'string' || !delta) return previous ?? null;
  const next = `${previous ?? ''}${delta}`.replace(/\r\n/g, '\n');
  if (next.length <= CODEX_TOOL_RESULT_MAX) return next;
  const marker = '… (earlier output truncated)\n';
  return marker + next.slice(-(CODEX_TOOL_RESULT_MAX - marker.length));
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

// A completed agentMessage (commentary preamble OR final_answer) that did NOT stream deltas:
// append + emit it live. deltaItems holds the ids already streamed, so a completed item echoing
// a streamed one is not double-counted (matches the legacy driver's deltaSeenForItem guard).
// Both phases are surfaced — codex's commentary preambles are part of the visible "中间过程".
export function captureCodexAgentMessage(
  item: any, s: CodexContentState, deltaItems: Set<string>, phases: Map<string, string>,
  emit: (e: DriverEvent) => void,
): void {
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
    // Do NOT force model_reasoning_summary — codex reasoning summaries stay OFF by default
    // (respecting ~/.codex/config.toml, which is the original behavior). A caller that wants
    // thinking can pass `model_reasoning_summary=...` via configOverrides; we never inject it.
    const overrides = [...(input.configOverrides || [])];
    if (!overrides.some(c => /^features\.goals\s*=/.test(c))) overrides.push('features.goals=true');
    const args = ['app-server'];
    for (const c of overrides) args.push('-c', c);
    const srv = new StdioRpcClient({ command: this.bin, args, env: input.env, label: 'codex app-server' });
    const state = { text: '', reasoning: '', streamedReasoning: false, msgs: [] as string[], thinkParts: [] as string[], sessionId: input.sessionId ?? null, input: null as number | null, output: null as number | null, cached: null as number | null, contextUsed: null as number | null, contextWindow: null as number | null, status: null as string | null, error: null as string | null, turnId: null as string | null };
    const phases = new Map<string, string>();
    const toolCalls = new Map<string, UniversalToolCall>();
    const deltaItems = new Set<string>();
    let lastTextItemId: string | null = null;
    let steerRegistered = false;

    if (!srv.start()) return { ok: false, text: '', error: 'failed to start codex app-server', stopReason: 'error' };

    let settled = false;
    let resolveTurn: () => void = () => {};
    const turnDone = new Promise<void>((res) => { resolveTurn = res; });
    // Idempotent: turnDone can be settled from three racing sources (turn/completed, abort,
    // process death); the first wins and the rest are no-ops.
    const settle = () => { if (settled) return; settled = true; resolveTurn(); };

    // If the app-server process dies WITHOUT a turn/completed (crash, kill, disconnect), the
    // `await turnDone` below would otherwise hang forever — run() never resolves, recordResult
    // never fires, and the session is stranded runState:"running" in the orchestrator even though
    // the codex process is already dead. Settle it as a failed turn so the orchestrator can
    // finalize it (mirrors the claude driver's child.on('close') settle).
    srv.onClose(() => {
      if (settled) return;
      state.error = state.error || srv.stderrText().trim().split('\n').pop() || 'codex app-server exited before the turn completed';
      state.status = 'error';
      settle();
    });

    // On abort: gracefully interrupt the running turn, then settle turnDone OURSELVES. A bare
    // srv.kill() (SIGTERM) never produces a turn/completed notification, so without this explicit
    // settle() the `await turnDone` below hangs forever — run() never resolves and the task stays
    // "running" in the orchestrator even though the codex process is already dead ("停止不掉，但实际上已经停了").
    wireAbort(ctx.signal, () => {
      if (state.sessionId && state.turnId) {
        srv.request('turn/interrupt', { threadId: state.sessionId, turnId: state.turnId }, 5_000).finally(() => settle());
      } else {
        srv.kill();
        settle();
      }
    });

    try {
      const init = await srv.request('initialize', { clientInfo: { name: '@pikiloom/kernel', version: '0.1.0' }, capabilities: { experimentalApi: true } }, 15_000);
      if (init.error) return { ok: false, text: '', error: 'failed to start codex app-server', stopReason: 'error' };
      const threadParams: any = { cwd: input.workdir, model: input.model || null };
      if (input.systemPrompt) threadParams.developerInstructions = input.systemPrompt;
      if (input.fullAccess) { threadParams.approvalPolicy = 'never'; threadParams.sandbox = 'danger-full-access'; }
      const threadResp = input.sessionId
        ? await srv.request('thread/resume', { threadId: input.sessionId, ...threadParams })
        : await srv.request('thread/start', threadParams);
      if (threadResp.error) return { ok: false, text: '', error: threadResp.error.message || 'thread/start failed', stopReason: 'error' };
      const threadId = threadResp.result?.thread?.id ?? input.sessionId ?? null;
      if (threadId && threadId !== state.sessionId) { state.sessionId = threadId; ctx.emit({ type: 'session', sessionId: threadId }); }

      srv.onNotification((method, params) => {
        if (params?.threadId && params.threadId !== state.sessionId && method !== 'turn/started') return;
        switch (method) {
          case 'turn/started':
            state.turnId = params?.turn?.id ?? null;
            if (!steerRegistered && state.turnId) {
              steerRegistered = true;
              ctx.registerSteer(async (prompt: string, attachments: string[] = []) => {
                if (!state.sessionId || !state.turnId) return false;
                const r = await srv.request('turn/steer', { threadId: state.sessionId, expectedTurnId: state.turnId, input: buildTurnInput(prompt, attachments) }, 30_000);
                if (r.error) return false;
                state.turnId = r.result?.turnId ?? state.turnId;
                return true;
              });
            }
            break;
          case 'item/started': {
            const item = params?.item || {};
            if (item.type === 'agentMessage' && item.id) phases.set(item.id, item.phase || 'final_answer');
            const call = codexToolCall(item, 'running');
            if (call && !toolCalls.has(call.id)) {
              toolCalls.set(call.id, call);
              ctx.emit({ type: 'tool', call });
            }
            break;
          }
          case 'item/commandExecution/outputDelta':
          case 'item/fileChange/outputDelta': {
            const id = String(params?.itemId || '');
            const previous = toolCalls.get(id);
            if (!previous) break;
            const call = { ...previous, result: appendCodexToolOutput(previous.result, params?.delta) };
            toolCalls.set(id, call);
            ctx.emit({ type: 'tool', call });
            break;
          }
          case 'item/fileChange/patchUpdated': {
            const id = String(params?.itemId || '');
            const projected = codexToolCall({ type: 'fileChange', id, changes: params?.changes }, 'running');
            if (!projected) break;
            const previous = toolCalls.get(id);
            const call = previous ? { ...previous, ...projected, result: projected.result ?? previous.result } : projected;
            toolCalls.set(id, call);
            ctx.emit({ type: 'tool', call });
            break;
          }
          case 'item/agentMessage/delta': {
            if (!params?.delta) break;
            // Surface BOTH commentary (preamble) and final_answer messages live. Codex narrates
            // what it is about to do via phase=commentary agentMessages before tool calls;
            // gating on final_answer dropped them, leaving the "中间过程" invisible. Separate
            // distinct message items with a blank line so preamble and answer don't run together.
            if (params.itemId && params.itemId !== lastTextItemId && state.text) {
              state.text += '\n\n';
              ctx.emit({ type: 'text', delta: '\n\n' });
            }
            if (params.itemId) { lastTextItemId = params.itemId; deltaItems.add(params.itemId); }
            state.text += params.delta;
            ctx.emit({ type: 'text', delta: params.delta });
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
            const projected = codexToolCall(item, 'done');
            if (projected) {
              // Prefer the completed item's summary when it is specific — webSearch carries its
              // query only at completion (item/started may be query-less or absent entirely,
              // so a completed-only tool still gets its row).
              const previous = toolCalls.get(projected.id);
              const summary = !CODEX_GENERIC_TOOL_SUMMARIES.has(projected.summary)
                ? projected.summary
                : (previous?.summary || projected.summary);
              const call: UniversalToolCall = {
                ...previous,
                ...projected,
                summary,
                input: projected.input ?? previous?.input ?? null,
                // Some app-server versions stream output deltas but omit aggregatedOutput on the
                // terminal item. Preserve the accumulated live result in that case.
                result: projected.result ?? previous?.result ?? null,
              };
              toolCalls.set(call.id, call);
              ctx.emit({ type: 'tool', call });
            }
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
      // accept approvals by default (parity with the legacy codex driver). Never throw —
      // an unanswerable request degrades to an empty response, not a JSON-RPC error.
      srv.onRequest(async (method, params, id) => {
        try {
          if (method === 'item/tool/requestUserInput') {
            const interaction = codexUserInputToInteraction(params, `codex-input-${id}`);
            if (!interaction) return { answers: {} };
            const answers = await ctx.askUser(interaction);
            return { answers: Object.fromEntries(Object.entries(answers).map(([qid, vals]) => [qid, { answers: vals }])) };
          }
          if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') return { decision: 'accept' };
          if (method === 'item/permissions/requestApproval') return { permissions: {}, scope: 'turn' };
          return {};
        } catch { return {}; }
      });

      const turnResp = await srv.request('turn/start', {
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

  listNativeSessions(opts: { workdir: string; limit?: number }): NativeSessionInfo[] {
    return discoverCodexNativeSessions(opts.workdir, { limit: opts.limit });
  }
}

function buildTurnInput(prompt: string, attachments: string[]): any[] {
  const input: any[] = [];
  for (const f of attachments) {
    input.push(imageMimeForFile(f) ? { type: 'localImage', path: f } : { type: 'text', text: attachedFileNote(f) });
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

interface CodexUsageState {
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
function applyCodexTokenUsage(s: CodexUsageState, rawUsage: any): void {
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

function codexUsageOf(s: CodexUsageState): UniversalUsage {
  const fallback = (s.input ?? 0) + (s.cached ?? 0);
  const used = s.contextUsed ?? (fallback > 0 ? fallback : null);
  const window = s.contextWindow ?? null;
  const turnOutput = s.output ?? 0;
  return {
    inputTokens: s.input,
    outputTokens: s.output,
    cachedInputTokens: s.cached,
    contextUsedTokens: used,
    contextPercent: contextPercent(used, window),
    turnOutputTokens: turnOutput > 0 ? turnOutput : null,
  };
}
