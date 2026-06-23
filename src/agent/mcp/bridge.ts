import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  ensurePlaywrightMcpConfigFile,
  getConfiguredRemoteCdpUrl,
  getManagedBrowserProfileDir,
  resolveManagedBrowserCdpEndpoint,
  resolveManagedBrowserMcpCommand,
} from '../../browser-profile.js';
import { loadUserConfig } from '../../core/config/user-config.js';
import { MCP_TIMEOUTS, MCP_ARTIFACT_MAX_BYTES } from '../../core/constants.js';
import type { AgentInteraction, AgentInteractionQuestion } from '../types.js';
import { mergeExtensionsForSession, getGlobalExtensionsAsServers } from './extensions.js';

export interface McpSendFileOpts {
  caption?: string;
  kind?: 'photo' | 'document';
}

export interface McpSendFileResult {
  ok: boolean;
  error?: string;
}

export type McpSendFileCallback = (
  filePath: string,
  opts: McpSendFileOpts,
) => Promise<McpSendFileResult>;

export type AskUserCallback = (
  request: AgentInteraction,
) => Promise<Record<string, any> | null>;

export interface McpBridgeHandle {
  configPath: string;
  extraEnv?: Record<string, string>;
  mcpServers?: Record<string, any>;
  hadActivity: () => boolean;
  stop: () => Promise<void>;
}

export interface McpBridgeOpts {
  sessionDir: string;
  workspacePath: string;
  workdir?: string;
  stagedFiles: string[];
  sendFile?: McpSendFileCallback;
  onInteraction?: AskUserCallback;
  agent?: string;
  onLog?: (message: string) => void;
}

interface McpServerRuntimeInfo {
  execPath: string;
  execArgv: string[];
  argv: string[];
  moduleUrl: string;
}

interface RegisteredMcpServer {
  name: string;
  type?: 'stdio' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export interface GuiIntegrationConfig {
  browserEnabled: boolean;
  browserProfileDir: string;
  browserHeadless: boolean;
  peekabooEnabled: boolean;
}

function sanitizeExecArgv(execArgv: string[]): string[] {
  return execArgv.filter(arg => !/^--inspect(?:-brk)?(?:=.*)?$/.test(arg));
}

function resolveCurrentCliCommand(
  runtime: McpServerRuntimeInfo,
  extraArgs: string[],
): { command: string; args: string[] } | null {
  const entryScript = runtime.argv[1] ? path.resolve(runtime.argv[1]) : '';
  const base = path.basename(entryScript).toLowerCase();
  if (!entryScript || !fs.existsSync(entryScript)) return null;
  if (base !== 'main.js' && base !== 'main.ts' && base !== 'cli.js' && base !== 'cli.ts') return null;
  return {
    command: runtime.execPath,
    args: [...sanitizeExecArgv(runtime.execArgv), entryScript, ...extraArgs],
  };
}

export function resolveMcpServerCommand(runtime: McpServerRuntimeInfo = {
  execPath: process.execPath,
  execArgv: process.execArgv,
  argv: process.argv,
  moduleUrl: import.meta.url,
}): { command: string; args: string[] } {
  const currentProcess = resolveCurrentCliCommand(runtime, ['--mcp-serve']);
  if (currentProcess) return currentProcess;

  const thisDir = path.dirname(fileURLToPath(runtime.moduleUrl));
  const serverScript = path.join(thisDir, 'session-server.js');
  if (fs.existsSync(serverScript)) {
    return { command: 'node', args: [serverScript] };
  }
  const cliScript = path.resolve(thisDir, '../../cli/main.js');
  if (fs.existsSync(cliScript)) {
    return { command: 'node', args: [cliScript, '--mcp-serve'] };
  }
  return { command: 'pikiloom', args: ['--mcp-serve'] };
}

function parseOptionalBool(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!text) return null;
  if (['1', 'true', 'yes', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'off'].includes(text)) return false;
  return null;
}

function boolFromConfigEnv(configValue: unknown, envValue: unknown, fallback: boolean): boolean {
  const envParsed = parseOptionalBool(envValue);
  if (envParsed != null) return envParsed;
  const configParsed = parseOptionalBool(configValue);
  if (configParsed != null) return configParsed;
  return fallback;
}

