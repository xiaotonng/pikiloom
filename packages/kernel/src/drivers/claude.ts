import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import type { AgentDriver, AgentTurnInput, DriverContext, DriverResult, DriverEvent, TuiInput, TuiSpec, NativeSessionInfo } from '../contracts/driver.js';
import type { UniversalUsage, UniversalPlan, UniversalSubAgent } from '../protocol/index.js';
import { discoverClaudeNativeSessions } from '../workspace/native.js';

// Real driver: shells the local `claude` CLI in stream-json mode and normalizes its
// events into kernel DriverEvents. Faithful to pikiloom's claude.ts event shapes
// (system / stream_event{message_start,content_block_delta,message_delta} / assistant / result),
// but fully self-contained. Proves "下层 Claude 不变".
export class ClaudeDriver implements AgentDriver {
  readonly id = 'claude';
  readonly capabilities = { steer: true, interact: false, resume: true, tui: true };

  constructor(private readonly bin: string = 'claude') {}

  // Interactive Claude Code TUI (no -p): the kernel spawns this in a PTY and passes
  // the terminal through. Model/resume/BYOK-env come from the kernel's resolution.
  tui(input: TuiInput): TuiSpec {
    const args: string[] = [];
    if (input.model) args.push('--model', input.model);
    if (input.sessionId) args.push('--resume', input.sessionId);
    if (input.extraArgs?.length) args.push(...input.extraArgs);
    return { command: this.bin, args, cwd: input.workdir, env: input.env };
  }

  listNativeSessions(opts: { workdir: string; limit?: number }): NativeSessionInfo[] {
    return discoverClaudeNativeSessions(opts.workdir, { limit: opts.limit });
  }

