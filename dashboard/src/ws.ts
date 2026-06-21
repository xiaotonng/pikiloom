/**
 * ws.ts — Singleton push connection + React hook for dashboard live events.
 *
 * The dashboard's ONE inbound transport is pikichannel (`/pikichannel/ws`) — the
 * same universal L2 protocol mobile/web/remote clients use. There is no second
 * stack: the legacy `/ws` path was retired. The wire schema is a single
 * UniversalSnapshot delivered as deltas; this module reconstructs the cumulative
 * snapshot and adapts it (channelToSnapshot) into the StreamSnapshot-shaped
 * object the SPA's applyStreamSnapshot / normalizeLiveSessionState already
 * consume — and which the REST initial-state fetch also returns. That thin
 * wire→view-model adapter is the single, deliberate boundary: the wire protocol
 * stays agent-agnostic; the SPA keeps its own view-model; neither leaks into the
 * other. Components are unchanged — they still see DashboardEvent.
 *
 * The public API — useDashboardEvent / useDashboardReconnect — is unchanged.
 */

import { useEffect, useRef } from 'react';
import { getEndpoint, isRemote } from './endpoint';

// ---------------------------------------------------------------------------
// Types — DashboardEvent is the SPA-internal pub/sub envelope (not a wire type).
// ---------------------------------------------------------------------------

export type DashboardEventType = 'stream-update' | 'sessions-changed';

export interface DashboardEvent {
  type: DashboardEventType;
  key?: string;
  snapshot?: unknown;
}

type Listener = (event: DashboardEvent) => void;

// ---------------------------------------------------------------------------
// Singleton connection with auto-reconnect
// ---------------------------------------------------------------------------

const listeners = new Map<DashboardEventType, Set<Listener>>();
const reconnectListeners = new Set<() => void>();

// A transport pipe: WebSocket (local/direct) or WebRTC datachannel (remote/NAT).
// The protocol logic runs over it identically. Mirrors the SDK transports.
interface Pipe { send(frame: string): void; close(): void; isOpen(): boolean; }
interface PipeCbs { onOpen(): void; onFrame(raw: string): void; onClose(): void; }
const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

let pipe: Pipe | null = null;
let connecting = false;
let authed = false;       // welcome received on the current connection
let refCount = 0;
// In remote mode the channel must stay up for the control-plane tunnel even
// when no stream is subscribed, so connection is not gated on refCount.
let keepAlive = false;
let wasConnected = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelay = 500;
const MAX_RECONNECT_DELAY = 8_000;

// Access token — only needed when the host runs in strict auth (loopback is
// exempt by default, which covers the local dashboard). Fetched once, best-effort,
// from the localhost-only pairing endpoint; absent token is fine in the default
// posture. A remotely-served dashboard gets 403 here and must be paired anyway.
let token: string | null = null;
let tokenFetched = false;
async function ensureToken(): Promise<void> {
  if (tokenFetched) return;
  tokenFetched = true;
  const ep = getEndpoint();
  if (ep) { token = ep.token || null; return; } // remote: token supplied via config
  try {
    // local: loopback is exempt, so this is best-effort (covers strict mode).
    const r = await fetch('/pikichannel/pair');
    if (r.ok) { const j = await r.json(); if (j && typeof j.token === 'string') token = j.token; }
  } catch { /* token optional */ }
}

function dispatch(event: DashboardEvent) {
  const set = listeners.get(event.type);
  if (set) for (const fn of set) fn(event);
}

