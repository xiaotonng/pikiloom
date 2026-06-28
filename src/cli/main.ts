#!/usr/bin/env node

process.env.CLAUDECODE = '1';

import { hydrateLegacyEnv, migrateLegacyStateDir } from '../core/legacy-compat.js';
hydrateLegacyEnv();
migrateLegacyStateDir();

import { spawn } from 'node:child_process';
import path from 'node:path';
import { startAgentAutoUpdate } from '../agent/auto-update.js';
import { envBool, DEFAULT_RUN_TIMEOUT_S } from '../bot/bot.js';
import { DAEMON_TIMEOUTS } from '../core/constants.js';
import { hasConfiguredChannelToken, resolveConfiguredChannels } from './channels.js';
import { ChannelSupervisor } from './channel-supervisor.js';
import { listAgents } from '../agent/index.js';
import { startDashboard, type DashboardServer } from '../dashboard/server.js';
import { buildServerCode } from '../pikichannel/code.js';
import { buildSetupGuide, collectSetupState, hasReadyAgent, isSetupReady } from './onboarding.js';
import {
  buildRestartCommand,
  clearDaemonPidFile,
  clearRestartStateFile,
  consumeRestartStateFile,
  createRestartStateFilePath,
  isProcessAlive,
  PROCESS_RESTART_EXIT_CODE,
  readDaemonPidFile,
  requestProcessRestart,
  writeDaemonPidFile,
} from '../core/process-control.js';
import { runSetupWizard } from './setup-wizard.js';
import { FROM_LAUNCHD_ENV, maybePromptAutostart } from './autostart.js';
import {
  applyUserConfig,
  loadUserConfig,
  startUserConfigSync,
  updateUserConfig,
  type ChannelName,
  type UserConfig,
} from '../core/config/user-config.js';
import { VERSION } from '../core/version.js';

const DAEMON_RESTART_DELAY_MS = DAEMON_TIMEOUTS.restartDelay;
const DAEMON_MAX_RESTART_DELAY_MS = DAEMON_TIMEOUTS.maxRestartDelay;
const DAEMON_RAPID_CRASH_WINDOW_MS = DAEMON_TIMEOUTS.rapidCrashWindow;

function daemonLog(msg: string) {
  const ts = new Date().toTimeString().slice(0, 8);
  process.stdout.write(`[daemon ${ts}] ${msg}\n`);
}

const DAEMON_STRIP_ARGS = new Set(['--daemon', '--no-daemon']);

