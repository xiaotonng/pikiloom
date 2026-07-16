import { randomUUID } from 'node:crypto';
import {
  type UniversalSnapshot, type SnapshotPatch, type SessionMeta, type UniversalQueuedTask,
  type AgentInfo, type ModelDescriptor, type EffortOption, type ToolDescriptor, type SkillDescriptor,
  diffSnapshot, emptySnapshot, makeSessionKey, splitSessionKey,
} from '../protocol/index.js';
import type { AgentDriver, AgentTurnInput, McpServerSpec, TuiSpec } from '../contracts/driver.js';
import type {
  SessionStore, ModelResolver, ToolProvider, SystemPromptBuilder, InteractionHandler, Catalog,
} from '../contracts/ports.js';
import type { LoomIO, PromptInput, ForkSessionInput, Plugin, SpawnContribution } from '../contracts/surface.js';
import { SessionRunner } from './session-runner.js';
import { buildForkSeed } from './fork.js';
import { normalizeImageAttachments } from '../attachments.js';

export interface HubDeps {
  drivers: Map<string, AgentDriver>;
  defaultAgent: string;
  workdir: string;
  sessionStore: SessionStore;
  modelResolver: ModelResolver;
  toolProvider: ToolProvider;
  systemPromptBuilder: SystemPromptBuilder;
  catalog: Catalog;
  interactionHandler: InteractionHandler;
  plugins: Plugin[];
  serialPerSession?: boolean;   // default true: one turn per session at a time, queue the rest
  systemPromptBase?: string;
  log?: (msg: string) => void;
}

interface SessionEntry {
  meta: SessionMeta;
  snapshot: UniversalSnapshot;
  lastPublished: UniversalSnapshot;
  seq: number;
  runner?: SessionRunner;
}

// A turn accepted but not yet started (the session is busy). The turn is built lazily at
// promotion time so injection / tools / resume-target reflect the latest session state.
interface QueuedItem {
  runner: SessionRunner;
  taskId: string;
  input: PromptInput;
  driver: AgentDriver;
  agent: string;
  sessionId: string;
  sessionKey: string;
  workdir: string;
  workspacePath: string;
  preExisted: boolean;
}

export class Hub implements LoomIO {
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly runnersByTask = new Map<string, SessionRunner>();
  private readonly active = new Map<string, SessionRunner>();        // sessionKey -> currently running turn
  private readonly waiting = new Map<string, QueuedItem[]>();        // sessionKey -> FIFO of queued turns
  private readonly seqByKey = new Map<string, number>();             // monotonic publish seq per session (survives turn changes)
  private readonly updateSubs = new Set<(k: string, s: UniversalSnapshot, p: SnapshotPatch, seq: number) => void>();
  private readonly sessionsSubs = new Set<(s: SessionMeta[]) => void>();

  constructor(private readonly deps: HubDeps) {}

  listAgents(): string[] { return [...this.deps.drivers.keys()]; }

  // ---- discovery (capabilities from drivers; models/effort/tools/skills from Catalog) ----
  listAgentInfo(): AgentInfo[] {
    return [...this.deps.drivers.values()].map(d => ({ id: d.id, capabilities: d.capabilities }));
  }
  listModels(agent: string): Promise<ModelDescriptor[]> {
    return this.deps.catalog.listModels({ agent }).catch((e: any) => { this.deps.log?.(`[hub] listModels failed: ${e?.message || e}`); return []; });
  }
  listEffort(agent: string, model?: string | null): Promise<EffortOption[]> {
    return this.deps.catalog.listEffort({ agent, model: model ?? null }).catch((e: any) => { this.deps.log?.(`[hub] listEffort failed: ${e?.message || e}`); return []; });
  }
  listTools(agent: string, workdir?: string): Promise<ToolDescriptor[]> {
    return this.deps.catalog.listTools({ agent, workdir: workdir || this.deps.workdir }).catch((e: any) => { this.deps.log?.(`[hub] listTools failed: ${e?.message || e}`); return []; });
  }
  listSkills(agent: string, workdir?: string): Promise<SkillDescriptor[]> {
    return this.deps.catalog.listSkills({ agent, workdir: workdir || this.deps.workdir }).catch((e: any) => { this.deps.log?.(`[hub] listSkills failed: ${e?.message || e}`); return []; });
  }

