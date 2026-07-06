export type Agent = 'claude' | 'codex' | 'gemini' | 'hermes';
export type OpenTarget = 'vscode' | 'cursor' | 'windsurf' | 'finder' | 'default';

export interface AgentInfo {
  agent: Agent;
  label: string;
  installed: boolean;
  version?: string;
  installCommand?: string;
}

export interface ModelInfo {
  id: string;
  alias: string | null;
}

export interface UsageWindowInfo {
  label: string;
  usedPercent: number | null;
  remainingPercent: number | null;
  resetAt: string | null;
  resetAfterSeconds: number | null;
  status: string | null;
  detail?: string | null;
}

export interface UsageResult {
  ok: boolean;
  agent: Agent;
  source: string | null;
  capturedAt: string | null;
  status: string | null;
  windows: UsageWindowInfo[];
  error: string | null;
  planType?: string | null;
  creditsSummary?: string | null;
  resetCreditsAvailable?: number | null;
}

export interface AgentNativeConfig {
  model: string;
  provider: string;
  baseURL: string | null;
  effort: string | null;
  configPath: string;
  source: string;
}

export interface AgentInstallInfo {
  method: 'npm' | 'manual';
  command: string;
  docsUrl?: string;
  note?: string;
}

// Wire shape of one reasoning-effort level; the authoritative catalog lives in the backend
// (core/config/runtime-config.ts effortOptionsFor). The dashboard only consumes these.
export interface EffortLevel { id: string; label: string }

export interface AgentRuntimeStatus extends AgentInfo {
  install?: AgentInstallInfo | null;
  selectedModel: string | null;
  selectedEffort: string | null;
  // Authoritative effort levels for this agent's current (agent, model), from the backend
  // catalog. Empty/absent ⇒ no effort selector. Do not hardcode a list in the frontend.
  effortOptions?: EffortLevel[];
  nativeSelectedModel?: string | null;
  nativeSelectedEffort?: string | null;
  workflowEnabled?: boolean;
  claudeAccessMode?: 'subscription' | 'api';
  isDefault: boolean;
  models: ModelInfo[];
  usage: UsageResult | null;
  nativeConfig?: AgentNativeConfig | null;
  capabilities?: { fork?: boolean; modelSwitch?: boolean; workflow?: boolean };
  byokProviderName?: string | null;
  byokProfileName?: string | null;
  byokModels?: { id: string; alias: string | null }[] | null;
  latestVersion?: string | null;
  updateAvailable?: boolean;
  updateStatus?: string | null;
  updateDetail?: string | null;
}

export interface AgentStatusResponse {
  defaultAgent: Agent;
  workdir: string;
  agents: AgentRuntimeStatus[];
}

export type ChannelStatus = 'ready' | 'missing' | 'invalid' | 'error' | 'checking';

export interface ChannelSetupState {
  channel: 'telegram' | 'feishu' | 'weixin' | 'slack' | 'discord' | 'dingtalk' | 'wecom';
  configured: boolean;
  ready: boolean;
  validated: boolean;
  status: ChannelStatus;
  detail: string;
}

export interface SetupState {
  agents: AgentInfo[];
  channel: string;
  tokenProvided: boolean;
  channels?: ChannelSetupState[];
}

export interface PermissionStatus {
  granted: boolean;
  checkable: boolean;
  detail: string;
}

export type PermissionRequestAction = 'already_granted' | 'prompted' | 'opened_settings' | 'unsupported';

export interface PermissionRequestResult {
  ok: boolean;
  action: PermissionRequestAction;
  granted: boolean;
  requiresManualGrant: boolean;
  error?: string;
}

export interface BotStatus {
  workdir: string;
  defaultAgent: Agent;
  uptime: number;
  connected: boolean;
  stats: {
    totalTurns: number;
    totalInputTokens: number;
    totalOutputTokens: number;
  };
  activeTasks: number;
  sessions: number;
}

