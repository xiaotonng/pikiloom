// Workspace subsystem: the unified top-level directory + session/skill/mcp management that
// a consuming app gets "for free" off createLoom() (exposed as loom.paths/sessions/skills/mcp).

export { resolveLoomPaths, normalizeStateDirName, type LoomPaths, type LoomScope } from './paths.js';
export {
  discoverClaudeNativeSessions, discoverCodexNativeSessions, discoverGeminiNativeSessions,
  encodeClaudeProjectDir, NATIVE_SESSION_RUNNING_THRESHOLD_MS,
  type DiscoverOptions, type NativeSessionInfo,
} from './native.js';
export {
  SessionsManager,
  type ManagedSessionInfo, type SessionSource, type ListSessionsOptions,
  type SearchSessionsOptions, type SessionsManagerDeps,
} from './sessions.js';
export {
  SkillsManager, ensureDirSymlink,
  type SkillInfo, type SkillSearchResult, type SkillsManagerOptions,
} from './skills.js';
export {
  McpRegistry,
  type McpCatalogEntry, type McpSearchResult, type McpRegistryOptions,
} from './mcp.js';
