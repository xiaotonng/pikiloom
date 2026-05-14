/**
 * CLI auth + install runner.
 *
 * Two flows share a single streaming-child-session core:
 *
 *   - oauth-web: spawn `loginArgv`, stream stdout/stderr to the UI, poll
 *     `statusArgv` in the background, and settle when the CLI reports ready.
 *     Used by CLIs that print a device code / one-time-code non-interactively
 *     (gh, wrangler, supabase, …). CLIs whose sign-in needs a real TTY use
 *     `manualLoginCommands` instead and never reach this runner.
 *   - install: spawn the `npm install -g <pkg>` argv, stream output, re-detect
 *     once the child exits.
 *
 * Token CLIs (aws, mocli) skip this entirely — credentials come in via a plain
 * POST and are applied synchronously by `applyCliToken`.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { detectCli, invalidateCliStatus, currentPlatform, type CliStatus } from './detector.js';
import { getRecommendedCli, type RecommendedCli } from './registry.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AuthSessionEvent =
  | { type: 'output'; chunk: string }
  | { type: 'status'; status: CliStatus }
  | { type: 'error'; message: string }
  | { type: 'done'; ok: boolean; exitCode: number | null };

export interface AuthSession {
  sessionId: string;
  cliId: string;
  startedAt: number;
  events: EventEmitter;
  done: boolean;
  ok: boolean;
  exitCode: number | null;
  /** Ring buffer of recent output so late subscribers can catch up. */
  backlog: string[];
}

const SESSIONS = new Map<string, AuthSession>();
const MAX_SESSION_AGE_MS = 15 * 60 * 1000;
const POLL_INTERVAL_MS = 2_000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000;
const BACKLOG_LINES = 200;

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

function reapExpiredSessions(): void {
  const now = Date.now();
  for (const [id, s] of SESSIONS) {
    if (s.done && now - s.startedAt > MAX_SESSION_AGE_MS) SESSIONS.delete(id);
  }
}

export function getAuthSession(sessionId: string): AuthSession | undefined {
  reapExpiredSessions();
  return SESSIONS.get(sessionId);
}

export function cancelAuthSession(sessionId: string): boolean {
  const s = SESSIONS.get(sessionId);
  if (!s || s.done) return false;
  (s as any)._child?.kill?.('SIGTERM');
  return true;
}

// ---------------------------------------------------------------------------
// Shared streaming-child session core
// ---------------------------------------------------------------------------

export interface StartAuthSessionResult {
  ok: true;
  sessionId: string;
}

interface StreamingSessionOpts {
  cli: RecommendedCli;
  argv: string[];
  env: NodeJS.ProcessEnv;
  shell?: boolean;
  /**
   * When true, poll the CLI's status command in the background and settle as
   * soon as it reports ready — used for long-running login children that don't
   * exit on their own. When false (install), settle on child close only.
   */
  pollUntilReady: boolean;
  /**
   * Decide the final ok flag once the child has exited and a fresh status has
   * been read. For login: ready === true ⇒ ok. For install: child exit 0 AND
   * binary now detected.
   */
  computeOk: (exitCode: number | null, finalStatus: CliStatus | undefined) => boolean;
}

function startStreamingSession(opts: StreamingSessionOpts): StartAuthSessionResult {
  const { cli, argv, env, shell, pollUntilReady, computeOk } = opts;
  const sessionId = randomUUID();
  const events = new EventEmitter();
  // Unlimited listeners — SSE clients may resubscribe multiple times.
  events.setMaxListeners(0);

  const session: AuthSession & { _child?: ChildProcess } = {
    sessionId,
    cliId: cli.id,
    startedAt: Date.now(),
    events,
    done: false,
    ok: false,
    exitCode: null,
    backlog: [],
  };
  SESSIONS.set(sessionId, session);

  const [cmd, ...args] = argv;
  const child = spawn(cmd, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
    shell,
    windowsHide: true,
  });
  session._child = child;

  const pushOutput = (chunk: string) => {
    session.backlog.push(chunk);
    if (session.backlog.length > BACKLOG_LINES) {
      session.backlog.splice(0, session.backlog.length - BACKLOG_LINES);
    }
    events.emit('event', { type: 'output', chunk } satisfies AuthSessionEvent);
  };

  child.stdout?.on('data', (buf: Buffer) => pushOutput(buf.toString('utf8')));
  child.stderr?.on('data', (buf: Buffer) => pushOutput(buf.toString('utf8')));
  child.on('error', (err) => {
    events.emit('event', { type: 'error', message: err.message } satisfies AuthSessionEvent);
  });

  let settled = false;
  let poller: NodeJS.Timeout | undefined;
  const settle = async (exitCode: number | null) => {
    if (settled) return;
    settled = true;
    if (poller) clearInterval(poller);
    invalidateCliStatus(cli.id);
    let finalStatus: CliStatus | undefined;
    try { finalStatus = await detectCli(cli); } catch { /* best-effort */ }
    if (finalStatus) {
      events.emit('event', { type: 'status', status: finalStatus } satisfies AuthSessionEvent);
    }
    session.ok = computeOk(exitCode, finalStatus);
    session.exitCode = exitCode;
    session.done = true;
    events.emit('event', { type: 'done', ok: session.ok, exitCode } satisfies AuthSessionEvent);
  };

  if (pollUntilReady) {
    const pollDeadline = Date.now() + POLL_TIMEOUT_MS;
    poller = setInterval(async () => {
      if (settled) return;
      if (Date.now() > pollDeadline) {
        child.kill('SIGTERM');
        void settle(null);
        return;
      }
      try {
        invalidateCliStatus(cli.id);
        const status = await detectCli(cli);
        events.emit('event', { type: 'status', status } satisfies AuthSessionEvent);
        if (status.state === 'ready') {
          if (!child.killed) child.kill('SIGTERM');
          void settle(child.exitCode);
        }
      } catch { /* ignore polling errors */ }
    }, POLL_INTERVAL_MS);
  }

  child.on('close', (code) => { void settle(code); });

  return { ok: true, sessionId };
}