  // Resolve how to launch an agent's interactive TUI (with model injection applied),
  // without spawning it — the caller (launcher / Loom.runTui) owns the PTY.
  async resolveTui(opts: { agent?: string; workdir?: string; model?: string | null; sessionId?: string | null }): Promise<TuiSpec> {
    const agent = (opts.agent || this.deps.defaultAgent || '').trim();
    const driver = this.deps.drivers.get(agent);
    if (!driver) throw new Error(`No driver registered for agent "${agent}"`);
    if (!driver.tui) throw new Error(`Driver "${agent}" does not support TUI mode`);
    const workdir = opts.workdir || this.deps.workdir;
    const injection = await this.deps.modelResolver.resolve(agent, { model: opts.model, profileId: null }).catch(() => null);
    const model = injection?.model ?? opts.model ?? null;
    // Same merge as run(), so the raw-PTY rail also gets plugin env/args (e.g. a hijack redirect).
    const pluginParts = await this.pluginSpawn(agent, workdir, 'tui', opts.sessionId ?? null, model);
    const spawn = this.mergeSpawn([{ env: injection?.env, extraArgs: injection?.extraArgs }, ...pluginParts]);
    return driver.tui({ workdir, model, sessionId: opts.sessionId ?? null, env: spawn.env, extraArgs: spawn.extraArgs });
  }

  async prompt(input: PromptInput): Promise<{ sessionKey: string; taskId: string }> {
    const agent = (input.agent || this.deps.defaultAgent || '').trim();
    const driver = this.deps.drivers.get(agent);
    if (!driver) throw new Error(`No driver registered for agent "${agent}"`);
    const workdir = input.workdir || this.deps.workdir;

    const resumeId = input.sessionKey ? splitSessionKey(input.sessionKey).sessionId : null;
    const preExisted = resumeId ? !!(await this.deps.sessionStore.get(agent, resumeId)) : false;
    const { sessionId, workspacePath } = await this.deps.sessionStore.ensure(agent, {
      sessionId: resumeId, workdir, title: input.prompt.slice(0, 80),
    });
    const sessionKey = makeSessionKey(agent, sessionId);

    const taskId = randomUUID();
    const runner = new SessionRunner(sessionKey, agent, taskId, (snap, seq) => this.onRunnerUpdate(sessionKey, snap, seq), this.deps.interactionHandler);
    this.runnersByTask.set(taskId, runner);
    const item: QueuedItem = { runner, taskId, input, driver, agent, sessionId, sessionKey, workdir, workspacePath, preExisted };

    // Per-session serial orchestration (default): one turn per session at a time. A prompt
    // for a busy session queues (surfaced in the active snapshot's `queued`) and promotes
    // when the running turn finishes — never clobbering the in-flight turn's snapshot.
    if (this.deps.serialPerSession !== false && this.active.has(sessionKey)) {
      this.enqueue(item);
    } else {
      void this.runNow(item);
    }
    return { sessionKey, taskId };
  }

