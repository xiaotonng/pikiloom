import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import type {
  UniversalSnapshot,
  ModelDescriptor, EffortOption, ToolDescriptor, SkillDescriptor,
} from '../protocol/index.js';
import type {
  SessionStore, CoreSessionRecord, ModelResolver, ToolProvider,
  SystemPromptBuilder, InteractionHandler, Catalog,
} from '../contracts/ports.js';

// ---- FsSessionStore: the default local persistence + workspace backend ----

export class FsSessionStore implements SessionStore {
  constructor(private readonly baseDir: string) {}

  private dir(agent: string, sessionId: string): string {
    return path.join(this.baseDir, agent, sessionId);
  }
  private recordPath(agent: string, sessionId: string): string {
    return path.join(this.dir(agent, sessionId), 'record.json');
  }
  private turnsPath(agent: string, sessionId: string): string {
    return path.join(this.dir(agent, sessionId), 'turns.jsonl');
  }

  async ensure(agent: string, opts: { sessionId?: string | null; title?: string | null; workdir: string }): Promise<{ sessionId: string; workspacePath: string }> {
    const sessionId = (opts.sessionId && opts.sessionId.trim()) || randomUUID();
    const workspacePath = path.join(this.dir(agent, sessionId), 'workspace');
    fs.mkdirSync(workspacePath, { recursive: true });
    const existing = await this.get(agent, sessionId);
    if (!existing) {
      const now = new Date().toISOString();
      await this.save({
        agent, sessionId, workspacePath, workdir: path.resolve(opts.workdir),
        createdAt: now, updatedAt: now,
        title: opts.title ?? null, runState: 'running', runDetail: null,
      });
    } else if (!existing.workdir) {
      existing.workdir = path.resolve(opts.workdir);
      await this.save(existing);
    }
    return { sessionId, workspacePath };
  }

  async get(agent: string, sessionId: string): Promise<CoreSessionRecord | null> {
    try {
      const raw = fs.readFileSync(this.recordPath(agent, sessionId), 'utf8');
      return JSON.parse(raw) as CoreSessionRecord;
    } catch {
      return null;
    }
  }

  async save(record: CoreSessionRecord): Promise<void> {
    const p = this.recordPath(record.agent, record.sessionId);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ ...record, updatedAt: new Date().toISOString() }, null, 2));
  }

  async list(agent: string, opts?: { limit?: number }): Promise<CoreSessionRecord[]> {
    const agentDir = path.join(this.baseDir, agent);
    let ids: string[] = [];
    try { ids = fs.readdirSync(agentDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); } catch { return []; }
    const records: CoreSessionRecord[] = [];
    for (const id of ids) {
      const rec = await this.get(agent, id);
      if (rec) records.push(rec);
    }
    records.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    return opts?.limit ? records.slice(0, opts.limit) : records;
  }

  async recordResult(agent: string, sessionId: string, result: { ok: boolean; error?: string | null; text?: string; sessionId?: string | null }): Promise<void> {
    const rec = await this.get(agent, sessionId);
    if (!rec) return;
    rec.runState = result.ok ? 'completed' : 'incomplete';
    rec.runDetail = result.error ?? null;
    rec.runPid = null;            // turn is over — drop the owner so reconciliation ignores it
    if (result.sessionId) rec.nativeSessionId = result.sessionId;
    if (result.text && !rec.title) rec.title = result.text.slice(0, 80);
    if (result.text) rec.preview = result.text.replace(/\s+/g, ' ').trim().slice(0, 200) || rec.preview || null;
    await this.save(rec);
  }

  async markRunning(agent: string, sessionId: string, owner: { pid: number; startedAt: number }): Promise<void> {
    const rec = await this.get(agent, sessionId);
    if (!rec) return;
    rec.runState = 'running';
    rec.runDetail = null;
    rec.runPid = owner.pid;
    rec.runStartedAt = owner.startedAt;
    await this.save(rec);
  }

  async reconcileRunning(isAlive: (pid: number) => boolean): Promise<number> {
    let agents: string[] = [];
    try { agents = fs.readdirSync(this.baseDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); } catch { return 0; }
    let repaired = 0;
    for (const agent of agents) {
      for (const rec of await this.list(agent)) {
        if (rec.runState !== 'running') continue;
        // Only reap a KNOWN-dead owner. No pid (legacy record) or a live pid (possibly a turn
        // running in another process against this shared store) is left alone — never clobber a
        // turn that might still be live elsewhere.
        if (typeof rec.runPid !== 'number' || isAlive(rec.runPid)) continue;
        rec.runState = 'incomplete';
        rec.runDetail = rec.runDetail || 'interrupted: owner process exited';
        rec.runPid = null;
        await this.save(rec);
        repaired++;
      }
    }
    return repaired;
  }

  async appendTurn(agent: string, sessionId: string, turn: UniversalSnapshot): Promise<void> {
    const p = this.turnsPath(agent, sessionId);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify(turn) + '\n');
  }

  async history(agent: string, sessionId: string): Promise<UniversalSnapshot[]> {
    let raw: string;
    try { raw = fs.readFileSync(this.turnsPath(agent, sessionId), 'utf8'); } catch { return []; }
    const out: UniversalSnapshot[] = [];
    for (const line of raw.split('\n')) {
      const t = line.trim(); if (!t) continue;
      try { out.push(JSON.parse(t) as UniversalSnapshot); } catch { /* skip a corrupt/partial line */ }
    }
    return out;
  }
}

/**
 * Is a pid currently a live process? `signal 0` probes without delivering a signal: ESRCH =>
 * no such process (dead); EPERM => alive but owned by someone we can't signal (treat as alive).
 * The conservative bias (unknown => alive) is deliberate — reconciliation must never reap a turn
 * that might still be running.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === 'EPERM'; }
}

export function defaultBaseDir(appNamespace: string): string {
  return path.join(os.homedir(), `.${appNamespace}`, 'sessions');
}

// ---- Trivial defaults: native login, no tools, passthrough prompt, auto-cancel HITL ----

export class NullModelResolver implements ModelResolver {
  async resolve(): Promise<null> { return null; }
}

export class NoopToolProvider implements ToolProvider {
  async provideForSession(): Promise<{ servers: []; env?: Record<string, string> }> { return { servers: [] }; }
}

export class PassthroughSystemPromptBuilder implements SystemPromptBuilder {
  compose(opts: { agent: string; base?: string; isFirstTurn: boolean }): string | undefined {
    return opts.isFirstTurn ? opts.base : undefined;
  }
}

// Headless HITL resolver: cancel every interaction immediately (empty answers).
export class AutoCancelInteractionHandler implements InteractionHandler {
  async askUser(): Promise<Record<string, string[]>> { return {}; }
}

// Default HITL resolver: defer to a terminal. Returns null so the interaction stays
// pending in the snapshot until a terminal calls interact() — the right default for an
// IM/Web-attached app. Headless callers opt into AutoCancelInteractionHandler instead.
export class DeferToTerminalInteractionHandler implements InteractionHandler {
  async askUser(): Promise<null> { return null; }
}

// Default catalog: empty. The kernel knows zero models/effort/tools/skills; an app
// supplies them via its own Catalog impl. Agent capabilities come from the driver registry.
export class NoopCatalog implements Catalog {
  async listModels(): Promise<ModelDescriptor[]> { return []; }
  async listEffort(): Promise<EffortOption[]> { return []; }
  async listTools(): Promise<ToolDescriptor[]> { return []; }
  async listSkills(): Promise<SkillDescriptor[]> { return []; }
}
