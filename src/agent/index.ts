import './drivers/claude.js';
import './drivers/codex.js';
import './drivers/gemini.js';
import './drivers/hermes.js';

export type {
  Agent, AgentDetectOptions, AgentInfo, AgentListResult,
  AgentDriverCapabilities, SessionLineageRef, HandoverRef,
  CodexCumulativeUsage, CodexTurnControl,
  AgentInteractionOption, AgentInteractionQuestion, AgentInteraction,
  StreamPreviewMeta, StreamPreviewPlanStep, StreamPreviewPlan, StreamSubAgent,
  StreamOpts, StreamResult,
  ManagedSessionRecord, SessionRunState, SessionClassification,
  SessionInfo, SessionListResult, SessionListOpts,
  TailMessage, MessageBlock, RichMessage,
  SessionTailResult, SessionTailOpts,
  SessionMessagesOpts, SessionMessagesWindow, SessionMessagesResult,
  StageSessionFilesOpts, StageSessionFilesResult, EnsureManagedSessionOpts,
  ExportSessionOpts, ExportSessionResult, ImportSessionOpts, ImportSessionResult,
  MigrateSessionOpts,
  ModelInfo, ModelListResult, ModelListOpts,
  UsageWindowInfo, UsageResult, UsageOpts,
} from './types.js';
export { IMAGE_EXTS } from './types.js';

export {
  attachAgentImage,
  attachInlineImage,
  materializeImage,
  rewriteAttachmentBlocksForTransport,
  attachmentUrl,
  resolveAllowedAttachmentPath,
  allowedAttachmentRoots,
  decodeAttachmentPathParam,
  sessionAttachmentsDir,
  codexHome,
  type AttachAgentImageOpts,
  type AttachInlineImageOpts,
  type MaterializedImage,
  type TransportContext,
} from './images.js';

export {
  deliverArtifact,
  readDeliveredArtifacts,
  deliveredArtifactBlocks,
  tailDeliveredBlocks,
  latestDeliveredTaskId,
  mimeForArtifact,
  type DeliveredArtifact,
  type ArtifactKind,
} from './artifacts.js';

export {
  Q, agentLog, agentWarn, agentError,
  dedupeStrings, numberOrNull,
  normalizeStreamPreviewPlan, parseTodoWriteAsPlan, normalizeActivityLine, pushRecentActivity,
  detectClaudeApiError, isRetryableClaudeApiError,
  detectClaudeModelError, claudeModelErrorMessage,
  firstNonEmptyLine, shortValue, normalizeErrorMessage, joinErrorMessages,
  appendSystemPrompt, mimeForExt, computeContext, buildStreamPreviewMeta,
  summarizeClaudeToolUse, summarizeClaudeToolResult,
  previewToolCallInput, previewToolCallResult,
  roundPercent, toIsoFromEpochSeconds, normalizeUsageStatus,
  labelFromWindowMinutes, usageWindowFromRateLimit,
  parseJsonTail, modelFamily, normalizeClaudeModelId, emptyUsage,
  readTailLines, stripInjectedPrompts, sanitizeSessionUserPreviewText,
  SESSION_PREVIEW_IMAGE_PLACEHOLDER_RE,
  CLAUDE_AT_MENTION_IMAGE_RE, extractClaudeAtMentionImagePaths, stripClaudeAtMentionImages,
  isPendingSessionId, emitSessionIdUpdate,
  sessionListDisplayTitle,
} from './utils.js';

export {
  updateSessionMeta, promoteSessionId, recordFork, resolveCanonicalSessionId, getSessionPromotions,
  listPikiloomSessions, findPikiloomSession, getSessionStoredConfig,
  ensureManagedSession, findManagedThreadSession, stageSessionFiles,
  mergeManagedAndNativeSessions, managedRecordToSessionInfo,
  getSessions, getSessionTail, getSessionMessages,
  applyTurnWindow, applyTurnFilter,
  classifySession, deriveUserStatus,
  exportSession, importSession,
  deleteAgentSession,
  type DeleteAgentSessionOpts, type DeleteAgentSessionResult,
  isProcessAlive, isRunningSessionStale, reconcileOrphanedRunningSessions,
} from './session.js';

