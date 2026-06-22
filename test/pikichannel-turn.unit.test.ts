import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Drive resolveTurnConfig's config source without touching ~/.pikiloom/setting.json.
const { cfgRef } = vi.hoisted(() => ({ cfgRef: { value: { version: 1 } as Record<string, unknown> } }));
vi.mock('../src/core/config/user-config.js', () => ({ loadUserConfig: () => cfgRef.value }));
// Keep the minter's logging from writing to the real log file during tests.
vi.mock('../src/core/logging.js', () => ({ writeScopedLog: () => {} }));

import {
  resolveIceServers,
  getCachedIceServers,
  toWeriftIceServers,
  resolveTurnConfig,
  turnStatus,
  prewarmTurn,
  __resetTurnCacheForTest,
  type IceServer,
} from '../src/pikichannel/turn.js';

// The exact shape Cloudflare's generate-ice-servers endpoint returns.
const CF_RESPONSE = {
  iceServers: [
    { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.cloudflare.com:53'] },
    {
      urls: [
        'turn:turn.cloudflare.com:3478?transport=udp',
        'turn:turn.cloudflare.com:53?transport=udp',
        'turn:turn.cloudflare.com:3478?transport=tcp',
        'turn:turn.cloudflare.com:80?transport=tcp',
        'turns:turn.cloudflare.com:5349?transport=tcp',
        'turns:turn.cloudflare.com:443?transport=tcp',
      ],
      username: 'cf-user',
      credential: 'cf-cred',
    },
  ],
};

const STUN_ONLY: IceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

const TURN_ENV = ['PIKICHANNEL_TURN_KEY_ID', 'PIKICHANNEL_TURN_API_TOKEN', 'PIKICHANNEL_TURN_TTL', 'PIKICHANNEL_ICE_SERVERS'];
const savedEnv: Record<string, string | undefined> = {};

function okFetch(body: unknown, status = 201) {
  return vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => body }));
}

beforeEach(() => {
  __resetTurnCacheForTest();
  cfgRef.value = { version: 1 };
  for (const k of TURN_ENV) { savedEnv[k] = process.env[k]; delete process.env[k]; }
});

afterEach(() => {
  for (const k of TURN_ENV) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
  vi.restoreAllMocks();
});

describe('resolveTurnConfig', () => {
  it('defaults TTL to 24h and reads from config', () => {
    cfgRef.value = { version: 1, pikichannelTurnKeyId: 'cfgkey', pikichannelTurnApiToken: 'cfgtok' };
    expect(resolveTurnConfig()).toEqual({ keyId: 'cfgkey', apiToken: 'cfgtok', ttl: 86400 });
  });

  it('lets env override config and floors a too-small TTL', () => {
    cfgRef.value = { version: 1, pikichannelTurnKeyId: 'cfgkey', pikichannelTurnApiToken: 'cfgtok', pikichannelTurnTtl: 99999 };
    process.env.PIKICHANNEL_TURN_KEY_ID = 'envkey';
    process.env.PIKICHANNEL_TURN_TTL = '5'; // below MIN_TTL → floored to 600
    const c = resolveTurnConfig();
    expect(c.keyId).toBe('envkey'); // env wins
    expect(c.apiToken).toBe('cfgtok'); // falls back to config
    expect(c.ttl).toBe(600);
  });
});

