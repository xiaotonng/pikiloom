/**
 * constants.ts — Centralized timeout, retry, and numeric constants.
 *
 * Grouped by domain / module so each subsystem can import only the
 * bucket it needs.
 */

import path from 'node:path';

// ---------------------------------------------------------------------------
// MCP bridge
// ---------------------------------------------------------------------------

/** Timeouts for the per-stream MCP callback server and tool operations. */
export const MCP_TIMEOUTS = {
  /** Max time to wait for the sendFile callback to complete. */
  sendFile: 60_000,
  /** Max time to receive the HTTP request body on the callback server. */
  requestBody: 10_000,
  /** Server-level: max time for an entire request lifecycle. */
  serverRequest: 90_000,
  /** Server-level: max time to receive request headers. */
  serverHeaders: 10_000,
  /** Timeout for `codex mcp add` registration commands. */
  codexMcpAdd: 10_000,
  /** Timeout for `codex mcp remove` cleanup commands. */
  codexMcpRemove: 5_000,
};

/** Maximum artifact file size the MCP bridge will accept (20 MB). */
export const MCP_ARTIFACT_MAX_BYTES = 20 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

/** Timeouts used by the dashboard HTTP server and its status endpoints. */
export const DASHBOARD_TIMEOUTS = {
  /** Timeout for agent model discovery (Codex cold-start can be slow). */
  agentStatusModels: 4_000,
  /** Timeout for agent usage data fetch. */
  agentStatusUsage: 1_500,
  /** Timeout for channel credential validation requests. */
  channelStatusValidation: 3_000,
  /** How long validated channel states are cached before re-checking. */
  channelStatusCacheTtl: 20_000,
  /** How long the full agent-status response is cached (SWR). */
  agentStatusCacheTtl: 30_000,
  /** Timeout for agent npm install via the dashboard. */
  agentInstall: 10 * 60_000,
  /** Default timeout for dashboard-spawned shell commands. */
  runCommand: 30_000,
};

// ---------------------------------------------------------------------------
// Browser automation
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Brand / state-dir / env identifiers — single source of truth
// ---------------------------------------------------------------------------

/** Home state directory name: `~/.pikiloom`. */
export const STATE_DIR_NAME = '.pikiloom';
/** Env var prefix for all pikiloom-specific variables. */
export const ENV_PREFIX = 'PIKILOOM_';
/**
 * Pre-rename identifier (`pikiclaw`). Kept ONLY for the one-time state-dir
 * migration, the env-var fallback (see core/legacy-compat.ts) and project-skill
 * discovery, so the real pikiclaw install base is never orphaned. Kept as lists
 * so a future rename only appends one entry. Drop a couple releases later.
 */
export const LEGACY_STATE_DIR_NAMES = ['.pikiclaw'] as const;
export const LEGACY_ENV_PREFIXES = ['PIKICLAW_'] as const;

/**
 * Stable relative path for the managed Chrome profile under the home directory.
 * Keep this outside config-specific directories so `npm run dev` and the main
 * runtime share the same browser login state.
 */
export const MANAGED_BROWSER_PROFILE_SUBPATH = path.join(STATE_DIR_NAME, 'browser', 'chrome-profile');

/** Base Playwright MCP args for the managed browser integration. */
export const PLAYWRIGHT_MCP_PACKAGE_NAME = '@playwright/mcp';
export const PLAYWRIGHT_MCP_PACKAGE_VERSION = '0.0.75';
export const PLAYWRIGHT_MCP_PACKAGE_SPEC = `${PLAYWRIGHT_MCP_PACKAGE_NAME}@${PLAYWRIGHT_MCP_PACKAGE_VERSION}`;
export const PLAYWRIGHT_MCP_BROWSER_ARGS = ['--browser', 'chrome', '--viewport-size', '1920x1080'] as const;

