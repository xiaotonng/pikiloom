import path from 'node:path';

export const MCP_TIMEOUTS = {
  sendFile: 60_000,
  requestBody: 10_000,
  serverRequest: 90_000,
  serverHeaders: 10_000,
  codexMcpAdd: 10_000,
  codexMcpRemove: 5_000,
};

export const MCP_ARTIFACT_MAX_BYTES = 20 * 1024 * 1024;

export const DELIVERED_ARTIFACT_TAIL_STALE_MS = 60 * 60_000;

export const DASHBOARD_TIMEOUTS = {
  agentStatusModels: 4_000,
  agentStatusUsage: 1_500,
  channelStatusValidation: 3_000,
  channelStatusCacheTtl: 20_000,
  agentStatusCacheTtl: 30_000,
  agentInstall: 10 * 60_000,
  runCommand: 30_000,
};

export const STATE_DIR_NAME = '.pikiloom';
export const ENV_PREFIX = 'PIKILOOM_';
export const LEGACY_STATE_DIR_NAMES = ['.pikiclaw'] as const;
export const LEGACY_ENV_PREFIXES = ['PIKICLAW_'] as const;

export const MANAGED_BROWSER_PROFILE_SUBPATH = path.join(STATE_DIR_NAME, 'browser', 'chrome-profile');

export const PLAYWRIGHT_MCP_PACKAGE_NAME = '@playwright/mcp';
export const PLAYWRIGHT_MCP_PACKAGE_VERSION = '0.0.75';
export const PLAYWRIGHT_MCP_PACKAGE_SPEC = `${PLAYWRIGHT_MCP_PACKAGE_NAME}@${PLAYWRIGHT_MCP_PACKAGE_VERSION}`;
export const PLAYWRIGHT_MCP_BROWSER_ARGS = ['--browser', 'chrome', '--viewport-size', '1920x1080'] as const;

export const PIKILOOM_BROWSER_CDP_URL_ENV = 'PIKILOOM_BROWSER_CDP_URL';

export const DASHBOARD_PAGINATION = {
  defaultPageSize: 6,
  maxPageSize: 30,
};

export const DASHBOARD_PERMISSION_TIMEOUTS = {
  jxaDefault: 5_000,
  screenRecordingProbe: 5_000,
  screenRecordingPreflight: 4_000,
  screenRecordingRequest: 6_000,
  openSystemPreferences: 3_000,
  detectTerminal: 3_000,
};

export const DASHBOARD_PERMISSION_CACHE_TTL_MS = 30_000;

export const DAEMON_TIMEOUTS = {
  restartDelay: 3_000,
  maxRestartDelay: 60_000,
  rapidCrashWindow: 10_000,
  configPollInterval: 1_000,
};

export const BOT_SHUTDOWN_FORCE_EXIT_MS = 3_000;

export const BOT_TIMEOUTS = {
  defaultRunTimeoutS: 7200,
  macosUserActivityPulseInterval: 20_000,
  macosUserActivityPulseTimeoutS: 30,
};

export const STREAM_PREVIEW_TIMEOUTS = {
  heartbeat: 5_000,
  typing: 4_000,
  stalledNotice: 15_000,
};

export const TELEGRAM_LIMITS = {
  maxMessageLength: 4096,
  fileMaxBytes: 20 * 1024 * 1024,
  maxRetryDelay: 60_000,
};

export const FEISHU_LIMITS = {
  cardMax: 28_000,
  fileMaxBytes: 20 * 1024 * 1024,
  wsStartRetryMaxDelay: 60_000,
  wsStartRetryInitialDelay: 3_000,
};

export const FEISHU_BOT_CARD_MAX = 25_000;

export const WEIXIN_LIMITS = {
  maxMessageLength: 1200,
  longPollTimeout: 35_000,
  maxRetryDelay: 60_000,
};

export const SLACK_LIMITS = {
  maxMessageLength: 35_000,
  fileMaxBytes: 20 * 1024 * 1024,
  maxRetryDelay: 60_000,
  initialRetryDelay: 3_000,
};

export const DISCORD_LIMITS = {
  maxMessageLength: 1900,
  fileMaxBytes: 20 * 1024 * 1024,
  maxRetryDelay: 60_000,
  initialRetryDelay: 3_000,
};

export const DINGTALK_LIMITS = {
  maxMessageLength: 5_000,
  maxRetryDelay: 60_000,
  initialRetryDelay: 3_000,
};

export const WECOM_LIMITS = {
  maxMessageLength: 4_000,
  heartbeatInterval: 30_000,
  maxRetryDelay: 60_000,
  initialRetryDelay: 1_000,
  defaultEndpoint: 'wss://openws.work.weixin.qq.com/wssvr/',
};

export const VALIDATION_TIMEOUTS = {
  feishuDefault: 15_000,
  feishuBotInfo: 5_000,
  telegramToken: 8_000,
  weixinDefault: 8_000,
  weixinQrPoll: 35_000,
  slackDefault: 8_000,
  discordDefault: 8_000,
  dingtalkDefault: 8_000,
  wecomDefault: 8_000,
};

export const AGENT_UPDATE_TIMEOUTS = {
  lockStale: 60 * 60_000,
  commandTimeout: 15 * 60_000,
  npmPrefix: 10_000,
  npmView: 20_000,
  spawnWait: 2 * 60_000,
  spawnWaitPoll: 200,
};

export const AGENT_DETECT_TIMEOUTS = {
  detectTtl: 1_000,
  versionTtl: 5 * 60_000,
  versionCommand: 3_000,
};

export const AGENT_STREAM_HARD_KILL_GRACE_MS = 10_000;

export const AGENT_GRACEFUL_ABORT_GRACE_MS = 2_000;

export const CLAUDE_TUI_STALL_QUIET_MS = 10 * 60_000;
export const CLAUDE_TUI_STALL_PENDING_TOOL_MS = 30 * 60_000;
export const CLAUDE_TUI_STALL_PTY_DEAD_MS = 3 * 60_000;
export const CLAUDE_TUI_MODEL_ERROR_SETTLE_MS = 2_500;
export const CLAUDE_TUI_STOP_HOLD_QUIET_TTL_MS = 10 * 60_000;

export const CODEX_STREAM_HARD_KILL_GRACE_MS = 5_000;

export const SESSION_RUNNING_THRESHOLD_MS = 10_000;

export const CODEX_APPSERVER_SPAWN_TIMEOUT_MS = 15_000;

export const GEMINI_USAGE_TIMEOUTS = {
  request: 5_000,
  execSyncBuffer: 3_000,
};

export const USER_CONFIG_SYNC_DEFAULT_INTERVAL_MS = 1_000;

export const GIT_STATUS_TIMEOUT_MS = 5_000;