describe('no Cloudflare config', () => {
  it('returns STUN and never calls Cloudflare', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const servers = await resolveIceServers();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(servers).toEqual(STUN_ONLY);
    expect(turnStatus()).toEqual({ turn: false, provider: null, relay: false, expiresAt: null });
  });

  it('prewarmTurn is a no-op without creds', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await prewarmTurn();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('manual PIKICHANNEL_ICE_SERVERS override', () => {
  it('is used verbatim (flattened) and suppresses minting even when creds exist', async () => {
    process.env.PIKICHANNEL_TURN_KEY_ID = 'k';
    process.env.PIKICHANNEL_TURN_API_TOKEN = 't';
    process.env.PIKICHANNEL_ICE_SERVERS = JSON.stringify([
      { urls: ['stun:a:1', 'stun:b:2'] },
      { urls: 'turn:c:3', username: 'u', credential: 'p' },
    ]);
    const fetchSpy = okFetch(CF_RESPONSE);
    vi.stubGlobal('fetch', fetchSpy);
    const servers = await resolveIceServers();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(servers).toEqual([
      { urls: 'stun:a:1' },
      { urls: 'stun:b:2' },
      { urls: 'turn:c:3', username: 'u', credential: 'p' },
    ]);
    expect(turnStatus()).toMatchObject({ provider: 'manual', turn: true, relay: true });
  });
});

describe('Cloudflare minting', () => {
  beforeEach(() => {
    process.env.PIKICHANNEL_TURN_KEY_ID = 'mykey';
    process.env.PIKICHANNEL_TURN_API_TOKEN = 'mytoken';
  });

  it('POSTs the right endpoint/headers/ttl and flattens the response', async () => {
    const fetchSpy = okFetch(CF_RESPONSE);
    vi.stubGlobal('fetch', fetchSpy);
    const servers = await resolveIceServers();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, any];
    expect(url).toBe('https://rtc.live.cloudflare.com/v1/turn/keys/mykey/credentials/generate-ice-servers');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer mytoken');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({ ttl: 86400 });

    // 2 stun + 6 turn/turns, each url its own entry; creds only on turn entries.
    expect(servers).toHaveLength(8);
    expect(servers[0]).toEqual({ urls: 'stun:stun.cloudflare.com:3478' });
    expect(servers[0].username).toBeUndefined();
    expect(servers.find((s) => s.urls === 'turn:turn.cloudflare.com:3478?transport=udp')).toEqual({
      urls: 'turn:turn.cloudflare.com:3478?transport=udp',
      username: 'cf-user',
      credential: 'cf-cred',
    });
    expect(servers.find((s) => s.urls.startsWith('turns:'))?.credential).toBe('cf-cred');

    expect(turnStatus()).toMatchObject({ turn: true, provider: 'cloudflare', relay: true });
    expect(turnStatus().expiresAt).toBeGreaterThan(Date.now());
  });

  it('caches across calls (single-flight) — one mint for concurrent + repeat callers', async () => {
    const fetchSpy = okFetch(CF_RESPONSE);
    vi.stubGlobal('fetch', fetchSpy);
    await Promise.all([resolveIceServers(), resolveIceServers(), resolveIceServers()]);
    await resolveIceServers();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('falls back to STUN on a non-2xx response (no throw)', async () => {
    const fetchSpy = okFetch({ error: 'nope' }, 401);
    vi.stubGlobal('fetch', fetchSpy);
    const servers = await resolveIceServers();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(servers).toEqual(STUN_ONLY);
    expect(turnStatus()).toMatchObject({ turn: true, provider: 'cloudflare', relay: false });
  });

  it('falls back to STUN when fetch throws / times out', async () => {
    const fetchSpy = vi.fn(async () => { throw new Error('aborted'); });
    vi.stubGlobal('fetch', fetchSpy);
    const servers = await resolveIceServers();
    expect(servers).toEqual(STUN_ONLY);
  });

  it('re-mints just before expiry and never serves expired credentials', async () => {
    process.env.PIKICHANNEL_TURN_TTL = '600'; // ttl=600s; refresh margin=300s
    const fetchSpy = okFetch(CF_RESPONSE);
    vi.stubGlobal('fetch', fetchSpy);
    const now = vi.spyOn(Date, 'now');

    now.mockReturnValue(1_000_000);
    await resolveIceServers(); // mint #1 → expiresAt = 1_600_000
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Inside the fresh window (< expiresAt - 300s): served from cache, no refetch.
    now.mockReturnValue(1_200_000);
    expect(getCachedIceServers().some((s) => s.urls.startsWith('turn:'))).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Inside the refresh margin (>= 1_300_000, < expiry): background re-mint fires,
    // but live creds are still served (not dropped mid-connection).
    now.mockReturnValue(1_350_000);
    expect(getCachedIceServers().some((s) => s.urls.startsWith('turn:'))).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    await new Promise((r) => setImmediate(r)); // let the background re-mint settle
  });

  it('serves STUN (not stale creds) past expiry when the re-mint fails', async () => {
    process.env.PIKICHANNEL_TURN_TTL = '600';
    const now = vi.spyOn(Date, 'now').mockReturnValue(0);
    vi.stubGlobal('fetch', okFetch(CF_RESPONSE));
    await resolveIceServers(); // expiresAt = 600_000

    vi.stubGlobal('fetch', okFetch({}, 500)); // re-mint will fail
    now.mockReturnValue(700_000); // past expiry
    expect(getCachedIceServers()).toEqual(STUN_ONLY);
    await new Promise((r) => setImmediate(r));
  });

  it('mints from config-only creds (no env)', async () => {
    delete process.env.PIKICHANNEL_TURN_KEY_ID;
    delete process.env.PIKICHANNEL_TURN_API_TOKEN;
    cfgRef.value = { version: 1, pikichannelTurnKeyId: 'cfgkey', pikichannelTurnApiToken: 'cfgtok' };
    const fetchSpy = okFetch(CF_RESPONSE);
    vi.stubGlobal('fetch', fetchSpy);
    await resolveIceServers();
    const [url, init] = fetchSpy.mock.calls[0] as [string, any];
    expect(url).toContain('/keys/cfgkey/');
    expect(init.headers.Authorization).toBe('Bearer cfgtok');
  });
});

describe('toWeriftIceServers', () => {
  it('reduces a minted list to one STUN + one UDP TURN and drops turns:', async () => {
    process.env.PIKICHANNEL_TURN_KEY_ID = 'k';
    process.env.PIKICHANNEL_TURN_API_TOKEN = 't';
    vi.stubGlobal('fetch', okFetch(CF_RESPONSE));
    const full = await resolveIceServers();

    const werift = toWeriftIceServers(full);
    expect(werift).toEqual([
      { urls: 'stun:stun.cloudflare.com:3478' },
      { urls: 'turn:turn.cloudflare.com:3478?transport=udp', username: 'cf-user', credential: 'cf-cred' },
    ]);
    expect(werift.some((s) => s.urls.startsWith('turns:'))).toBe(false);
  });

  it('passes STUN through (no TURN entry) when no creds are configured', () => {
    const werift = toWeriftIceServers(getCachedIceServers());
    expect(werift).toEqual([{ urls: 'stun:stun.l.google.com:19302' }]);
  });
});