/**
 * Env var name for pointing pikiloom at an external Chrome DevTools Protocol
 * endpoint (e.g. `http://chromium:9222`) instead of launching a local Chrome.
 * Primary use cases: Docker deployments that run a sidecar like
 * `lscr.io/linuxserver/chromium`, or attaching to a remote browser the user
 * already manages. When set, browser-supervisor skips every local-launch
 * codepath (no Chrome detection, no pid SIGKILL on restart) and pipes the URL
 * through to Playwright MCP's `--cdp-endpoint`.
 */
export const PIKILOOM_BROWSER_CDP_URL_ENV = 'PIKILOOM_BROWSER_CDP_URL';

/** Dashboard session pagination limits. */
export const DASHBOARD_PAGINATION = {
  defaultPageSize: 6,
  maxPageSize: 30,
};

/** Timeouts for macOS permission checks and JXA scripts (dashboard). */
export const DASHBOARD_PERMISSION_TIMEOUTS = {
  /** Default timeout for osascript / JXA calls. */
  jxaDefault: 5_000,
  /** Timeout for screencapture permission probe. */
  screenRecordingProbe: 5_000,
  /** Timeout for CGPreflight screen capture check. */
  screenRecordingPreflight: 4_000,
  /** Timeout for CGRequest screen capture request. */
  screenRecordingRequest: 6_000,
  /** Timeout for `open` command to launch System Preferences. */
  openSystemPreferences: 3_000,
  /** Timeout for parent process tree detection. */
  detectTerminal: 3_000,
};

/**
 * TTL for cached dashboard permission / host-terminal probes. `/api/state` is
 * polled (~1.5s while a channel validates) and each probe spawns subprocesses
 * (screencapture, an `ls` shell, a `ps` process-tree walk), so the raw checks
 * must not run per request. The host terminal is immutable per process;
 * permission grants change rarely and `requestPermission` invalidates the cache
 * on user action, so a short TTL surfaces grants without per-request spawns.
 */
export const DASHBOARD_PERMISSION_CACHE_TTL_MS = 30_000;

// ---------------------------------------------------------------------------
// CLI / Daemon
// ---------------------------------------------------------------------------

/** Daemon (watchdog) restart timing constants. */
export const DAEMON_TIMEOUTS = {
  /** Initial delay before restarting a crashed child. */
  restartDelay: 3_000,
  /** Maximum back-off delay for repeated rapid crashes. */
  maxRestartDelay: 60_000,
  /** If the child runs shorter than this, treat it as a rapid crash. */
  rapidCrashWindow: 10_000,
  /** Polling interval while waiting for dashboard config to become ready. */
  configPollInterval: 1_000,
};

// ---------------------------------------------------------------------------
// Bot orchestration / shutdown
// ---------------------------------------------------------------------------

/** Time to wait before force-exiting during bot shutdown. */
export const BOT_SHUTDOWN_FORCE_EXIT_MS = 3_000;

// ---------------------------------------------------------------------------
// Bot runtime
// ---------------------------------------------------------------------------

/** Bot-level timing constants. */
export const BOT_TIMEOUTS = {
  /** Default run timeout for agent streams (seconds). */
  defaultRunTimeoutS: 7200,
  /** Interval for macOS user-activity caffeinate pulses. */
  macosUserActivityPulseInterval: 20_000,
  /** Timeout (seconds) for the caffeinate assertion per pulse. */
  macosUserActivityPulseTimeoutS: 30,
};

// ---------------------------------------------------------------------------
// Live preview (stream feedback)
// ---------------------------------------------------------------------------

/** Timing constants for the channel-agnostic live preview controller. */
export const STREAM_PREVIEW_TIMEOUTS = {
  /** Interval between heartbeat edits that refresh the elapsed timer. */
  heartbeat: 5_000,
  /** Interval between typing indicator pulses. */
  typing: 4_000,
  /** After this idle time, a "stalled" notice is shown. */
  stalledNotice: 15_000,
};

// ---------------------------------------------------------------------------
// Channels — Telegram
// ---------------------------------------------------------------------------