export interface UserConfig {
  defaultAgent?: Agent;
  claudeModel?: string;
  claudeReasoningEffort?: string;
  codexModel?: string;
  codexReasoningEffort?: string;
  geminiModel?: string;
  workdir?: string;
  telegramBotToken?: string;
  telegramAllowedChatIds?: string;
  feishuAppId?: string;
  feishuAppSecret?: string;
  weixinBaseUrl?: string;
  weixinBotToken?: string;
  weixinAccountId?: string;
  slackBotToken?: string;
  slackAppToken?: string;
  discordBotToken?: string;
  dingtalkClientId?: string;
  dingtalkClientSecret?: string;
  wecomBotId?: string;
  wecomBotSecret?: string;
  wecomEndpoint?: string;
  channels?: string[];
  browserEnabled?: boolean;
  browserHeadless?: boolean;
}

export interface WeixinValidationResult {
  ok: boolean;
  error?: string | null;
  normalizedBaseUrl?: string;
  account?: {
    accountId: string;
    baseUrl: string;
  } | null;
}

export interface WeixinLoginStartResult {
  ok: boolean;
  sessionKey: string;
  qrcodeUrl?: string;
  message: string;
  error?: string;
}

export interface WeixinLoginWaitResult {
  ok: boolean;
  connected: boolean;
  status: 'wait' | 'scaned' | 'confirmed' | 'expired' | 'error';
  message: string;
  qrcodeUrl?: string;
  botToken?: string;
  accountId?: string;
  userId?: string;
  baseUrl?: string;
  error?: string;
}

export interface AppState {
  version: string;
  ready: boolean;
  configExists: boolean;
  config: UserConfig;
  runtimeWorkdir: string;
  setupState: SetupState | null;
  permissions: Record<string, PermissionStatus>;
  hostApp?: string | null;
  platform: string;
  pid: number;
  nodeVersion?: string;
  bot: BotStatus | null;
}

export interface HostInfo {
  hostName: string;
  cpuModel: string;
  cpuCount: number;
  totalMem: number;
  freeMem: number;
  memoryUsed?: number;
  memoryPercent?: number;
  platform: string;
  arch: string;
  cpuUsage?: { usedPercent: number };
  loadAverage?: { one: number; five: number; fifteen: number } | null;
  disk?: { used: string; total: string; percent: string };
  battery?: { percent: string; state: string };
}

export type LocalBackendId = 'ollama' | 'mlx';
export type LocalBackendOs = 'darwin' | 'linux' | 'win';

export interface LocalBackendInstallCommand {
  label?: string;
  cmd: string;
}

export interface LocalBackendInstallSpec {
  darwin?: LocalBackendInstallCommand[];
  linux?: LocalBackendInstallCommand[];
  win?: LocalBackendInstallCommand[];
  docs?: string;
}

export interface LocalBackendStatus {
  id: LocalBackendId;
  label: string;
  detected: boolean;
  version?: string;
  baseURL: string;
  openAIBaseURL: string;
  models: Array<{ id: string; sizeBytes?: number }>;
  existingProviderId: string | null;
  homepage: string;
  install: LocalBackendInstallSpec;
  runHint: LocalBackendInstallCommand;
  pullCommandTemplate: string;
  supportedOnThisOs: boolean;
}

export interface LocalModelCatalogEntry {
  id: string;
  name: string;
  publisher: string;
  paramsB: number;
  sizeGb: number;
  minRamGb: number;
  description: string;
  descriptionZh: string;
  ollamaTag?: string;
  mlxModel?: string;
  homepage?: string;
  installed: { backend: LocalBackendId; id: string } | null;
}

export interface LocalModelsProbeResponse {
  ok: boolean;
  backends?: LocalBackendStatus[];
  catalog?: LocalModelCatalogEntry[];
  currentOs?: LocalBackendOs;
  addedProviderIds?: string[];
  error?: string;
}