  run(input: AgentTurnInput, ctx: DriverContext): Promise<DriverResult> {
    const steerable = !!input.steerable;
    // Always drive Claude over a stream-json stdin and keep that stdin OPEN for the whole turn.
    // That open stdin is what lets Claude's native "launch detached background work → end the
    // turn → wake itself up and report when the work finishes" flow play out: it only happens
    // while stdin stays open (with it closed, Claude exits at the first `result` and the wake-up
    // — and any in-process background agent/workflow — is lost). Image attachments also need the
    // stream-json user message (a plain text stdin can't carry images). `--replay-user-messages`
    // + registerSteer remain the only mid-turn-steer-specific bits.
    const args = ['-p', '--verbose', '--output-format', 'stream-json', '--include-partial-messages', '--input-format', 'stream-json'];
    if (input.model) args.push('--model', input.model);
    if (input.effort) args.push('--effort', input.effort === 'ultra' ? 'max' : input.effort); // request extended thinking (ultra is a display-only alias for max)
    if (input.sessionId) args.push('--resume', input.sessionId);
    if (input.systemPrompt) args.push('--append-system-prompt', input.systemPrompt);
    if (input.mcpConfigPath) args.push('--mcp-config', input.mcpConfigPath);
    if (input.permissionMode) args.push('--permission-mode', input.permissionMode); // parity: keep bypass/accept-edits on the kernel path
    if (steerable) args.push('--replay-user-messages'); // parity: mid-turn steer
    if (input.extraArgs?.length) args.push(...input.extraArgs);

    const state = {
      text: '', reasoning: '', streamedText: false, streamedReasoning: false,
      sessionId: null as string | null, model: null as string | null,
      stopReason: null as string | null, error: null as string | null,
      input: null as number | null, output: null as number | null, cached: null as number | null,
      cacheCreation: null as number | null,
      contextWindow: null as number | null, turnOutputTokensBase: 0,
      subAgents: new Map<string, any>(),
      tools: new Map<string, { name: string; summary: string }>(),
      taskList: new Map<string, { subject: string; status: string }>(),
      taskOrder: [] as string[],
      pendingTaskCreates: new Map<string, { subject: string }>(),
      // run_in_background lifecycle: task ids seen as started vs. reached a terminal status.
      bgStarted: new Set<string>(), bgTerminal: new Set<string>(),
    };

    return new Promise<DriverResult>((resolve) => {
      let child: ChildProcess;
      let settled = false;
      let holdCapTimer: ReturnType<typeof setTimeout> | null = null;
      const usageOf = () => this.usage(state);
      const clearHoldCap = () => { if (holdCapTimer) { clearTimeout(holdCapTimer); holdCapTimer = null; } };
      // kill=true SIGTERMs immediately — fast exit, used once nothing is left running in the
      // background (a normal turn, or a wake-up turn after every background task finished).
      // kill=false only ends stdin and lets Claude shut down on its own, so any still-running
      // detached background work survives a clean exit (a hard kill mid-flight is exactly what
      // tore the background — and the wake-up — down before). A leak-guard SIGTERM is the backstop.
      const finish = (r: DriverResult, kill = true) => {
        if (settled) return; settled = true;
        clearHoldCap();
        try { child?.stdin?.end(); } catch { /* ignore */ }
        if (!child.killed && child.exitCode == null) {
          if (kill) { try { child.kill('SIGTERM'); } catch { /* ignore */ } }
          else {
            const guard = setTimeout(() => { try { child?.kill('SIGTERM'); } catch { /* ignore */ } }, CLAUDE_EXIT_LEAK_GUARD_MS);
            if (typeof (guard as any).unref === 'function') (guard as any).unref();
          }
        }
        resolve(r);
      };
      const settleResult = (opts: { stopReason?: string | null; kill?: boolean } = {}) => finish({
        ok: !state.error, text: state.text, reasoning: state.reasoning || undefined,
        error: state.error, stopReason: opts.stopReason ?? state.stopReason, sessionId: state.sessionId, usage: usageOf(),
      }, opts.kill ?? true);

      try {
        child = spawn(this.bin, args, { cwd: input.workdir, env: { ...process.env, ...(input.env || {}) }, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (err: any) {
        finish({ ok: false, text: '', error: `spawn failed: ${err?.message || err}`, stopReason: 'error' });
        return;
      }

      const onAbort = () => { try { child.kill('SIGTERM'); } catch { /* ignore */ } };
      if (ctx.signal.aborted) onAbort();
      else ctx.signal.addEventListener('abort', onAbort, { once: true });

      if (steerable) {
        ctx.registerSteer(async (prompt: string, attachments?: string[]) => {
          try { child.stdin!.write(claudeUserMessage(prompt, attachments) + '\n'); return true; } catch { return false; }
        });
      }

      let buf = '';
      let stderr = '';
      child.stdout!.on('data', (chunk: Buffer) => {
        if (settled) return; // ignore the process's post-settle shutdown chatter
        buf += chunk.toString('utf8');
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          if (settled) return;
          const trimmed = line.trim();
          if (!trimmed) continue;
          let ev: any;
          try { ev = JSON.parse(trimmed); } catch { continue; }
          handleClaudeEvent(ev, state, ctx.emit);
          if (ev.type !== 'result') continue;
          const hasError = !!ev.is_error || (Array.isArray(ev.errors) && ev.errors.length > 0) || !!state.error;
          const pending = pendingClaudeBackgroundTasks(state);
          if (decideClaudeResultSettle({ hasError, pendingBackground: pending }) === 'hold') {
            // Background work is still running: do NOT end the turn here. Keep stdin open so Claude
            // wakes itself up and streams a follow-up turn reporting the finished work — we settle
            // on THAT result (pending back to 0). A cap bounds the wait so a never-completing daemon
            // (e.g. a dev server) eventually settles (graceful, no kill) instead of holding forever.
            if (!holdCapTimer) {
              holdCapTimer = setTimeout(() => { if (!settled) settleResult({ stopReason: 'background', kill: false }); }, claudeBgHoldCapMs());
              if (typeof (holdCapTimer as any).unref === 'function') (holdCapTimer as any).unref();
            }
            continue;
          }
          settleResult();
        }
      });
      child.stderr!.on('data', (c: Buffer) => { stderr += c.toString('utf8'); });
      child.on('error', (err) => finish({ ok: false, text: state.text, error: `claude spawn error: ${err.message}`, stopReason: 'error' }));
      child.on('close', (code) => {
        if (settled) return;
        if (ctx.signal.aborted) { finish({ ok: false, text: state.text, reasoning: state.reasoning, error: 'Interrupted by user.', stopReason: 'interrupted', sessionId: state.sessionId, usage: usageOf() }, false); return; }
        const ok = !state.error && code === 0;
        finish({ ok, text: state.text, reasoning: state.reasoning || undefined, error: state.error || (ok ? null : `claude exited ${code}${stderr ? `: ${stderr.slice(0, 300)}` : ''}`), stopReason: state.stopReason, sessionId: state.sessionId, usage: usageOf() }, false);
      });

      try {
        // Send the prompt as a stream-json user message and keep stdin OPEN (do not end it here):
        // closing it makes Claude exit at the first `result`, before any background task finishes.
        child.stdin!.write(claudeUserMessage(input.prompt, input.attachments) + '\n');
      } catch { /* ignore */ }
    });
  }

  private usage(s: ClaudeUsageState): UniversalUsage {
    return claudeUsageOf(s);
  }

}

// ── Token usage / context projection (ported from pikiloom's claude driver) ──────
// Claude reports per-message usage; the live UI wants three derived signals the raw
// counts don't carry: context-window %, cumulative context tokens, and this turn's
// output. Computing them here (not just inputTokens/outputTokens) is what restores the
// live "xx.x% · NNk · ↑NN" row the kernel path previously dropped.

export interface ClaudeUsageState {
  input: number | null; output: number | null; cached: number | null;
  cacheCreation?: number | null; contextWindow?: number | null; turnOutputTokensBase?: number | null;
}

export function claudeUsageOf(s: ClaudeUsageState): UniversalUsage {
  const used = (s.input ?? 0) + (s.cached ?? 0) + (s.cacheCreation ?? 0) + (s.output ?? 0);
  const window = s.contextWindow ?? null;
  const contextPercent = window && used > 0 ? Math.min(99.9, Math.round((used / window) * 1000) / 10) : null;
  const turnOutput = (s.turnOutputTokensBase ?? 0) + (s.output ?? 0);
  return {
    inputTokens: s.input,
    outputTokens: s.output,
    cachedInputTokens: s.cached,
    contextUsedTokens: used > 0 ? used : null,
    contextPercent,
    turnOutputTokens: turnOutput > 0 ? turnOutput : null,
  };
}

// Advertised context window by Claude model id (best-effort; unknown -> null so the
// percent simply stays absent rather than wrong). Anchor-free so vendor-prefixed ids
// (us.anthropic.claude-…) still match.
export function claudeContextWindowFromModel(model: unknown): number | null {
  const id = String(model ?? '').trim().toLowerCase();
  if (!id) return null;
  if (id === 'haiku' || /claude-haiku-/.test(id)) return 200_000;
  if (id === 'opus' || id === 'sonnet' || id === 'fable') return 1_000_000;
  if (/claude-(opus|sonnet)-/.test(id) || /claude-fable-/.test(id)) return 1_000_000;
  return null;
}

// Usable window = advertised minus Claude's max-output (20k) + autocompact (13k) reserve.
const CLAUDE_USABLE_WINDOW_RESERVE = 33_000;
export function claudeEffectiveContextWindow(advertised: number | null): number | null {
  if (advertised == null) return null;
  return advertised <= CLAUDE_USABLE_WINDOW_RESERVE ? advertised : advertised - CLAUDE_USABLE_WINDOW_RESERVE;
}

// Parse one claude stream-json event into kernel DriverEvents (pure + exported for
// hermetic testing). Faithful to pikiloom's claudeParse shapes.
export function handleClaudeEvent(ev: any, s: any, emit: (e: DriverEvent) => void): void {
  const t = ev.type || '';
  // Child events of a spawned sub-agent are tagged with parent_tool_use_id; route their
  // tool_uses into that sub-agent rather than the main turn (mirrors pikiloom).
  const parentId: string | null = (typeof ev.parent_tool_use_id === 'string' && ev.parent_tool_use_id) ? ev.parent_tool_use_id : null;
  if (parentId) {
    const sub: UniversalSubAgent | undefined = s.subAgents?.get?.(parentId);
    if (sub) {
      if (t === 'assistant') {
        for (const b of (ev.message?.content || [])) {
          if (b?.type !== 'tool_use') continue;
          sub.tools.push({ id: String(b.id || ''), name: String(b.name || 'Tool'), summary: String(b.name || 'Tool') });
        }
        const m = ev.message?.model; if (typeof m === 'string' && m.trim()) sub.model = m;
        emit({ type: 'subagent', subagent: { ...sub, tools: [...sub.tools] } });
      } else if (t === 'system' && typeof ev.model === 'string' && ev.model.trim()) {
        sub.model = ev.model;
        emit({ type: 'subagent', subagent: { ...sub, tools: [...sub.tools] } });
      }
    }
    return;
  }
  if (t === 'system') {
    trackClaudeBackgroundTask(ev, s);
    if (ev.session_id && ev.session_id !== s.sessionId) { s.sessionId = ev.session_id; emit({ type: 'session', sessionId: ev.session_id }); }
    s.model = ev.model ?? s.model;
    s.contextWindow = claudeEffectiveContextWindow(claudeContextWindowFromModel(s.model)) ?? s.contextWindow;
    return;
  }
  if (t === 'stream_event') {
    const inner = ev.event || {};
    if (inner.type === 'message_start') {
      const u = inner.message?.usage;
      // Claude emits one message per tool-use round within a single turn. Carry the prior
      // message's output into the per-turn base, then reset to the new message's prompt size
      // so contextUsedTokens tracks current occupancy while turnOutputTokens sums the turn.
      s.turnOutputTokensBase = (s.turnOutputTokensBase ?? 0) + (s.output ?? 0);
      s.input = u?.input_tokens ?? 0;
      s.cached = u?.cache_read_input_tokens ?? 0;
      s.cacheCreation = u?.cache_creation_input_tokens ?? 0;
      s.output = 0;
    } else if (inner.type === 'content_block_start') {
      // Claude emits multiple text/thinking blocks per turn (one set per tool-use round). Insert a
      // paragraph break before a NEW block when prior content exists, so the live preview shows
      // breaks between segments instead of running them together. Mirrors the legacy driver; the
      // separator is emitted as a delta so the runtime's accumulated snapshot stays in sync with s.
      const bt = inner.content_block?.type;
      if (bt === 'text' && s.text && !s.text.endsWith('\n\n')) {
        const sep = s.text.endsWith('\n') ? '\n' : '\n\n';
        s.text += sep; emit({ type: 'text', delta: sep });
      } else if (bt === 'thinking' && s.reasoning && !s.reasoning.endsWith('\n\n')) {
        const sep = s.reasoning.endsWith('\n') ? '\n' : '\n\n';
        s.reasoning += sep; emit({ type: 'reasoning', delta: sep });
      }
    } else if (inner.type === 'content_block_delta') {
      const d = inner.delta || {};
      if (d.type === 'text_delta' && d.text) { s.text += d.text; s.streamedText = true; emit({ type: 'text', delta: d.text }); }
      else if (d.type === 'thinking_delta' && d.thinking) { s.reasoning += d.thinking; s.streamedReasoning = true; emit({ type: 'reasoning', delta: d.thinking }); }
    } else if (inner.type === 'message_delta') {
      const u = inner.usage;
      if (u) {
        if (u.output_tokens != null) s.output = u.output_tokens;
        if (u.input_tokens != null) s.input = u.input_tokens;
        if (u.cache_read_input_tokens != null) s.cached = u.cache_read_input_tokens;
        if (u.cache_creation_input_tokens != null) s.cacheCreation = u.cache_creation_input_tokens;
        emit({ type: 'usage', usage: claudeUsageOf(s) });
      }
      if (inner.delta?.stop_reason) s.stopReason = inner.delta.stop_reason;
    }
    if (ev.session_id && ev.session_id !== s.sessionId) { s.sessionId = ev.session_id; emit({ type: 'session', sessionId: ev.session_id }); }
    return;
  }
  if (t === 'assistant') {
    const contents = ev.message?.content || [];
    for (const b of contents) {
      if (b?.type !== 'tool_use') continue;
      const id = String(b.id || '');
      const name = String(b.name || 'Tool');
      if (name === 'TodoWrite') {
        const plan = todoWriteToPlan(b.input);
        if (plan) emit({ type: 'plan', plan });
        continue;
      }
      // Task list (current Claude mechanism): stash the subject; the tool_result assigns the id.
      // Plan-only — like the legacy driver these never surface as Activity rows.
      if (name === 'TaskCreate') {
        const subject = typeof b.input?.subject === 'string' ? b.input.subject.trim() : '';
        if (subject) (s.pendingTaskCreates ||= new Map()).set(id, { subject });
        continue;
      }
      if (name === 'TaskUpdate') {
        const taskId = String(b.input?.taskId ?? '').trim();
        const rawStatus = String(b.input?.status ?? '').trim().toLowerCase();
        if (taskId) {
          if (rawStatus === 'deleted') {
            s.taskList?.delete(taskId);
            if (Array.isArray(s.taskOrder)) s.taskOrder = s.taskOrder.filter((x: string) => x !== taskId);
          } else if (rawStatus) {
            const existing = s.taskList?.get(taskId);
            if (existing) existing.status = rawStatus;
          }
          const plan = rebuildClaudeTaskPlan(s);
          if (plan) emit({ type: 'plan', plan });
        }
        continue;
      }
      if (name === 'Task' || name === 'Agent') {
        const input = b.input || {};
        const sub: UniversalSubAgent = {
          id,
          kind: typeof input.subagent_type === 'string' ? input.subagent_type : null,
          description: typeof input.description === 'string' ? input.description : null,
          model: null, tools: [], status: 'running',
        };
        (s.subAgents ||= new Map()).set(id, sub);
        emit({ type: 'subagent', subagent: { ...sub, tools: [] } });
        continue;
      }
      const summary = summarizeToolUse(name, b.input);
      (s.tools ||= new Map()).set(id, { name, summary });
      emit({ type: 'tool', call: { id, name, summary, input: shortToolValue(toolInputDetail(name, b.input), 200) || null, status: 'running' } });
    }
    emitClaudeImages(contents, s, emit);
    // Reasoning fallback: when thinking is NOT streamed as thinking_delta (claude can deliver
    // it as a complete `thinking` block in the assistant message instead), capture it here.
    // Mirrors the legacy driver — without this the kernel path silently drops all thinking.
    if (!s.streamedReasoning) {
      const th = contents.filter((b: any) => b?.type === 'thinking').map((b: any) => b.thinking || '').filter(Boolean).join('\n\n');
      if (th) { const delta = s.reasoning ? '\n\n' + th : th; s.reasoning += delta; emit({ type: 'reasoning', delta }); }
    }
    if (!s.streamedText) {
      const tx = contents.filter((b: any) => b?.type === 'text').map((b: any) => b.text || '').join('\n\n');
      if (tx) { s.text = tx; emit({ type: 'text', delta: tx }); }
    }
    return;
  }
  if (t === 'user') {
    // Tool results: surface generated images as artifacts AND close out the tool call
    // (status done/failed + a result detail) so toolCalls is a faithful structured SSOT
    // and the runtime's activity projection can render the execution trail.
    const contents = ev.message?.content || [];
    for (const b of contents) {
      if (b?.type !== 'tool_result') continue;
      emitClaudeImages(b.content || [], s, emit);
      const id = String(b.tool_use_id || '').trim();
      // TaskCreate result: the assigned task id arrives here; register the task and emit the plan.
      if (id && s.pendingTaskCreates?.has(id)) {
        const pending = s.pendingTaskCreates.get(id);
        const assignedId = readClaudeTaskCreateId(ev, b);
        if (pending && assignedId) {
          s.pendingTaskCreates.delete(id);
          (s.taskList ||= new Map());
          (s.taskOrder ||= []);
          if (!s.taskList.has(assignedId)) s.taskOrder.push(assignedId);
          s.taskList.set(assignedId, { subject: pending.subject, status: 'pending' });
          const plan = rebuildClaudeTaskPlan(s);
          if (plan) emit({ type: 'plan', plan });
        }
        continue;
      }
      const tool = id ? s.tools?.get(id) : undefined;
      if (!tool) continue;
      const isError = !!b.is_error;
      // File-shaped tools have no useful result detail (mirrors pikiloom): just mark done.
      const fileTool = tool.name === 'Read' || tool.name === 'Edit' || tool.name === 'Write' || tool.name === 'TodoWrite';
      const detail = (isError || !fileTool) ? firstResultLine(b.content) : null;
      emit({ type: 'tool', call: { id, name: tool.name, summary: tool.summary, status: isError ? 'failed' : 'done', result: detail || null } });
    }
    return;
  }
  if (t === 'result') {
    if (ev.session_id) s.sessionId = ev.session_id;
    if (ev.is_error && Array.isArray(ev.errors) && ev.errors.length) s.error = ev.errors.join('; ');
    if (ev.result && !s.text.trim()) { s.text = ev.result; }
    if (ev.stop_reason && !s.stopReason) s.stopReason = ev.stop_reason;
    const u = ev.usage;
    if (u) {
      if (s.input == null && u.input_tokens != null) s.input = u.input_tokens;
      if (s.output == null && u.output_tokens != null) s.output = u.output_tokens;
      const cached = u.cache_read_input_tokens ?? u.cached_input_tokens;
      if (s.cached == null && cached != null) s.cached = cached;
      if (s.cacheCreation == null && u.cache_creation_input_tokens != null) s.cacheCreation = u.cache_creation_input_tokens;
    }
    return;
  }
}

// ── run_in_background lifecycle (background → wake-up) ───────────────────────────────────
// Claude streams a structured lifecycle for detached background work as `system` sub-events:
//   { subtype:'task_started',      task_id, tool_use_id, description }   ← launched
//   { subtype:'task_updated',      task_id, patch:{ status } }           ← progress / terminal
//   { subtype:'task_notification', task_id, status }                     ← terminal (completed/killed/…)
// A task counts as pending from task_started until a terminal task_updated/task_notification.
// While any are pending the driver keeps the turn alive instead of ending it at `result`, so
// Claude's own background→wake-up turn (which reports the finished work) can stream in. Pure +
// exported for hermetic testing.

// How long, with no settle, to keep holding a turn open for a background task to finish and
// trigger Claude's wake-up turn, before giving up (so a never-completing daemon doesn't hang
// the turn forever). Override with PIKILOOM_CLAUDE_BG_HOLD_MS.
const CLAUDE_BG_HOLD_CAP_DEFAULT_MS = 10 * 60_000;
export function claudeBgHoldCapMs(): number {
  const raw = Number(process.env.PIKILOOM_CLAUDE_BG_HOLD_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : CLAUDE_BG_HOLD_CAP_DEFAULT_MS;
}
// After we settle a held turn gracefully (stdin closed, no kill), force-kill the lingering
// process only if it hasn't exited on its own within this window. Backstop against leaks.
const CLAUDE_EXIT_LEAK_GUARD_MS = 15_000;

export function isTerminalTaskStatus(status: unknown): boolean {
  return /^(complete|done|success|succeed|finish|kill|fail|error|stop|cancel|abort|timed?_?out|timeout)/i
    .test(String(status ?? '').trim());
}

export function trackClaudeBackgroundTask(ev: any, s: any): void {
  const subtype = ev?.subtype;
  if (subtype !== 'task_started' && subtype !== 'task_updated' && subtype !== 'task_notification') return;
  const id = String(ev?.task_id ?? ev?.tool_use_id ?? '').trim();
  if (!id) return;
  if (subtype === 'task_started') { (s.bgStarted ||= new Set<string>()).add(id); return; }
  if (isTerminalTaskStatus(ev?.patch?.status ?? ev?.status)) (s.bgTerminal ||= new Set<string>()).add(id);
}

export function pendingClaudeBackgroundTasks(s: any): number {
  const started: Set<string> | undefined = s?.bgStarted;
  if (!started?.size) return 0;
  const terminal: Set<string> | undefined = s?.bgTerminal;
  let n = 0;
  for (const id of started) if (!terminal?.has(id)) n++;
  return n;
}

export type ClaudeResultSettleDecision = 'settle' | 'hold';
// At a `result` event: settle the turn normally, unless background work is still running
// (then hold the process open for the wake-up). Errors always settle.
export function decideClaudeResultSettle(input: { hasError: boolean; pendingBackground: number }): ClaudeResultSettleDecision {
  if (input.hasError) return 'settle';
  return input.pendingBackground > 0 ? 'hold' : 'settle';
}

// Claude vision input formats (matches the legacy driver / Anthropic API: png, jpeg, gif, webp).
const CLAUDE_IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp',
};

// A stream-json user message (for --input-format stream-json; used to send the prompt and to
// inject mid-turn steer messages while stdin stays open). Image attachments are inlined as base64
// image content blocks so the model actually sees them; other files become a text note. Without
// this the kernel path sent text only and silently dropped pasted/attached images.
export function claudeUserMessage(text: string, attachments?: string[]): string {
  const content: any[] = [];
  for (const filePath of attachments || []) {
    const mime = CLAUDE_IMAGE_MIME[extname(filePath).toLowerCase()];
    if (mime) {
      try {
        content.push({ type: 'image', source: { type: 'base64', media_type: mime, data: readFileSync(filePath).toString('base64') } });
        continue;
      } catch { /* unreadable -> fall through to a text note */ }
    }
    content.push({ type: 'text', text: `[Attached file: ${filePath}]` });
  }
  content.push({ type: 'text', text });
  return JSON.stringify({ type: 'user', message: { role: 'user', content } });
}

// Surface base64 image content blocks as artifacts (data URLs), deduped per turn.
export function emitClaudeImages(blocks: any[], s: any, emit: (e: DriverEvent) => void): void {
  if (!Array.isArray(blocks)) return;
  s.seenImages ||= new Set<string>();
  let n = 0;
  for (const b of blocks) {
    if (b?.type !== 'image' || b?.source?.type !== 'base64' || typeof b.source.data !== 'string') continue;
    const mime = String(b.source.media_type || 'image/png');
    const key = `${mime}:${b.source.data.length}:${b.source.data.slice(0, 32)}`;
    if (s.seenImages.has(key)) continue;
    s.seenImages.add(key);
    const ext = mime.split('/')[1] || 'png';
    emit({ type: 'artifact', artifact: { url: `data:${mime};base64,${b.source.data}`, fileName: `image-${++n}.${ext}`, mime, kind: 'photo' } });
  }
}

// Claude's TodoWrite tool input -> a normalized UniversalPlan (ported from pikiloom).
export function todoWriteToPlan(input: any): UniversalPlan | null {
  if (!input || typeof input !== 'object') return null;
  const rawTodos = Array.isArray(input.todos) ? input.todos : [];
  const steps: UniversalPlan['steps'] = [];
  for (const todo of rawTodos) {
    if (!todo || typeof todo !== 'object') continue;
    const text = typeof todo.content === 'string' ? todo.content.trim() : '';
    if (!text) continue;
    const raw = typeof todo.status === 'string' ? todo.status : 'pending';
    const status = raw === 'completed' ? 'completed' : raw === 'in_progress' ? 'inProgress' : 'pending';
    steps.push({ text, status });
  }
  return steps.length ? { explanation: null, steps } : null;
}

// ── Claude task-list (TaskCreate / TaskUpdate) -> UniversalPlan ──────────────────────
// Current Claude Code drives its task list through TaskCreate/TaskUpdate, NOT TodoWrite
// (TodoWrite is the legacy mechanism). TaskCreate carries the subject; its tool_result then
// assigns a stable task id (toolUseResult.task.id, or "Task #N" in the text). TaskUpdate flips
// a task's status by id. We accumulate the list in driver state and re-emit the whole plan on
// each change. Without this the kernel path never emits a plan event for Claude, so the
// dashboard's task-list card never renders. Ported from pikiloom's legacy claude driver.

// The assigned task id from a TaskCreate tool_result. Prefer the structured field; fall back
// to parsing "Task #N" from a string result.
export function readClaudeTaskCreateId(ev: any, block: any): string | null {
  const structured = ev?.toolUseResult?.task?.id;
  if (structured != null && String(structured).trim()) return String(structured).trim();
  const content = block?.content;
  if (typeof content === 'string') {
    const m = content.match(/Task #(\d+)/);
    if (m) return m[1];
  }
  return null;
}

export function rebuildClaudeTaskPlan(s: any): UniversalPlan | null {
  if (!Array.isArray(s?.taskOrder) || !s.taskOrder.length) return null;
  const steps: UniversalPlan['steps'] = [];
  for (const id of s.taskOrder) {
    const task = s.taskList?.get(id);
    if (!task) continue;
    const lowered = String(task.status || '').toLowerCase();
    const status = lowered === 'completed' ? 'completed'
      : (lowered === 'in_progress' || lowered === 'inprogress') ? 'inProgress'
      : 'pending';
    const text = String(task.subject || '').trim();
    if (text) steps.push({ text, status });
  }
  return steps.length ? { explanation: null, steps } : null;
}

// ── Tool-call summarization (ported from pikiloom's summarizeClaudeToolUse) ──────────
// Turns a Claude tool_use {name,input} into a one-line human summary. The runtime's
// activity projector joins these into snapshot.activity; the structured form lives in
// toolCalls. Kept driver-local: knowing Claude's tool input shapes is the driver's job.

export function shortToolValue(value: unknown, max = 140): string {
  if (value == null) return '';
  const text = (typeof value === 'string' ? value : String(value)).replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
}

function toolInputDetail(name: string, input: any): string {
  const i = input || {};
  return i.command || i.file_path || i.path || i.pattern || i.query || i.url || i.description || '';
}

export function summarizeToolUse(name: string, input: any): string {
  const tool = String(name || '').trim() || 'Tool';
  const i = input || {};
  const description = shortToolValue(i.description, 120);
  switch (tool) {
    case 'Read': { const t = shortToolValue(i.file_path || i.path); return t ? `Read ${t}` : 'Read file'; }
    case 'Edit': { const t = shortToolValue(i.file_path || i.path); return t ? `Edit ${t}` : 'Edit file'; }
    case 'Write': { const t = shortToolValue(i.file_path || i.path); return t ? `Write ${t}` : 'Write file'; }
    case 'Glob': { const p = shortToolValue(i.pattern || i.glob, 120); return p ? `List files: ${p}` : 'List files'; }
    case 'Grep': { const p = shortToolValue(i.pattern || i.query, 120); return p ? `Search text: ${p}` : 'Search text'; }
    case 'WebFetch': { const u = shortToolValue(i.url, 120); return u ? `Fetch ${u}` : 'Fetch web page'; }
    case 'WebSearch': { const q = shortToolValue(i.query, 120); return q ? `Search web: ${q}` : 'Search web'; }
    case 'TodoWrite': return 'Update plan';
    case 'Task': { const p = shortToolValue(i.description || i.prompt, 120); return p ? `Run task: ${p}` : 'Run task'; }
    case 'Bash': {
      if (description) return `Run shell: ${description}`;
      const c = shortToolValue(i.command, 120);
      return c ? `Run shell: ${c}` : 'Run shell command';
    }
    default: {
      const mcpMatch = tool.match(/^mcp__[^_]+__(.+)$/);
      const bare = mcpMatch ? mcpMatch[1] : tool;
      if (bare === 'im_send_file') { const p = shortToolValue(i.path, 120); return p ? `Send file: ${p}` : 'Send file'; }
      if (bare === 'im_list_files') return 'List workspace files';
      if (bare === 'im_ask_user') { const q = shortToolValue(i.question, 120); return q ? `Ask user: ${q}` : 'Ask user'; }
      if (description) return `${tool}: ${description}`;
      const d = shortToolValue(toolInputDetail(tool, i), 120);
      return d ? `${tool}: ${d}` : tool;
    }
  }
}

// First non-empty line of a tool_result content (string | block[]), for the "summary -> detail" form.
export function firstResultLine(content: any): string {
  let text = '';
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) text = content.map((b: any) => (typeof b === 'string' ? b : b?.type === 'text' ? b.text || '' : '')).join('\n');
  for (const line of text.split('\n')) { const t = line.trim(); if (t) return shortToolValue(t, 120); }
  return '';
}