async function runDaemon(userArgs: string[]): Promise<never> {
  const forwardedArgs = userArgs.filter(a => !DAEMON_STRIP_ARGS.has(a));
  const restartCmd = process.env.PIKILOOM_RESTART_CMD;
  const restartStateFile = createRestartStateFilePath(process.pid);

  writeDaemonPidFile(process.pid);
  process.once('exit', clearDaemonPidFile);

  if (userArgs.includes('--daemon')) {
    maybePromptAutostart(daemonLog);
  }

  let restartDelay = DAEMON_RESTART_DELAY_MS;
  let attempt = 0;
  let nextRestartEnv: Record<string, string> = {};

  const spawnChild = (extraEnv: Record<string, string> = {}) => {
    clearRestartStateFile(restartStateFile);
    const { bin, args } = buildRestartCommand(forwardedArgs, restartCmd);
    daemonLog(`exec: ${bin} ${args.join(' ')}`);
    const needsShell = process.platform === 'win32' && !bin.endsWith('node.exe');
    return spawn(needsShell ? `"${bin}"` : bin, args, {
      stdio: 'inherit',
      shell: needsShell || undefined,
      env: {
        ...process.env,
        ...extraEnv,
        PIKILOOM_DAEMON_CHILD: '1',
        PIKILOOM_RESTART_STATE_FILE: restartStateFile,
        npm_config_yes: 'true',
      },
    });
  };

  // eslint-disable-next-line no-constant-condition
  while (true) {
    attempt++;
    daemonLog(`starting child process (attempt #${attempt})`);
    const child = spawnChild(nextRestartEnv);
    nextRestartEnv = {};
    daemonLog(`child running (pid=${child.pid})`);
    const startedAt = Date.now();

    let shutdownSignal: 'SIGINT' | 'SIGTERM' | null = null;

    const forwardShutdownSignal = (sig: 'SIGINT' | 'SIGTERM') => {
      shutdownSignal = sig;
      child.kill(sig);
    };
    const forwardRestartSignal = () => {
      child.kill('SIGUSR2');
    };
    process.on('SIGINT', forwardShutdownSignal);
    process.on('SIGTERM', forwardShutdownSignal);
    process.on('SIGUSR2', forwardRestartSignal);

    const code = await new Promise<number | null>(resolve => {
      child.on('exit', (c) => resolve(c));
    });

    process.removeListener('SIGINT', forwardShutdownSignal);
    process.removeListener('SIGTERM', forwardShutdownSignal);
    process.removeListener('SIGUSR2', forwardRestartSignal);

    if (shutdownSignal) {
      const exitCode = shutdownSignal === 'SIGINT' ? 130 : 143;
      daemonLog(`received ${shutdownSignal}, daemon stopping`);
      process.exit(exitCode);
    }

    if (code === PROCESS_RESTART_EXIT_CODE) {
      nextRestartEnv = consumeRestartStateFile(restartStateFile);
      restartDelay = DAEMON_RESTART_DELAY_MS;
      daemonLog('child requested restart, respawning immediately');
      continue;
    }

    if (code === 0 || code === null) {
      daemonLog(`child exited cleanly (code=${code}), daemon stopping`);
      process.exit(0);
    }

    const uptime = Date.now() - startedAt;
    if (uptime > DAEMON_RAPID_CRASH_WINDOW_MS) {
      restartDelay = DAEMON_RESTART_DELAY_MS;
    } else {
      restartDelay = Math.min(restartDelay * 2, DAEMON_MAX_RESTART_DELAY_MS);
    }

    daemonLog(`child crashed (code=${code}, uptime=${Math.round(uptime / 1000)}s), restarting in ${Math.round(restartDelay / 1000)}s...`);
    await new Promise(resolve => setTimeout(resolve, restartDelay));
  }
}

function parseArgs(argv: string[]) {
  const args: Record<string, any> = {
    token: null, agent: null, model: null, workdir: null,
    fullAccess: null, safeMode: false, allowedIds: null,
    timeout: null, version: false, help: false, doctor: false, setup: false,
    noDashboard: false, dashboardPort: null, daemon: true,
    stop: false,
  };
  const it = argv[Symbol.iterator]();
  for (const arg of it) {
    switch (arg) {
      case 'stop': args.stop = true; break;
      case '-t': case '--token': args.token = it.next().value; break;
      case '-a': case '--agent': args.agent = it.next().value; break;
      case '-m': case '--model': args.model = it.next().value; break;
      case '-w': case '--workdir': args.workdir = it.next().value; break;
      case '--full-access': args.fullAccess = true; break;
      case '--safe-mode': args.safeMode = true; break;
      case '--allowed-ids': args.allowedIds = it.next().value; break;
      case '--timeout': args.timeout = parseInt(it.next().value ?? '', 10); break;
      case '--doctor': args.doctor = true; break;
      case '--setup': args.setup = true; break;
      case '--no-dashboard': args.noDashboard = true; break;
      case '--server': args.server = true; break;
      case '--dashboard-port': args.dashboardPort = parseInt(it.next().value ?? '', 10); break;
      case '--daemon': args.daemon = true; break;
      case '--no-daemon': args.daemon = false; break;
      case '-v': case '--version': args.version = true; break;
      case '-h': case '--help': args.help = true; break;
      default:
        if (arg.startsWith('-')) { process.stderr.write(`Unknown option: ${arg}\n`); process.exit(1); }
    }
  }
  return args;
}

function processLog(message: string) {
  const ts = new Date().toTimeString().slice(0, 8);
  process.stdout.write(`[pikiloom ${ts}] ${message}\n`);
}

