import type {
  UniversalSnapshot, SnapshotPatch, SessionMeta,
  AgentInfo, ModelDescriptor, EffortOption, ToolDescriptor, SkillDescriptor,
} from '../protocol/index.js';
import type { McpServerSpec } from './driver.js';

// The single seam every entrypoint binds to. IM channels and the Web/tunnel terminal
// are ALL just `Surface`s over the same `LoomIO`. The kernel drives sessions and
// publishes snapshots; a terminal translates an external surface to/from this API.

export interface PromptInput {
  prompt: string;
  agent?: string;
  sessionKey?: string;
  workdir?: string;
  model?: string | null;
  effort?: string | null;
  attachments?: string[];
}

// Branch a session at a turn boundary into a NEW session; the source is never mutated.
export interface ForkSessionInput {
  fromSessionKey: string;
  // Last KEPT turn (kernel taskId from the parent's transcript); omit/null = keep everything
  // up to the parent's current tail.
  atTaskId?: string | null;
  // Explicit agent-native keep-boundary override (same terms as AgentTurnInput.fork.anchor).
  // When absent the hub resolves it from the kept turn's recorded anchor, else from the
  // driver's resolveNativeAnchor (tail cuts), else falls back to a seed fork.
  anchor?: string | null;
  title?: string | null;
}

export interface LoomIO {
  // inbound (terminal -> kernel)
  prompt(input: PromptInput): Promise<{ sessionKey: string; taskId: string }>;
  // Create a new managed session branched off `fromSessionKey` at a turn boundary: copies
  // the kept transcript prefix, stamps fork lineage, and defers the native-side branch to
  // the first prompt() on the returned key (fork-on-dispatch). The parent session — managed
  // record, transcript, and native store alike — is never mutated.
  forkSession(input: ForkSessionInput): Promise<{ sessionKey: string }>;
  stop(sessionKey: string): boolean;
  steer(taskId: string, prompt: string, attachments?: string[]): Promise<boolean>;
  interact(promptId: string, action: 'select' | 'text' | 'skip' | 'cancel', value?: string): boolean;

  // outbound (kernel -> terminal)
  subscribe(cb: (sessionKey: string, snapshot: UniversalSnapshot, patch: SnapshotPatch, seq: number) => void): () => void;
  onSessionsChanged(cb: (sessions: SessionMeta[]) => void): () => void;

  // queries
  listSessions(): SessionMeta[];
  getSnapshot(sessionKey: string): { snapshot: UniversalSnapshot; seq: number } | null;
  getHistory(sessionKey: string): Promise<UniversalSnapshot[]>; // past turns (transcript), one final snapshot per completed turn
  listAgents(): string[];
  // discovery: agent capabilities derive from the driver registry; models/effort/tools/
  // skills come from the Catalog port as opaque descriptors. Lets a terminal build its
  // composer (pickers/toggles) without hardcoding any concrete agent/model/tool.
  listAgentInfo(): AgentInfo[];
  listModels(agent: string): Promise<ModelDescriptor[]>;
  listEffort(agent: string, model?: string | null): Promise<EffortOption[]>;
  listTools(agent: string, workdir?: string): Promise<ToolDescriptor[]>;
  listSkills(agent: string, workdir?: string): Promise<SkillDescriptor[]>;
}

export interface SurfaceCapabilities {
  editMessages?: boolean;
  images?: boolean;
  buttons?: boolean;
  tunnel?: boolean;
}

// Raw-PTY handle (PtyBridge satisfies this structurally) — the Lane R seam. Kept OFF
// LoomIO so the structured contract stays pure; a Surface that serves the raw-PTY
// surface receives a TuiHost as the optional 2nd arg to start().
export interface PtyHandle {
  onData(cb: (data: string) => void): () => void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): () => void;
  readonly pid: number;
}
export interface TuiHost {
  openTui(opts: { agent?: string; workdir?: string; model?: string | null; sessionId?: string | null; cols?: number; rows?: number }): Promise<PtyHandle>;
}

export interface Surface {
  readonly id: string;
  readonly capabilities?: SurfaceCapabilities;
  start(io: LoomIO, host?: TuiHost): Promise<void>;   // host carries the raw-PTY (Lane R) opener
  stop(): Promise<void>;
}

// What a plugin contributes to ONE spawned agent turn/TUI, beyond MCP tools: env vars,
// verbatim CLI flags, and codex `-c key=value` config overrides. The kernel merges these
// per-spawn (never mutating global process.env) so cross-cutting concerns — e.g. pointing
// an agent's model base URL at a local proxy — register here instead of reaching for the
// global environment. env/extraArgs/configOverrides are the full vocabulary for
// parameterizing a spawned agent CLI.
export interface SpawnContribution {
  env?: Record<string, string>;
  extraArgs?: string[];
  configOverrides?: string[];
}

// A plugin is the registration unit for everything ONE capability adds to a session:
// MCP tools, an init prompt fragment (how to use those tools / behavior guidance), per-spawn
// parameters (env/args/config), and snapshot decoration. The kernel composes all plugins'
// contributions deterministically (registration order; plugins merge AFTER the singular
// ModelResolver/SystemPromptBuilder, so a plugin can override them). Management UX
// (catalog, health, OAuth, install) stays in the app.
export interface Plugin {
  readonly id: string;
  tools?(opts: { agent: string; workdir: string }): McpServerSpec[] | Promise<McpServerSpec[]>;
  // First-turn (or every-turn) system/developer prompt fragment for this capability —
  // composed onto the base SystemPromptBuilder output and delivered via the agent's native
  // mechanism (claude --append-system-prompt / codex developerInstructions / gemini system).
  promptFragment?(opts: { agent: string; workdir: string; isFirstTurn: boolean }): string | null | undefined | Promise<string | null | undefined>;
  // Per-spawn env/args/config for this capability. `mode` distinguishes the structured run()
  // rail from the raw-PTY tui() rail (a redirect knob may differ, e.g. env vs launch arg).
  contributeSpawn?(opts: { agent: string; workdir: string; mode: 'run' | 'tui'; sessionId?: string | null; model?: string | null }): SpawnContribution | null | undefined | Promise<SpawnContribution | null | undefined>;
  decorateSnapshot?(snapshot: UniversalSnapshot): UniversalSnapshot;
}
