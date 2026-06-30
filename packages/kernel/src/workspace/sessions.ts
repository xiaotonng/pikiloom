import path from 'node:path';
import type { AgentDriver, NativeSessionInfo } from '../contracts/driver.js';
import type { SessionStore, CoreSessionRecord } from '../contracts/ports.js';
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

function splitKey(sessionKey: string): { agent: string; sessionId: string } {
  const i = sessionKey.indexOf(':');
  return i < 0 ? { agent: '', sessionId: sessionKey } : { agent: sessionKey.slice(0, i), sessionId: sessionKey.slice(i + 1) };
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
    sessionKey: `${agent}:${rec.sessionId}`,
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
  };
}

function nativeToInfo(agent: string, n: NativeSessionInfo): ManagedSessionInfo {
  return {
    sessionKey: `${agent}:${n.sessionId}`,
    agent,
    sessionId: n.sessionId,
    title: n.title,
    preview: n.preview,
    workdir: n.cwd,
    model: n.model,
    effort: null,
    runState: n.running ? 'running' : 'completed',
    running: n.running,
    source: 'native',
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
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

    // Managed sessions (the kernel's own store).
    for (const agent of agentIds) {
      let records: CoreSessionRecord[] = [];
      try { records = await this.deps.store.list(agent); }
      catch (e: any) { this.deps.log?.(`[sessions] store.list(${agent}) failed: ${e?.message || e}`); }
      for (const rec of records) {
        if (scope === 'workspace') {
          if (!rec.workdir || path.resolve(rec.workdir) !== workdir) continue;
        }
        byKey.set(`${agent}:${rec.sessionId}`, managedToInfo(agent, rec));
      }
    }

    // Native sessions (the agents' own stores) — inherently per-workdir.
    if (includeNative) {
      for (const agent of agentIds) {
        const driver = drivers.get(agent);
        if (!driver?.listNativeSessions) continue;
        let natives: NativeSessionInfo[] = [];
        try { natives = await driver.listNativeSessions({ workdir, limit: opts.limit }); }
        catch (e: any) { this.deps.log?.(`[sessions] ${agent}.listNativeSessions failed: ${e?.message || e}`); }
        for (const n of natives) {
          const key = `${agent}:${n.sessionId}`;
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
    return typeof opts.limit === 'number' ? out.slice(0, Math.max(0, opts.limit)) : out;
  }

  async search(opts: SearchSessionsOptions): Promise<ManagedSessionInfo[]> {
    const q = (opts.query || '').trim().toLowerCase();
    const all = await this.list({ ...opts, limit: undefined });
    const matched = q
      ? all.filter(s => [s.title, s.preview, s.sessionId, s.model, s.agent].some(v => v != null && v.toLowerCase().includes(q)))
      : all;
    return typeof opts.limit === 'number' ? matched.slice(0, Math.max(0, opts.limit)) : matched;
  }

  async get(sessionKey: string, opts: { workdir?: string } = {}): Promise<ManagedSessionInfo | null> {
    const { agent, sessionId } = splitKey(sessionKey);
    if (!agent) return null;
    const rec = await this.deps.store.get(agent, sessionId).catch(() => null);
    if (rec) return managedToInfo(agent, rec);
    const list = await this.list({ agent, workdir: opts.workdir });
    return list.find(s => s.sessionKey === sessionKey) ?? null;
  }
}