const listStartupAgents = () => listAgents().agents;
const listVerboseAgents = () => listAgents({ includeVersion: true }).agents;

async function handleMcpServeMode(): Promise<boolean> {
  if (process.argv.includes('--mcp-serve')) {
    await import('../agent/mcp/session-server.js');
    return true;
  }
  return false;
}

function printHelp(): never {
  process.stdout.write(
`pikiloom v${VERSION} — Run local coding agents through IM.

Run a bot that forwards IM messages to a local AI coding agent
(Claude Code or Codex CLI), streams responses in real-time, and manages
sessions, models, and workdirs.

Channels are auto-detected from configured credentials. If multiple
validated channels are enabled, they launch simultaneously.

Usage:
  npx pikiloom                              # auto-detect from config/env
  npx pikiloom -w ~/project                 # set working directory
  npx pikiloom stop                         # stop the running daemon

Options:
  -t, --token <token>       Channel auth token (env: PIKILOOM_TOKEN)
  -a, --agent <agent>       AI agent: claude | codex  [default: codex]
  -m, --model <model>       Default model, switchable in chat via /models
  -w, --workdir <dir>       Working directory for the agent  [default: current process cwd]
  --full-access             Codex full-access + Claude bypassPermissions + Gemini yolo/no-sandbox  [default]
  --safe-mode               Use safer agent permission modes
  --allowed-ids <id,id>     Comma-separated chat/user ID whitelist
  --timeout <seconds>       Max seconds per agent request  [default: ${DEFAULT_RUN_TIMEOUT_S}]
  --doctor                  Run setup checks and exit
  --setup                   Run the interactive setup wizard
  --server                  Headless server: keep the host running, don't open a browser, print a connection code
  --no-daemon               Disable watchdog (auto-restart on crash is ON by default)
  --no-dashboard            Skip the web dashboard
  --dashboard-port <port>   Dashboard port  [default: 3939]
  -v, --version             Print version
  -h, --help                Print this help

Environment variables (general):
  PIKILOOM_TOKEN             Channel auth token (same as -t, channel-agnostic)
  DEFAULT_AGENT              Default agent (same as -a)
  PIKILOOM_WORKDIR           Working directory (same as -w)
  PIKILOOM_TIMEOUT           Timeout in seconds (same as --timeout)
  PIKILOOM_ALLOWED_IDS       Comma-separated chat/user ID whitelist
  PIKILOOM_FULL_ACCESS       Default full-access behavior (true/false)

Environment variables (Telegram):
  TELEGRAM_BOT_TOKEN         Telegram bot token (from @BotFather)
  TELEGRAM_ALLOWED_CHAT_IDS  Comma-separated allowed Telegram chat IDs

Environment variables (Weixin):
  WEIXIN_BASE_URL            Weixin API base URL (default: https://ilinkai.weixin.qq.com)
  WEIXIN_BOT_TOKEN           Weixin bot token (normally configured from dashboard QR login)
  WEIXIN_ACCOUNT_ID          Weixin bot account ID

Environment variables (per agent):
  CLAUDE_MODEL               Claude model name
  CLAUDE_PERMISSION_MODE     Permission mode (default: bypassPermissions)
  CLAUDE_EXTRA_ARGS          Extra CLI args for claude
  CODEX_MODEL                Codex model name
  CODEX_REASONING_EFFORT     Reasoning effort (default: xhigh)
  CODEX_FULL_ACCESS          Full-access mode (default: true)
  CODEX_EXTRA_ARGS           Extra CLI args for codex
  GEMINI_MODEL               Gemini model name
  GEMINI_APPROVAL_MODE       Approval mode (default: yolo)
  GEMINI_SANDBOX             Sandbox mode (default: false)
  GEMINI_EXTRA_ARGS          Extra CLI args for gemini

Bot commands (available once running):
  /sessions   List or switch coding sessions
  /digest     Show a compact digest of recent sessions
  /agents     List or switch AI agents
  /models     List or switch models
  /status     Bot status, uptime, and token usage
  /host       Host machine info (CPU, memory, disk, battery)
  /switch     Browse and change working directory
  /restart    Restart with latest version

Environment variables (Feishu):
  FEISHU_APP_ID              Feishu app ID (from Feishu Open Platform)
  FEISHU_APP_SECRET          Feishu app secret
  FEISHU_DOMAIN              API domain (default: https://open.feishu.cn)
  FEISHU_ALLOWED_CHAT_IDS    Comma-separated allowed Feishu chat IDs

Notes:
  - weixin setup is QR-based in the dashboard and currently supports text-only replies.
  - --safe-mode delegates to the agent's own permission model; it does not add
    a pikiloom-specific approval workflow.

Prerequisites: Node.js >= 18, and at least one agent CLI installed (claude or codex).
Docs: https://github.com/xiaotonng/pikiloom
`);
  process.exit(0);
}