/** Telegram channel transport constants. */
export const TELEGRAM_LIMITS = {
  /** Maximum text length per Telegram message. */
  maxMessageLength: 4096,
  /** Maximum file size for send/receive (20 MB). */
  fileMaxBytes: 20 * 1024 * 1024,
  /** Maximum back-off delay for polling/connect retries. */
  maxRetryDelay: 60_000,
};

// ---------------------------------------------------------------------------
// Channels — Feishu
// ---------------------------------------------------------------------------

/** Feishu channel transport constants. */
export const FEISHU_LIMITS = {
  /** Card markdown budget (card JSON limit ~30 KB). */
  cardMax: 28_000,
  /** Maximum file size for send/receive (20 MB). */
  fileMaxBytes: 20 * 1024 * 1024,
  /** Maximum back-off delay for WebSocket reconnection retries. */
  wsStartRetryMaxDelay: 60_000,
  /** Initial retry delay for Feishu WebSocket connection. */
  wsStartRetryInitialDelay: 3_000,
};

/** Feishu bot rendering limit for card payloads. */
export const FEISHU_BOT_CARD_MAX = 25_000;

// ---------------------------------------------------------------------------
// Channels — Weixin
// ---------------------------------------------------------------------------

/** Weixin channel transport constants. */
export const WEIXIN_LIMITS = {
  /** Conservative text split budget for plain-text replies. */
  maxMessageLength: 1200,
  /** Long-poll timeout for getupdates. */
  longPollTimeout: 35_000,
  /** Maximum back-off delay for polling retries. */
  maxRetryDelay: 60_000,
};

// ---------------------------------------------------------------------------
// Channels — Slack
// ---------------------------------------------------------------------------

/** Slack channel transport constants. */
export const SLACK_LIMITS = {
  /** Slack chat.postMessage hard limit is 40000; cap at 35k for safety. */
  maxMessageLength: 35_000,
  /** Slack file upload size cap (1 GB); we keep parity with other channels at 20 MB. */
  fileMaxBytes: 20 * 1024 * 1024,
  /** Maximum back-off delay for socket-mode reconnect retries. */
  maxRetryDelay: 60_000,
  /** Initial back-off delay for socket-mode reconnect. */
  initialRetryDelay: 3_000,
};

// ---------------------------------------------------------------------------
// Channels — Discord
// ---------------------------------------------------------------------------

/** Discord channel transport constants. */
export const DISCORD_LIMITS = {
  /** Hard message cap is 2000 chars; leave a small buffer. */
  maxMessageLength: 1900,
  /** File size cap for non-Nitro guilds is 25 MB; we keep parity at 20 MB. */
  fileMaxBytes: 20 * 1024 * 1024,
  /** Maximum back-off delay for gateway reconnect retries. */
  maxRetryDelay: 60_000,
  /** Initial back-off delay for gateway reconnect. */
  initialRetryDelay: 3_000,
};

// ---------------------------------------------------------------------------
// Channels — DingTalk
// ---------------------------------------------------------------------------

/** DingTalk channel transport constants. */
export const DINGTALK_LIMITS = {
  /** Conservative text limit per message (markdown segments split here). */
  maxMessageLength: 5_000,
  /** Maximum back-off delay for stream reconnect retries. */
  maxRetryDelay: 60_000,
  /** Initial back-off delay for stream reconnect. */
  initialRetryDelay: 3_000,
};

// ---------------------------------------------------------------------------
// Channels — WeChat Work (企业微信 智能机器人)
// ---------------------------------------------------------------------------

/** WeChat Work Smart Bot WebSocket transport constants. */
export const WECOM_LIMITS = {
  /** Smart Bot text message hard cap is roughly 5KB chars. */
  maxMessageLength: 4_000,
  /** Heartbeat interval to keep the websocket alive. */
  heartbeatInterval: 30_000,
  /** Maximum back-off delay for websocket reconnect retries. */
  maxRetryDelay: 60_000,
  /** Initial back-off delay for websocket reconnect. */
  initialRetryDelay: 1_000,
  /** Default smart bot websocket endpoint. */
  defaultEndpoint: 'wss://openws.work.weixin.qq.com/wssvr/',
};

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