// Resolve the ws(s):// URL for the configured endpoint (or same origin).
function wsUrl(path: string): string {
  const loc = window.location;
  const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  const ep = getEndpoint();
  if (!ep || !ep.host) return `${proto}//${loc.host}${path}`;
  const h = ep.host;
  let base: string;
  if (/^wss?:\/\//.test(h)) base = h.replace(/\/$/, '');
  else if (/^https:\/\//.test(h)) base = 'wss://' + h.slice(8).replace(/\/$/, '');
  else if (/^http:\/\//.test(h)) base = 'ws://' + h.slice(7).replace(/\/$/, '');
  else base = `${proto}//${h.replace(/\/$/, '')}`;
  return base + path;
}

function fireReconnect() {
  const isReconnect = wasConnected;
  wasConnected = true;
  reconnectDelay = 500;
  if (isReconnect) for (const fn of reconnectListeners) fn();
}

// Delta reconstruction: the wire carries patches, so we keep the cumulative
// snapshot per session and apply each one. Mirror of applySnapshotPatch() in
// src/pikichannel/protocol.ts — keep in lockstep.
const channelSnaps = new Map<string, any>();
const channelSeqs = new Map<string, number>();
function applyChannelPatch(prev: any, patch: any): any {
  if (patch.full) return patch.full;
  const next = prev ? { ...prev } : { phase: 'idle', updatedAt: 0 };
  if (patch.appendText) next.text = (next.text || '') + patch.appendText;
  if (patch.appendReasoning) next.reasoning = (next.reasoning || '') + patch.appendReasoning;
  if (patch.set) Object.assign(next, patch.set);
  return next;
}

/**
 * Adapt a reconstructed UniversalSnapshot into the StreamSnapshot shape the SPA
 * consumes (the same shape the REST stream-state endpoint returns). The session
 * key comes from the envelope — it is not duplicated in the snapshot.
 */
function channelToSnapshot(key: string, u: any): any {
  if (!u) return null;
  const sessionId = key.includes(':') ? key.slice(key.indexOf(':') + 1) : key;
  const usage = u.usage || null;
  return {
    sessionId,
    phase: u.phase,
    taskId: u.taskId ?? null,
    queuedTaskIds: Array.isArray(u.queued) ? u.queued.map((q: any) => q.taskId) : [],
    queuedTasks: Array.isArray(u.queued) ? u.queued : [],
    interactions: Array.isArray(u.interactions) ? u.interactions : [],
    text: u.text || '',
    thinking: u.reasoning || '',
    activity: u.activity,
    plan: u.plan ? { explanation: u.plan.explanation, steps: (u.plan.steps || []).map((s: any) => ({ step: s.text, status: s.status })) } : null,
    model: u.model ?? null,
    effort: u.effort ?? null,
    question: u.prompt ?? null,
    artifacts: Array.isArray(u.artifacts) ? u.artifacts : [],
    startedAt: typeof u.startedAt === 'number' ? u.startedAt : undefined,
    updatedAt: u.updatedAt,
    error: u.error ?? undefined,
    incomplete: u.incomplete,
    previewMeta: usage ? {
      inputTokens: usage.inputTokens ?? null,
      outputTokens: usage.outputTokens ?? null,
      cachedInputTokens: usage.cachedInputTokens ?? null,
      contextUsedTokens: usage.contextUsedTokens ?? null,
      contextPercent: usage.contextPercent ?? null,
      turnOutputTokens: usage.turnOutputTokens ?? null,
      providerName: usage.providerName ?? null,
      subAgents: u.subAgents ?? undefined,
      toolCalls: u.toolCalls ?? undefined,
      generatingImages: usage.generatingImages ?? 0,
    } : null,
  };
}

// ---------------------------------------------------------------------------
// Control-plane tunnel — /api/* over the channel (used when remote-pointed).
// ---------------------------------------------------------------------------

interface ChannelResponse { status: number; headers: Record<string, string>; body: string; encoding: string; error?: string; }
const channelPending = new Map<string, { resolve: (r: ChannelResponse) => void; reject: (e: Error) => void }>();
let channelReqSeq = 0;

function awaitReady(timeoutMs = 10000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (authed && pipe && pipe.isOpen()) { resolve(); return; }
    connect();
    const t0 = Date.now();
    const tick = () => {
      if (authed && pipe && pipe.isOpen()) return resolve();
      if (Date.now() - t0 > timeoutMs) return reject(new Error('channel connect timeout'));
      setTimeout(tick, 100);
    };
    tick();
  });
}

/** Tunnel an HTTP-style request to the connected host over the channel. */
export async function channelRequest(
  method: string,
  path: string,
  opts: { headers?: Record<string, string>; body?: string } = {},
): Promise<ChannelResponse> {
  await awaitReady();
  return new Promise<ChannelResponse>((resolve, reject) => {
    if (!pipe || !pipe.isOpen()) { reject(new Error('channel not connected')); return; }
    const id = 'q' + (++channelReqSeq);
    channelPending.set(id, { resolve, reject });
    pipe.send(JSON.stringify({ type: 'request', id, method, path, headers: opts.headers, body: opts.body, encoding: 'utf8' }));
    setTimeout(() => { if (channelPending.has(id)) { channelPending.delete(id); reject(new Error('channel request timeout')); } }, 20000);
  });
}

function failChannelPending(reason: string) {
  for (const [, p] of channelPending) { try { p.reject(new Error(reason)); } catch { /* ignore */ } }
  channelPending.clear();
}

function pipeSend(obj: any) { if (pipe && pipe.isOpen()) pipe.send(JSON.stringify(obj)); }

function connect() {
  if (pipe || connecting) return;
  connecting = true;
  clearReconnectTimer();
  void ensureToken().finally(() => {
    connecting = false;
    if ((refCount <= 0 && !keepAlive) || pipe) return; // nobody needs it, or already opened
    openConnection();
  });
}

function openConnection() {
  const ep = getEndpoint();
  const cbs: PipeCbs = {
    onOpen: () => {
      const hello: any = { type: 'hello', v: 1, client: { name: 'pikiloom-dashboard', platform: navigator.userAgent } };
      if (token) hello.token = token;
      pipeSend(hello);
    },
    onFrame: handleFrame,
    onClose: () => { pipe = null; authed = false; failChannelPending('channel closed'); if (refCount > 0 || keepAlive) scheduleReconnect(); },
  };
  pipe = (ep && ep.mode === 'remote' && ep.rendezvous && ep.nodeId)
    ? openRtcPipe(ep.rendezvous, ep.nodeId, cbs)   // NAT: WebRTC via rendezvous
    : openWsPipe(wsUrl('/pikichannel/ws'), cbs);    // local / direct: WebSocket
}

function handleFrame(raw: string) {
  let m: any; try { m = JSON.parse(raw); } catch { return; }
  switch (m.type) {
    case 'welcome':
      authed = true;
      channelSnaps.clear(); channelSeqs.clear(); // fresh baselines per connection
      pipeSend({ type: 'subscribe', sessionKey: '*' });
      fireReconnect();
      break;
    case 'response': {
      const p = channelPending.get(m.id);
      if (p) { channelPending.delete(m.id); p.resolve({ status: m.status, headers: m.headers || {}, body: m.body || '', encoding: m.encoding || 'utf8', error: m.error }); }
      break;
    }
    case 'session': {
      const key = m.sessionKey;
      const prev = channelSnaps.get(key) || null;
      const lastSeq = channelSeqs.get(key);
      const contiguous = lastSeq === undefined || m.seq === lastSeq + 1 || !!m.patch.full;
      if (!m.patch.full && (prev === null || !contiguous)) { pipeSend({ type: 'getSnapshot', sessionKey: key }); break; }
      const next = applyChannelPatch(prev, m.patch);
      channelSnaps.set(key, next);
      channelSeqs.set(key, m.seq);
      dispatch({ type: 'stream-update', key, snapshot: channelToSnapshot(key, next) });
      break;
    }
    case 'sessions':
      dispatch({ type: 'sessions-changed' });
      break;
    default: break; // accepted / error / pong
  }
}

/** WebSocket pipe — local (same origin) or direct (reachable host:port). */
function openWsPipe(url: string, cbs: PipeCbs): Pipe {
  const sock = new WebSocket(url);
  sock.onopen = () => cbs.onOpen();
  sock.onmessage = (e) => cbs.onFrame(typeof e.data === 'string' ? e.data : String(e.data));
  sock.onclose = () => cbs.onClose();
  sock.onerror = () => { /* onclose drives reconnect */ };
  return {
    send: (f) => { if (sock.readyState === WebSocket.OPEN) sock.send(f); },
    close: () => { try { sock.close(); } catch { /* ignore */ } },
    isOpen: () => sock.readyState === WebSocket.OPEN,
  };
}

/** WebRTC datachannel pipe — dials a NodeID through a rendezvous broker (NAT). */
function openRtcPipe(rendezvous: string, nodeId: string, cbs: PipeCbs): Pipe {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const dc = pc.createDataChannel('piki', { ordered: true });
  const sig = new WebSocket(rendezvous);
  let sessionId: string | null = null;
  let remoteSet = false;
  const pendCand: any[] = [];

  dc.onopen = () => { cbs.onOpen(); try { sig.close(); } catch { /* ignore */ } };
  dc.onmessage = (e) => cbs.onFrame(typeof e.data === 'string' ? e.data : String(e.data));
  dc.onclose = () => cbs.onClose();
  pc.onconnectionstatechange = () => { const s = pc.connectionState; if (s === 'failed' || s === 'closed' || s === 'disconnected') cbs.onClose(); };
  pc.onicecandidate = (e) => { if (e.candidate && sessionId && sig.readyState === WebSocket.OPEN) sig.send(JSON.stringify({ t: 'signal', sessionId, data: { kind: 'candidate', candidate: e.candidate.toJSON() } })); };

  sig.onopen = () => sig.send(JSON.stringify({ t: 'dial', nodeId }));
  sig.onmessage = async (m) => {
    let msg: any; try { msg = JSON.parse(m.data); } catch { return; }
    if (msg.t === 'dialed') {
      sessionId = msg.sessionId;
      const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
      sig.send(JSON.stringify({ t: 'signal', sessionId, data: { kind: 'offer', type: offer.type, sdp: offer.sdp } }));
    } else if (msg.t === 'signal' && msg.data) {
      const d = msg.data;
      if (d.kind === 'answer') { await pc.setRemoteDescription({ type: 'answer', sdp: d.sdp }); remoteSet = true; for (const c of pendCand.splice(0)) { try { await pc.addIceCandidate(c); } catch { /* ignore */ } } }
      else if (d.kind === 'candidate' && d.candidate) { if (remoteSet) { try { await pc.addIceCandidate(d.candidate); } catch { /* ignore */ } } else pendCand.push(d.candidate); }
    } else if (msg.t === 'error') { cbs.onClose(); } // node offline / unreachable
  };
  sig.onerror = () => { /* pc/dc state drives onClose */ };

  return {
    send: (f) => { if (dc.readyState === 'open') dc.send(f); },
    close: () => { try { dc.close(); } catch { /* ignore */ } try { pc.close(); } catch { /* ignore */ } try { sig.close(); } catch { /* ignore */ } },
    isOpen: () => dc.readyState === 'open',
  };
}

function disconnect() {
  clearReconnectTimer();
  if (!pipe) return;
  pipe.close();
  pipe = null;
}

function clearReconnectTimer() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (refCount > 0 || keepAlive) connect();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
}