export interface OllamaLibSize {
  tag: string;
  paramsB: number;
  diskGb: number;
  minRamGb: number;
}

export interface OllamaLibModel {
  name: string;
  description: string;
  capabilities: string[];
  sizes: OllamaLibSize[];
  pulls: string;
  updated: string;
  url: string;
}

export interface OllamaLibraryResponse {
  ok: boolean;
  models?: OllamaLibModel[];
  fetchedAt?: number;
  stale?: boolean;
  error?: string;
}

export interface InteractionOption {
  label: string;
  description?: string | null;
  value: string;
}

export interface InteractionQuestion {
  id: string;
  header: string;
  prompt: string;
  options?: InteractionOption[] | null;
  allowFreeform?: boolean;
  secret?: boolean;
  allowEmpty?: boolean;
}

export interface InteractionSnapshot {
  promptId: string;
  kind: 'user-input' | 'permission' | 'confirmation';
  title: string;
  hint?: string | null;
  questions: InteractionQuestion[];
  currentIndex?: number;
}

export interface SessionInfo {
  sessionId: string;
  title?: string;
  createdAt?: string;
  running?: boolean;
  isCurrent?: boolean;
  model?: string;
  profileId?: string | null;
  thinkingEffort?: string | null;
  workflowEnabled?: boolean | null;
  workdir?: string;
  runState: 'running' | 'completed' | 'incomplete';
  runDetail?: string | null;
  runUpdatedAt?: string | null;
  awaiting?: { reason: string; since: string } | null;
  agent?: string;
  lastQuestion?: string | null;
  lastAnswer?: string | null;
  lastMessageText?: string | null;
  classification?: {
    outcome: 'answer' | 'proposal' | 'implementation' | 'partial' | 'blocked' | 'conversation';
    summary: string;
    suggestedNextAction?: string | null;
    classifiedAt?: string;
  } | null;
  userStatus?: 'inbox' | 'active' | 'review' | 'done' | 'parked' | null;
  userNote?: string | null;
  workspacePath?: string | null;
  migratedFrom?: SessionLineageRef | null;
  migratedTo?: SessionLineageRef | null;
  linkedSessions?: SessionLineageRef[];
  numTurns?: number | null;
}

export interface SessionLineageRef {
  agent: Agent;
  sessionId: string;
  kind?: 'migrate' | 'fork';
  forkedAtTurn?: number;
}

export interface WorkspaceEntry {
  path: string;
  name: string;
}

export interface GitStatus {
  branch: string | null;
  detached: boolean;
  shortSha: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: number;
  unstaged: number;
  untracked: number;
  changed: number;
}

export interface WorkspaceGitResult {
  ok: boolean;
  isGit: boolean;
  git: GitStatus | null;
  error?: string;
}

export interface SessionHubResult {
  ok: boolean;
  workdir: string;
  workspaceName: string;
  sessions: SessionInfo[];
  statusCounts: Record<string, number>;
  total: number;
  errors: string[];
  promotions?: Record<string, string>;
}

export interface SessionsPageResult {
  ok: boolean;
  sessions: SessionInfo[];
  error: string | null;
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasMore: boolean;
}

export interface SessionTailMessage {
  role: 'user' | 'assistant';
  text: string;
}

export interface SessionMessage {
  role: 'user' | 'assistant';
  text: string;
}

export interface MessageBlock {
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'image' | 'file' | 'plan' | 'sub_agent' | 'system_notice';
  content: string;
  toolName?: string;
  toolId?: string;
  phase?: 'commentary' | 'final_answer';
  plan?: StreamPlan | null;
  subAgent?: StreamSubAgent | null;
  imagePath?: string;
  imageMime?: string;
  imageCaption?: string;
  imageCaptionKind?: 'prompt' | 'caption';
  filePath?: string;
  fileMime?: string;
  fileName?: string;
  fileSize?: number;
  fileCaption?: string;
}

