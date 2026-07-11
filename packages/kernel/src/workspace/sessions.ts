import path from 'node:path';
import type { AgentDriver, NativeSessionInfo } from '../contracts/driver.js';
import type { SessionStore, CoreSessionRecord } from '../contracts/ports.js';
import { makeSessionKey, splitSessionKey } from '../protocol/index.js';
import type { LoomScope } from './paths.js';

// ---- SessionsManager: the unified, searchable session read-model ----
//
// Merges the kernel's MANAGED sessions (SessionStore, scoped per workspace by the cwd they
// ran in) with each agent's NATIVE sessions (driver.listNativeSessions) into one list. This
// is the "全局控制会话列表 + 每个工作区下的会话列表" capability: a global view (all managed,
// any workdir) and a per-workspace view (this folder's managed + the agents' own sessions
// for this folder), plus search across both — all owned by the kernel.

export type SessionSource = 'managed' | 'native';

export interface ManagedSessionInfo {
  sessionKey: string;          // `${agent}:${sessionId}`
  agent: string;
  sessionId: string;
  title: string | null;
  preview: string | null;
  workdir: string | null;
  model: string | null;
  effort: string | null;
  runState: 'running' | 'completed' | 'incomplete' | null;
  running: boolean;
  source: SessionSource;
  createdAt: string | null;
  updatedAt: string | null;
  messageCount?: number | null;
}

export interface ListSessionsOptions {
  /**
   * 'workspace' = only sessions for `workdir` (managed-with-matching-cwd + native for the cwd).
   * 'global'    = all managed sessions across every workdir, plus native for `workdir`.
   * 'all'       = global, the default.
   */
  scope?: LoomScope | 'all';
  workdir?: string;
  agent?: string;
  includeNative?: boolean;     // default true
  limit?: number;
  /** Skip this many of the most-recent rows before taking `limit` — for paginated "load more". */
  offset?: number;
}

export interface SearchSessionsOptions extends ListSessionsOptions {
  query: string;
}

export interface SessionsManagerDeps {
  store: SessionStore;
  drivers: () => Map<string, AgentDriver>;
  defaultWorkdir: string;
  log?: (msg: string) => void;
}

function ts(iso: string | null | undefined): number {
  if (!iso) return 0;
  const n = Date.parse(iso);
  return Number.isNaN(n) ? 0 : n;
}

function newer(a: string | null, b: string | null): string | null {
  return ts(b) > ts(a) ? b : a;
}

function managedToInfo(agent: string, rec: CoreSessionRecord): ManagedSessionInfo {
  return {
    sessionKey: makeSessionKey(agent, rec.sessionId),
    agent,
    sessionId: rec.sessionId,
    title: rec.title ?? null,
    preview: rec.preview ?? null,
    workdir: rec.workdir ?? null,
    model: rec.model ?? null,
    effort: rec.effort ?? null,
    runState: rec.runState ?? null,
    running: rec.runState === 'running',
    source: 'managed',
    createdAt: rec.createdAt ?? null,
    updatedAt: rec.updatedAt ?? null,
    messageCount: null, // managed records don't track a turn count; native rows carry the head-approx one
  };
}

function nativeToInfo(agent: string, n: NativeSessionInfo): ManagedSessionInfo {
  return {
    sessionKey: makeSessionKey(agent, n.sessionId),
    agent,
    sessionId: n.sessionId,
    title: n.title,
    preview: n.preview,
    workdir: n.cwd,
    model: n.model,
    effort: n.effort ?? null,
    runState: n.running ? 'running' : 'completed',
    running: n.running,
    source: 'native',
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
    messageCount: n.messageCount ?? null,
  };
}

export class SessionsManager {
  constructor(private readonly deps: SessionsManagerDeps) {}