  // Branch `fromSessionKey` at a turn boundary into a NEW managed session. Copies the kept
  // transcript prefix, pins the native keep-boundary NOW (so the branch is immune to the
  // parent continuing afterwards), and stamps a pendingFork the first prompt() dispatch
  // consumes (fork-on-dispatch). The parent — record, transcript, native store — is never
  // mutated. Works for sessions the kernel never ran: a native-only session's id IS its
  // native id (the same assumption prompt() makes when resuming one).
  async forkSession(input: ForkSessionInput): Promise<{ sessionKey: string }> {
    const { agent, sessionId: fromId } = splitSessionKey(input.fromSessionKey);
    const driver = this.deps.drivers.get(agent);
    if (!driver) throw new Error(`No driver registered for agent "${agent}"`);
    const parent = await this.deps.sessionStore.get(agent, fromId);
    const parentNativeId = parent?.nativeSessionId || fromId;
    const workdir = parent?.workdir || this.deps.workdir;

    // Kept transcript prefix: through atTaskId inclusive (default: the whole transcript).
    const turns = this.deps.sessionStore.history
      ? await this.deps.sessionStore.history(agent, fromId).catch(() => [] as UniversalSnapshot[])
      : [];
    let kept = turns;
    if (input.atTaskId) {
      const cut = turns.findIndex(t => t.taskId === input.atTaskId);
      if (cut < 0) throw new Error(`fork point ${input.atTaskId} not found in ${input.fromSessionKey}`);
      kept = turns.slice(0, cut + 1);
    }
    const cutIsTail = kept.length === turns.length;

    // Pin the native keep-boundary at fork time: explicit override → the kept turn's recorded
    // anchor → the parent's CURRENT tail (tail cuts only). A mid cut that can't be anchored
    // falls back to a seed fork — a tail-anchored native fork there would silently absorb the
    // dropped turns, which is worse than the seed's lower fidelity.
    let anchor = input.anchor ?? kept[kept.length - 1]?.anchor ?? null;
    if (!anchor && cutIsTail && driver.resolveNativeAnchor) {
      try { anchor = (await driver.resolveNativeAnchor({ sessionId: parentNativeId, workdir })) ?? null; }
      catch { anchor = null; }
    }
    const mode: 'native' | 'seed' = driver.capabilities?.fork && parentNativeId && (anchor || cutIsTail) ? 'native' : 'seed';

    const { sessionId: newId } = await this.deps.sessionStore.ensure(agent, {
      workdir, title: input.title ?? parent?.title ?? null,
    });
    for (const turn of kept) {
      try { await this.deps.sessionStore.appendTurn?.(agent, newId, turn); }
      catch (e: any) { this.deps.log?.(`[hub] fork transcript copy failed ${newId}: ${e?.message || e}`); }
    }
    const rec = await this.deps.sessionStore.get(agent, newId);
    if (rec) {
      const last = kept[kept.length - 1];
      rec.model = parent?.model ?? last?.model ?? null;
      rec.effort = parent?.effort ?? last?.effort ?? null;
      rec.preview = parent?.preview ?? null;
      // ensure() stamps fresh records 'running' (prompt() marks them properly right after);
      // a fork has not dispatched anything yet — settle it so it can't read as a live turn.
      rec.runState = 'completed';
      rec.runDetail = null;
      rec.forkedFrom = { sessionKey: input.fromSessionKey, taskId: input.atTaskId ?? last?.taskId ?? null };
      rec.pendingFork = { parentNativeSessionId: parentNativeId, anchor, mode };
      await this.deps.sessionStore.save(rec);
    }
    this.deps.log?.(`[hub] forked ${input.fromSessionKey} -> ${agent}:${newId} (${mode}${anchor ? `, anchor ${anchor}` : ''}, ${kept.length}/${turns.length} turns)`);
    return { sessionKey: makeSessionKey(agent, newId) };
  }

  // Rewind `sessionKey` IN PLACE to a turn boundary: drop the transcript after `atTaskId` (the
  // last KEPT turn) and stamp a pendingRewind the next prompt() consumes (resume the SAME native
  // session at the kept boundary, NO fork). The session id — managed AND native — is unchanged;
  // only the dropped tip leaves the active path. Requires a rewind-capable driver, a store that
  // can truncate, and a resolvable native anchor at the cut; otherwise throws so the caller can
  // fall back (append on the same session, or a fork).
  async rewindSession(input: { sessionKey: string; atTaskId: string; anchor?: string | null }): Promise<{ sessionKey: string }> {
    const { agent, sessionId } = splitSessionKey(input.sessionKey);
    const driver = this.deps.drivers.get(agent);
    if (!driver) throw new Error(`No driver registered for agent "${agent}"`);
    if (!driver.capabilities?.rewind) throw new Error(`agent "${agent}" has no in-place rewind`);
    if (!this.deps.sessionStore.truncateTurns || !this.deps.sessionStore.history) {
      throw new Error('session store cannot rewind (no truncateTurns/history)');
    }
    const rec = await this.deps.sessionStore.get(agent, sessionId);
    if (!rec) throw new Error(`rewind: session ${input.sessionKey} not found`);
    const nativeId = rec.nativeSessionId || sessionId;

    const turns = await this.deps.sessionStore.history(agent, sessionId).catch(() => [] as UniversalSnapshot[]);
    const cut = turns.findIndex((t) => t.taskId === input.atTaskId);
    if (cut < 0) throw new Error(`rewind point ${input.atTaskId} not found in ${input.sessionKey}`);
    if (cut === turns.length - 1) throw new Error(`rewind point ${input.atTaskId} is the tail — nothing to regenerate`);
    const kept = turns.slice(0, cut + 1);
    // Native rebranch boundary: explicit override → the kept tail's recorded anchor. No anchor =
    // the kept turn never recorded one (e.g. a native-only import) — can't rebranch, so refuse.
    const anchor = input.anchor ?? kept[kept.length - 1]?.anchor ?? null;
    if (!anchor) throw new Error(`rewind: no native anchor at ${input.atTaskId} in ${input.sessionKey}`);

    // Drop the tip from the managed transcript, then stamp the rewind intent. The native store is
    // untouched here — the next dispatch rebranches it at `anchor` via AgentTurnInput.rewind.
    await this.deps.sessionStore.truncateTurns(agent, sessionId, input.atTaskId);
    const last = kept[kept.length - 1];
    rec.model = last?.model ?? rec.model ?? null;
    rec.effort = last?.effort ?? rec.effort ?? null;
    rec.nativeSessionId = nativeId;
    rec.runState = 'completed';
    rec.runDetail = null;
    rec.pendingRewind = { anchor };
    await this.deps.sessionStore.save(rec);
    this.deps.log?.(`[hub] rewound ${input.sessionKey} to ${input.atTaskId} (anchor ${anchor}, kept ${kept.length}/${turns.length} turns)`);
    return { sessionKey: input.sessionKey };
  }

