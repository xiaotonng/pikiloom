/**
 * pikichannel/adapter-pikiloom.ts — the reference {@link SessionSource}.
 *
 * Binds the universal protocol to pikiloom's live runtime *without touching the
 * bot*. It is a peer consumer of the very same surfaces the Web Dashboard uses:
 *   - data plane: the `runtime.events` 'dashboard-event' bus (same bus the
 *     dashboard WebSocket layer listens to). We must NOT call
 *     `bot.onStreamSnapshot` — that is a single-slot callback already owned by
 *     the runtime; re-registering it would silently break the dashboard.
 *   - control plane: the exported session-control functions
 *     (`queueDashboardSessionTask`, `stopSessionTasks`, …) — the same entry
 *     points the dashboard REST routes call.
 *
 * The StreamSnapshot → UniversalSnapshot projection lives here, keeping the
 * protocol package free of any pikiloom-internal type.
 */

import { EventEmitter } from 'node:events';
import { runtime, type DashboardEvent } from '../dashboard/runtime.js';
import {
  queueDashboardSessionTask,
  stopSessionTasks,
  steerSessionTask,
  cancelSessionTask,
  interactionSelectOption,
  interactionSubmitText,
  interactionSkip,
  interactionCancel,
} from '../dashboard/session-control.js';
import { loadUserConfig } from '../core/config/user-config.js';
import { VERSION } from '../core/version.js';
import type { StreamSnapshot } from '../bot/bot.js';
import type {
  HostCapability,
  SessionMeta,
  UniversalInteraction,
  UniversalSnapshot,
} from './protocol.js';
import type { PromptCommand, CommandResult, SessionSource, TunnelRequest, TunnelResponse } from './host.js';

const CAPABILITIES: HostCapability[] = ['prompt', 'stop', 'steer', 'recall', 'interact', 'subscribe-all', 'artifacts', 'tunnel'];

/** Forwards a tunneled control-plane request to the host's HTTP router. */
export type RequestForwarder = (req: TunnelRequest) => Promise<TunnelResponse>;

function splitKey(sessionKey: string): { agent: string; sessionId: string } {
  const idx = sessionKey.indexOf(':');
  if (idx < 0) return { agent: '', sessionId: sessionKey };
  return { agent: sessionKey.slice(0, idx), sessionId: sessionKey.slice(idx + 1) };
}

function projectInteractions(snap: StreamSnapshot): UniversalInteraction[] | undefined {
  if (!snap.interactions?.length) return undefined;
  return snap.interactions.map((it) => ({
    promptId: it.promptId,
    kind: it.kind,
    title: it.title,
    hint: it.hint,
    currentIndex: it.currentIndex,
    questions: (it.questions || []).map((q: any) => ({
      id: String(q.id),
      text: String(q.text ?? q.label ?? ''),
      type: q.type,
      choices: Array.isArray(q.choices)
        ? q.choices.map((c: any) => ({ label: String(c.label ?? c), description: c.description }))
        : undefined,
    })),
  }));
}

/** Strip empty optionals so the projection is lean AND deterministic (the diff
 *  baseline must be stable: a field is either consistently present or absent). */
function compact<T extends Record<string, any>>(obj: T): T {
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    const emptyArr = Array.isArray(v) && v.length === 0;
    const emptyObj = v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0;
    if (v === null || v === undefined || v === '' || emptyArr || emptyObj) delete obj[k];
  }
  return obj;
}

/** Project pikiloom's StreamSnapshot into the agent-agnostic wire snapshot. */
export function projectSnapshot(sessionKey: string, snap: StreamSnapshot): UniversalSnapshot {
  const { agent } = splitKey(sessionKey);
  const meta = snap.previewMeta;
  return compact({
    phase: snap.phase,
    taskId: snap.taskId ?? undefined,
    agent: agent || undefined,
    model: snap.model ?? undefined,
    effort: snap.effort ?? undefined,
    prompt: snap.question ?? undefined,
    text: snap.text || undefined,
    reasoning: snap.thinking || undefined,
    activity: snap.activity || undefined,
    plan: snap.plan
      ? { explanation: snap.plan.explanation, steps: snap.plan.steps.map((s) => ({ text: s.step, status: s.status })) }
      : undefined,
    toolCalls: meta?.toolCalls?.map((t) => ({
      id: t.id, name: t.name, summary: t.summary, input: t.input, result: t.result, status: t.status,
    })),
    subAgents: meta?.subAgents?.map((s) => ({
      id: s.id, kind: s.kind, description: s.description, model: s.model, tools: s.tools, status: s.status,
    })),
    usage: meta
      ? compact({
          inputTokens: meta.inputTokens,
          outputTokens: meta.outputTokens,
          cachedInputTokens: meta.cachedInputTokens,
          contextUsedTokens: meta.contextUsedTokens,
          contextPercent: meta.contextPercent,
          turnOutputTokens: meta.turnOutputTokens,
          providerName: meta.providerName,
          generatingImages: meta.generatingImages,
        })
      : undefined,
    artifacts: snap.artifacts,
    interactions: projectInteractions(snap),
    queued: snap.queuedTasks?.length ? snap.queuedTasks.map((q) => ({ taskId: q.taskId, prompt: q.prompt })) : undefined,
    error: snap.error ?? undefined,
    ...(snap.incomplete ? { incomplete: true } : {}),
    startedAt: snap.startedAt,
    updatedAt: snap.updatedAt,
  }) as UniversalSnapshot;
}