function persistWorkdir(args: Record<string, any>, userConfig: Partial<UserConfig>): Partial<UserConfig> {
  if (process.env.PIKILOOM_DAEMON_CHILD) return userConfig;
  if (process.env[FROM_LAUNCHD_ENV]) return userConfig;
  const explicitWorkdir = typeof args.workdir === 'string' && args.workdir.trim()
    ? args.workdir.trim()
    : '';
  if (!explicitWorkdir && userConfig.workdir) return userConfig;
  const nextWorkdir = path.resolve(explicitWorkdir || process.cwd());
  if (userConfig.workdir === nextWorkdir) return userConfig;
  updateUserConfig({ workdir: nextWorkdir });
  return loadUserConfig();
}

async function enterDaemonIfNeeded(args: Record<string, any>): Promise<void> {
  if (args.daemon && !process.env.PIKILOOM_DAEMON_CHILD) {
    await runDaemon(process.argv.slice(2));
  }
  if (!args.daemon) {
    delete process.env.PIKILOOM_DAEMON_CHILD;
  }
}

function installRestartSignalHandler(): void {
  const onSigusr2 = () => {
    processLog('SIGUSR2 received, restarting...');
    void requestProcessRestart({ log: processLog });
  };
  process.on('SIGUSR2', onSigusr2);
  process.once('exit', () => {
    process.off('SIGUSR2', onSigusr2);
  });
}

function installTopLevelShutdownHandler(): void {
  const GRACE_MS = 5_000;
  let shuttingDown = false;
  const onSignal = (sig: 'SIGINT' | 'SIGTERM') => {
    const exitCode = sig === 'SIGINT' ? 130 : 143;
    if (shuttingDown) {
      processLog(`${sig} again, forcing immediate exit`);
      process.exit(exitCode);
    }
    shuttingDown = true;
    processLog(`${sig} received, shutting down (force exit in ${GRACE_MS / 1000}s)...`);
    setTimeout(() => process.exit(exitCode), GRACE_MS);
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));
}

async function handleStopCommand(): Promise<never> {
  const pid = readDaemonPidFile();
  if (!pid) {
    process.stderr.write('pikiloom stop: no daemon PID file found (is pikiloom running in daemon mode?)\n');
    process.exit(1);
  }
  if (!isProcessAlive(pid)) {
    process.stdout.write(`pikiloom stop: daemon (pid ${pid}) is not running, clearing stale PID file\n`);
    clearDaemonPidFile();
    process.exit(0);
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ESRCH') {
      process.stdout.write(`pikiloom stop: daemon (pid ${pid}) already exited\n`);
      clearDaemonPidFile();
      process.exit(0);
    }
    process.stderr.write(`pikiloom stop: failed to signal pid ${pid}: ${err}\n`);
    process.exit(1);
  }
  process.stdout.write(`pikiloom stop: SIGTERM → pid ${pid}\n`);

  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      clearDaemonPidFile();
      process.stdout.write(`pikiloom stop: daemon (pid ${pid}) stopped\n`);
      process.exit(0);
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }

  process.stderr.write(`pikiloom stop: daemon (pid ${pid}) still alive after 8s, sending SIGKILL\n`);
  try { process.kill(pid, 'SIGKILL'); } catch {}
  clearDaemonPidFile();
  process.exit(0);
}