  private enqueue(item: QueuedItem): void {
    const q = this.waiting.get(item.sessionKey) ?? [];
    q.push(item);
    this.waiting.set(item.sessionKey, q);
    this.publishQueued(item.sessionKey);
  }

  // Build and run one turn. The sync prefix (mark active, install the session entry) runs
  // before the first await, so getSnapshot() is valid the instant prompt() returns.
  private async runNow(item: QueuedItem): Promise<void> {
    const { runner, taskId, input, driver, agent, sessionId, sessionKey, workdir, workspacePath, preExisted } = item;
    this.active.set(sessionKey, runner);
    const prev = this.sessions.get(sessionKey);
    const entry: SessionEntry = {
      meta: { sessionKey, agent, title: input.prompt.slice(0, 80), phase: 'streaming', updatedAt: Date.now() },
      // Inherit the prior turn's published state so this turn's FIRST diff correctly resets
      // text/tools/usage/queued on the client — no cross-turn bleed on the same session.
      snapshot: runner.snapshot, lastPublished: prev?.lastPublished ?? emptySnapshot(), seq: prev?.seq ?? 0, runner,
    };
    this.sessions.set(sessionKey, entry);
    this.emitSessionsChanged();

    // Stamp the persisted record as running under THIS process, so runState is authoritative for
    // the whole turn (new AND resumed) and a crash strands an owner pid that boot reconciliation
    // can reap. Best-effort: a store without markRunning just won't be reconcilable.
    await this.deps.sessionStore.markRunning?.(agent, sessionId, { pid: process.pid, startedAt: Date.now() }).catch(() => {});

    // Resolve injection / tools / resume-target at run time so a promoted turn sees the
    // prior turn's native session id and any refreshed credentials/tools.
    const rec = await this.deps.sessionStore.get(agent, sessionId);
    // Fork-on-dispatch: a pendingFork rides every dispatch until a native id lands (a failed
    // first turn keeps the intent, so the retry forks again). Native mode resumes the PARENT's
    // native id with the fork flag; seed mode starts fresh and replays the copied transcript.
    const pendingFork = rec && !rec.nativeSessionId ? rec.pendingFork ?? null : null;
    // A rewind keeps the SAME native id (it resumes+rebranches this session), so — unlike a fork —
    // it is NOT gated on a missing native id. Fork and rewind never coexist on one record.
    const pendingRewind = rec?.pendingRewind ?? null;
    const injection = await this.deps.modelResolver.resolve(agent, { model: input.model, profileId: null }).catch(() => null);
    const model = injection?.model ?? input.model ?? null;
    const effort = input.effort ?? null;
    const tools = await this.collectTools(agent, workdir, workspacePath);
    const pluginParts = await this.pluginSpawn(agent, workdir, 'run', sessionId, model);
    // precedence: ModelResolver (model/creds) -> ToolProvider.env -> plugins (last, so a
    // model-traffic hijack plugin can override the resolver's base URL).
    const spawn = this.mergeSpawn([
      { env: injection?.env, extraArgs: injection?.extraArgs, configOverrides: injection?.configOverrides },
      { env: tools.env },
      ...pluginParts,
    ]);
    // A seed fork opens a brand-new native session, so it takes the first-turn system prompt;
    // a native fork is resume-shaped (the parent's opening turn already carried it).
    const systemPrompt = await this.composeSystemPrompt(agent, workdir, !preExisted || pendingFork?.mode === 'seed');

    let driverSessionId = rec?.nativeSessionId || (input.sessionKey ? sessionId : null);
    let driverFork: { anchor?: string | null } | null = null;
    let driverRewind: { anchor?: string | null } | null = null;
    let driverPrompt = input.prompt;
    if (pendingFork) {
      if (pendingFork.mode === 'native' && pendingFork.parentNativeSessionId) {
        driverSessionId = pendingFork.parentNativeSessionId;
        driverFork = { anchor: pendingFork.anchor };
      } else {
        driverSessionId = null;
        const seed = buildForkSeed(await this.getHistory(sessionKey));
        if (seed) driverPrompt = `${seed}\n\n${input.prompt}`;
      }
    } else if (pendingRewind) {
      // In-place rewind: resume THIS session's own native id but rebranch at the kept boundary
      // (no fork), so the dropped tip leaves the active path and the prompt regenerates from it.
      driverSessionId = rec?.nativeSessionId || sessionId;
      driverRewind = { anchor: pendingRewind.anchor };
    }

    const turnInput: AgentTurnInput = {
      prompt: driverPrompt,
      // Oversized images are downscaled here and in steer() — the two dispatch chokepoints —
      // so every driver (built-in or host-plugged) sends model-safe attachments.
      attachments: await normalizeImageAttachments(input.attachments, this.deps.log),
      sessionId: driverSessionId,
      fork: driverFork,
      rewind: driverRewind,
      workdir,
      model, effort, systemPrompt,
      env: spawn.env,
      extraArgs: spawn.extraArgs,
      configOverrides: spawn.configOverrides,
      extraMcpServers: tools.servers,
      // The managed path's control verb `LoomIO.steer()` can only reach a driver that was
      // launched steer-enabled, so honor the driver's declared capability here — otherwise
      // steer is a silent no-op for steer-capable agents (claude gates registerSteer +
      // --replay-user-messages on this flag). Drivers that don't support steer stay
      // un-steerable; those that steer over their own channel regardless (codex RPC) ignore it.
      steerable: !!driver.capabilities?.steer,
    };

    runner.run(driver, turnInput, input.prompt, model, effort)
      .then(async (result) => {
        await this.deps.sessionStore.recordResult(agent, sessionId, result);
        // The branch materialized natively (recordResult stored its id) — consume the fork
        // intent. A turn that died before a native id landed keeps it, so the retry re-forks.
        if (pendingFork && result.sessionId) {
          try {
            const settled = await this.deps.sessionStore.get(agent, sessionId);
            if (settled?.pendingFork) { settled.pendingFork = null; await this.deps.sessionStore.save(settled); }
          } catch (e: any) { this.deps.log?.(`[hub] pendingFork clear failed ${sessionKey}: ${e?.message || e}`); }
        }
        // A rewind materialized (the turn ran and rebranched the native session) — consume the
        // intent so a normal follow-up prompt appends to the regenerated tip instead of rewinding.
        if (pendingRewind && result.sessionId) {
          try {
            const settled = await this.deps.sessionStore.get(agent, sessionId);
            if (settled?.pendingRewind) { settled.pendingRewind = null; await this.deps.sessionStore.save(settled); }
          } catch (e: any) { this.deps.log?.(`[hub] pendingRewind clear failed ${sessionKey}: ${e?.message || e}`); }
        }
        // Persist the completed turn's final snapshot as a transcript entry. The runner's
        // snapshot is stable once done (a follow-up prompt spawns a fresh runner+snapshot).
        try { await this.deps.sessionStore.appendTurn?.(agent, sessionId, runner.snapshot); }
        catch (e: any) { this.deps.log?.(`[hub] appendTurn failed ${sessionKey}: ${e?.message || e}`); }
      })
      .catch((err) => this.deps.log?.(`[hub] run error ${sessionKey}: ${err?.message || err}`))
      .finally(() => {
        this.runnersByTask.delete(taskId);
        if (this.active.get(sessionKey) === runner) this.active.delete(sessionKey);
        this.promoteNext(sessionKey);   // serial: start the next queued turn (queue survives stop)
        this.emitSessionsChanged();
      });
  }

