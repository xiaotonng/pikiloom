import { Hono } from 'hono';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadUserConfig, saveUserConfig, applyUserConfig, hasUserConfigFile } from '../../core/config/user-config.js';
import { expandTilde, whichSync } from '../../core/platform.js';
import { readGitStatus } from '../../core/git.js';
import { isSetupReady } from '../../cli/onboarding.js';
import {
  validateDingtalkConfig,
  validateDiscordConfig,
  validateFeishuConfig,
  validateSlackConfig,
  validateTelegramConfig,
  validateWecomConfig,
  validateWeixinConfig,
} from '../../core/config/validation.js';
import { resolveGuiIntegrationConfig } from '../../agent/mcp/bridge.js';
import {
  normalizeWeixinBaseUrl,
  startWeixinQrLogin,
  waitForWeixinQrLogin,
} from '../../channels/weixin/api.js';
import {
  getConfiguredRemoteCdpUrl,
  getManagedBrowserStatus,
  launchManagedBrowserSetup,
} from '../../browser-profile.js';
import {
  requestProcessRestart,
  getActiveTaskCount,
} from '../../core/process-control.js';
import {
  getPermissionsStatus,
  getHostTerminalApp,
  isValidPermissionKey,
  requestPermission,
} from '../platform.js';
import { VERSION } from '../../core/version.js';
import { runtime } from '../runtime.js';
import { writeScopedLog } from '../../core/logging.js';

export async function buildBrowserStatusResponse(config = loadUserConfig(), browserState = getManagedBrowserStatus()) {
  const gui = resolveGuiIntegrationConfig(config);
  const remoteCdpUrl = gui.browserEnabled ? getConfiguredRemoteCdpUrl() : null;
  return {
    browser: {
      status: gui.browserEnabled ? browserState.status : 'disabled',
      enabled: gui.browserEnabled,
      remoteCdpUrl,
      headlessMode: gui.browserHeadless ? 'headless' : 'headed',
      chromeInstalled: browserState.chromeInstalled,
      profileCreated: browserState.profileCreated,
      running: browserState.running,
      pid: browserState.pid,
      profileDir: browserState.profileDir || gui.browserProfileDir,
      detail: !gui.browserEnabled
        ? 'Browser automation is disabled. No browser MCP server will be injected into agent sessions. On macOS, operate your main browser directly with open, osascript, and screencapture when needed.'
        : remoteCdpUrl
          ? `Attached to an external Chrome over CDP at ${remoteCdpUrl} (PIKILOOM_BROWSER_CDP_URL). pikiloom does not launch or manage a local browser in this mode — sign in to sites from the Chrome that owns this endpoint (e.g. your sidecar's web VNC).`
          : browserState.detail,
    },
  };
}

type OpenTarget = 'vscode' | 'cursor' | 'windsurf' | 'finder' | 'default';

function isOpenTarget(value: unknown): value is OpenTarget {
  return value === 'vscode'
    || value === 'cursor'
    || value === 'windsurf'
    || value === 'finder'
    || value === 'default';
}

function runOpenCommand(command: string, args: string[]) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 5_000,
  });
  if (result.error) throw result.error;
  if ((result.status ?? 0) !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim();
    throw new Error(detail || `Failed to run ${command} ${args.join(' ')}`);
  }
}

export interface ResolvedOpenPath {
  filePath: string;
  line: number | null;
  column: number | null;
}

function stripOpenPathWrapping(value: string): string {
  let text = value.trim();
  const pairs: Array<[string, string]> = [['`', '`'], ['"', '"'], ["'", "'"], ['<', '>']];
  let changed = true;
  while (changed && text.length >= 2) {
    changed = false;
    for (const [left, right] of pairs) {
      if (text.startsWith(left) && text.endsWith(right)) {
        text = text.slice(left.length, -right.length).trim();
        changed = true;
      }
    }
  }
  return text;
}

function decodeOpenPathInput(raw: string): string {
  const text = stripOpenPathWrapping(raw);
  if (text.startsWith('file://')) {
    try { return fileURLToPath(text); } catch { return decodeURI(text.slice('file://'.length)); }
  }
  if (text.startsWith('vscode://file/')) {
    return decodeURI(`/${text.slice('vscode://file/'.length)}`);
  }
  return text;
}

function resolveOpenBasePath(basePath?: string | null): string {
  const base = typeof basePath === 'string' && basePath.trim()
    ? basePath.trim()
    : runtime.getRuntimeWorkdir(loadUserConfig());
  return path.resolve(expandTilde(base || process.cwd()));
}