function runDoctorCheck(channel: ChannelName, tokenProvided: boolean): never {
  const setupState = collectSetupState({
    agents: listVerboseAgents(),
    channel,
    tokenProvided,
  });
  const guide = buildSetupGuide(setupState, VERSION, { doctor: true });
  const ready = isSetupReady(setupState);
  if (ready) process.stdout.write(`${guide}\nSetup looks ready.\n`);
  else process.stderr.write(guide);
  process.exit(ready ? 0 : 1);
}

async function awaitDashboardConfig(
  dashboard: DashboardServer,
  ctx: { userConfig: Partial<UserConfig>; configOverrides: Partial<UserConfig>; args: Record<string, any> },
): Promise<{ channels: ChannelName[]; channel: ChannelName }> {
  const ts = new Date().toTimeString().slice(0, 8);
  process.stdout.write(`[pikiloom ${ts}] waiting for configuration via dashboard...\n`);
  process.stdout.write(`[pikiloom ${ts}] configure at ${dashboard.url}; startup will continue automatically once ready.\n`);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    await new Promise(resolve => setTimeout(resolve, DAEMON_TIMEOUTS.configPollInterval));
    ctx.userConfig = loadUserConfig();
    const channels = resolveConfiguredChannels({
      config: { ...ctx.userConfig, ...ctx.configOverrides },
      tokenOverride: ctx.args.token,
    });
    const channel: ChannelName = channels[0] || 'feishu';

    const nextSetupState = collectSetupState({
      agents: listStartupAgents(),
      channel,
      tokenProvided: channels.length > 0 && hasConfiguredChannelToken({ ...ctx.userConfig, ...ctx.configOverrides }, channel, ctx.args.token),
    });
    const nextNeedsSetup = !hasReadyAgent(nextSetupState);
    if (!nextNeedsSetup) {
      const resumeTs = new Date().toTimeString().slice(0, 8);
      process.stdout.write(`[pikiloom ${resumeTs}] configuration detected, starting bot channels...\n`);
      return { channels, channel };
    }
  }
}

async function runSetupPhase(
  args: Record<string, any>,
  userConfig: Partial<UserConfig>,
  configOverrides: Partial<UserConfig>,
  channels: ChannelName[],
  channel: ChannelName,
  tokenProvided: boolean,
): Promise<{
  dashboard: DashboardServer | null;
  userConfig: Partial<UserConfig>;
  channels: ChannelName[];
  channel: ChannelName;
}> {
  const setupState = collectSetupState({
    agents: listStartupAgents(),
    channel,
    tokenProvided,
  });

  const useDashboard = !args.noDashboard && !args.setup;
  let dashboard: DashboardServer | null = null;
  const needsSetup = useDashboard
    ? !hasReadyAgent(setupState)
    : (channels.length === 0 || !tokenProvided || !hasReadyAgent(setupState));

  if (useDashboard) {
    const openBrowser =
      !args.server
      && !process.env[FROM_LAUNCHD_ENV]
      && !envBool('PIKILOOM_DOCKER', false)
      && envBool('PIKILOOM_OPEN_BROWSER', true);
    dashboard = await startDashboard({
      port: args.dashboardPort || 3939,
      open: openBrowser,
    });

    if (args.server) printServerConnectionCode(dashboard);

    if (needsSetup) {
      const ctx = { userConfig, configOverrides, args };
      const resolved = await awaitDashboardConfig(dashboard, ctx);
      userConfig = ctx.userConfig;
      channels = resolved.channels;
      channel = resolved.channel;
    }
  } else if (args.setup) {
    const canPromptInteractively = !!(process.stdin.isTTY && process.stdout.isTTY);
    if (!canPromptInteractively) {
      process.stderr.write('--setup requires an interactive terminal.\n');
      process.exit(1);
    }
    const wizard = await runSetupWizard({
      version: VERSION,
      channel,
      argsAgent: args.agent || userConfig.defaultAgent || null,
      currentToken: args.token || userConfig.telegramBotToken || null,
      initialState: setupState,
      listAgents: listVerboseAgents,
    });
    if (!wizard.completed) process.exit(1);
    userConfig = loadUserConfig();
  } else if (needsSetup) {
    process.stdout.write(buildSetupGuide(setupState, VERSION));
    process.exit(0);
  }

  return { dashboard, userConfig, channels, channel };
}