function metaFromSnapshot(sessionKey: string, snap: UniversalSnapshot): SessionMeta {
  const title = (snap.prompt || snap.text || '').slice(0, 80) || null;
  return { sessionKey, agent: snap.agent, title, phase: snap.phase, updatedAt: snap.updatedAt };
}

/**
 * The pikiloom SessionSource. One instance per process; it attaches to the
 * runtime event bus lazily on first `onUpdate`.
 */
export class PikiloomSessionSource implements SessionSource {
  private seqs = new Map<string, number>();
  private known = new Map<string, SessionMeta>();
  private bus = new EventEmitter();
  private wired = false;

  /** @param forwarder forwards tunneled `/api/*` requests to the HTTP router. */
  constructor(private readonly forwarder?: RequestForwarder) {}

  hostInfo() {
    return { name: 'pikiloom', version: VERSION, capabilities: CAPABILITIES, authRequired: true };
  }

  /** Control-plane HTTP tunnel — delegates to the embedder-supplied forwarder
   *  (the dashboard's Hono router). The host has already enforced auth + the
   *  `/api/*` allowlist before we get here. */
  async handleRequest(req: TunnelRequest): Promise<TunnelResponse> {
    if (!this.forwarder) return { status: 503, body: 'tunnel forwarder not configured' };
    return this.forwarder(req);
  }

  listSessions(): SessionMeta[] {
    // Most-recent first, bounded so a long-lived host never ships an unbounded
    // list over the wire (remote clients want a recent picker, not all history).
    return Array.from(this.known.values()).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 50);
  }

  getSnapshot(sessionKey: string): { snapshot: UniversalSnapshot; seq: number } | null {
    const bot = runtime.getBotRef();
    const raw = bot?.getStreamSnapshot(sessionKey) as StreamSnapshot | null | undefined;
    if (!raw) return null;
    return { snapshot: projectSnapshot(sessionKey, raw), seq: this.seqs.get(sessionKey) || 0 };
  }

  onUpdate(cb: (sessionKey: string, snapshot: UniversalSnapshot, seq: number) => void): () => void {
    this.ensureWired();
    const handler = (k: string, s: UniversalSnapshot, seq: number) => cb(k, s, seq);
    this.bus.on('update', handler);
    return () => this.bus.off('update', handler);
  }

  onSessionsChanged(cb: (sessions: SessionMeta[]) => void): () => void {
    this.ensureWired();
    const handler = () => cb(this.listSessions());
    this.bus.on('sessions', handler);
    return () => this.bus.off('sessions', handler);
  }

  /** Subscribe once to the runtime's dashboard-event bus and fan out internally. */
  private ensureWired(): void {
    if (this.wired) return;
    this.wired = true;
    runtime.events.on('dashboard-event', (event: DashboardEvent) => {
      if (event.type === 'stream-update' && event.key && event.snapshot) {
        const snapshot = projectSnapshot(event.key, event.snapshot as StreamSnapshot);
        const seq = (this.seqs.get(event.key) || 0) + 1;
        this.seqs.set(event.key, seq);
        this.known.set(event.key, metaFromSnapshot(event.key, snapshot));
        this.bus.emit('update', event.key, snapshot, seq);
      } else if (event.type === 'sessions-changed') {
        this.bus.emit('sessions');
      }
    });
  }

  // -- control plane (delegates to the shared session-control surface) -----

  async prompt(cmd: PromptCommand): Promise<CommandResult> {
    const config = loadUserConfig();
    const workdir = cmd.workdir || runtime.getRequestWorkdir(config);
    const agent = cmd.agent || runtime.getRuntimeDefaultAgent(config);
    const sessionId = cmd.sessionKey ? splitKey(cmd.sessionKey).sessionId : '';
    const res: any = await queueDashboardSessionTask({
      workdir,
      agent,
      sessionId,
      prompt: cmd.prompt,
      model: cmd.model,
      effort: cmd.effort,
      workflow: cmd.workflow,
      attachments: cmd.attachments,
    });
    if (!res?.ok) return { ok: false, error: res?.error || 'submit failed' };
    return { ok: true, sessionKey: res.sessionKey, taskId: res.taskId };
  }

  stop(sessionKey: string): CommandResult {
    const { agent, sessionId } = splitKey(sessionKey);
    const r: any = stopSessionTasks(agent, sessionId);
    return r?.ok ? { ok: true } : { ok: false, error: r?.error || 'stop failed' };
  }

  async steer(taskId: string): Promise<CommandResult> {
    const r: any = await steerSessionTask(taskId);
    return r?.ok ? { ok: true } : { ok: false, error: r?.error || 'steer failed' };
  }

  recall(taskId: string): CommandResult {
    const r: any = cancelSessionTask(taskId);
    return r?.ok ? { ok: true } : { ok: false, error: r?.error || 'recall failed' };
  }

  interact(promptId: string, action: 'select' | 'text' | 'skip' | 'cancel', value?: string, requestFreeform?: boolean): CommandResult {
    let r: any;
    if (action === 'select') r = interactionSelectOption(promptId, value || '', { requestFreeform });
    else if (action === 'text') r = interactionSubmitText(promptId, value || '');
    else if (action === 'skip') r = interactionSkip(promptId);
    else r = interactionCancel(promptId);
    return r?.ok ? { ok: true } : { ok: false, error: r?.error || 'interaction failed' };
  }
}