function splitExistingLineSuffix(candidate: string): ResolvedOpenPath {
  const normalized = path.normalize(candidate);
  if (fs.existsSync(normalized)) return { filePath: normalized, line: null, column: null };

  const match = /^(.*?)(?::(\d+)(?::(\d+))?)$/.exec(normalized);
  if (!match || !match[1]) return { filePath: normalized, line: null, column: null };

  const filePath = path.normalize(match[1]);
  if (!fs.existsSync(filePath)) return { filePath: normalized, line: null, column: null };

  return {
    filePath,
    line: Number(match[2]),
    column: match[3] ? Number(match[3]) : null,
  };
}

export function resolveOpenPathLocator(rawPath: string, basePath?: string | null): ResolvedOpenPath {
  const decoded = decodeOpenPathInput(rawPath);
  const expanded = expandTilde(decoded);
  const absolute = path.isAbsolute(expanded)
    ? path.resolve(expanded)
    : path.resolve(resolveOpenBasePath(basePath), expanded);
  return splitExistingLineSuffix(absolute);
}

function editorGotoArg(filePath: string, location?: Pick<ResolvedOpenPath, 'line' | 'column'> | null): string | null {
  if (!location?.line) return null;
  return `${filePath}:${location.line}${location.column ? `:${location.column}` : ''}`;
}

function tryOpenCommand(command: string, args: string[]): boolean {
  if (!whichSync(command)) return false;
  try {
    runOpenCommand(command, args);
    return true;
  } catch {
    return false;
  }
}

function tryOpenVSCodeUrl(filePath: string, location?: Pick<ResolvedOpenPath, 'line' | 'column'> | null): boolean {
  if (!location?.line) return false;
  const suffix = `:${location.line}${location.column ? `:${location.column}` : ''}`;
  try {
    runOpenCommand('open', [`vscode://file${encodeURI(filePath)}${suffix}`]);
    return true;
  } catch {
    return false;
  }
}

function openPathWithTarget(filePath: string, target: OpenTarget, isDirectory: boolean, location?: Pick<ResolvedOpenPath, 'line' | 'column'> | null) {
  const gotoArg = isDirectory ? null : editorGotoArg(filePath, location);
  if (process.platform === 'darwin') {
    switch (target) {
      case 'finder':
        runOpenCommand('open', isDirectory ? [filePath] : ['-R', filePath]);
        return;
      case 'default':
        runOpenCommand('open', [filePath]);
        return;
      case 'cursor':
        if (gotoArg && tryOpenCommand('cursor', ['-g', gotoArg])) return;
        runOpenCommand('open', ['-a', 'Cursor', filePath]);
        return;
      case 'windsurf':
        if (gotoArg && tryOpenCommand('windsurf', ['-g', gotoArg])) return;
        runOpenCommand('open', ['-a', 'Windsurf', filePath]);
        return;
      case 'vscode':
      default:
        if (gotoArg && tryOpenCommand('code', ['-g', gotoArg])) return;
        if (gotoArg && tryOpenVSCodeUrl(filePath, location)) return;
        runOpenCommand('open', ['-a', 'Visual Studio Code', filePath]);
        return;
    }
  }

  if (process.platform === 'win32') {
    switch (target) {
      case 'cursor':
        if (gotoArg) runOpenCommand('cursor', ['-g', gotoArg]);
        else runOpenCommand('cursor', [filePath]);
        return;
      case 'windsurf':
        if (gotoArg) runOpenCommand('windsurf', ['-g', gotoArg]);
        else runOpenCommand('windsurf', [filePath]);
        return;
      case 'finder':
      case 'default':
        runOpenCommand('cmd', ['/c', 'start', '', filePath]);
        return;
      case 'vscode':
      default:
        if (gotoArg) runOpenCommand('code', ['-g', gotoArg]);
        else runOpenCommand('code', [filePath]);
        return;
    }
  }

  switch (target) {
    case 'cursor':
      if (gotoArg) runOpenCommand('cursor', ['-g', gotoArg]);
      else runOpenCommand('cursor', [filePath]);
      return;
    case 'windsurf':
      if (gotoArg) runOpenCommand('windsurf', ['-g', gotoArg]);
      else runOpenCommand('windsurf', [filePath]);
      return;
    case 'finder':
    case 'default':
      runOpenCommand('xdg-open', [filePath]);
      return;
    case 'vscode':
    default:
      if (gotoArg) runOpenCommand('code', ['-g', gotoArg]);
      else runOpenCommand('code', [filePath]);
      return;
  }
}