function printServerConnectionCode(dashboard: DashboardServer): void {
  const c = loadUserConfig();
  const sc = buildServerCode({
    token: process.env.PIKICHANNEL_TOKEN || c.pikichannelToken,
    nodeId: c.pikichannelNodeId,
    publicHost: process.env.PIKICHANNEL_PUBLIC_HOST || c.pikichannelPublicHost,
    rendezvous: process.env.PIKICHANNEL_RENDEZVOUS || c.pikichannelRendezvous,
  });
  const ts = new Date().toTimeString().slice(0, 8);
  process.stdout.write(`\n[pikiloom ${ts}] server mode — host running, browser not opened\n`);
  process.stdout.write(`  local console:  ${dashboard.url}\n`);
  if (sc.mode === 'none') {
    process.stdout.write('  to let others connect: set a public address (env PIKICHANNEL_PUBLIC_HOST,\n');
    process.stdout.write('     or the dashboard 连接 → 分享 panel), or enable internet access, then restart.\n\n');
  } else {
    process.stdout.write(`  connection code (${sc.mode === 'direct' ? 'direct → ' : 'NAT via '}${sc.detail}):\n`);
    process.stdout.write(`    ${sc.code}\n`);
    process.stdout.write('  paste it into a client → 连接 → 互联网/局域网.\n\n');
  }
}

function validatePostSetupChannels(
  configOverrides: Partial<UserConfig>,
  userConfig: Partial<UserConfig>,
  args: Record<string, any>,
  useDashboard: boolean,
): { channels: ChannelName[]; channel: ChannelName } {
  const effectiveConfig = { ...userConfig, ...configOverrides };
  const channels = resolveConfiguredChannels({
    config: effectiveConfig,
    tokenOverride: args.token,
  });
  const channel: ChannelName = channels[0] || 'feishu';

  const refreshedSetupState = collectSetupState({
    agents: listStartupAgents(),
    channel,
    tokenProvided: channels.length > 0,
  });

  if (!hasReadyAgent(refreshedSetupState)) {
    process.stderr.write(buildSetupGuide(refreshedSetupState, VERSION, { doctor: true }));
    process.exit(1);
  }

  if (channels.length === 0 && !useDashboard) {
    process.stdout.write(buildSetupGuide(refreshedSetupState, VERSION));
    process.exit(0);
  }

  return { channels, channel };
}

