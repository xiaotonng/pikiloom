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

export interface LoomIO {
  // inbound (terminal -> kernel)
  prompt(input: PromptInput): Promise<{ sessionKey: string; taskId: string }>;
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

// A plugin contributes tools (MCP/skills) and/or augments snapshots. Management UX
// (catalog, health, OAuth, install) stays in the app — the kernel only wires the
// per-session tool contribution.
export interface Plugin {
  readonly id: string;
  tools?(opts: { agent: string; workdir: string }): McpServerSpec[] | Promise<McpServerSpec[]>;
  decorateSnapshot?(snapshot: UniversalSnapshot): UniversalSnapshot;
}