const app = new Hono();

app.get('/api/state', async (c) => {
  const config = loadUserConfig();
  const setupState = await runtime.buildValidatedSetupState(config);
  const permissions = getPermissionsStatus();
  const botRef = runtime.getBotRef();
  return c.json({
    version: VERSION,
    ready: isSetupReady(setupState),
    configExists: hasUserConfigFile(),
    config,
    runtimeWorkdir: runtime.getRuntimeWorkdir(config),
    setupState,
    permissions,
    hostApp: getHostTerminalApp(),
    platform: process.platform,
    pid: process.pid,
    nodeVersion: process.versions.node,
    bot: botRef ? {
      workdir: botRef.workdir,
      defaultAgent: botRef.defaultAgent,
      uptime: Date.now() - botRef.startedAt,
      connected: botRef.connected,
      stats: botRef.stats,
      activeTasks: botRef.activeTasks.size,
      sessions: botRef.sessionStates.size,
    } : null,
  });
});

app.get('/api/host', (c) => {
  const botRef = runtime.getBotRef();
  if (botRef) return c.json(botRef.getHostData());
  const cpus = os.cpus();
  const [one, five, fifteen] = os.loadavg();
  return c.json({
    hostName: os.hostname(), cpuModel: cpus[0]?.model || 'unknown',
    cpuCount: cpus.length, totalMem: os.totalmem(), freeMem: os.freemem(),
    loadAverage: { one, five, fifteen },
    platform: process.platform, arch: os.arch(),
  });
});

app.get('/api/permissions', (c) => {
  const data = { ...getPermissionsStatus(), hostApp: getHostTerminalApp() };
  return c.json(data);
});

app.post('/api/config', async (c) => {
  const body = await c.req.json();
  const merged = { ...loadUserConfig(), ...body };
  const configPath = saveUserConfig(merged);
  applyUserConfig(loadUserConfig());
  return c.json({ ok: true, configPath });
});

app.post('/api/validate-telegram-token', async (c) => {
  const body = await c.req.json();
  const result = await validateTelegramConfig(body.token || '', body.allowedChatIds || '');
  return c.json({
    ok: result.state.ready,
    error: result.state.ready ? null : result.state.detail,
    bot: result.bot,
    normalizedAllowedChatIds: result.normalizedAllowedChatIds,
  });
});

app.post('/api/validate-feishu-config', async (c) => {
  const body = await c.req.json();
  const startedAt = Date.now();
  const rawAppId = String(body.appId || '').trim();
  const maskedAppId = !rawAppId
    ? '(missing)'
    : rawAppId.length <= 10
      ? rawAppId
      : `${rawAppId.slice(0, 6)}...${rawAppId.slice(-4)}`;
  writeScopedLog('dashboard', `[feishu-config] request app=${maskedAppId}`, { level: 'debug' });
  const result = await validateFeishuConfig(body.appId || '', body.appSecret || '');
  writeScopedLog(
    'dashboard',
    `[feishu-config] result app=${maskedAppId} ok=${result.state.ready} status=${result.state.status} elapsedMs=${Date.now() - startedAt}`,
    { level: 'debug' },
  );
  return c.json({
    ok: result.state.ready,
    error: result.state.ready ? null : result.state.detail,
    app: result.app,
  });
});

app.post('/api/validate-weixin-config', async (c) => {
  const body = await c.req.json();
  const result = await validateWeixinConfig(body.baseUrl || '', body.botToken || '', body.accountId || '');
  return c.json({
    ok: result.state.ready,
    error: result.state.ready ? null : result.state.detail,
    account: result.account,
    normalizedBaseUrl: result.normalizedBaseUrl,
  });
});

app.post('/api/validate-slack-config', async (c) => {
  const body = await c.req.json();
  const result = await validateSlackConfig(body.botToken || '', body.appToken || '');
  return c.json({
    ok: result.state.ready,
    error: result.state.ready ? null : result.state.detail,
    bot: result.bot,
  });
});

app.post('/api/validate-discord-config', async (c) => {
  const body = await c.req.json();
  const result = await validateDiscordConfig(body.botToken || '');
  return c.json({
    ok: result.state.ready,
    error: result.state.ready ? null : result.state.detail,
    bot: result.bot,
  });
});