function applyRuntimeConfig(
  args: Record<string, any>,
  userConfig: Partial<UserConfig>,
  configOverrides: Partial<UserConfig>,
  channel: ChannelName,
): Partial<UserConfig> {
  const runtimeConfig: Partial<UserConfig> = { ...userConfig, ...configOverrides };

  if (args.token) {
    if (channel === 'telegram') runtimeConfig.telegramBotToken = args.token;
    else if (channel === 'feishu') {
      const [appId, ...rest] = args.token.split(':');
      runtimeConfig.feishuAppId = appId;
      runtimeConfig.feishuAppSecret = rest.join(':');
    }
  }
  if (args.allowedIds && channel === 'telegram') runtimeConfig.telegramAllowedChatIds = args.allowedIds;
  applyUserConfig(runtimeConfig, undefined, { overwrite: true, clearMissing: true });

  startAgentAutoUpdate({
    config: runtimeConfig,
    agents: listAgents({ includeVersion: true, refresh: true }).agents,
    log: processLog,
  });

  if (args.model) {
    const ag = args.agent || runtimeConfig.defaultAgent || 'codex';
    if (ag === 'codex') process.env.CODEX_MODEL = args.model;
    else if (ag === 'gemini') process.env.GEMINI_MODEL = args.model;
    else process.env.CLAUDE_MODEL = args.model;
  }
  if (args.timeout != null) process.env.PIKILOOM_TIMEOUT = String(args.timeout);

  if (args.safeMode) {
    process.env.CODEX_FULL_ACCESS = 'false';
    process.env.CLAUDE_PERMISSION_MODE = 'default';
    process.env.GEMINI_APPROVAL_MODE = 'default';
    process.env.GEMINI_SANDBOX = 'true';
  } else if (args.fullAccess || envBool('PIKILOOM_FULL_ACCESS', true)) {
    process.env.CODEX_FULL_ACCESS = 'true';
    process.env.CLAUDE_PERMISSION_MODE = 'bypassPermissions';
    process.env.GEMINI_APPROVAL_MODE = 'yolo';
    process.env.GEMINI_SANDBOX = 'false';
  }

  const syncOverrides: Partial<UserConfig> = {};
  if (args.agent) syncOverrides.defaultAgent = args.agent;
  if (args.token) {
    if (channel === 'telegram') syncOverrides.telegramBotToken = args.token;
    else if (channel === 'feishu') {
      const [appId, ...rest] = args.token.split(':');
      syncOverrides.feishuAppId = appId;
      syncOverrides.feishuAppSecret = rest.join(':');
    }
  }
  if (args.allowedIds && channel === 'telegram') syncOverrides.telegramAllowedChatIds = args.allowedIds;

  const stopUserConfigSync = startUserConfigSync({
    overrides: syncOverrides,
    log: message => processLog(message),
  });
  process.once('exit', stopUserConfigSync);

  return runtimeConfig;
}

async function launchChannels(
  channels: ChannelName[],
  dashboard: DashboardServer | null,
): Promise<void> {
  processLog(`launching channels: ${channels.join(', ')}`);
  const supervisor = new ChannelSupervisor({ dashboard, log: processLog });
  await supervisor.start();
  await new Promise<void>(() => {});
}

export async function main() {
  if (await handleMcpServeMode()) return;

  // Cutover gate: LOOM_KERNEL_APP=1 boots the backend on @pikiloom/kernel (new version)
  // instead of the legacy app. Non-PIKILOOM_ prefix so it survives dev.sh's env scrub.
  if (process.env.LOOM_KERNEL_APP === '1') {
    const { runKernelApp } = await import('./kernel-app.js');
    await runKernelApp(process.argv.slice(2));
    return;
  }

  const args = parseArgs(process.argv.slice(2));
  let userConfig = loadUserConfig();

  if (args.version) { process.stdout.write(`pikiloom ${VERSION}\n`); process.exit(0); }
  if (args.help) printHelp();
  if (args.stop) await handleStopCommand();

  userConfig = persistWorkdir(args, userConfig);

  await enterDaemonIfNeeded(args);

  installRestartSignalHandler();
  installTopLevelShutdownHandler();

  const configOverrides: Partial<UserConfig> = {};
  if (args.agent) configOverrides.defaultAgent = args.agent;
  applyUserConfig({ ...userConfig, ...configOverrides }, undefined, { overwrite: true, clearMissing: true });

  const effectiveConfig = () => ({ ...userConfig, ...configOverrides });
  let channels = resolveConfiguredChannels({ config: effectiveConfig(), tokenOverride: args.token });
  let channel: ChannelName = channels[0] || 'feishu';
  const tokenProvided = channels.length > 0 && hasConfiguredChannelToken(effectiveConfig(), channel, args.token);

  if (args.doctor) runDoctorCheck(channel, tokenProvided);

  const useDashboard = !args.noDashboard && !args.setup;
  let dashboard: DashboardServer | null;
  ({ dashboard, userConfig, channels, channel } = await runSetupPhase(
    args, userConfig, configOverrides, channels, channel, tokenProvided,
  ));

  ({ channels, channel } = validatePostSetupChannels(configOverrides, userConfig, args, useDashboard));

  applyRuntimeConfig(args, userConfig, configOverrides, channel);

  await launchChannels(channels, dashboard);
}

main().catch(err => { console.error(err); process.exit(1); });
