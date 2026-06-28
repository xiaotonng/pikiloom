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
  createdAt: string;
  updatedAt: string;
  title?: string | null;
  model?: string | null;
  effort?: string | null;
  runState?: 'running' | 'completed' | 'incomplete';
  runDetail?: string | null;
}

export interface SessionStore {
  ensure(agent: string, opts: { sessionId?: string | null; title?: string | null; workdir: string }): Promise<{ sessionId: string; workspacePath: string }>;
  get(agent: string, sessionId: string): Promise<CoreSessionRecord | null>;
  save(record: CoreSessionRecord): Promise<void>;
  list(agent: string, opts?: { limit?: number }): Promise<CoreSessionRecord[]>;
  recordResult(agent: string, sessionId: string, result: DriverResult): Promise<void>;
  // Transcript: append the final snapshot of a completed turn, and read the ordered
  // history back. Optional so a minimal store can opt out (history() then yields []).
  appendTurn?(agent: string, sessionId: string, turn: UniversalSnapshot): Promise<void>;
  history?(agent: string, sessionId: string): Promise<UniversalSnapshot[]>;
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