export interface SnapshotArtifact {
  url: string;
  fileName: string;
  fileSize: number;
  mime: string;
  kind: 'photo' | 'document';
  caption?: string;
}

export interface QueuedTaskPreview {
  taskId: string;
  prompt: string;
  attachments?: MessageBlock[];
}

export interface RichMessage {
  role: 'user' | 'assistant';
  text: string;
  blocks: MessageBlock[];
  usage?: StreamPreviewMeta | null;
}

export interface StreamPlanStep {
  step: string;
  status: 'pending' | 'inProgress' | 'completed';
}

export interface StreamPlan {
  explanation: string | null;
  steps: StreamPlanStep[];
}

export interface StreamPreviewMeta {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  contextUsedTokens?: number | null;
  contextPercent: number | null;
  turnOutputTokens?: number | null;
  subAgents?: StreamSubAgent[];
  providerName?: string | null;
  generatingImages?: number;
  toolCalls?: StreamToolCall[];
}

export interface StreamToolCall {
  id: string;
  name: string;
  summary: string;
  input?: string | null;
  result?: string | null;
  status: 'running' | 'done' | 'failed';
}

export interface StreamSubAgent {
  id: string;
  kind: string | null;
  description: string | null;
  model: string | null;
  tools: Array<{ id: string; name: string; summary: string }>;
  status: 'running' | 'done' | 'failed';
}

export interface SessionMessagesWindow {
  offset: number;
  limit: number;
  returnedTurns: number;
  totalTurns: number;
  hasOlder: boolean;
  hasNewer: boolean;
  startTurn: number;
  endTurn: number;
}

export interface SessionMessagesResult {
  ok: boolean;
  messages: SessionMessage[];
  richMessages?: RichMessage[];
  totalTurns?: number;
  window?: SessionMessagesWindow;
  error: string | null;
}

export type BrowserProfileStatus = 'disabled' | 'ready' | 'needs_setup' | 'chrome_missing';

export interface BrowserStatus {
  status: BrowserProfileStatus;
  enabled: boolean;
  remoteCdpUrl?: string | null;
  headlessMode: 'headless' | 'headed';
  chromeInstalled: boolean;
  profileCreated: boolean;
  running: boolean;
  pid: number | null;
  profileDir: string;
  detail?: string | null;
}

export interface BrowserStatusResponse {
  browser: BrowserStatus;
}

export interface BrowserSetupResponse {
  ok: boolean;
  browser: BrowserStatus;
  error?: string;
}

export interface SkillInfo {
  name: string;
  label: string | null;
  description: string | null;
  scope?: 'global' | 'project';
  mcpRequires?: string[];
}

export interface McpServerConfig {
  type?: 'stdio' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
  disabled?: boolean;
  catalogId?: string;
}

export interface McpExtensionEntry {
  name: string;
  config: McpServerConfig;
  scope: 'global' | 'workspace' | 'builtin';
  source?: string;
}

export interface McpHealthResult {
  ok: boolean;
  tools?: string[];
  error?: string;
  elapsedMs?: number;
  cached?: boolean;
}

export type McpCatalogState = 'recommended' | 'needs_auth' | 'disabled' | 'ready' | 'unhealthy';

export interface McpCredentialField {
  key: string;
  label: string;
  labelZh: string;
  secret?: boolean;
  required?: boolean;
  placeholder?: string;
  helpUrl?: string;
}

export type McpAuthSpec =
  | { type: 'none' }
  | { type: 'credentials'; fields: McpCredentialField[] }
  | {
      type: 'mcp-oauth';
      authorizationEndpoint?: string;
      tokenEndpoint?: string;
      registrationEndpoint?: string;
      clientId?: string;
      scopes?: string[];
    };

export type RecommendedScope = 'global' | 'workspace' | 'both';

