import type {
  UniversalSnapshot, UniversalInteraction, UniversalToolCall, UniversalUsage, UniversalSubAgent,
} from '../protocol/index.js';
import type { AgentDriver, AgentTurnInput, DriverContext, DriverEvent, DriverResult, SteerFn } from '../contracts/driver.js';
import type { InteractionHandler } from '../contracts/ports.js';

// Drives ONE turn of ONE session: applies driver events into an accumulating
// UniversalSnapshot and owns the single-session control verbs (stop/steer/interact).
// Knows nothing about chat ids, queues, or transports.

export class SessionRunner {
  readonly snapshot: UniversalSnapshot;
  private seq = 0;
  private readonly abort = new AbortController();
  private steerFn: SteerFn | null = null;
  private pending: { promptId: string; resolve: (a: Record<string, string[]>) => void } | null = null;
  private finished = false;

  constructor(
    readonly sessionKey: string,
    readonly agent: string,
    readonly taskId: string,
    private readonly onUpdate: (snapshot: UniversalSnapshot, seq: number) => void,
    private readonly interactionHandler?: InteractionHandler,
  ) {
    this.snapshot = {
      phase: 'queued', taskId, agent, sessionId: null,
      text: '', reasoning: '', activity: '',
      toolCalls: [], interactions: [], artifacts: [],
      updatedAt: Date.now(),
    };
  }

  get currentSeq(): number { return this.seq; }

  private publish(): void {
    this.snapshot.updatedAt = Date.now();
    this.seq += 1;
    this.onUpdate(this.snapshot, this.seq);
  }

  async run(driver: AgentDriver, input: AgentTurnInput, prompt: string, model: string | null, effort: string | null): Promise<DriverResult> {
    this.snapshot.phase = 'streaming';
    this.snapshot.prompt = prompt;
    this.snapshot.model = model;
    this.snapshot.effort = effort;
    this.snapshot.startedAt = Date.now();
    this.publish();

    const ctx: DriverContext = {
      signal: this.abort.signal,
      emit: (e) => this.applyEvent(e),
      askUser: (interaction) => this.askUser(interaction),
      registerSteer: (fn) => { this.steerFn = fn; },
    };

    let result: DriverResult;
    try {
      result = await driver.run(input, ctx);
    } catch (err: any) {
      result = { ok: false, text: this.snapshot.text || '', error: err?.message || String(err), stopReason: 'error' };
    }

    // Merge terminal result into the snapshot (driver may have only streamed deltas).
    if (result.text && result.text.trim() && result.text.length >= (this.snapshot.text || '').length) {
      this.snapshot.text = result.text;
    }
    if (result.reasoning && !(this.snapshot.reasoning || '').trim()) this.snapshot.reasoning = result.reasoning;
    if (result.sessionId) this.snapshot.sessionId = result.sessionId;
    if (result.anchor) this.snapshot.anchor = result.anchor;
    if (result.usage) this.snapshot.usage = result.usage;
    this.snapshot.error = result.error ?? null;
    this.snapshot.incomplete = !result.ok;
    this.snapshot.phase = 'done';
    this.snapshot.interactions = [];
    this.finished = true;
    this.flushPending({});
    this.publish();
    return result;
  }

  private applyEvent(e: DriverEvent): void {
    switch (e.type) {
      case 'session': this.snapshot.sessionId = e.sessionId; break;
      case 'text': this.snapshot.text = (this.snapshot.text || '') + e.delta; break;
      case 'reasoning': this.snapshot.reasoning = (this.snapshot.reasoning || '') + e.delta; break;
      case 'activity': this.snapshot.activity = e.line; break;
      case 'plan': this.snapshot.plan = e.plan; break;
      case 'artifact': (this.snapshot.artifacts ||= []).push(e.artifact); break;
      case 'usage': this.snapshot.usage = mergeUsage(this.snapshot.usage, e.usage); break;
      // toolCalls is the structured SSOT; activity is its derived human-readable view.
      // A driver that streams explicit `activity` lines (e.g. echo) owns activity directly;
      // any driver that emits structured tool/subagent events gets the projection for free.
      case 'tool': upsertTool(this.snapshot, e.call); this.snapshot.activity = projectActivity(this.snapshot); break;
      case 'subagent': upsertSubAgent(this.snapshot, e.subagent); this.snapshot.activity = projectActivity(this.snapshot); break;
    }
    this.publish();
  }