  private promoteNext(sessionKey: string): void {
    const q = this.waiting.get(sessionKey);
    if (!q || q.length === 0) { this.waiting.delete(sessionKey); return; }
    const next = q.shift()!;
    if (q.length === 0) this.waiting.delete(sessionKey);
    void this.runNow(next);
  }

  private queueView(sessionKey: string): UniversalQueuedTask[] {
    return (this.waiting.get(sessionKey) || []).map(it => ({ taskId: it.taskId, prompt: it.input.prompt }));
  }

  // Re-publish the active turn's snapshot so a queue change (enqueue/drain) reaches subscribers.
  private publishQueued(sessionKey: string): void {
    const entry = this.sessions.get(sessionKey);
    if (entry?.runner) this.onRunnerUpdate(sessionKey, entry.runner.snapshot, entry.runner.currentSeq);
  }

  // MCP servers (ToolProvider + each plugin) PLUS the ToolProvider's session env (previously
  // dropped) — surfaced so the spawn env merge can apply it.
  private async collectTools(agent: string, workdir: string, workspacePath: string): Promise<{ servers: McpServerSpec[]; env?: Record<string, string> }> {
    const servers: McpServerSpec[] = [];
    let env: Record<string, string> | undefined;
    try {
      const base = await this.deps.toolProvider.provideForSession({ agent, workdir, workspacePath });
      servers.push(...base.servers);
      if (base.env && Object.keys(base.env).length) env = base.env;
    } catch (e: any) { this.deps.log?.(`[hub] toolProvider failed: ${e?.message || e}`); }
    for (const plugin of this.deps.plugins) {
      if (!plugin.tools) continue;
      try { servers.push(...(await plugin.tools({ agent, workdir }))); }
      catch (e: any) { this.deps.log?.(`[hub] plugin ${plugin.id} tools failed: ${e?.message || e}`); }
    }
    return { servers, env };
  }

