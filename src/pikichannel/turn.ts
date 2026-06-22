/**
 * pikichannel/turn.ts — Cloudflare Realtime TURN credential minter (host side).
 *
 * Why host-only is sufficient: the host is the WebRTC *answerer*. A TURN relay
 * candidate it gathers is an allocation ON the TURN server that ANY client can
 * reach OUTBOUND (NAT always allows outbound). So configuring TURN here alone
 * gives relay fallback for EVERY NAT combination — symmetric NAT and CGNAT on
 * either end included — without the browser needing its own TURN credentials.
 * The host trickles its relay candidate to the client; the client just sends to
 * it. (The browser keeps plain STUN; see web/sdk.js.)
 *
 * Security: the long-lived Cloudflare API token NEVER leaves this process. We
 * exchange it for SHORT-LIVED (TTL'd) credentials via Cloudflare's API and feed
 * only those to the peer connection. No secret is ever sent over the wire.
 *
 * Cost: callers must keep `iceTransportPolicy` at its default `'all'` (never
 * force `'relay'`), so direct/STUN paths are always preferred and the relay —
 * the only metered part of Cloudflare Realtime — is a genuine last resort.
 * Credentials are minted once and cached across all connections, refreshed just
 * before expiry, so steady state is zero API calls per connection.
 *
 * Fallback: no Cloudflare config (or any mint failure) → plain STUN, exactly as
 * before. Existing hosts see zero behavior change.
 *
 * See https://developers.cloudflare.com/realtime/turn/generate-credentials/.
 */

import { loadUserConfig } from '../core/config/user-config.js';
import { writeScopedLog } from '../core/logging.js';

const tlog = (msg: string) => writeScopedLog('pikichannel', `[turn] ${msg}`, { level: 'info' });

/** A single ICE server entry. `urls` is a single string (werift requires this;
 *  the browser accepts it too) — Cloudflare's grouped `urls` arrays are flattened
 *  into one entry per URL by {@link flattenCloudflare}. */
export interface IceServer {
  urls: string;
  username?: string;
  credential?: string;
}

export interface TurnConfig {
  keyId: string;
  apiToken: string;
  /** Seconds the minted credentials remain valid. */
  ttl: number;
}

/** Default credential lifetime (24h). Must exceed a single session's duration. */
const DEFAULT_TTL = 86_400;
/** Floor for TTL so a fat-fingered tiny value can't churn the cache. */
const MIN_TTL = 600;
/** Re-mint this long before expiry so live connections never use dead creds. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
/** Abort a hung Cloudflare call so connection setup falls back to STUN promptly. */
const MINT_TIMEOUT_MS = 8_000;
/** Cloudflare credentials endpoint (the array-returning `generate-ice-servers`). */
const CF_ENDPOINT = (keyId: string) =>
  `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`;

/** Free public STUN used when no TURN is configured. Google first keeps the
 *  no-config host's behavior identical to before; Cloudflare added for redundancy. */
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

/** Resolve TURN config from env (highest) then ~/.pikiloom/setting.json. */
export function resolveTurnConfig(): TurnConfig {
  const cfg = loadUserConfig();
  const keyId = String(process.env.PIKICHANNEL_TURN_KEY_ID || cfg.pikichannelTurnKeyId || '').trim();
  const apiToken = String(process.env.PIKICHANNEL_TURN_API_TOKEN || cfg.pikichannelTurnApiToken || '').trim();
  const ttlRaw = process.env.PIKICHANNEL_TURN_TTL || (cfg.pikichannelTurnTtl != null ? String(cfg.pikichannelTurnTtl) : '');
  const ttl = Math.max(MIN_TTL, Number.parseInt(ttlRaw, 10) || DEFAULT_TTL);
  return { keyId, apiToken, ttl };
}

/** A manual `PIKICHANNEL_ICE_SERVERS` JSON override, flattened — or null. This
 *  preserves the original escape hatch and takes precedence over minting. */
function manualIceServers(): IceServer[] | null {
  const raw = process.env.PIKICHANNEL_ICE_SERVERS;
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    if (Array.isArray(v) && v.length) return flatten(v as Array<{ urls: string | string[]; username?: string; credential?: string }>);
  } catch { /* fall through */ }
  return null;
}

/** Flatten any `{ urls: string | string[], ... }[]` into one entry per URL,
 *  carrying username/credential onto each. werift treats `urls` as a string. */
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

/** Mint a fresh set of short-lived ICE servers from Cloudflare. Throws on any
 *  non-2xx / network error / timeout so the caller can fall back to STUN. */
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

/** (Re)mint into the module cache. Single-flight: concurrent callers await one
 *  in-flight mint. On failure the last-good cache is kept if still for this key;
 *  otherwise cleared so the resolver yields STUN. */
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

/**
 * Mint TURN credentials ahead of the first connection (call once at mount).
 * Best-effort and non-blocking-by-design — awaiting it is optional. No creds /
 * manual override → no-op.
 */
export async function prewarmTurn(): Promise<void> {
  if (manualIceServers()) return;
  const cfg = resolveTurnConfig();
  if (!cfg.keyId || !cfg.apiToken) return;
  await refresh(cfg);
}

/**
 * The current resolved ICE servers, synchronously, for building a peer
 * connection. Order of precedence: manual override → cached Cloudflare creds →
 * STUN. When the cache is missing/stale it kicks off a background refresh and
 * returns the best value available right now (never blocks, never returns
 * expired creds).
 */
export function getCachedIceServers(): IceServer[] {
  const manual = manualIceServers();
  if (manual) return manual;

  const cfg = resolveTurnConfig();
  if (!cfg.keyId || !cfg.apiToken) return DEFAULT_STUN;

  const key = cfgKey(cfg);
  const fresh = !!cache && cache.key === key && Date.now() < cache.expiresAt - REFRESH_MARGIN_MS;
  if (!fresh) void refresh(cfg); // background; don't block the handshake

  // Use cached creds only while genuinely unexpired; otherwise STUN.
  if (cache && cache.key === key && Date.now() < cache.expiresAt) return cache.servers;
  return DEFAULT_STUN;
}

/** Async resolver (mint awaited) — for status, tests, and one-off callers. */
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

/**
 * Reduce a (flattened) ICE list to what werift's primitive `parseIceServers`
 * actually consumes: it takes the FIRST `stun:` and FIRST `turn:` entry, reads
 * `urls` as a string, and connects to TURN over UDP. So we hand it exactly one
 * STUN and one UDP TURN entry. `turns:` (TLS) is dropped — werift's TURN client
 * speaks only udp/tcp. List order is meaningful: Cloudflare returns :3478/udp
 * first, and DEFAULT_STUN puts Google first, so the right entries win.
 */
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

/** Lightweight status for /pikichannel/status (no secrets). */
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

/** Test-only: drop the module cache + in-flight mint so cases start clean. */
export function __resetTurnCacheForTest(): void {
  cache = null;
  pending = null;
}