  private askUser(interaction: UniversalInteraction): Promise<Record<string, string[]>> {
    if (this.finished || this.abort.signal.aborted) return Promise.resolve({});
    (this.snapshot.interactions ||= []).push(interaction);
    this.publish();
    return new Promise<Record<string, string[]>>((resolve) => {
      let settled = false;
      const finish = (answers: Record<string, string[]>) => {
        if (settled) return; settled = true;
        this.pending = null;
        this.snapshot.interactions = (this.snapshot.interactions || []).filter(i => i.promptId !== interaction.promptId);
        this.publish();
        resolve(answers);
      };
      this.pending = { promptId: interaction.promptId, resolve: finish };
      // A programmatic resolver may answer (or auto-cancel) the interaction; returning
      // null defers to a terminal calling interact(). The default handler defers.
      Promise.resolve(this.interactionHandler?.askUser(interaction) ?? null)
        .then((answers) => { if (answers) finish(answers); })
        .catch(() => { /* defer to terminal */ });
    });
  }

  private flushPending(answers: Record<string, string[]>): void {
    this.pending?.resolve(answers);
  }

  // ---- control verbs ----

  stop(): void {
    this.abort.abort();
    this.flushPending({});
  }

  async steer(prompt: string, attachments?: string[]): Promise<boolean> {
    if (this.finished || !this.steerFn) return false;
    return this.steerFn(prompt, attachments);
  }

  interact(promptId: string, action: 'select' | 'text' | 'skip' | 'cancel', value?: string): boolean {
    if (!this.pending || this.pending.promptId !== promptId) return false;
    const interaction = (this.snapshot.interactions || []).find(i => i.promptId === promptId);
    const q = interaction?.questions[interaction.currentIndex ?? 0] || interaction?.questions[0];
    const qid = q?.id || 'answer';
    const resolve = this.pending.resolve;   // resolver does its own cleanup (pending/snapshot/publish)
    if (action === 'cancel') resolve({});
    else if (action === 'skip') resolve({ [qid]: [] });
    else resolve({ [qid]: [value ?? ''] });
    return true;
  }
}

// Derive the human-readable activity trail from the structured tool/subagent calls.
// One line per call, with a status suffix: running -> "summary", done -> "summary done"
// (or "summary -> detail"), failed -> "summary failed[: detail]". This is the kernel's
// activity line contract — a lowest-common-denominator view every terminal can render
// without re-deriving it from toolCalls itself.
export function projectActivity(snap: UniversalSnapshot): string {
  const lines: string[] = [];
  for (const t of snap.toolCalls || []) {
    if (t.status === 'failed') lines.push(t.result ? `${t.summary} failed: ${t.result}` : `${t.summary} failed`);
    else if (t.status === 'done') lines.push(t.result ? `${t.summary} -> ${t.result}` : `${t.summary} done`);
    else lines.push(t.summary);
  }
  for (const sub of snap.subAgents || []) {
    const label = sub.description || sub.kind || 'subagent';
    if (sub.status === 'failed') lines.push(`Run task: ${label} failed`);
    else if (sub.status === 'done') lines.push(`Run task: ${label} done`);
    else lines.push(`Run task: ${label}`);
  }
  return lines.join('\n');
}

function upsertTool(snap: UniversalSnapshot, call: UniversalToolCall): void {
  const list = (snap.toolCalls ||= []);
  const idx = list.findIndex(t => t.id === call.id);
  if (idx >= 0) list[idx] = { ...list[idx], ...call };
  else list.push(call);
}

function upsertSubAgent(snap: UniversalSnapshot, sub: UniversalSubAgent): void {
  const list = (snap.subAgents ||= []);
  const idx = list.findIndex(s => s.id === sub.id);
  if (idx >= 0) list[idx] = { ...list[idx], ...sub };
  else list.push(sub);
}

function mergeUsage(prev: UniversalUsage | null | undefined, next: Partial<UniversalUsage>): UniversalUsage {
  const base: UniversalUsage = prev || { inputTokens: null, outputTokens: null, cachedInputTokens: null, contextPercent: null };
  return { ...base, ...next };
}
