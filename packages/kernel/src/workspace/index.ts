// Workspace subsystem: the unified top-level directory + session/skill/mcp management that
// a consuming app gets "for free" off createLoom() (exposed as loom.paths/sessions/skills/mcp).
// (Native-session discovery lives with the drivers — drivers/native.ts — because knowing each
// agent CLI's on-disk transcript format is driver-axis knowledge.)

export { resolveLoomPaths, normalizeStateDirName, type LoomPaths, type LoomScope } from './paths.js';
export {
  SessionsManager,
  type ManagedSessionInfo, type SessionSource, type ListSessionsOptions,
  type SearchSessionsOptions, type SessionsManagerDeps,
} from './sessions.js';
export {
  SkillsManager, ensureDirSymlink, parseSkillMeta,
  type SkillInfo, type SkillMeta, type SkillSearchResult, type SkillsManagerOptions,
} from './skills.js';
export {
  McpRegistry,
  type McpCatalogEntry, type McpSearchResult, type McpRegistryOptions,
} from './mcp.js';