export function resolveGuiIntegrationConfig(
  config = loadUserConfig(),
  env: Record<string, string | undefined> = process.env,
): GuiIntegrationConfig {
  const browserEnabled = boolFromConfigEnv(
    typeof config.browserEnabled === 'boolean' ? config.browserEnabled : (config as Record<string, unknown>).browserUseProfile,
    env.PIKILOOM_BROWSER_ENABLED ?? env.PIKILOOM_BROWSER_USE_PROFILE,
    !!getConfiguredRemoteCdpUrl(env),
  );
  const peekabooEnabled = boolFromConfigEnv(
    config.peekabooEnabled,
    env.PIKILOOM_PEEKABOO_ENABLED,
    false,
  );
  return {
    browserEnabled,
    browserProfileDir: getManagedBrowserProfileDir(),
    browserHeadless: boolFromConfigEnv(config.browserHeadless, env.PIKILOOM_BROWSER_HEADLESS, false),
    peekabooEnabled,
  };
}

export interface BrowserSupervisorEndpoints {
  cdpEndpoint?: string | null;
}

export const PEEKABOO_NPX_PACKAGE = '@steipete/peekaboo';
export const PEEKABOO_MCP_ARGV = ['-y', '-p', PEEKABOO_NPX_PACKAGE, 'peekaboo-mcp'];
export const PEEKABOO_WARM_ARGV = ['-y', '-p', PEEKABOO_NPX_PACKAGE, 'peekaboo', '--version'];

let peekabooWarmStarted = false;

const PEEKABOO_ENV_ALLOWLIST = [
  'HOME',
  'PATH',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
] as const;
const PEEKABOO_DEFAULT_PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';

function cleanEnvString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes('\0')) return null;
  return trimmed;
}

export function buildPeekabooChildEnv(
  env: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const key of PEEKABOO_ENV_ALLOWLIST) {
    const value = cleanEnvString(env[key]);
    if (value) safe[key] = value;
  }
  safe.PATH ||= PEEKABOO_DEFAULT_PATH;
  safe.HOME ||= os.homedir();
  safe.PIKILOOM_MCP_SERVER = 'peekaboo';
  safe.npm_config_yes = 'true';
  return safe;
}

function peekabooEnvArgs(env: Record<string, string>): string[] {
  return Object.entries(env).map(([key, value]) => `${key}=${value}`);
}

function buildPeekabooMcpServer(): RegisteredMcpServer {
  const safeEnv = buildPeekabooChildEnv();
  return {
    name: 'peekaboo',
    command: '/usr/bin/env',
    args: ['-i', ...peekabooEnvArgs(safeEnv), 'npx', ...PEEKABOO_MCP_ARGV],
  };
}

export function ensurePeekabooWarm(): void {
  if (process.platform !== 'darwin' || peekabooWarmStarted) return;
  peekabooWarmStarted = true;
  try {
    const child = spawn('npx', PEEKABOO_WARM_ARGV, {
      stdio: 'ignore',
      detached: true,
      env: buildPeekabooChildEnv(),
    });
    child.on('error', () => { peekabooWarmStarted = false; });
    child.unref();
  } catch {
    peekabooWarmStarted = false;
  }
}

export function buildSupplementalMcpServers(
  gui: GuiIntegrationConfig = resolveGuiIntegrationConfig(),
  endpoints: BrowserSupervisorEndpoints = {},
): RegisteredMcpServer[] {
  const servers: RegisteredMcpServer[] = [];
  if (gui.browserEnabled) {
    const profileDir = gui.browserProfileDir || getManagedBrowserProfileDir();
    const cdpEndpoint = (endpoints.cdpEndpoint || '').trim() || null;
    const browserServer = resolveManagedBrowserMcpCommand(profileDir, {
      headless: gui.browserHeadless,
      cdpEndpoint,
    });
    servers.push({
      name: 'pikiloom-browser',
      command: browserServer.command,
      args: browserServer.args,
    });
  }
  if (gui.peekabooEnabled && process.platform === 'darwin') {
    servers.push(buildPeekabooMcpServer());
  }
  return servers;
}

