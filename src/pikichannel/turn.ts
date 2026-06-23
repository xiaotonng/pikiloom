import { loadUserConfig } from '../core/config/user-config.js';
import { writeScopedLog } from '../core/logging.js';

const tlog = (msg: string) => writeScopedLog('pikichannel', `[turn] ${msg}`, { level: 'info' });

export interface IceServer {
  urls: string;
  username?: string;
  credential?: string;
}

export interface TurnConfig {
  keyId: string;
  apiToken: string;
  ttl: number;
}

const DEFAULT_TTL = 86_400;
const MIN_TTL = 600;
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const MINT_TIMEOUT_MS = 8_000;
const CF_ENDPOINT = (keyId: string) =>
  `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`;

const DEFAULT_STUN: IceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

interface CacheEntry {
  key: string;
  servers: IceServer[];
  expiresAt: number;
}

let cache: CacheEntry | null = null;
let pending: Promise<void> | null = null;

export function resolveTurnConfig(): TurnConfig {
  const cfg = loadUserConfig();
  const keyId = String(process.env.PIKICHANNEL_TURN_KEY_ID || cfg.pikichannelTurnKeyId || '').trim();
  const apiToken = String(process.env.PIKICHANNEL_TURN_API_TOKEN || cfg.pikichannelTurnApiToken || '').trim();
  const ttlRaw = process.env.PIKICHANNEL_TURN_TTL || (cfg.pikichannelTurnTtl != null ? String(cfg.pikichannelTurnTtl) : '');
  const ttl = Math.max(MIN_TTL, Number.parseInt(ttlRaw, 10) || DEFAULT_TTL);
  return { keyId, apiToken, ttl };
}

function manualIceServers(): IceServer[] | null {
  const raw = process.env.PIKICHANNEL_ICE_SERVERS;
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    if (Array.isArray(v) && v.length) return flatten(v as Array<{ urls: string | string[]; username?: string; credential?: string }>);
  } catch {  }
  return null;
}

function flatten(servers: Array<{ urls: string | string[]; username?: string; credential?: string }>): IceServer[] {
  const out: IceServer[] = [];
  for (const s of servers) {
    if (!s || !s.urls) continue;
    const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
    for (const u of urls) {
      if (typeof u !== 'string' || !u) continue;
      const entry: IceServer = { urls: u };
      if (s.username != null) entry.username = s.username;
      if (s.credential != null) entry.credential = s.credential;
      out.push(entry);
    }
  }
  return out;
}

const flattenCloudflare = flatten;

function cfgKey(c: TurnConfig): string {
  return `${c.keyId}::${c.ttl}`;
}

async function mintCloudflare(cfg: TurnConfig): Promise<IceServer[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), MINT_TIMEOUT_MS);
  try {
    const res = await fetch(CF_ENDPOINT(cfg.keyId), {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.apiToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: cfg.ttl }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`cloudflare turn responded ${res.status}`);
    const data = (await res.json()) as { iceServers?: Array<{ urls: string | string[]; username?: string; credential?: string }> };
    const flat = flattenCloudflare(data.iceServers || []);
    if (!flat.length) throw new Error('cloudflare turn returned no iceServers');
    return flat;
  } finally {
    clearTimeout(timer);
  }
}

function refresh(cfg: TurnConfig): Promise<void> {
  if (pending) return pending;
  const key = cfgKey(cfg);
  pending = (async () => {
    try {
      const servers = await mintCloudflare(cfg);
      cache = { key, servers, expiresAt: Date.now() + cfg.ttl * 1000 };
      tlog(`minted ${servers.length} ice entries (ttl=${cfg.ttl}s)`);
    } catch (err) {
      tlog(`mint failed, falling back to STUN: ${(err as Error)?.message || err}`);
      if (!cache || cache.key !== key) cache = null;
    } finally {
      pending = null;
    }
  })();
  return pending;
}

export async function prewarmTurn(): Promise<void> {
  if (manualIceServers()) return;
  const cfg = resolveTurnConfig();
  if (!cfg.keyId || !cfg.apiToken) return;
  await refresh(cfg);
}

export function getCachedIceServers(): IceServer[] {
  const manual = manualIceServers();
  if (manual) return manual;

  const cfg = resolveTurnConfig();
  if (!cfg.keyId || !cfg.apiToken) return DEFAULT_STUN;

  const key = cfgKey(cfg);
  const fresh = !!cache && cache.key === key && Date.now() < cache.expiresAt - REFRESH_MARGIN_MS;
  if (!fresh) void refresh(cfg);

  if (cache && cache.key === key && Date.now() < cache.expiresAt) return cache.servers;
  return DEFAULT_STUN;
}

export async function resolveIceServers(): Promise<IceServer[]> {
  const manual = manualIceServers();
  if (manual) return manual;
  const cfg = resolveTurnConfig();
  if (!cfg.keyId || !cfg.apiToken) return DEFAULT_STUN;
  const key = cfgKey(cfg);
  const fresh = !!cache && cache.key === key && Date.now() < cache.expiresAt - REFRESH_MARGIN_MS;
  if (!fresh) await refresh(cfg);
  if (cache && cache.key === key && Date.now() < cache.expiresAt) return cache.servers;
  return DEFAULT_STUN;
}

export function toWeriftIceServers(servers: IceServer[]): IceServer[] {
  const stun = servers.find((s) => s.urls.startsWith('stun:'));
  const turn =
    servers.find((s) => s.urls.startsWith('turn:') && s.urls.includes('transport=udp')) ||
    servers.find((s) => s.urls.startsWith('turn:'));
  const out: IceServer[] = [];
  if (stun) out.push({ urls: stun.urls });
  if (turn) out.push({ urls: turn.urls, username: turn.username, credential: turn.credential });
  return out.length ? out : servers;
}

export function turnStatus(): { turn: boolean; provider: 'cloudflare' | 'manual' | null; relay: boolean; expiresAt: number | null } {
  if (manualIceServers()) {
    const hasTurn = (manualIceServers() || []).some((s) => s.urls.startsWith('turn:') || s.urls.startsWith('turns:'));
    return { turn: hasTurn, provider: 'manual', relay: hasTurn, expiresAt: null };
  }
  const cfg = resolveTurnConfig();
  const configured = !!cfg.keyId && !!cfg.apiToken;
  const live = !!cache && cache.key === cfgKey(cfg) && Date.now() < cache.expiresAt;
  return {
    turn: configured,
    provider: configured ? 'cloudflare' : null,
    relay: live,
    expiresAt: live && cache ? cache.expiresAt : null,
  };
}

export function __resetTurnCacheForTest(): void {
  cache = null;
  pending = null;
}