export interface McpCatalogItem {
  id: string;
  name: string;
  description: string;
  descriptionZh: string;
  category: 'dev' | 'productivity' | 'communication' | 'data' | 'search' | 'utility' | 'custom';
  iconSlug?: string;
  iconUrl?: string;
  homepage?: string;
  transport: { type: 'stdio' | 'http'; summary: string };
  auth: McpAuthSpec;
  state: McpCatalogState;
  isRecommended: boolean;
  installed: boolean;
  scope?: 'global' | 'workspace' | 'builtin';
  config?: McpServerConfig;
  installedKey?: string;
  recommendedScope?: RecommendedScope;
  isBuiltin?: boolean;
}

export interface RecommendedSkillRepo {
  id: string;
  name: string;
  description: string;
  descriptionZh: string;
  source: string;
  skills?: string[];
  category?: string;
  homepage?: string;
}

export interface SkillCatalogItem {
  id: string;
  name: string;
  description: string;
  descriptionZh: string;
  source: string;
  category: string;
  recommendedScope?: RecommendedScope;
  homepage?: string;
  installed: boolean;
  scope?: 'global' | 'project';
  installedNames: string[];
  stars?: number;
  pushedAt?: string;
  iconUrl?: string;
  totalCount?: number;
  partial?: boolean;
  pinned?: boolean;
  updateAvailable?: boolean;
  installedSha?: string | null;
  latestSha?: string | null;
}

export interface RemoteSkillInfo {
  name: string;
  description?: string;
  path: string;
}

export interface McpSearchResult {
  name: string;
  description: string;
  npmPackage?: string;
  source?: string;
}

export interface GitChange {
  status: 'added' | 'modified' | 'deleted';
  file: string;
  path: string;
}

export interface GitChangesResult {
  ok: boolean;
  changes: GitChange[];
  isGit: boolean;
  error?: string;
}

export interface DirEntry {
  name: string;
  path: string;
  isDir?: boolean;
}

export interface LsDirResult {
  ok: boolean;
  path: string;
  parent: string;
  dirs: DirEntry[];
  isGit: boolean;
  error?: string;
}

export type CliCategory = 'dev' | 'cloud' | 'data' | 'commerce' | 'social' | 'content';
export type CliState = 'not_installed' | 'installed_not_auth' | 'ready' | 'unknown';
export type CliAuthType = 'oauth-web' | 'token' | 'none';

export interface CliInstallCommand {
  cmd: string;
  label?: string;
}

export interface CliInstallSpec {
  darwin?: CliInstallCommand[];
  linux?: CliInstallCommand[];
  win?: CliInstallCommand[];
  docs?: string;
}

export interface CliAuthSpec {
  type: CliAuthType;
  statusArgv?: string[];
  statusReadyPattern?: string;
  loginArgv?: string[];
  logoutArgv?: string[];
  tokenFields?: McpCredentialField[];
  applyTokenArgv?: string[];
  envKey?: string;
  loginHint?: string;
  loginHintZh?: string;
  manualLoginCommands?: { label?: string; cmd: string }[];
}

export interface CliCatalogItem {
  id: string;
  binary: string;
  name: string;
  description: string;
  descriptionZh: string;
  category: CliCategory;
  iconSlug?: string;
  iconUrl?: string;
  homepage?: string;
  install: CliInstallSpec;
  auth: CliAuthSpec;
  state: CliState;
  version?: string;
  authDetail?: string;
  platform: 'darwin' | 'linux' | 'win';
  autoInstall?: { label: string };
}

export interface CliStatus {
  id: string;
  binary: string;
  state: CliState;
  version?: string;
  authDetail?: string;
  error?: string;
  checkedAt: number;
}

export type CliAuthStreamEvent =
  | { type: 'output'; chunk: string }
  | { type: 'status'; status: CliStatus }
  | { type: 'error'; message: string }
  | { type: 'done'; ok: boolean; exitCode: number | null };