  async list(opts: ListSessionsOptions = {}): Promise<ManagedSessionInfo[]> {
    const scope = opts.scope ?? 'all';
    const workdir = path.resolve(opts.workdir || this.deps.defaultWorkdir);
    const includeNative = opts.includeNative !== false;
    const drivers = this.deps.drivers();
    const agentIds = opts.agent ? [opts.agent] : [...drivers.keys()];
    const byKey = new Map<string, ManagedSessionInfo>();
    // Native discovery must surface enough of the newest rows to satisfy offset+limit paging, since
    // the final page is sliced AFTER merging managed + native. `undefined` limit = discover all.
    const offset = Math.max(0, opts.offset ?? 0);
    const nativeLimit = typeof opts.limit === 'number' ? offset + opts.limit : undefined;

    // Native session keys a managed record already represents because the agent minted a DIVERGENT
    // transcript id (rec.sessionId ≠ rec.nativeSessionId — the new-chat case). Those native rows are
    // dropped below so they don't double up with their managed row. Deduping HERE (before paging) keeps
    // page sizes and "has more" correct — doing it in a host wrapper after slicing shrinks pages.
    const coveredNativeKeys = new Set<string>();

    // Managed sessions (the kernel's own store).
    for (const agent of agentIds) {
      let records: CoreSessionRecord[] = [];
      try { records = await this.deps.store.list(agent); }
      catch (e: any) { this.deps.log?.(`[sessions] store.list(${agent}) failed: ${e?.message || e}`); }
      for (const rec of records) {
        if (rec.nativeSessionId && rec.nativeSessionId !== rec.sessionId) {
          coveredNativeKeys.add(makeSessionKey(agent, rec.nativeSessionId));
        }
        if (scope === 'workspace') {
          if (!rec.workdir || path.resolve(rec.workdir) !== workdir) continue;
        }
        byKey.set(makeSessionKey(agent, rec.sessionId), managedToInfo(agent, rec));
      }
    }

    // Native sessions (the agents' own stores) — inherently per-workdir.
    if (includeNative) {
      for (const agent of agentIds) {
        const driver = drivers.get(agent);
        if (!driver?.listNativeSessions) continue;
        let natives: NativeSessionInfo[] = [];
        try { natives = await driver.listNativeSessions({ workdir, limit: nativeLimit }); }
        catch (e: any) { this.deps.log?.(`[sessions] ${agent}.listNativeSessions failed: ${e?.message || e}`); }
        for (const n of natives) {
          const key = makeSessionKey(agent, n.sessionId);
          if (coveredNativeKeys.has(key)) continue; // a managed record already represents this transcript
          const existing = byKey.get(key);
          if (existing) {
            // Same identity discovered both ways: managed record wins, but adopt the newer
            // timestamp and backfill any fields the managed record never captured.
            existing.updatedAt = newer(existing.updatedAt, n.updatedAt);
            existing.preview = existing.preview ?? n.preview;
            existing.title = existing.title ?? n.title;
            existing.model = existing.model ?? n.model;
            existing.running = existing.running || n.running;
          } else {
            byKey.set(key, nativeToInfo(agent, n));
          }
        }
      }
    }

    const out = [...byKey.values()].sort((a, b) => ts(b.updatedAt) - ts(a.updatedAt));
    return typeof opts.limit === 'number' ? out.slice(offset, offset + opts.limit) : offset ? out.slice(offset) : out;
  }

  async search(opts: SearchSessionsOptions): Promise<ManagedSessionInfo[]> {
    const q = (opts.query || '').trim().toLowerCase();
    const all = await this.list({ ...opts, limit: undefined, offset: 0 });
    const matched = q
      ? all.filter(s => [s.title, s.preview, s.sessionId, s.model, s.agent].some(v => v != null && v.toLowerCase().includes(q)))
      : all;
    const offset = Math.max(0, opts.offset ?? 0);
    return typeof opts.limit === 'number' ? matched.slice(offset, offset + opts.limit) : offset ? matched.slice(offset) : matched;
  }

  async get(sessionKey: string, opts: { workdir?: string } = {}): Promise<ManagedSessionInfo | null> {
    const { agent, sessionId } = splitSessionKey(sessionKey);
    if (!agent) return null;
    const rec = await this.deps.store.get(agent, sessionId).catch(() => null);
    if (rec) return managedToInfo(agent, rec);
    const list = await this.list({ agent, workdir: opts.workdir });
    return list.find(s => s.sessionKey === sessionKey) ?? null;
  }
}