export function buildGuiSetupHints(gui: GuiIntegrationConfig = resolveGuiIntegrationConfig()): string[] {
  const hints: string[] = [];
  if (gui.browserEnabled) {
    hints.push(
      `managed browser profile mode enabled; runtime sessions reuse ${gui.browserProfileDir || getManagedBrowserProfileDir()}; configured MCP browser mode=${gui.browserHeadless ? 'headless' : 'headed'}. This mode keeps automation isolated from your everyday browser. If the managed browser is already open, pikiloom will try to attach to it first. When using browser_tabs, use action="new" to open a tab, not "create".`,
    );
  }
  if (gui.peekabooEnabled && process.platform === 'darwin') {
    hints.push(
      'Peekaboo enabled — native macOS GUI tools (see / click / type / scroll / window / menu / app / dock) via Accessibility + ScreenCaptureKit. Prefer element-ID interactions (call `see` first) over raw coordinates.',
    );
  }
  return hints;
}

function buildClaudeMcpConfig(servers: RegisteredMcpServer[]) {
  return {
    mcpServers: Object.fromEntries(servers.map(server => [
      server.name,
      { type: 'stdio', command: server.command, args: server.args, ...(server.env ? { env: server.env } : {}) },
    ])),
  };
}

export function buildCodexMcpAddArgs(
  server: RegisteredMcpServer,
  tokenEnv: Record<string, string>,
): string[] | null {
  if (server.type === 'http') {
    if (!server.url) return null;
    const args = ['mcp', 'add', server.name, '--url', server.url];
    const bearer = extractBearerToken(server.headers);
    if (bearer) {
      const envName = codexBearerEnvName(server.name);
      tokenEnv[envName] = bearer;
      args.push('--bearer-token-env-var', envName);
    }
    return args;
  }
  if (!server.command) return null;
  const args = ['mcp', 'add', server.name];
  for (const [k, v] of Object.entries(server.env || {})) args.push('--env', `${k}=${v}`);
  args.push('--', server.command, ...(server.args || []));
  return args;
}

function extractBearerToken(headers?: Record<string, string>): string | null {
  if (!headers) return null;
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== 'authorization') continue;
    const m = /^\s*Bearer\s+(.+)$/i.exec(v);
    if (m) return m[1].trim();
  }
  return null;
}

function codexBearerEnvName(serverName: string): string {
  const safe = serverName.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return `PIKILOOM_MCP_BEARER_${safe || 'UNNAMED'}`;
}

const REDACTED = '[REDACTED]';
const SENSITIVE_CONFIG_KEY_RE = /(authorization|bearer|token|secret|password|passwd|api[_-]?key|credential|cookie|session|connection[_-]?string|dsn)/i;
const URL_PASSWORD_RE = /([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^@\s/]+)@/gi;
const QUERY_SECRET_RE = /([?&](?:access_token|api[_-]?key|key|token|secret|password|passwd)=)[^&\s]+/gi;

function redactStringForLog(key: string, value: string): string {
  if (SENSITIVE_CONFIG_KEY_RE.test(key)) {
    const bearer = /^\s*Bearer\s+/i.test(value);
    return bearer ? `Bearer ${REDACTED}` : REDACTED;
  }
  return value
    .replace(URL_PASSWORD_RE, `$1$2:${REDACTED}@`)
    .replace(QUERY_SECRET_RE, `$1${REDACTED}`);
}

function redactForLog(value: unknown, key = ''): unknown {
  if (typeof value === 'string') return redactStringForLog(key, value);
  if (Array.isArray(value)) return value.map(item => redactForLog(item, key));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .map(([childKey, childValue]) => [childKey, redactForLog(childValue, childKey)]));
}

export function redactMcpConfigForLog(configPath: string): string {
  const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  return JSON.stringify(redactForLog(parsed), null, 2);
}

export function buildGeminiMcpConfig(servers: RegisteredMcpServer[]) {
  return {
    fileFiltering: {
      respectGitIgnore: false,
      respectGeminiIgnore: false,
    },
    mcpServers: Object.fromEntries(servers.map(server => {
      if (server.type === 'http' && server.url) {
        return [
          server.name,
          {
            type: 'http',
            url: server.url,
            ...(server.headers && Object.keys(server.headers).length ? { headers: server.headers } : {}),
            trust: true,
          },
        ];
      }
      return [
        server.name,
        {
          command: server.command,
          args: server.args || [],
          ...(server.env ? { env: server.env } : {}),
          trust: true,
        },
      ];
    })),
  };
}