app.post('/api/validate-dingtalk-config', async (c) => {
  const body = await c.req.json();
  const result = await validateDingtalkConfig(body.clientId || '', body.clientSecret || '');
  return c.json({
    ok: result.state.ready,
    error: result.state.ready ? null : result.state.detail,
    app: result.app,
  });
});

app.post('/api/validate-wecom-config', async (c) => {
  const body = await c.req.json();
  const result = await validateWecomConfig(body.botId || '', body.botSecret || '');
  return c.json({
    ok: result.state.ready,
    error: result.state.ready ? null : result.state.detail,
    bot: result.bot,
  });
});

app.post('/api/weixin-login/start', async (c) => {
  const body = await c.req.json();
  const result = await startWeixinQrLogin({
    baseUrl: normalizeWeixinBaseUrl(body.baseUrl || ''),
    sessionKey: body.sessionKey || undefined,
  });
  return c.json(result, result.ok ? 200 : 500);
});

app.post('/api/weixin-login/wait', async (c) => {
  const body = await c.req.json();
  const result = await waitForWeixinQrLogin({
    baseUrl: normalizeWeixinBaseUrl(body.baseUrl || ''),
    sessionKey: String(body.sessionKey || '').trim(),
  });
  return c.json(result, result.ok ? 200 : 500);
});

app.post('/api/open-preferences', async (c) => {
  const body = await c.req.json();
  const permission = String(body.permission || '');
  if (!isValidPermissionKey(permission)) {
    return c.json({
      ok: false,
      action: 'unsupported',
      granted: false,
      requiresManualGrant: false,
      error: 'Invalid permission.',
    }, 400);
  }
  const result = requestPermission(permission);
  runtime.log(
    `[permissions] permission=${permission} action=${result.action} granted=${result.granted} manual=${result.requiresManualGrant} ok=${result.ok}`
  );
  return c.json(result, result.ok ? 200 : 500);
});

app.post('/api/restart', (c) => {
  const activeTasks = getActiveTaskCount();
  if (activeTasks > 0) {
    return c.json({
      ok: false,
      activeTasks,
      error: `${activeTasks} task(s) still running — can't restart. Wait for them to finish or stop them, then retry.`,
    }, 409);
  }
  setTimeout(() => {
    void requestProcessRestart({ log: message => runtime.log(message) });
  }, 50);
  return c.json({ ok: true });
});

app.post('/api/switch-workdir', async (c) => {
  const body = await c.req.json();
  const newPath = body.path;
  if (!newPath) return c.json({ ok: false, error: 'Missing path' }, 400);
  const resolvedPath = path.resolve(expandTilde(String(newPath)));
  const botRef = runtime.getBotRef();
  if (botRef) {
    botRef.switchWorkdir(resolvedPath);
    return c.json({ ok: true, workdir: botRef.workdir });
  }
  const { setUserWorkdir } = await import('../../core/config/user-config.js');
  const saved = setUserWorkdir(resolvedPath);
  return c.json({ ok: true, workdir: saved.workdir });
});

app.get('/api/browser', async (c) => {
  const config = loadUserConfig();
  const data = await buildBrowserStatusResponse(config);
  return c.json(data);
});