  // Merge ordered spawn contributions: env keys later-wins, extraArgs/configOverrides concatenate.
  // Callers order parts [ModelResolver, ToolProvider.env, ...plugins] so a plugin (e.g. a model-
  // traffic hijack) can override the resolver's base URL. Never touches global process.env.
  private mergeSpawn(parts: Array<SpawnContribution | null | undefined>): { env?: Record<string, string>; extraArgs?: string[]; configOverrides?: string[] } {
    let env: Record<string, string> | undefined;
    const extraArgs: string[] = [];
    const configOverrides: string[] = [];
    for (const p of parts) {
      if (!p) continue;
      if (p.env && Object.keys(p.env).length) env = { ...(env || {}), ...p.env };
      if (p.extraArgs?.length) extraArgs.push(...p.extraArgs);
      if (p.configOverrides?.length) configOverrides.push(...p.configOverrides);
    }
    return { env, extraArgs: extraArgs.length ? extraArgs : undefined, configOverrides: configOverrides.length ? configOverrides : undefined };
  }

  private async pluginSpawn(agent: string, workdir: string, mode: 'run' | 'tui', sessionId: string | null, model: string | null): Promise<SpawnContribution[]> {
    const out: SpawnContribution[] = [];
    for (const plugin of this.deps.plugins) {
      if (!plugin.contributeSpawn) continue;
      try { const c = await plugin.contributeSpawn({ agent, workdir, mode, sessionId, model }); if (c) out.push(c); }
      catch (e: any) { this.deps.log?.(`[hub] plugin ${plugin.id} contributeSpawn failed: ${e?.message || e}`); }
    }
    return out;
  }

