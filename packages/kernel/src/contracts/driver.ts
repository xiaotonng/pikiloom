import type {
  UniversalToolCall, UniversalPlan, UniversalUsage,
  UniversalInteraction, UniversalArtifact, UniversalSubAgent,
} from '../protocol/index.js';

// The agent axis (the "下层" — Claude / Codex / Gemini / ACP). A driver knows how to
// spawn ONE turn of ONE agent CLI and emit normalized events. It knows nothing about
// IM, web, queues, or persistence — those live above it.

export interface AgentTurnInput {
  prompt: string;
  attachments?: string[];
  sessionId?: string | null;      // resume target (null/undefined = fresh)
  workdir: string;
  model?: string | null;
  effort?: string | null;
  systemPrompt?: string;          // composed first-turn system/developer prompt
  env?: Record<string, string>;   // injected by ModelResolver (BYOK base url / key / etc.)
  extraMcpServers?: McpServerSpec[];
  mcpConfigPath?: string | null;  // path to an agent-native MCP config file (Claude --mcp-config)
  permissionMode?: string | null; // agent-native permission mode (Claude --permission-mode); must be carried so the kernel path preserves bypass/accept-edits
  extraArgs?: string[];           // verbatim passthrough flags the app already resolved
  configOverrides?: string[];     // codex `-c key=value` overrides (BYOK provider routing); carried so the kernel path keeps BYOK
  fullAccess?: boolean;           // codex full-access (approvalPolicy=never, sandbox=danger-full-access)
  steerable?: boolean;            // enable mid-turn steer (Claude stream-json input mode)
}

export interface McpServerSpec {
  name: string;
  type?: 'stdio' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export type DriverEvent =
  | { type: 'session'; sessionId: string }
  | { type: 'text'; delta: string }
  | { type: 'reasoning'; delta: string }
  | { type: 'tool'; call: UniversalToolCall }
  | { type: 'plan'; plan: UniversalPlan }
  | { type: 'subagent'; subagent: UniversalSubAgent }
  | { type: 'usage'; usage: Partial<UniversalUsage> }
  | { type: 'artifact'; artifact: UniversalArtifact }
  | { type: 'activity'; line: string };

export type SteerFn = (prompt: string, attachments?: string[]) => Promise<boolean>;

export interface DriverContext {
  signal: AbortSignal;                                   // aborts on stop()
  emit(event: DriverEvent): void;                        // stream a normalized event
  askUser(interaction: UniversalInteraction): Promise<Record<string, string[]>>; // human-in-the-loop
  registerSteer(fn: SteerFn): void;                      // drivers that support mid-turn steer call this
}

export interface DriverResult {
  ok: boolean;
  text: string;
  reasoning?: string;
  error?: string | null;
  stopReason?: string | null;
  sessionId?: string | null;
  usage?: UniversalUsage | null;
}

// ---- TUI mode (the second, orthogonal shape) ----
// run() yields a structured snapshot (for Web/IM). tui() yields a raw, full-screen
// interactive process to passthrough over a PTY (for a terminal app like `pikiloom code`).
// Same driver registry, two outputs: structured frames vs raw bytes.

export interface TuiInput {
  workdir: string;
  model?: string | null;
  sessionId?: string | null;       // resume the agent's native interactive session
  env?: Record<string, string>;    // injected by ModelResolver (BYOK)
  extraArgs?: string[];
}

export interface TuiSpec {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
}

// A session discovered from an agent's OWN on-disk transcript store (not created via the
// kernel). Drivers that can read their CLI's native session history expose them here so the
// kernel can present a unified list (managed + native). `agent` is stamped by the kernel.
export interface NativeSessionInfo {
  sessionId: string;
  title: string | null;
  preview: string | null;     // the latest message text (from the transcript tail, not just the head)
  cwd: string | null;
  model: string | null;
  effort?: string | null;     // reasoning effort the session last ran with (codex), when discoverable
  createdAt: string | null;   // ISO
  updatedAt: string | null;   // ISO
  running: boolean;
  messageCount?: number | null;
}

export interface AgentDriver {
  readonly id: string;
  readonly capabilities?: { steer?: boolean; interact?: boolean; resume?: boolean; tui?: boolean };
  run(input: AgentTurnInput, ctx: DriverContext): Promise<DriverResult>;
  // Optional: how to launch this agent's interactive TUI. Drivers that set capabilities.tui
  // must implement this. The kernel spawns it in a PTY and passes terminal I/O through.
  tui?(input: TuiInput): TuiSpec;
  // Optional: discover the agent's own native sessions for a workdir (e.g. claude reads
  // ~/.claude/projects/<enc>/*.jsonl). The kernel merges these with its managed sessions.
  listNativeSessions?(opts: { workdir: string; limit?: number }): NativeSessionInfo[] | Promise<NativeSessionInfo[]>;
}
