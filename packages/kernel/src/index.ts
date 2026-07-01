// @pikiloom/kernel — heterogeneous coding agents -> an interaction-friendly,
// accumulating session snapshot + control handle, over pluggable surfaces.
//
//   const loom = createLoom({
//     drivers: [new ClaudeDriver()],                 // 下层 (unchanged)
//     surfaces: [new WebSurface({ port: 8787 })],  // 上层 (IM / Web / tunnel)
//   })
//   await loom.start()
//
// pikiloom itself is just a consumer of this package.

export { createLoom, type Loom, type LoomConfig, type TuiLaunchOptions } from './runtime/loom.js';
export { Hub } from './runtime/hub.js';
export { SessionRunner } from './runtime/session-runner.js';
export { runTurn, type RunTurnOptions, type TurnOutcome } from './runtime/turn.js';
export { PtyBridge, ptyAvailable, type PtyExit, type PtyOpenOpts } from './runtime/pty.js';
export { attachTui, type AttachTuiOptions } from './runtime/tui.js';

// Contracts
export type {
  AgentDriver, AgentTurnInput, DriverContext, DriverEvent, DriverResult, SteerFn, McpServerSpec,
  TuiInput, TuiSpec, NativeSessionInfo,
} from './contracts/driver.js';
export type {
  SessionStore, CoreSessionRecord, ModelResolver, ModelInjection,
  ToolProvider, SystemPromptBuilder, InteractionHandler, Catalog,
} from './contracts/ports.js';
export type {
  LoomIO, PromptInput, Surface, SurfaceCapabilities, Plugin, SpawnContribution,
} from './contracts/surface.js';
// AgentInfo + Model/Effort/Tool/Skill descriptors are wire vocabulary — exported via protocol below.

// Default ports
export {
  FsSessionStore, NullModelResolver, NoopToolProvider,
  PassthroughSystemPromptBuilder, AutoCancelInteractionHandler, DeferToTerminalInteractionHandler,
  NoopCatalog, defaultBaseDir,
} from './ports/defaults.js';

// Drivers & surfaces (also available via subpath exports)
export { EchoDriver } from './drivers/echo.js';
export {
  ClaudeDriver,
  isTerminalTaskStatus, trackClaudeBackgroundTask, pendingClaudeBackgroundTasks,
  markClaudeTaskNotificationTerminal,
  decideClaudeResultSettle, claudeBgHoldCapMs, claudeBgSettleQuietMs, type ClaudeResultSettleDecision,
  claudeModelStallMs, claudeUserEventHasToolResult,
} from './drivers/claude.js';
export { CodexDriver } from './drivers/codex.js';
export { GeminiDriver } from './drivers/gemini.js';
export { AcpDriver, type AcpDriverConfig } from './drivers/acp.js';
export { HermesDriver } from './drivers/hermes.js';
export { WebSurface, type WebSurfaceOptions } from './surfaces/web.js';
export { CliSurface } from './surfaces/cli.js';

// Workspace: unified top-level directory + session/skill/mcp management (loom.paths/sessions/skills/mcp)
export * from './workspace/index.js';

// Multi-account: per-account isolated config dirs (CLAUDE_CONFIG_DIR / CODEX_HOME)
export * from './accounts.js';

// Protocol (the wire vocabulary; shared with transports)
export * from './protocol/index.js';
