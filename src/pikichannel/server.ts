/**
 * pikichannel/server.ts — wires pikichannel into the pikiloom dashboard server.
 *
 * Responsibilities:
 *   - build the host over the pikiloom SessionSource,
 *   - stand up BOTH transport bindings (WebSocket always; WebRTC via a guarded
 *     dynamic import so a missing/broken werift never blocks startup),
 *   - register the reference web routes (demo page + browser SDK + status),
 *   - expose `attachUpgrade(server)` so the dashboard's HTTP server can route
 *     `/pikichannel/*` upgrade requests to the right binding.
 *
 * Both bindings funnel into the SAME `host.handleConnection`, so a session
 * behaves identically regardless of transport — that is the pluggability the
 * two bindings exist to demonstrate.
 */

import type http from 'node:http';
import type internal from 'node:stream';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Hono } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { writeScopedLog } from '../core/logging.js';
import { loadUserConfig, updateUserConfig } from '../core/config/user-config.js';
import { PikichannelHost } from './host.js';
import { prewarmTurn, turnStatus } from './turn.js';
import { PikiloomSessionSource, type RequestForwarder } from './adapter-pikiloom.js';
import { WebSocketTransport } from './transports/websocket-host.js';
import { RendezvousBroker } from './rendezvous-broker.js';
import type { RendezvousHostClient } from './rendezvous-host.js';
import type { ChannelConnection, ChannelTransport } from './transport.js';

export interface PikichannelHandle {
  /** Try to handle a `/pikichannel/*` WebSocket upgrade. Returns true if the
   *  path was ours (handled or rejected), false to let the caller deal with it. */
  handleUpgrade(req: http.IncomingMessage, socket: internal.Duplex, head: Buffer): boolean;
  status(): {
    ok: boolean; transports: string[]; peers: number; authedPeers: number;
    webrtc: boolean; webrtcError: string | null; authRequired: boolean; strict: boolean;
    nodeId: string; rendezvous: string | null; publicHost: string | null; registered: boolean; broker: { hosts: number; sessions: number };
    turn: { turn: boolean; provider: 'cloudflare' | 'manual' | null; relay: boolean; expiresAt: number | null };
  };
  stop(): void;
}

/** A remote address label is loopback when it is the local host. */
function isLoopback(remote: string | undefined): boolean {
  if (!remote) return false;
  const r = remote.toLowerCase();
  return r.startsWith('127.') || r.includes('127.0.0.1') || r === '::1' || r.startsWith('::1:') || r.startsWith('[::1]') || r.includes('::ffff:127.');
}

