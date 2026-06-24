export type Agent = string;

export interface AgentDetectOptions {
  includeVersion?: boolean;
  refresh?: boolean;
  versionTimeoutMs?: number;
}

export interface CodexCumulativeUsage {
  input: number;
  output: number;
  cached: number;
}

export interface CodexTurnControl {
  threadId: string;
  turnId: string;
  steer: (prompt: string, attachments?: string[]) => Promise<boolean>;
}

export interface AgentInteractionOption {
  label: string;
  description?: string | null;
  value: string;
}

export interface AgentInteractionQuestion {
  id: string;
  header: string;
  prompt: string;
  options?: AgentInteractionOption[] | null;
  allowFreeform?: boolean;
  secret?: boolean;
  allowEmpty?: boolean;
}

export interface AgentInteraction {
  kind: 'user-input' | 'permission' | 'confirmation';
  id: string;
  title: string;
  hint?: string | null;
  questions: AgentInteractionQuestion[];
  resolveWith: (answers: Record<string, string[]>) => Record<string, any> | null;
}

export interface StreamToolCall {
  id: string;
  name: string;
  summary: string;
  input?: string | null;
  result?: string | null;
  status: 'running' | 'done' | 'failed';
}

export interface StreamPreviewMeta {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  contextUsedTokens?: number | null;
  contextPercent: number | null;
  turnOutputTokens?: number | null;
  subAgents?: StreamSubAgent[];
  toolCalls?: StreamToolCall[];
  providerName?: string | null;
  profileName?: string | null;
  generatingImages?: number;
}

export interface StreamPreviewPlanStep {
  step: string;
  status: 'pending' | 'inProgress' | 'completed';
}

export interface StreamPreviewPlan {
  explanation: string | null;
  steps: StreamPreviewPlanStep[];
}

export interface StreamSubAgent {
  id: string;
  kind: string | null;
  description: string | null;
  model: string | null;
  tools: Array<{ id: string; name: string; summary: string }>;
  status: 'running' | 'done' | 'failed';
}

export interface StreamOpts {
  agent: Agent;
  prompt: string;
  workdir: string;
  timeout: number;
  sessionId: string | null;
  model: string | null;
  thinkingEffort: string;
  onText: (
    text: string,
    thinking: string,
    activity?: string,
    meta?: StreamPreviewMeta,
    plan?: StreamPreviewPlan | null,
  ) => void;
  onSessionId?: (sessionId: string) => void;
  attachments?: string[];
  codexModel?: string;
  codexFullAccess?: boolean;
  codexDeveloperInstructions?: string;
  codexExtraArgs?: string[];
  codexPrevCumulative?: CodexCumulativeUsage;
  claudeModel?: string;
  claudePermissionMode?: string;
  claudeAppendSystemPrompt?: string;
  claudeExtraArgs?: string[];
  claudeWorkflowEnabled?: boolean;
  claudeAccessMode?: 'subscription' | 'api';
  geminiModel?: string;
  geminiApprovalMode?: string;
  geminiSandbox?: boolean;
  geminiSystemInstruction?: string;
  geminiExtraArgs?: string[];
  hermesModel?: string;
  _stdinOverride?: string;
  mcpSendFile?: import('./mcp/bridge.js').McpSendFileCallback;
  mcpConfigPath?: string;
  mcpServers?: Record<string, any>;
  extraEnv?: Record<string, string>;
  byokArgvAppend?: string[];
  byokContextWindow?: number;
  byokProviderName?: string;
  byokProfileName?: string;
  abortSignal?: AbortSignal;
  onInteraction?: (request: AgentInteraction) => Promise<Record<string, any> | null>;
  onSteerReady?: (steer: (prompt: string, attachments?: string[]) => Promise<boolean>) => void;
  onCodexTurnReady?: (control: CodexTurnControl) => void;
  forkOf?: {
    parentSessionId: string;
    atTurn: number;
  };
}

export interface AgentDriverCapabilities {
  fork: boolean;
  modelSwitch: boolean;
  workflow: boolean;
}

export interface StreamResult {
  ok: boolean;
  message: string;
  thinking: string | null;
  plan?: StreamPreviewPlan | null;
  sessionId: string | null;
  workspacePath: string | null;
  model: string | null;
  thinkingEffort: string;
  elapsedS: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  cacheCreationInputTokens: number | null;
  contextWindow: number | null;
  contextUsedTokens: number | null;
  contextPercent: number | null;
  codexCumulative: CodexCumulativeUsage | null;
  error: string | null;
  stopReason: string | null;
  incomplete: boolean;
  activity: string | null;
  assistantBlocks?: MessageBlock[];
  byokProviderName?: string | null;
  byokProfileName?: string | null;
}

export interface ManagedSessionRecord {
  sessionId: string;
  agent: Agent;
  workdir: string;
  workspacePath: string;
  threadId: string | null;
  createdAt: string;
  updatedAt: string;
  title: string | null;
  model: string | null;
  thinkingEffort: string | null;
  workflowEnabled: boolean | null;
  profileId: string | null;
  stagedFiles: string[];
  lastUserAttachments?: string[];
  runState: SessionRunState;
  runDetail: string | null;
  runUpdatedAt: string | null;
  runPid: number | null;
  classification: SessionClassification | null;
  userStatus: 'inbox' | 'active' | 'review' | 'done' | 'parked' | null;
  userNote: string | null;
  lastQuestion: string | null;
  lastAnswer: string | null;
  lastMessageText: string | null;
  lastThinking: string | null;
  lastPlan: StreamPreviewPlan | null;
  migratedFrom: SessionLineageRef | null;
  migratedTo: SessionLineageRef | null;
  linkedSessions: SessionLineageRef[];
  numTurns?: number | null;
  handoverFrom?: HandoverRef | null;
}

