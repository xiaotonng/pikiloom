import type {
  UniversalInteraction, UniversalSnapshot,
  ModelDescriptor, EffortOption, ToolDescriptor, SkillDescriptor,
} from '../protocol/index.js';
import type { McpServerSpec, DriverResult } from './driver.js';

// Side ports: everything environmental that the kernel reaches through an interface,
// so a consuming app can swap storage / credentials / tools / prompts without forking.
// Every port ships a default impl (see ../ports/defaults.ts) so `createLoom()` runs
// with zero wiring.

export interface CoreSessionRecord {
  agent: string;
  sessionId: string;            // stable kernel id (== sessionKey suffix)
  nativeSessionId?: string | null; // agent-native id for resume (e.g. claude's own id)
  workspacePath: string;
  workdir?: string | null;      // the cwd the turn ran in — scopes managed sessions per workspace
  createdAt: string;
  updatedAt: string;
  title?: string | null;
  preview?: string | null;      // head of the latest assistant text (for list rendering)
  model?: string | null;
  effort?: string | null;
  runState?: 'running' | 'completed' | 'incomplete';
  runDetail?: string | null;
  // Liveness ownership for a 'running' turn: the OS pid of the process driving it, plus when it
  // started. A store shared by multiple processes (e.g. a dev + prod app on the same home dir)
  // uses this to tell a crashed orphan (owner pid dead) apart from a turn live in another
  // process (owner pid alive) during boot reconciliation — see SessionStore.reconcileRunning.
  runPid?: number | null;
  runStartedAt?: number | null;
  // Fork lineage: set once at Hub.forkSession and never cleared — consumers use it to label
  // the branch. `taskId` is the last KEPT parent turn (null = forked at the parent's tail).
  forkedFrom?: { sessionKey: string; taskId?: string | null } | null;
  // Fork intent, pending until the first dispatch materializes the branch (then cleared).
  // mode 'native': resume the parent's native id with AgentTurnInput.fork (fork-capable
  // drivers). mode 'seed': start a fresh native session and replay the copied transcript
  // as a context seed (any driver). `anchor` is pinned at fork time so the branch is
  // immune to the parent continuing to run afterwards.
  pendingFork?: { parentNativeSessionId: string | null; anchor: string | null; mode: 'native' | 'seed' } | null;
  // Rewind intent (in-place tip regeneration), pending until the next dispatch consumes it (then
  // cleared). Unlike a fork it keeps the SAME session/native id: the dispatch resumes the native
  // session at `anchor` (the last KEPT turn's boundary) WITHOUT forking, rebranching in place so
  // the dropped tip leaves the active context. Only drivers with capabilities.rewind honor it.
  pendingRewind?: { anchor: string | null } | null;
}

export interface SessionStore {
  ensure(agent: string, opts: { sessionId?: string | null; title?: string | null; workdir: string }): Promise<{ sessionId: string; workspacePath: string }>;
  get(agent: string, sessionId: string): Promise<CoreSessionRecord | null>;
  save(record: CoreSessionRecord): Promise<void>;
  list(agent: string, opts?: { limit?: number }): Promise<CoreSessionRecord[]>;
  recordResult(agent: string, sessionId: string, result: DriverResult): Promise<void>;
  // Stamp a session as actively running under the current process (runState:'running' + owner
  // pid). Called at turn start for BOTH new and resumed sessions, so the persisted runState is
  // authoritative for the whole turn — not just its opening. Optional: a store that skips it
  // simply won't be eligible for orphan reconciliation.
  markRunning?(agent: string, sessionId: string, owner: { pid: number; startedAt: number }): Promise<void>;
  // Boot-time repair: flip every record stranded at runState:'running' whose owner pid is dead
  // (isAlive(pid) === false) to 'incomplete'. Records with a live owner or no recorded pid are
  // left untouched, so this is safe to run against a store shared by several live processes.
  // Returns the number of records repaired. Optional.
  reconcileRunning?(isAlive: (pid: number) => boolean): Promise<number>;
  // Transcript: append the final snapshot of a completed turn, and read the ordered
  // history back. Optional so a minimal store can opt out (history() then yields []).
  appendTurn?(agent: string, sessionId: string, turn: UniversalSnapshot): Promise<void>;
  history?(agent: string, sessionId: string): Promise<UniversalSnapshot[]>;
  // Drop transcript turns AFTER `throughTaskId` (inclusive keep), rewriting the store to the kept
  // prefix — the in-place counterpart to appendTurn, used by Hub.rewindSession to regenerate a
  // tip. `throughTaskId` null clears the whole transcript; an unknown id is a no-op (never wipes
  // history on a stale cut). Optional so a minimal store can opt out (rewind then rejects).
  truncateTurns?(agent: string, sessionId: string, throughTaskId: string | null): Promise<void>;
}

export interface ModelInjection {
  model?: string | null;
  env?: Record<string, string>;
  extraArgs?: string[];          // verbatim CLI flags the provider injection resolved (BYOK)
  configOverrides?: string[];    // codex `-c key=value` provider routing (BYOK)
  providerName?: string | null;
  contextWindow?: number | null;
}

export interface ModelResolver {
  // null => native CLI login (no injection)
  resolve(agent: string, opts: { model?: string | null; profileId?: string | null }): Promise<ModelInjection | null>;
}

export interface ToolProvider {
  provideForSession(opts: { agent: string; workdir: string; workspacePath: string }): Promise<{ servers: McpServerSpec[]; env?: Record<string, string> }>;
}

export interface SystemPromptBuilder {
  // compose the first-turn system/developer prompt for an entrypoint.
  compose(opts: { agent: string; base?: string; isFirstTurn: boolean }): string | undefined;
}

// Resolves a human-in-the-loop interaction. The kernel owns the pure prompt lifecycle;
// this port is the async resolver the runtime awaits (a terminal / app supplies it).
export interface InteractionHandler {
  askUser(interaction: UniversalInteraction): Promise<Record<string, string[]> | null>;
}

// ---- Catalog: discovery of WHAT is available, as opaque descriptors ----
// So an upper app can build its composer (model/effort/tool/skill pickers) without
// hardcoding any of them. The app supplies these from its own SSOT (e.g. pikiloom's
// runtime-config / catalog/* / mcp / skills); the kernel bakes in zero model knowledge.
// Per-agent capabilities are NOT here — they are derived from the driver registry.

export interface Catalog {
  listModels(opts: { agent: string }): Promise<ModelDescriptor[]>;
  listEffort(opts: { agent: string; model?: string | null }): Promise<EffortOption[]>;
  listTools(opts: { agent: string; workdir: string }): Promise<ToolDescriptor[]>;
  listSkills(opts: { agent: string; workdir: string }): Promise<SkillDescriptor[]>;
}