app.post('/api/browser/setup', async (c) => {
  runtime.log('[browser] setup requested');
  try {
    const config = loadUserConfig();
    const gui = resolveGuiIntegrationConfig(config);
    if (!gui.browserEnabled) {
      return c.json({
        ok: false,
        error: 'Browser automation is disabled. Enable it first if you want pikiloom to launch the managed browser profile.',
      }, 400);
    }
    if (getConfiguredRemoteCdpUrl()) {
      runtime.log('[browser] setup skipped: PIKILOOM_BROWSER_CDP_URL configured (external CDP, no local browser to launch)');
      return c.json({ ok: true, ...(await buildBrowserStatusResponse(config)) });
    }
    const launch = launchManagedBrowserSetup();
    runtime.log(`[browser] launched managed profile at ${launch.profileDir} pid=${launch.pid ?? 'unknown'}`);
    const payload = await buildBrowserStatusResponse(config, launch);
    return c.json({
      ok: true,
      browser: {
        ...payload.browser,
        detail: launch.running
          ? 'Managed browser is open. Sign in to the sites you want pikiloom to reuse. If it is still open later, pikiloom will close it automatically before browser automation starts.'
          : payload.browser.detail,
      },
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    runtime.log(`[browser] setup failed: ${detail}`);
    return c.json({ ok: false, error: detail }, 500);
  }
});

app.get('/api/ls-dir', (c) => {
  const dir = c.req.query('path') || os.homedir();
  const includeFiles = c.req.query('files') === '1';
  const includeHidden = c.req.query('hidden') === '1';
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const dirs = entries
      .filter(e => (includeHidden || !e.name.startsWith('.')) && (includeFiles || e.isDirectory()))
      .map(e => ({ name: e.name, path: path.join(dir, e.name), isDir: e.isDirectory() }))
      .sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    const isGit = fs.existsSync(path.join(dir, '.git'));
    return c.json({ ok: true, path: dir, parent: path.dirname(dir), dirs, isGit });
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

app.get('/api/git-changes', (c) => {
  const dir = c.req.query('path');
  if (!dir) return c.json({ ok: false, error: 'path is required' }, 400);
  try {
    if (!fs.existsSync(path.join(dir, '.git'))) {
      return c.json({ ok: true, changes: [], isGit: false });
    }
    const result = spawnSync('git', ['diff', '--name-status', 'HEAD', '--no-renames'], {
      cwd: dir,
      timeout: 5_000,
      encoding: 'utf-8',
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    });
    const lines = (result.stdout || '').trim().split('\n').filter(Boolean);
    const changes = lines.map(line => {
      const [status, ...rest] = line.split('\t');
      const file = rest.join('\t');
      return {
        status: status === 'A' ? 'added' as const
          : status === 'D' ? 'deleted' as const
          : 'modified' as const,
        file,
        path: path.join(dir, file),
      };
    });
    return c.json({ ok: true, changes, isGit: true });
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

app.get('/api/workspace-git', (c) => {
  const dir = c.req.query('path');
  if (!dir) return c.json({ ok: false, error: 'path is required' }, 400);
  const git = readGitStatus(dir);
  return c.json({ ok: true, isGit: git !== null, git });
});

app.post('/api/open-in-editor', async (c) => {
  try {
    const body = await c.req.json();
    const filePath = typeof body?.filePath === 'string' ? body.filePath.trim() : '';
    const basePath = typeof body?.basePath === 'string' && body.basePath.trim()
      ? body.basePath.trim()
      : typeof body?.workdir === 'string' && body.workdir.trim()
        ? body.workdir.trim()
        : null;
    const target = isOpenTarget(body?.target) ? body.target : 'vscode';
    if (!filePath) return c.json({ ok: false, error: 'filePath is required' }, 400);
    const resolved = resolveOpenPathLocator(filePath, basePath);
    if (!fs.existsSync(resolved.filePath)) return c.json({ ok: false, error: 'Path not found' }, 404);
    const stat = fs.statSync(resolved.filePath);
    openPathWithTarget(resolved.filePath, target, stat.isDirectory(), resolved);
    return c.json({ ok: true, filePath: resolved.filePath, line: resolved.line, column: resolved.column });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    runtime.log(`[open-in-editor] failed: ${detail}`);
    return c.json({ ok: false, error: detail }, 500);
  }
});

app.post('/api/open-diff', async (c) => {
  try {
    const body = await c.req.json();
    const filePath = typeof body?.filePath === 'string' ? body.filePath.trim() : '';
    const target = isOpenTarget(body?.target) ? body.target : 'vscode';
    if (!filePath) return c.json({ ok: false, error: 'filePath is required' }, 400);

    const dir = path.dirname(filePath);
    const relFile = path.basename(filePath);

    const origResult = spawnSync('git', ['show', `HEAD:${path.relative(findGitRoot(dir), filePath)}`], {
      cwd: dir,
      timeout: 5_000,
      encoding: 'buffer',
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    });

    if (origResult.status !== 0) {
      openPathWithTarget(filePath, target, false);
      return c.json({ ok: true });
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikiloom-diff-'));
    const origPath = path.join(tmpDir, `${relFile}.orig`);
    fs.writeFileSync(origPath, origResult.stdout);

    const cli = target === 'cursor' ? 'cursor' : target === 'windsurf' ? 'windsurf' : 'code';
    const child = spawn(cli, ['--diff', origPath, filePath], {
      cwd: dir,
      stdio: 'ignore',
      detached: true,
    });
    child.unref();

    setTimeout(() => fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {}), 30_000);
    return c.json({ ok: true });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    runtime.log(`[open-diff] failed: ${detail}`);
    return c.json({ ok: false, error: detail }, 500);
  }
});

function findGitRoot(dir: string): string {
  let current = dir;
  while (current !== path.dirname(current)) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    current = path.dirname(current);
  }
  return dir;
}

export default app;