/** Timeouts for channel credential validation flows. */
export const VALIDATION_TIMEOUTS = {
  /** Default timeout for Feishu credential validation. */
  feishuDefault: 15_000,
  /** Timeout for fetching Feishu bot info after credential validation. */
  feishuBotInfo: 5_000,
  /** Timeout for Telegram token validation (setup wizard). */
  telegramToken: 8_000,
  /** Default timeout for Weixin credential validation. */
  weixinDefault: 8_000,
  /** Long-poll timeout for dashboard QR login wait calls. */
  weixinQrPoll: 35_000,
  /** Default timeout for Slack credential validation. */
  slackDefault: 8_000,
  /** Default timeout for Discord credential validation. */
  discordDefault: 8_000,
  /** Default timeout for DingTalk credential validation (gettoken endpoint). */
  dingtalkDefault: 8_000,
  /** Default timeout for WeChat Work bot validation handshake. */
  wecomDefault: 8_000,
};

// ---------------------------------------------------------------------------
// Agent auto-update
// ---------------------------------------------------------------------------

/** Timeouts for the background agent auto-update system. */
export const AGENT_UPDATE_TIMEOUTS = {
  /** After this duration a stale lock file is removed. */
  lockStale: 60 * 60_000,
  /** Maximum time for an agent update command to run. */
  commandTimeout: 15 * 60_000,
  /** Timeout for `npm prefix -g`. */
  npmPrefix: 10_000,
  /** Timeout for `npm view <pkg> version`. */
  npmView: 20_000,
  /** Max time an agent spawn waits for an in-flight reinstall of that agent's
   *  own CLI to finish before exec'ing. A concurrent `npm install -g` / `brew
   *  upgrade` (this process OR the prod self-bootstrap) briefly removes the bin
   *  symlink, so racing it yields exit 127 "command not found"; the wait
   *  resolves early the instant the install ends. */
  spawnWait: 2 * 60_000,
  /** Poll interval while a spawn waits out an in-flight reinstall. */
  spawnWaitPoll: 200,
};

// ---------------------------------------------------------------------------
// Code agent (shared layer)
// ---------------------------------------------------------------------------

/** Caching TTLs for agent detection and version lookups. */
export const AGENT_DETECT_TIMEOUTS = {
  /** How long a binary-detection result is cached. */
  detectTtl: 1_000,
  /** How long a version string is cached. */
  versionTtl: 5 * 60_000,
  /** Timeout for the `--version` command itself. */
  versionCommand: 3_000,
};

/** Grace period added to the user-configured timeout before hard-killing the agent. */
export const AGENT_STREAM_HARD_KILL_GRACE_MS = 10_000;

/**
 * On user abort, wait this long for the agent CLI to flush its session JSONL
 * (including any `[Request interrupted]` marker) before falling back to
 * SIGTERM. Keeps the partial assistant response persisted so the next task,
 * resumed via --resume, can see it in the transcript.
 */
export const AGENT_GRACEFUL_ABORT_GRACE_MS = 2_000;

/**
 * claude-tui stall watchdog — claude CLI is known to freeze mid-turn (observed
 * 2026-06-02 on 2.1.160: after a tool_result lands, the next assistant segment
 * never starts; the process stays alive, the JSONL goes permanently quiet, no
 * Stop hook ever fires). When every live signal (main JSONL, hook tool events,
 * sub-agent sidecars, hook lifecycle state) is silent past the threshold the
 * driver SIGTERMs the PTY and the dispatch wrapper auto-resumes the session
 * once. Quiet threshold must sit safely above the longest healthy gap between
 * JSONL events — a single max-effort inference can take a few minutes before
 * its first content block lands.
 */
