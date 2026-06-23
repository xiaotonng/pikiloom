import {
  forceCloseManagedBrowser,
  getConfiguredRemoteCdpUrl,
  getManagedBrowserProfileDir,
  prepareManagedBrowserForAutomation,
} from './browser-profile.js';
import { PIKILOOM_BROWSER_CDP_URL_ENV } from './core/constants.js';
import { writeScopedLog } from './core/logging.js';

export type ManagedBrowserConnectionMode = 'attach' | 'launch' | 'unavailable';

export interface ManagedBrowserSnapshot {
  cdpEndpoint: string | null;
  connectionMode: ManagedBrowserConnectionMode;
}

export interface EnsureManagedBrowserOptions {
  headless?: boolean;
  force?: boolean;
}

interface CachedState {
  cdpEndpoint: string | null;
  connectionMode: ManagedBrowserConnectionMode;
  validatedAt: number;
}

const HEALTH_CACHE_MS = 30_000;
const CDP_PROBE_TIMEOUT_MS = 1_500;

let cached: CachedState | null = null;
let inflight: Promise<ManagedBrowserSnapshot> | null = null;

function log(message: string, level: 'debug' | 'info' | 'warn' | 'error' = 'debug'): void {
  writeScopedLog('browser-supervisor', message, { level, stream: 'stderr' });
}

const getRemoteCdpUrl = getConfiguredRemoteCdpUrl;

async function snapshotRemote(remoteUrl: string, now: number): Promise<ManagedBrowserSnapshot> {
  if (cached?.cdpEndpoint === remoteUrl && now - cached.validatedAt < HEALTH_CACHE_MS) {
    return snapshotFromCache(cached);
  }
  const healthy = await pingCdpEndpoint(remoteUrl);
  if (!healthy) {
    if (cached?.cdpEndpoint === remoteUrl) cached = null;
    log(`remote CDP endpoint ${remoteUrl} not reachable`, 'warn');
    return { cdpEndpoint: null, connectionMode: 'unavailable' };
  }
  cached = { cdpEndpoint: remoteUrl, connectionMode: 'attach', validatedAt: now };
  log(`using remote CDP endpoint ${remoteUrl} (from ${PIKILOOM_BROWSER_CDP_URL_ENV})`);
  return snapshotFromCache(cached);
}

function snapshotFromCache(state: CachedState): ManagedBrowserSnapshot {
  return { cdpEndpoint: state.cdpEndpoint, connectionMode: state.connectionMode };
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return response;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function pingCdpEndpoint(endpoint: string): Promise<boolean> {
  if (!endpoint) return false;
  const versionResp = await fetchWithTimeout(`${endpoint}/json/version`, CDP_PROBE_TIMEOUT_MS);
  if (!versionResp || !versionResp.ok) return false;
  const versionPayload = await versionResp.json().catch(() => null) as { webSocketDebuggerUrl?: unknown } | null;
  if (typeof versionPayload?.webSocketDebuggerUrl !== 'string') return false;
  const targetsResp = await fetchWithTimeout(`${endpoint}/json`, CDP_PROBE_TIMEOUT_MS);
  if (!targetsResp || !targetsResp.ok) return false;
  const targets = await targetsResp.json().catch(() => null);
  return Array.isArray(targets);
}

async function freshenCacheIfPossible(now: number): Promise<ManagedBrowserSnapshot | null> {
  if (!cached?.cdpEndpoint) return null;
  if (now - cached.validatedAt < HEALTH_CACHE_MS) return snapshotFromCache(cached);
  const healthy = await pingCdpEndpoint(cached.cdpEndpoint);
  if (healthy) {
    cached.validatedAt = now;
    return snapshotFromCache(cached);
  }
  log(`cached endpoint ${cached.cdpEndpoint} no longer reachable; clearing cache`, 'warn');
  cached = null;
  return null;
}

export async function probeManagedBrowser(): Promise<ManagedBrowserSnapshot> {
  const remoteUrl = getRemoteCdpUrl();
  if (remoteUrl) return snapshotRemote(remoteUrl, Date.now());
  const fresh = await freshenCacheIfPossible(Date.now());
  if (fresh) return fresh;
  return { cdpEndpoint: null, connectionMode: 'unavailable' };
}

export async function ensureManagedBrowser(
  opts: EnsureManagedBrowserOptions = {},
): Promise<ManagedBrowserSnapshot> {
  const { headless = false, force = false } = opts;
  const now = Date.now();

  const remoteUrl = getRemoteCdpUrl();
  if (remoteUrl) {
    if (force && cached?.cdpEndpoint === remoteUrl) cached = null;
    return snapshotRemote(remoteUrl, now);
  }

  if (!force) {
    const fresh = await freshenCacheIfPossible(now);
    if (fresh) return fresh;
  }

  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const result = await prepareManagedBrowserForAutomation(
        getManagedBrowserProfileDir(),
        { headless },
      );
      const state: CachedState = {
        cdpEndpoint: result.cdpEndpoint,
        connectionMode: result.cdpEndpoint ? result.connectionMode : 'unavailable',
        validatedAt: Date.now(),
      };
      if (state.cdpEndpoint) {
        cached = state;
        log(`prepared managed browser: mode=${state.connectionMode} endpoint=${state.cdpEndpoint}`);
      } else {
        cached = null;
        log(`managed browser unavailable (mode=${result.connectionMode}); will fall back to upstream-managed launch`, 'warn');
      }
      return snapshotFromCache(state);
    } catch (err: any) {
      cached = null;
      log(`ensure failed: ${err?.message || err}`, 'error');
      return { cdpEndpoint: null, connectionMode: 'unavailable' };
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}

const RESTART_COOLDOWN_MS = 30_000;
let lastRestartAt = 0;
let restartInflight: Promise<void> | null = null;

export function restartManagedBrowser(reason: string): Promise<void> {
  const now = Date.now();
  if (restartInflight) return restartInflight;
  if (now - lastRestartAt < RESTART_COOLDOWN_MS) {
    log(`restart skipped (within ${RESTART_COOLDOWN_MS / 1000}s cooldown): ${reason}`, 'debug');
    return Promise.resolve();
  }
  lastRestartAt = now;

  const remoteUrl = getRemoteCdpUrl();
  if (remoteUrl) {
    log(`invalidating remote CDP cache (${remoteUrl}): ${reason}`, 'warn');
    cached = null;
    return Promise.resolve();
  }

  log(`restarting managed browser: ${reason}`, 'warn');
  restartInflight = (async () => {
    try {
      cached = null;
      const killed = await forceCloseManagedBrowser();
      log(`forced close complete; killed pids=[${killed.join(',')}]`);
    } catch (err: any) {
      log(`force-close failed: ${err?.message || err}`, 'error');
    } finally {
      restartInflight = null;
    }
  })();
  return restartInflight;
}

export function invalidateManagedBrowser(): void {
  if (cached) log(`invalidating cached endpoint ${cached.cdpEndpoint}`);
  cached = null;
}

export function getCachedManagedBrowserEndpoint(): string | null {
  return cached?.cdpEndpoint || null;
}

export function _resetManagedBrowserSupervisor(): void {
  cached = null;
  inflight = null;
  lastRestartAt = 0;
  restartInflight = null;
}