  // Final system/developer prompt = the singular SystemPromptBuilder base + each plugin's
  // promptFragment (in registration order), joined. Delivered via AgentTurnInput.systemPrompt,
  // which each driver applies its own way (claude --append-system-prompt / codex / gemini).
  private async composeSystemPrompt(agent: string, workdir: string, isFirstTurn: boolean): Promise<string | undefined> {
    const parts: string[] = [];
    const base = this.deps.systemPromptBuilder.compose({ agent, base: this.deps.systemPromptBase, isFirstTurn });
    if (base && base.trim()) parts.push(base);
    for (const plugin of this.deps.plugins) {
      if (!plugin.promptFragment) continue;
      try { const f = await plugin.promptFragment({ agent, workdir, isFirstTurn }); if (f && f.trim()) parts.push(f); }
      catch (e: any) { this.deps.log?.(`[hub] plugin ${plugin.id} promptFragment failed: ${e?.message || e}`); }
    }
    return parts.length ? parts.join('\n\n') : undefined;
  }

  private onRunnerUpdate(sessionKey: string, snapshot: UniversalSnapshot, _seq: number): void {
    const entry = this.sessions.get(sessionKey);
    if (!entry) return;
    let decorated = snapshot;
    for (const plugin of this.deps.plugins) {
      if (plugin.decorateSnapshot) decorated = plugin.decorateSnapshot(decorated);
    }
    const queued = this.queueView(sessionKey);
    decorated = { ...decorated, queued: queued.length ? queued : undefined };
    entry.snapshot = decorated;
    entry.seq = (this.seqByKey.get(sessionKey) ?? entry.seq ?? 0) + 1;   // monotonic per session across turns
    this.seqByKey.set(sessionKey, entry.seq);
    entry.meta = { ...entry.meta, phase: decorated.phase, updatedAt: decorated.updatedAt, title: entry.meta.title || decorated.prompt?.slice(0, 80) || null };
    const patch = diffSnapshot(entry.lastPublished, decorated);
    entry.lastPublished = JSON.parse(JSON.stringify(decorated));
    for (const cb of this.updateSubs) {
      try { cb(sessionKey, decorated, patch, entry.seq); } catch { /* isolate subscriber */ }
    }
    if (decorated.phase === 'done') this.emitSessionsChanged();
  }

  // ---- control verbs ----
  stop(sessionKey: string): boolean {
    const r = this.sessions.get(sessionKey)?.runner;
    if (!r) return false;
    r.stop();
    return true;
  }
  async steer(taskId: string, prompt: string, attachments?: string[]): Promise<boolean> {
    const r = this.runnersByTask.get(taskId);
    return r ? r.steer(prompt, await normalizeImageAttachments(attachments, this.deps.log)) : false;
  }
  interact(promptId: string, action: 'select' | 'text' | 'skip' | 'cancel', value?: string): boolean {
    for (const r of this.runnersByTask.values()) {
      if (r.interact(promptId, action, value)) return true;
    }
    return false;
  }

  // ---- subscriptions & queries ----
  subscribe(cb: (k: string, s: UniversalSnapshot, p: SnapshotPatch, seq: number) => void): () => void {
    this.updateSubs.add(cb);
    return () => this.updateSubs.delete(cb);
  }
  onSessionsChanged(cb: (s: SessionMeta[]) => void): () => void {
    this.sessionsSubs.add(cb);
    return () => this.sessionsSubs.delete(cb);
  }
  private emitSessionsChanged(): void {
    const list = this.listSessions();
    for (const cb of this.sessionsSubs) { try { cb(list); } catch { /* isolate */ } }
  }
  listSessions(): SessionMeta[] {
    return [...this.sessions.values()].map(e => e.meta).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }
  getSnapshot(sessionKey: string): { snapshot: UniversalSnapshot; seq: number } | null {
    const e = this.sessions.get(sessionKey);
    return e ? { snapshot: e.snapshot, seq: e.seq } : null;
  }
  async getHistory(sessionKey: string): Promise<UniversalSnapshot[]> {
    const { agent, sessionId } = splitSessionKey(sessionKey);
    if (!agent || !this.deps.sessionStore.history) return [];
    try { return await this.deps.sessionStore.history(agent, sessionId); }
    catch (e: any) { this.deps.log?.(`[hub] history failed ${sessionKey}: ${e?.message || e}`); return []; }
  }
}