/** Constant-time token comparison. */
function tokenMatches(presented: string | undefined, expected: string): boolean {
  if (!presented || !expected) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

interface WsLikeTransport extends ChannelTransport {
  handleUpgrade(req: http.IncomingMessage, socket: internal.Duplex, head: Buffer): void;
}

function readWebAsset(name: string): string {
  const file = path.join(import.meta.dirname, 'web', name);
  return fs.readFileSync(file, 'utf8');
}

export async function mountPikichannel(app: Hono): Promise<PikichannelHandle> {
  const log = (msg: string) => writeScopedLog('pikichannel', msg, { level: 'info' });

  // -- Access token: provision on first run, persist to ~/.pikiloom/setting.json.
  //    Loopback peers (the local dashboard / same-machine demo) are exempt;
  //    remote peers must present this token in `hello`. `strict` requires the
  //    token even from loopback (defense-in-depth / testing). --
  const cfg = loadUserConfig();
  // Env overrides (docker / headless): PIKICHANNEL_TOKEN pins the token without
  // persisting; PIKICHANNEL_STRICT=1 forces token even from loopback.
  const envToken = String(process.env.PIKICHANNEL_TOKEN || '').trim();
  let token = envToken || String(cfg.pikichannelToken || '').trim();
  if (!token) {
    token = crypto.randomBytes(24).toString('base64url');
    try { updateUserConfig({ pikichannelToken: token }); log('provisioned a new pikichannel access token'); }
    catch (err) { log(`could not persist access token: ${(err as Error)?.message}`); }
  }
  const strict = cfg.pikichannelStrictAuth === true || process.env.PIKICHANNEL_STRICT === '1';
  const authenticate = (presented: string | undefined, remote: string | undefined): boolean => {
    if (!strict && isLoopback(remote)) return true;
    return tokenMatches(presented, token);
  };

  // -- NodeID: the stable address a remote client dials over the rendezvous. --
  let nodeId = String(cfg.pikichannelNodeId || '').trim();
  if (!nodeId) {
    nodeId = crypto.randomBytes(8).toString('hex');
    try { updateUserConfig({ pikichannelNodeId: nodeId }); } catch { /* persisted best-effort */ }
  }
  const rendezvousUrl = String(process.env.PIKICHANNEL_RENDEZVOUS || cfg.pikichannelRendezvous || '').trim();
  let currentPublicHost = String(process.env.PIKICHANNEL_PUBLIC_HOST || cfg.pikichannelPublicHost || '').trim();

  // Control-plane tunnel forwarder: replay a tunneled request against the SAME
  // Hono router that serves /api/* locally — management logic stays single-sourced.
  // Text responses ride as utf8; anything else (attachment bytes) as base64.
  const forward: RequestForwarder = async (req) => {
    const init: RequestInit = { method: req.method || 'GET', headers: req.headers };
    if (req.body != null && req.method && req.method !== 'GET' && req.method !== 'HEAD') {
      init.body = req.encoding === 'base64' ? new Uint8Array(Buffer.from(req.body, 'base64')) : req.body;
    }
    const res = await app.fetch(new Request(`http://pikichannel.internal${req.path}`, init));
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => { headers[k] = v; });
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    const isText = ct === '' || /json|text|javascript|xml|svg|x-ndjson|form-urlencoded/.test(ct);
    if (isText) return { status: res.status, headers, body: await res.text(), encoding: 'utf8' };
    const buf = Buffer.from(await res.arrayBuffer());
    return { status: res.status, headers, body: buf.toString('base64'), encoding: 'base64' };
  };

  const source = new PikiloomSessionSource(forward);
  const host = new PikichannelHost(source, authenticate, log);
  host.start();

  // -- WebSocket binding (always available) --
  const wsTransport = new WebSocketTransport();
  wsTransport.start((conn: ChannelConnection) => host.handleConnection(conn));

  // -- WebRTC binding (guarded; degrades gracefully) --
  let rtcTransport: WsLikeTransport | null = null;
  let webrtcError: string | null = null;
  try {
    const mod = await import('./transports/webrtc-host.js');
    const t = new mod.WebRTCTransport();
    t.start((conn: ChannelConnection) => host.handleConnection(conn));
    rtcTransport = t;
    log('webrtc transport ready');
  } catch (err) {
    webrtcError = (err as Error)?.message || String(err);
    log(`webrtc transport unavailable: ${webrtcError}`);
  }

  // Pre-mint Cloudflare TURN credentials (if configured) so the first WebRTC
  // connection already has a relay to fall back to. Best-effort, non-blocking;
  // no creds → no-op, and the answerer resolves STUN until/unless minting lands.
  void prewarmTurn();

  // -- Rendezvous broker (NAT traversal): always mounted (no werift dep), so any
  //    reachable pikiloom can broker signaling for NAT'd peers. Relays signaling
  //    only; data stays P2P. --
  const broker = new RendezvousBroker();

  // -- Rendezvous registrar: when enabled, this host dials OUT to a broker and
  //    registers its NodeID so remote clients can reach it through NAT. Can be
  //    toggled at RUNTIME (one-click from the dashboard) — no restart. Needs
  //    werift, so the host-client class is loaded only when WebRTC is available. --
  let rendezvousHost: RendezvousHostClient | null = null;
  let HostClientCtor: typeof import('./rendezvous-host.js').RendezvousHostClient | null = null;
  let currentRendezvous = '';
  if (rtcTransport) {
    try { HostClientCtor = (await import('./rendezvous-host.js')).RendezvousHostClient; }
    catch (err) { log(`rendezvous-host load failed: ${(err as Error)?.message || err}`); }
  }
  async function setRendezvous(url: string | null, persist = true): Promise<{ ok: boolean; error?: string }> {
    const next = (url || '').trim();
    if (rendezvousHost) { rendezvousHost.stop(); rendezvousHost = null; }
    currentRendezvous = '';
    if (next) {
      if (!HostClientCtor) return { ok: false, error: 'WebRTC unavailable on this host' };
      rendezvousHost = new HostClientCtor(next, nodeId, (conn: ChannelConnection) => host.handleConnection(conn));
      rendezvousHost.start();
      currentRendezvous = next;
    }
    if (persist) { try { updateUserConfig({ pikichannelRendezvous: next }); } catch { /* best-effort */ } }
    log(`rendezvous ${next ? `enabled url=${next} nodeId=${nodeId}` : 'disabled'}`);
    return { ok: true };
  }
  if (rendezvousUrl) await setRendezvous(rendezvousUrl, false); // initial from env/config

  // -- Web assets (read once; the demo + SDK double as the OSS reference client) --
  let sdkJs = '';
  let demoHtml = '';
  try { sdkJs = readWebAsset('sdk.js'); demoHtml = readWebAsset('demo.html'); }
  catch (err) { log(`web assets missing: ${(err as Error)?.message}`); }

  const serveDemo = (c: any) => { c.header('Cache-Control', 'no-cache'); return c.html(demoHtml || '<h1>pikichannel demo asset missing</h1>'); };
  app.get('/pikichannel', serveDemo);
  app.get('/pikichannel/', serveDemo);
  // QR of a connection code (or any short string) as SVG — reuses the repo's
  // `qrcode` dep so the browser SDK needs no QR library. Dynamic-imported to
  // keep startup lean.
  app.get('/pikichannel/qr', async (c: any) => {
    const data = String(c.req.query('data') || '').slice(0, 2048);
    if (!data) return c.text('missing data', 400);
    try {
      const QRCode = (await import('qrcode')).default;
      const svg = await QRCode.toString(data, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
      c.header('Content-Type', 'image/svg+xml; charset=utf-8');
      c.header('Cache-Control', 'no-store');
      return c.body(svg);
    } catch { return c.text('qr failed', 500); }
  });
  app.get('/pikichannel/sdk.js', (c: any) => {
    c.header('Content-Type', 'application/javascript; charset=utf-8');
    c.header('Cache-Control', 'no-cache');
    return c.body(sdkJs || '// pikichannel sdk asset missing');
  });
  app.get('/pikichannel/status', (c: any) => c.json(statusObj()));

  // -- Pairing: hand the access token to a trusted LOCAL caller only (the
  //    dashboard / CLI on this machine). Remote callers get 403 — they must be
  //    paired out-of-band (token shown in the local dashboard, scanned as a QR). --
  app.get('/pikichannel/pair', (c: any) => {
    let remote: string | undefined;
    try { remote = getConnInfo(c)?.remote?.address; } catch { remote = undefined; }
    if (!isLoopback(remote)) return c.json({ ok: false, error: 'pairing is only available from localhost' }, 403);
    return c.json({ ok: true, token, strict, nodeId, rendezvous: currentRendezvous || null, publicHost: currentPublicHost || null, registered: !!rendezvousHost, hint: 'paste the connection code into a client' });
  });

  // -- Remote-access settings: configure how others reach THIS host — a public
  //    address (direct) and/or internet穿透 (rendezvous). Runtime, one-click,
  //    localhost-only (it changes who can reach this machine). --
  app.post('/pikichannel/remote', async (c: any) => {
    let remote: string | undefined;
    try { remote = getConnInfo(c)?.remote?.address; } catch { remote = undefined; }
    if (!isLoopback(remote)) return c.json({ ok: false, error: 'only available from localhost' }, 403);
    const body = await c.req.json().catch(() => ({}));
    if ('publicHost' in body) {
      currentPublicHost = String(body.publicHost || '').trim();
      try { updateUserConfig({ pikichannelPublicHost: currentPublicHost }); } catch { /* best-effort */ }
    }
    let r: { ok: boolean; error?: string } = { ok: true };
    if ('enabled' in body || 'rendezvous' in body) {
      r = await setRendezvous(body?.enabled ? String(body?.rendezvous || '') : null);
    }
    return c.json({ ...r, registered: !!rendezvousHost, rendezvous: currentRendezvous || null, publicHost: currentPublicHost || null, nodeId, token });
  });

  function statusObj() {
    return {
      ok: true,
      transports: rtcTransport ? ['websocket', 'webrtc'] : ['websocket'],
      peers: host.peerCount,
      authedPeers: host.authedPeerCount,
      webrtc: !!rtcTransport,
      webrtcError,
      authRequired: true,
      strict,
      nodeId,
      rendezvous: currentRendezvous || null,
      publicHost: currentPublicHost || null,
      registered: !!rendezvousHost,
      broker: broker.stats,
      turn: turnStatus(),
    };
  }

  return {
    handleUpgrade(req, socket, head): boolean {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      if (!url.pathname.startsWith('/pikichannel/')) return false; // not ours
      if (url.pathname === '/pikichannel/ws') { wsTransport.handleUpgrade(req, socket, head); return true; }
      if (url.pathname === '/pikichannel/signal' && rtcTransport) { rtcTransport.handleUpgrade(req, socket, head); return true; }
      if (url.pathname === '/pikichannel/rendezvous') { broker.handleUpgrade(req, socket, head); return true; }
      socket.destroy(); // unknown /pikichannel/* subpath (or webrtc disabled)
      return true;
    },
    status: statusObj,
    stop() { host.stop(); wsTransport.stop(); rtcTransport?.stop(); rendezvousHost?.stop(); broker.stop(); },
  };
}