function subscribe(type: DashboardEventType, fn: Listener) {
  let set = listeners.get(type);
  if (!set) { set = new Set(); listeners.set(type, set); }
  set.add(fn);
  refCount++;
  if (refCount === 1) connect();
}

function unsubscribe(type: DashboardEventType, fn: Listener) {
  const set = listeners.get(type);
  if (set) {
    set.delete(fn);
    if (set.size === 0) listeners.delete(type);
  }
  refCount = Math.max(0, refCount - 1);
  if (refCount === 0 && !keepAlive) disconnect();
}

// Reconnect on visibility change (tab becomes visible again)
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && (refCount > 0 || keepAlive) && !pipe) {
      reconnectDelay = 500;
      connect();
    }
  });
}

// Remote mode: keep the channel up from load so the control-plane tunnel works
// before any stream subscription. Local mode stays lazy (connect on first use).
if (typeof window !== 'undefined' && isRemote()) {
  keepAlive = true;
  connect();
}

// ---------------------------------------------------------------------------
// React hook
// ---------------------------------------------------------------------------

/**
 * Subscribe to dashboard events of a given type.
 *
 * The callback is stable — it is always called with the latest closure
 * without re-subscribing on every render.
 *
 * @param type   The event type to listen for (or null to disable).
 * @param callback  Called when a matching event arrives.
 */
export function useDashboardEvent(
  type: DashboardEventType | null,
  callback: (event: DashboardEvent) => void,
): void {
  const cbRef = useRef(callback);
  cbRef.current = callback;

  useEffect(() => {
    if (!type) return;
    const handler: Listener = (event) => cbRef.current(event);
    subscribe(type, handler);
    return () => unsubscribe(type, handler);
  }, [type]);
}

/**
 * Fires callback when the connection is re-established after a drop.
 * Useful for refreshing stale state that may have been missed during downtime.
 */
export function useDashboardReconnect(callback: () => void): void {
  const cbRef = useRef(callback);
  cbRef.current = callback;

  useEffect(() => {
    const handler = () => cbRef.current();
    reconnectListeners.add(handler);
    return () => { reconnectListeners.delete(handler); };
  }, []);
}