export {
  detectAgentBin, listAgents, resolveDefaultAgent,
  run, doStream, recoverProfileIdForModel,
  listModels, resolveAgentModels, dropNativeShadowedByProfiles, getUsage, getAgentBoundModelId, setAgentBoundModelId,
} from './stream.js';

export {
  type AgentDriver, type AgentNativeConfig, registerDriver, getDriver, getDriverCapabilities,
  allDrivers, allDriverIds, hasDriver, shutdownAllDrivers,
} from './driver.js';

export {
  getProjectSkillPaths, initializeProjectSkills, listSkills, getGlobalSkillsRoot,
  collapseSkillPrompt,
  type ProjectSkillPaths, type SkillInfo, type SkillListResult, type SkillScope,
} from './skills.js';

export {
  readGoal, writeGoal, clearGoal, setGoal, pauseGoal, resumeGoal, completeGoal,
  accountTurn, bumpContinuationCount, shouldContinueAfterTurn,
  renderContinuationPrompt, renderBudgetLimitPrompt,
  sessionGoalPath, DEFAULT_MAX_CONTINUATIONS,
  type ThreadGoal, type GoalStatus, type TurnUsage, type ContinuationDecision,
} from './goal.js';

export {
  setCodexGoal, getCodexGoal, clearCodexGoal, pauseCodexGoal, resumeCodexGoal,
  type CodexThreadGoal, type CodexGoalStatus,
} from './drivers/codex.js';

export {
  getClaudeNativeGoal, buildClaudeSetGoalPrompt, buildClaudeClearGoalPrompt,
  type ClaudeNativeGoal, type ClaudeNativeGoalStatus,
} from './drivers/claude.js';

export {
  listAllMcpExtensions,
  addGlobalMcpExtension, removeGlobalMcpExtension, updateGlobalMcpExtension,
  addWorkspaceMcpExtension, removeWorkspaceMcpExtension, updateWorkspaceMcpExtension,
  loadGlobalMcpExtensions, loadWorkspaceMcpExtensions,
  getCatalogItems, getCatalogItem, buildInstalledConfigFromRecommended,
  checkMcpHealth, getCachedHealth, cacheHealth,
  type McpExtensionEntry, type ExtensionScope, type McpHealthResult,
  type McpCatalogItem, type McpCatalogState,
} from './mcp/extensions.js';

export {
  getRecommendedMcpServers, getRecommendedMcpServer, getRecommendedSkillRepos,
  searchMcpServers, searchSkills as searchSkillRepos,
  type RecommendedMcpServer, type RecommendedSkillRepo,
  type McpSearchResult, type SkillSearchResult,
  type McpAuthSpec, type McpTransportSpec, type McpCategory,
  type CredentialField, type SkillCategory,
} from './mcp/registry.js';

export {
  getMcpToken, saveMcpToken, deleteMcpToken, hasValidMcpToken,
  startAuthorization, completeAuthorization, refreshMcpToken, injectOAuthHeaders,
  type StartOAuthResult, type CompleteOAuthResult,
} from './mcp/oauth.js';

export {
  installSkill, removeSkill, checkSkillUpdates, getGlobalSkillsDir,
  recordSkillInstall, getSkillLedgerEntry, forgetSkillInstall, normalizeSkillSourceKey,
  type SkillInstallOpts, type SkillInstallResult, type SkillRemoveResult, type SkillLedgerEntry,
} from './skill-installer.js';

export {
  getRecommendedClis, getRecommendedCli,
  detectCli, getCachedCliStatus, invalidateCliStatus, currentPlatform,
  getCliCatalog, refreshCliStatus,
  startCliAuthSession, getAuthSession, cancelAuthSession,
  applyCliToken, logoutCli,
  startCliInstallSession,
  type RecommendedCli, type CliCategory, type CliAuthType,
  type CliInstallSpec, type CliInstallCommand, type CliAuthSpec,
  type CliState, type CliStatus, type CliCatalogItem,
  type AuthSession, type AuthSessionEvent,
  type ApplyTokenResult, type LogoutResult, type StartAuthSessionResult,
} from './cli/index.js';

export { doClaudeStream } from './drivers/claude.js';
export { doCodexStream, buildCodexTurnInput, shutdownCodexServer, getCodexUsageLive, humanizeCodexError } from './drivers/codex.js';
export { doGeminiStream } from './drivers/gemini.js';
export { doHermesStream } from './drivers/hermes.js';