export interface SessionLineageRef {
  agent: Agent;
  sessionId: string;
  kind?: 'migrate' | 'fork';
  forkedAtTurn?: number;
}

export interface HandoverRef {
  agent: Agent;
  sessionId: string;
}

export type SessionRunState = 'running' | 'completed' | 'incomplete';

export interface SessionClassification {
  outcome: 'answer' | 'proposal' | 'implementation' | 'partial' | 'blocked' | 'conversation';
  suggestedNextAction: string | null;
  summary: string;
  classifiedAt: string;
}

export interface AwaitResumeState {
  reason: string;
  since: string;
}

export interface SessionInfo {
  sessionId: string | null;
  agent: Agent;
  workdir: string | null;
  workspacePath: string | null;
  threadId?: string | null;
  model: string | null;
  thinkingEffort?: string | null;
  workflowEnabled?: boolean | null;
  profileId?: string | null;
  createdAt: string | null;
  title: string | null;
  running: boolean;
  runState: SessionRunState;
  runDetail: string | null;
  runUpdatedAt: string | null;
  runPid?: number | null;
  awaiting?: AwaitResumeState | null;
  classification: SessionClassification | null;
  userStatus: 'inbox' | 'active' | 'review' | 'done' | 'parked' | null;
  userNote: string | null;
  lastQuestion: string | null;
  lastAnswer: string | null;
  lastMessageText: string | null;
  migratedFrom: SessionLineageRef | null;
  migratedTo: SessionLineageRef | null;
  linkedSessions: SessionLineageRef[];
  numTurns: number | null;
  handoverFrom?: HandoverRef | null;
}

export interface SessionListResult {
  ok: boolean;
  sessions: SessionInfo[];
  error: string | null;
}

export interface SessionListOpts {
  agent: Agent;
  workdir: string;
  limit?: number;
}

export interface TailMessage { role: 'user' | 'assistant'; text: string; }

export interface MessageBlock {
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'image' | 'file' | 'plan' | 'sub_agent' | 'system_notice';
  content: string;
  toolName?: string;
  toolId?: string;
  phase?: 'commentary' | 'final_answer';
  plan?: StreamPreviewPlan | null;
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

export interface RichMessage {
  role: 'user' | 'assistant';
  text: string;
  blocks: MessageBlock[];
  usage?: StreamPreviewMeta | null;
}

export interface SessionTailResult {
  ok: boolean;
  messages: TailMessage[];
  error: string | null;
}

export interface SessionTailOpts {
  agent: Agent;
  sessionId: string;
  workdir: string;
  limit?: number;
}

export interface SessionMessagesOpts {
  sessionId: string;
  workdir: string;
  lastNTurns?: number;
  turnOffset?: number;
  turnLimit?: number;
  rich?: boolean;
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
  messages: TailMessage[];
  richMessages?: RichMessage[];
  totalTurns: number;
  window?: SessionMessagesWindow;
  error: string | null;
}

export interface StageSessionFilesOpts {
  agent: Agent;
  workdir: string;
  files: string[];
  sessionId?: string | null;
  title?: string | null;
  threadId?: string | null;
  handoverFrom?: HandoverRef | null;
}

export interface StageSessionFilesResult {
  sessionId: string;
  workspacePath: string;
  threadId: string | null;
  importedFiles: string[];
  handoverFrom: HandoverRef | null;
}

export interface EnsureManagedSessionOpts {
  agent: Agent;
  workdir: string;
  sessionId: string;
  title?: string | null;
  model?: string | null;
  thinkingEffort?: string | null;
  profileId?: string | null;
  threadId?: string | null;
}

export interface ExportSessionOpts {
  workdir: string;
  agent: Agent;
  sessionId: string;
  format: 'markdown' | 'json' | 'text';
  lastNTurns?: number;
}

export interface ExportSessionResult {
  ok: boolean;
  content: string;
  filename: string;
  error: string | null;
}

export interface ImportSessionOpts {
  workdir: string;
  agent: Agent;
  content: string;
  format?: 'markdown' | 'json' | 'text';
}

export interface ImportSessionResult {
  ok: boolean;
  messages: TailMessage[];
  error: string | null;
}

export interface MigrateSessionOpts {
  source: { workdir: string; agent: Agent; sessionId: string };
  target: { workdir: string; agent: Agent };
  lastNTurns?: number;
}

export interface AgentInfo {
  agent: string;
  installed: boolean;
  path: string | null;
  version: string | null;
}

export interface AgentListResult { agents: AgentInfo[]; }

export interface ModelInfo {
  id: string;
  alias: string | null;
  group?: 'native' | 'cloud' | 'local';
  profileId?: string | null;
  providerName?: string | null;
  online?: boolean;
}

export interface ModelListResult {
  agent: Agent;
  models: ModelInfo[];
  sources: string[];
  note: string | null;
}

export interface ModelListOpts {
  workdir?: string;
  currentModel?: string | null;
}

export interface UsageWindowInfo {
  label: string;
  usedPercent: number | null;
  remainingPercent: number | null;
  resetAt: string | null;
  resetAfterSeconds: number | null;
  status: string | null;
}

export interface UsageResult {
  ok: boolean;
  agent: Agent;
  source: string | null;
  capturedAt: string | null;
  status: string | null;
  windows: UsageWindowInfo[];
  error: string | null;
}

export interface UsageOpts {
  agent: Agent;
  model?: string | null;
}

export const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);