// ---------------------------------------------------------------------------
// oauth-web login
// ---------------------------------------------------------------------------

export async function startCliAuthSession(
  cliId: string,
): Promise<StartAuthSessionResult | { ok: false; error: string }> {
  const cli = getRecommendedCli(cliId);
  if (!cli) return { ok: false, error: `unknown cli: ${cliId}` };
  if (cli.auth.type !== 'oauth-web' || !cli.auth.loginArgv) {
    return { ok: false, error: `cli ${cliId} does not support oauth-web sign-in` };
  }
  // CLIs configured for manual login should never spawn here — guard so a
  // misbehaving client can't end-run the documented terminal flow.
  if (cli.auth.manualLoginCommands && cli.auth.manualLoginCommands.length > 0) {
    return { ok: false, error: `cli ${cliId} uses manual sign-in (run the commands in your own terminal)` };
  }

  return startStreamingSession({
    cli,
    argv: cli.auth.loginArgv,
    env: { ...process.env, NO_COLOR: '1', TERM: 'dumb', CI: '' },
    pollUntilReady: true,
    computeOk: (_exit, status) => status?.state === 'ready',
  });
}

// ---------------------------------------------------------------------------
// Auto-install — npm-based, safe-to-run install commands
//
// Reuses the streaming session core. We deliberately allow ONLY
// `npm install -g <pkg>` style commands — brew/apt/dnf/winget/scoop flows
// often need sudo or interactive confirmation and stay manual.
// ---------------------------------------------------------------------------

export interface AutoInstallSpec {
  /** Argv to spawn, e.g. ['npm', 'install', '-g', '@jackwener/opencli']. */
  argv: string[];
  /** Short label shown on the auto-install button (e.g. "npm"). */
  label: string;
}