export function _matchPlaywrightMcpProcessCommand(
  command: string,
  normalizedCdpEndpoint: string,
): boolean {
  if (!command || !normalizedCdpEndpoint) return false;
  const tokens = command.split(/\s+/);
  if (tokens.length < 2) return false;
  if (!/(?:^|[\\/])node(?:\.exe)?$/.test(tokens[0])) return false;
  const isCliJs = /@playwright[\\/]mcp[\\/]cli\.js$/.test(tokens[1]);
  const isBinSymlink = /[\\/]\.bin[\\/]playwright-mcp(?:\.cmd)?$/.test(tokens[1]);
  if (!isCliJs && !isBinSymlink) return false;
  if (!command.includes(normalizedCdpEndpoint)) return false;
  return true;
}

const execFileAsync = promisify(execFile);

const REAP_THROTTLE_MS = 30_000;
const lastReapAt = new Map<string, number>();

function reapStalePlaywrightMcpProcesses(
  cdpEndpoint: string,
): { reaped: number[]; spared: number[] } {
  const reaped: number[] = [];
  const spared: number[] = [];
  if (process.platform === 'win32' || !cdpEndpoint) return { reaped, spared };

  const normalized = cdpEndpoint.replace(/\/+$/, '');
  if (Date.now() - (lastReapAt.get(normalized) ?? 0) < REAP_THROTTLE_MS) return { reaped, spared };
  lastReapAt.set(normalized, Date.now());

  const result = spawnSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' });
  if (result.status !== 0) return { reaped, spared };

  const ppidByPid = new Map<number, number>();
  const candidates: number[] = [];
  const lines = String(result.stdout || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  for (const line of lines) {
    const m = line.match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
    ppidByPid.set(pid, ppid);
    if (pid === process.pid) continue;
    const command = m[3] || '';
    if (!_matchPlaywrightMcpProcessCommand(command, normalized)) continue;
    candidates.push(pid);
  }

  const isOurDescendant = (pid: number): boolean => {
    let cur: number | undefined = pid;
    for (let depth = 0; depth < 30 && cur != null && cur > 1; depth++) {
      if (cur === process.pid) return true;
      cur = ppidByPid.get(cur);
    }
    return false;
  };

  for (const pid of candidates) {
    if (isOurDescendant(pid)) { spared.push(pid); continue; }
    try {
      process.kill(pid, 'SIGTERM');
      reaped.push(pid);
    } catch {
    }
  }
  return { reaped, spared };
}

function commandTokenBase(token: string): string {
  return path.basename(token.replace(/^"+|"+$/g, '')).replace(/\.(?:cmd|exe)$/i, '').toLowerCase();
}

export function _matchPeekabooMcpProcessCommand(command: string): boolean {
  if (!command || !command.includes('peekaboo-mcp')) return false;
  const tokens = command.split(/\s+/).filter(Boolean);
  if (!tokens.length) return false;
  if (commandTokenBase(tokens[0]) === 'node' && (tokens[1] === '-e' || tokens[1] === '--eval')) return false;

  const hasMcpBin = tokens.some(token =>
    token === 'peekaboo-mcp'
    || /(?:^|[\\/])peekaboo-mcp(?:$|\s)/.test(token)
    || /(?:^|[\\/])peekaboo-mcp$/.test(token));
  if (!hasMcpBin) return false;

  const hasPackage = command.includes('@steipete/peekaboo')
    || command.includes('@steipete\\peekaboo')
    || command.includes('/@steipete/peekaboo/');
  const launcher = commandTokenBase(tokens[0]);
  const knownLauncher = launcher === 'env' || launcher === 'npx' || launcher === 'npm' || launcher === 'node' || launcher === 'peekaboo-mcp';
  return hasPackage || knownLauncher;
}

function commandLooksLikeLiveMcpController(command: string): boolean {
  if (!command) return false;
  const text = command.toLowerCase();
  if (/\bpikiloom\b/.test(text) || text.includes('pikiloom@')) return true;
  const first = commandTokenBase(command.split(/\s+/)[0] || '');
  return first === 'claude' || first === 'codex' || first === 'gemini' || first === 'hermes';
}

const PEEKABOO_REAP_THROTTLE_MS = 30_000;
const PEEKABOO_REAP_FORCE_AFTER_MS = 2_000;
let lastPeekabooReapAt = 0;

function reapStalePeekabooMcpProcesses(): { reaped: number[]; spared: number[] } {
  const reaped: number[] = [];
  const spared: number[] = [];
  if (process.platform !== 'darwin') return { reaped, spared };
  if (Date.now() - lastPeekabooReapAt < PEEKABOO_REAP_THROTTLE_MS) return { reaped, spared };
  lastPeekabooReapAt = Date.now();

  const result = spawnSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' });
  if (result.status !== 0) return { reaped, spared };

  const ppidByPid = new Map<number, number>();
  const commandByPid = new Map<number, string>();
  const candidates: number[] = [];
  const lines = String(result.stdout || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  for (const line of lines) {
    const m = line.match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
    const command = m[3] || '';
    ppidByPid.set(pid, ppid);
    commandByPid.set(pid, command);
    if (pid === process.pid) continue;
    if (_matchPeekabooMcpProcessCommand(command)) candidates.push(pid);
  }

  const hasProtectedAncestor = (pid: number): boolean => {
    let cur: number | undefined = pid;
    for (let depth = 0; depth < 40 && cur != null && cur > 1; depth++) {
      if (cur === process.pid) return true;
      const command = commandByPid.get(cur) || '';
      if (cur !== pid && commandLooksLikeLiveMcpController(command)) return true;
      cur = ppidByPid.get(cur);
    }
    return false;
  };

  for (const pid of candidates) {
    if (hasProtectedAncestor(pid)) { spared.push(pid); continue; }
    try {
      process.kill(pid, 'SIGTERM');
      const forceTimer = setTimeout(() => {
        try {
          process.kill(pid, 0);
          process.kill(pid, 'SIGKILL');
        } catch {
        }
      }, PEEKABOO_REAP_FORCE_AFTER_MS);
      forceTimer.unref?.();
      reaped.push(pid);
    } catch {
    }
  }
  return { reaped, spared };
}

export type BridgeBrowserEndpointMode = 'remote' | 'local-attach' | 'none';

export interface BridgeBrowserEndpoint {
  endpoint: string | null;
  mode: BridgeBrowserEndpointMode;
}

export async function resolveBridgeBrowserEndpoint(
  profileDir = getManagedBrowserProfileDir(),
  remoteCdpUrl: string | null = getConfiguredRemoteCdpUrl(),
): Promise<BridgeBrowserEndpoint> {
  if (remoteCdpUrl) return { endpoint: remoteCdpUrl, mode: 'remote' };
  const local = await resolveManagedBrowserCdpEndpoint(profileDir).catch(() => null);
  return { endpoint: local, mode: local ? 'local-attach' : 'none' };
}

const ARTIFACT_MAX_BYTES = MCP_ARTIFACT_MAX_BYTES;
const SEND_FILE_TIMEOUT_MS = MCP_TIMEOUTS.sendFile;
const PHOTO_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

function isPhotoFile(filePath: string): boolean {
  return PHOTO_EXTS.has(path.extname(filePath).toLowerCase());
}

function isInsideAllowedRoot(realFile: string, allowedRoots: string[]): boolean {
  for (const root of allowedRoots) {
    try {
      const realRoot = fs.realpathSync(root);
      const rel = path.relative(realRoot, realFile);
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return true;
    } catch {  }
  }
  return false;
}

export function resolveSendFilePath(
  inputPath: string,
  workspacePath: string,
  stagedFiles: string[] = [],
  workdir?: string,
): { path: string | null; error?: string } {
  const requested = String(inputPath || '').trim();
  if (!requested) return { path: null, error: 'path is required' };
  if (path.isAbsolute(requested)) return { path: requested };

  const roots = {
    workspace: path.resolve(workspacePath),
    workdir: workdir ? path.resolve(workdir) : '',
    tmp: path.resolve(os.tmpdir()),
  };

  const aliasPrefixes: Array<{ prefix: string; root: string }> = [
    { prefix: '@workspace/', root: roots.workspace },
    { prefix: 'workspace:', root: roots.workspace },
    { prefix: 'ws:', root: roots.workspace },
    ...(roots.workdir ? [
      { prefix: '@workdir/', root: roots.workdir },
      { prefix: 'workdir:', root: roots.workdir },
      { prefix: 'wd:', root: roots.workdir },
    ] : []),
    { prefix: '@tmp/', root: roots.tmp },
    { prefix: 'tmp:', root: roots.tmp },
  ];

  for (const { prefix, root } of aliasPrefixes) {
    if (!requested.startsWith(prefix)) continue;
    const suffix = requested.slice(prefix.length).trim();
    return { path: suffix ? path.resolve(root, suffix) : root };
  }

  const candidates = [
    path.resolve(roots.workspace, requested),
    ...(roots.workdir ? [path.resolve(roots.workdir, requested)] : []),
  ];

  for (const candidate of candidates) {
    try {
      fs.realpathSync(candidate);
      return { path: candidate };
    } catch {
    }
  }

  if (!requested.includes('/') && !requested.includes(path.sep)) {
    const basenameMatches = new Map<string, string>();
    const dedupedMatches: string[] = [];
    const addMatch = (candidate: string) => {
      const key = path.resolve(candidate);
      if (basenameMatches.has(key)) return;
      basenameMatches.set(key, key);
      dedupedMatches.push(key);
    };

    try {
      const tmpCandidate = path.join(roots.tmp, requested);
      if (fs.existsSync(tmpCandidate)) addMatch(tmpCandidate);
    } catch {}

    for (const relPath of stagedFiles) {
      if (path.basename(relPath) !== requested) continue;
      addMatch(path.join(roots.workspace, relPath));
    }

    if (dedupedMatches.length === 1) return { path: dedupedMatches[0] };
    if (dedupedMatches.length > 1) {
      return {
        path: null,
        error: `ambiguous file name "${requested}"; use @workspace/..., @workdir/..., or @tmp/...`,
      };
    }
  }

  return {
    path: candidates[0] || null,
    error: `file not found: ${requested}; try @workspace/..., @workdir/..., @tmp/..., or a unique filename`,
  };
}

export async function startMcpBridge(opts: McpBridgeOpts): Promise<McpBridgeHandle | null> {
  const { sessionDir, workspacePath, stagedFiles, sendFile, onInteraction } = opts;
  let hadActivity = false;
  const gui = resolveGuiIntegrationConfig();
  for (const hint of buildGuiSetupHints(gui)) opts.onLog?.(hint);
  if (gui.peekabooEnabled) {
    ensurePeekabooWarm();
    const { reaped, spared } = reapStalePeekabooMcpProcesses();
    if (reaped.length) {
      opts.onLog?.(`reaped ${reaped.length} stale peekaboo-mcp process(es): pid=${reaped.join(',')}${spared.length ? ` (spared active: ${spared.join(',')})` : ''}`);
    }
  }
  let browserCdpEndpoint: string | null = null;
  if (gui.browserEnabled) {
    ensurePlaywrightMcpConfigFile();
    const { endpoint, mode } = await resolveBridgeBrowserEndpoint(gui.browserProfileDir);
    browserCdpEndpoint = endpoint;
    if (endpoint) {
      opts.onLog?.(mode === 'remote'
        ? `attaching to remote CDP endpoint ${endpoint} (PIKILOOM_BROWSER_CDP_URL); local Chrome launch disabled.`
        : `attaching to existing managed browser at ${endpoint}.`);
      const { reaped, spared } = reapStalePlaywrightMcpProcesses(endpoint);
      if (reaped.length) {
        opts.onLog?.(`reaped ${reaped.length} stale playwright-mcp process(es) attached to ${endpoint}: pid=${reaped.join(',')}${spared.length ? ` (spared in-tree: ${spared.join(',')})` : ''}`);
      }
    } else {
      opts.onLog?.('no managed browser running; playwright/mcp will launch one on first browser_* tool call.');
    }
  }

  const allowedRoots = [workspacePath];
  if (opts.workdir) allowedRoots.push(opts.workdir);
  allowedRoots.push('/tmp', os.tmpdir());

  let callbackServer: http.Server | null = null;
  let port = 0;
  const needsCallbackServer = !!sendFile || !!onInteraction;

  if (needsCallbackServer) {
    callbackServer = http.createServer((req, res) => {
      const endpoint = req.url || '';
      const known = endpoint === '/send-file' || endpoint === '/log' || endpoint === '/ask-user';
      if (req.method !== 'POST' || !known) {
        res.writeHead(404);
        res.end();
        return;
      }

      if (endpoint === '/ask-user') {
        req.setTimeout(0);
        res.setTimeout(0);
      }

      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk; });

      const bodyTimer = setTimeout(() => {
        req.destroy(new Error('request body timeout'));
      }, MCP_TIMEOUTS.requestBody);

      req.on('end', async () => {
        clearTimeout(bodyTimer);
        try {
          if (endpoint === '/log') {
            const data = JSON.parse(body || '{}');
            const message = typeof data.message === 'string' ? data.message.trim() : '';
            if (message) {
              hadActivity = true;
              opts.onLog?.(message);
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
            return;
          }

          if (endpoint === '/ask-user') {
            if (!onInteraction) {
              res.writeHead(503, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: 'ask-user is not available for this session' }));
              return;
            }
            const data = JSON.parse(body || '{}');
            const question = typeof data.question === 'string' ? data.question.trim() : '';
            if (!question) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: 'question is required' }));
              return;
            }
            const header = typeof data.header === 'string' ? data.header.trim() : '';
            const hint = typeof data.hint === 'string' ? data.hint.trim() : '';
            const allowFreeform = data.allowFreeform == null ? true : !!data.allowFreeform;
            const rawOptions = Array.isArray(data.options) ? data.options : [];
            const interactionOptions = rawOptions
              .map((o: any) => {
                const label = typeof o?.label === 'string' ? o.label.trim() : '';
                const description = typeof o?.description === 'string' ? o.description.trim() : '';
                return label ? { label, description: description || null, value: label } : null;
              })
              .filter((o: any): o is { label: string; description: string | null; value: string } => !!o);

            const questionId = 'ask-user';
            const interactionQuestion: AgentInteractionQuestion = {
              id: questionId,
              header: header || 'Question',
              prompt: question,
              options: interactionOptions.length ? interactionOptions : null,
              allowFreeform: interactionOptions.length ? allowFreeform : true,
            };

            const requestId = `ask-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
            const interaction: AgentInteraction = {
              kind: 'user-input',
              id: requestId,
              title: header || 'Pikiloom needs your input',
              hint: hint || null,
              questions: [interactionQuestion],
              resolveWith: (answers) => {
                const values = answers[questionId] || [];
                const text = values.map(v => String(v ?? '').trim()).filter(Boolean).join(' ');
                return { answer: text };
              },
            };

            hadActivity = true;
            try {
              const response = await onInteraction(interaction);
              const answer = typeof (response as any)?.answer === 'string' ? (response as any).answer : '';
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true, answer }));
            } catch (askErr: any) {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: askErr?.message || 'ask-user cancelled' }));
            }
            return;
          }

          if (!sendFile) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'send-file is not available for this session' }));
            return;
          }

          const data = JSON.parse(body);
          const relPath = String(data.path || '').trim();
          if (!relPath) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'path is required' }));
            return;
          }

          const resolved = resolveSendFilePath(relPath, workspacePath, stagedFiles, opts.workdir);
          const absPath = resolved.path;
          let realFile: string;
          try { realFile = fs.realpathSync(String(absPath || '')); } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: resolved.error || `file not found: ${relPath}` }));
            return;
          }
          if (!isInsideAllowedRoot(realFile, allowedRoots)) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'file must be inside the workspace, workdir, or /tmp' }));
            return;
          }

          const stat = fs.statSync(realFile);
          if (!stat.isFile()) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'not a regular file' }));
            return;
          }
          if (stat.size > ARTIFACT_MAX_BYTES) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: `file too large (${stat.size} bytes, max ${ARTIFACT_MAX_BYTES})` }));
            return;
          }

          const kind = data.kind === 'photo' ? 'photo'
            : data.kind === 'document' ? 'document'
            : isPhotoFile(realFile) ? 'photo'
            : 'document';

          const caption = typeof data.caption === 'string' ? data.caption.trim().slice(0, 1024) || undefined : undefined;
          hadActivity = true;

          const result = await Promise.race([
            sendFile(realFile, { caption, kind }),
            new Promise<McpSendFileResult>((_, reject) =>
              setTimeout(() => reject(new Error(`sendFile timed out after ${SEND_FILE_TIMEOUT_MS / 1000}s`)), SEND_FILE_TIMEOUT_MS),
            ),
          ]);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (e: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e?.message || 'internal error' }));
        }
      });
    });

    callbackServer.headersTimeout = MCP_TIMEOUTS.serverHeaders;
    if (onInteraction) callbackServer.requestTimeout = 0;

    await new Promise<void>((resolve, reject) => {
      callbackServer!.on('error', reject);
      callbackServer!.listen(0, '127.0.0.1', () => resolve());
    });
    port = (callbackServer.address() as { port: number }).port;
  }

  const supplementalServers = buildSupplementalMcpServers(gui, { cdpEndpoint: browserCdpEndpoint });
  const servers: RegisteredMcpServer[] = [...supplementalServers];

  if (port && (sendFile || onInteraction)) {
    const { command, args } = resolveMcpServerCommand();
    const enabledTools: string[] = [];
    if (sendFile) enabledTools.push('workspace');
    if (onInteraction && opts.agent !== 'codex') enabledTools.push('ask-user');
    const envVars = {
      MCP_WORKSPACE_PATH: workspacePath,
      MCP_WORKDIR: opts.workdir || '',
      MCP_AGENT: opts.agent || '',
      MCP_STAGED_FILES: JSON.stringify(stagedFiles),
      MCP_CALLBACK_URL: `http://127.0.0.1:${port}`,
      MCP_LOG_URL: `http://127.0.0.1:${port}/log`,
      MCP_TOOLS_AVAILABLE: enabledTools.join(','),
    };
    servers.unshift({ name: 'pikiloom', command, args, env: envVars });
  }

  if (!servers.length) {
    if (callbackServer) await new Promise<void>(resolve => callbackServer!.close(() => resolve()));
    return null;
  }

  let configPath = '';
  let extraEnv: Record<string, string> | undefined;
  let mcpServers: Record<string, any> | undefined;
  const codexRegisteredNames: string[] = [];

  if (opts.agent === 'codex') {
    const extServers = getGlobalExtensionsAsServers(opts.workdir);
    const allServers = [...extServers, ...servers];
    const codexBearerEnv: Record<string, string> = {};
    for (const server of allServers) {
      const codexArgs = buildCodexMcpAddArgs(server, codexBearerEnv);
      if (!codexArgs) continue;
      try {
        await execFileAsync('codex', codexArgs, { timeout: MCP_TIMEOUTS.codexMcpAdd });
        codexRegisteredNames.push(server.name);
      } catch {
        try { await execFileAsync('codex', ['mcp', 'remove', server.name], { timeout: MCP_TIMEOUTS.codexMcpRemove }); } catch {}
        await execFileAsync('codex', codexArgs, { timeout: MCP_TIMEOUTS.codexMcpAdd });
        codexRegisteredNames.push(server.name);
      }
    }
    if (Object.keys(codexBearerEnv).length) {
      extraEnv = { ...(extraEnv || {}), ...codexBearerEnv };
    }
  } else if (opts.agent === 'gemini') {
    const extServers = getGlobalExtensionsAsServers(opts.workdir);
    const allServers = [...extServers, ...servers];
    configPath = path.join(sessionDir, 'gemini-system-settings.json');
    const config = buildGeminiMcpConfig(allServers);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    extraEnv = { GEMINI_CLI_SYSTEM_SETTINGS_PATH: configPath };
  } else if (opts.agent === 'hermes') {
    mcpServers = mergeExtensionsForSession(servers, opts.workdir);
  } else {
    configPath = path.join(sessionDir, 'mcp-config.json');
    mcpServers = mergeExtensionsForSession(servers, opts.workdir);

    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ mcpServers }, null, 2));
  }

  return {
    configPath,
    extraEnv,
    mcpServers,
    hadActivity: () => hadActivity,
    stop: async () => {
      if (callbackServer) await new Promise<void>(resolve => callbackServer!.close(() => resolve()));
      for (const name of [...codexRegisteredNames].reverse()) {
        try { await execFileAsync('codex', ['mcp', 'remove', name], { timeout: MCP_TIMEOUTS.codexMcpRemove }); } catch {}
      }
      if (configPath) {
        try { fs.rmSync(configPath, { force: true }); } catch {}
      }
    },
  };
}