export const CLAUDE_TUI_STALL_QUIET_MS = 10 * 60_000;
/**
 * Stall threshold while a hook-reported tool is still executing (PreToolUse
 * seen, no matching PostToolUse). Claude's own Bash timeout caps foreground
 * commands at ~10 minutes and fires PostToolUse either way, so a pending tool
 * silent for this long means the freeze hit mid-execution.
 */
export const CLAUDE_TUI_STALL_PENDING_TOOL_MS = 30 * 60_000;
/**
 * Fast-path stall: a healthy claude TUI repaints continuously while a turn is
 * in flight (spinner frames, stream ticks, status line) — the PTY never goes
 * byte-silent for minutes. If NO PTY output arrives for this long AND every
 * structured signal is equally quiet, the process event loop itself is gone
 * (the 2.1.160 mid-turn freeze: attachment lands → next API call never
 * assembles). Declare the stall now instead of waiting out the 10/30-minute
 * quiet thresholds — turns a 10-30 分钟「卡死」into a ~3 分钟自愈。
 * False-positive safe: long thinking / long Bash keep painting frames, which
 * refreshes the PTY signal and defers this path to the slow thresholds.
 */
export const CLAUDE_TUI_STALL_PTY_DEAD_MS = 3 * 60_000;
/**
 * Settle window after the TUI paints the "selected model is unavailable" banner
 * (a 404 model_not_found). The notice is terminal — claude paints it then idles
 * at the REPL forever: no JSONL is written, no Stop hook fires. We wait this
 * brief window to cross-validate that nothing substantive followed (the banner
 * alone is evidence, not a verdict — same discipline as resolveClaudeTuiLimitOutcome)
 * before ending the turn, instead of waiting out the 3–10 minute stall watchdog.
 */
export const CLAUDE_TUI_MODEL_ERROR_SETTLE_MS = 2_500;
/**
 * TTL for the post-Stop `hold-background` path. The hold protects
 * run_in_background agents living inside the claude process — but a live
 * agent keeps emitting hook/sidecar/JSONL traffic. If the hold sees no
 * activity on ANY channel for this long, the pending count is phantom (lost
 * <task-notification>, agents already finished): release as a NORMAL Stop.
 * Without this TTL the stall watchdog eventually fires instead, mislabels the
 * cleanly-finished turn 'stalled', and injects a confusing auto-resume prompt
 * (the「回合明明答完了还被注入 Continue」symptom).
 */
export const CLAUDE_TUI_STOP_HOLD_QUIET_TTL_MS = 10 * 60_000;

/** Codex-specific grace period added to the user-configured timeout. */
export const CODEX_STREAM_HARD_KILL_GRACE_MS = 5_000;

/**
 * If a session file was modified more recently than this threshold,
 * consider the session "running". Shared across Claude, Codex, and Gemini drivers.
 */
export const SESSION_RUNNING_THRESHOLD_MS = 10_000;

// ---------------------------------------------------------------------------
// Driver — Codex
// ---------------------------------------------------------------------------

/** Timeout for the Codex app-server to become ready after spawn. */
export const CODEX_APPSERVER_SPAWN_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Driver — Gemini
// ---------------------------------------------------------------------------

/** Timeouts for Gemini usage / quota queries. */
export const GEMINI_USAGE_TIMEOUTS = {
  /** Max time for the curl quota request. */
  request: 5_000,
  /** Extra buffer added to the curl timeout for the execSync wrapper. */
  execSyncBuffer: 3_000,
};

// ---------------------------------------------------------------------------
// User config sync
// ---------------------------------------------------------------------------

/** Default interval for the user config file sync poll. */
export const USER_CONFIG_SYNC_DEFAULT_INTERVAL_MS = 1_000;

// ---------------------------------------------------------------------------
// Git status
// ---------------------------------------------------------------------------

/**
 * Upper bound for a single `git status` invocation. Bounded so a huge repo or a
 * stuck `.git/index.lock` can never block `/status` or a workspace poll. Matches
 * the timeout used by the existing `/api/git-changes` endpoint.
 */
export const GIT_STATUS_TIMEOUT_MS = 5_000;