const NPM_GLOBAL_INSTALL_RE = /^npm\s+(?:install|i)\s+(?:-g|--global)\s+(\S.*)$/;
const SHELL_METACHAR_RE = /[|;&`$()<>]/;

/**
 * Inspect a CLI's install spec for the current platform and return a single
 * argv that's safe to spawn without user-side approvals. Returns null when no
 * such command exists (brew/apt/dnf/winget/scoop/curl-pipe-sh entries are all
 * rejected on purpose — those require sudo or interactive confirmation).
 */
export function resolveAutoInstallSpec(
  cli: RecommendedCli,
  platform: 'darwin' | 'linux' | 'win',
): AutoInstallSpec | null {
  const commands = cli.install[platform] || [];
  for (const c of commands) {
    const cmd = c.cmd.trim();
    if (SHELL_METACHAR_RE.test(cmd)) continue;
    if (/^sudo\b/i.test(cmd)) continue;
    const m = cmd.match(NPM_GLOBAL_INSTALL_RE);
    if (!m) continue;
    const pkgs = m[1].split(/\s+/).filter(Boolean);
    if (pkgs.length === 0) continue;
    return { argv: ['npm', 'install', '-g', ...pkgs], label: c.label || 'npm' };
  }
  return null;
}

export async function startCliInstallSession(
  cliId: string,
): Promise<StartAuthSessionResult | { ok: false; error: string }> {
  const cli = getRecommendedCli(cliId);
  if (!cli) return { ok: false, error: `unknown cli: ${cliId}` };
  const spec = resolveAutoInstallSpec(cli, currentPlatform());
  if (!spec) return { ok: false, error: `no auto-install command available for ${cliId}` };

  return startStreamingSession({
    cli,
    argv: spec.argv,
    env: { ...process.env, NO_COLOR: '1', TERM: 'dumb', CI: '1' },
    // npm on Windows is npm.cmd — needs shell resolution. spawn() args are
    // still passed argv-style; we don't concat into a shell string.
    shell: process.platform === 'win32',
    pollUntilReady: false,
    computeOk: (exit, status) => exit === 0 && (status ? status.state !== 'not_installed' : true),
  });
}

// ---------------------------------------------------------------------------
// Token auth — apply-credentials flow
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface ApplyTokenResult {
  ok: boolean;
  error?: string;
  status?: CliStatus;
}

/**
 * Apply a set of credentials for a `token`-auth CLI and verify. Each CLI gets a
 * tailored write path because there's no universal convention — we only do this
 * for CLIs we explicitly support.
 */
export async function applyCliToken(cliId: string, values: Record<string, string>): Promise<ApplyTokenResult> {
  const cli = getRecommendedCli(cliId);
  if (!cli) return { ok: false, error: `unknown cli: ${cliId}` };
  if (cli.auth.type !== 'token') return { ok: false, error: `cli ${cliId} does not use token auth` };

  try {
    if (cli.id === 'aws') {
      const id = (values.AWS_ACCESS_KEY_ID || '').trim();
      const secret = (values.AWS_SECRET_ACCESS_KEY || '').trim();
      const region = (values.AWS_DEFAULT_REGION || '').trim();
      if (!id || !secret) return { ok: false, error: 'AWS access key ID and secret are required' };

      const awsDir = path.join(os.homedir(), '.aws');
      fs.mkdirSync(awsDir, { recursive: true, mode: 0o700 });

      const credPath = path.join(awsDir, 'credentials');
      const credBody = `[default]\naws_access_key_id = ${id}\naws_secret_access_key = ${secret}\n`;
      mergeIniSection(credPath, 'default', credBody);

      if (region) {
        const configPath = path.join(awsDir, 'config');
        mergeIniSection(configPath, 'default', `[default]\nregion = ${region}\n`);
      }
    } else if (cli.id === 'mocli') {
      // mocli stores its key via `mocli auth init --apik <KEY>` — let the CLI
      // own its storage path so future schema changes upstream don't break us.
      const key = (values.MOWEN_API_KEY || '').trim();
      if (!key) return { ok: false, error: 'Mowen API Key is required' };
      const applied = await new Promise<{ ok: boolean; stderr: string }>((resolve) => {
        const child = spawn('mocli', ['auth', 'init', '--apik', key], {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, NO_COLOR: '1', TERM: 'dumb' },
        });
        let stderr = '';
        child.stderr?.on('data', b => { stderr += b.toString('utf8'); });
        child.on('error', err => resolve({ ok: false, stderr: err.message }));
        child.on('close', code => resolve({ ok: code === 0, stderr }));
      });
      if (!applied.ok) {
        return { ok: false, error: applied.stderr.trim().slice(0, 200) || 'mocli auth init failed' };
      }
    } else {
      return { ok: false, error: `token auth is not implemented for ${cliId}` };
    }

    invalidateCliStatus(cliId);
    const status = await detectCli(cli);
    return { ok: status.state === 'ready', status, error: status.state === 'ready' ? undefined : status.authDetail };
  } catch (e: any) {
    return { ok: false, error: e?.message || 'failed to apply token' };
  }
}

/**
 * Merge a `[section]` block into an INI-style file, replacing any existing
 * block with the same name. Idempotent; preserves other sections and comments.
 */
function mergeIniSection(filePath: string, section: string, block: string): void {
  let current = '';
  try { current = fs.readFileSync(filePath, 'utf-8'); } catch { /* new file */ }
  const header = `[${section}]`;
  const lines = current.split(/\r?\n/);
  const out: string[] = [];
  let inTarget = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === header) { inTarget = true; continue; }
    if (inTarget) {
      if (/^\[.+\]$/.test(trimmed)) { inTarget = false; out.push(line); }
      // else: drop old line
    } else {
      out.push(line);
    }
  }
  let body = out.join('\n').replace(/\n+$/, '');
  if (body) body += '\n\n';
  body += block.trim() + '\n';
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, body, { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// Logout — run the CLI's logout command and invalidate cache
// ---------------------------------------------------------------------------

export interface LogoutResult { ok: boolean; error?: string; status?: CliStatus }

export async function logoutCli(cliId: string): Promise<LogoutResult> {
  const cli = getRecommendedCli(cliId);
  if (!cli) return { ok: false, error: `unknown cli: ${cliId}` };
  if (!cli.auth.logoutArgv || cli.auth.logoutArgv.length === 0) {
    return { ok: false, error: `cli ${cliId} has no logout command` };
  }
  return new Promise<LogoutResult>((resolve) => {
    const [cmd, ...args] = cli.auth.logoutArgv!;
    const child = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1', TERM: 'dumb' },
    });
    let stderr = '';
    child.stderr?.on('data', b => { stderr += b.toString('utf8'); });
    child.on('error', err => resolve({ ok: false, error: err.message }));
    child.on('close', async () => {
      invalidateCliStatus(cliId);
      const status = await detectCli(cli).catch(() => undefined);
      resolve({ ok: true, status, error: stderr.trim() ? stderr.trim().slice(0, 200) : undefined });
    });
  });
}

