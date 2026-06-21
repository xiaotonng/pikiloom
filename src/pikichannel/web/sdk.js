/**
 * pikichannel-sdk.js — the reference browser client SDK (vanilla ESM, zero deps).
 *
 * This is the embeddable client: drop it into any web app (or wrap it in a
 * WebView for mobile) and you get a live, bidirectional agent session over
 * either transport. It mirrors the L2 protocol in src/pikichannel/protocol.ts —
 * keep the message `type` literals in lockstep with that file.
 *
 * Layering mirrors the host:
 *   - Transport (L1): WsTransport | RtcTransport — both expose connect/send and
 *     onopen/onmessage/onclose. The client is blind to which one it holds.
 *   - Client (L2): PikichannelClient — speaks the protocol, keeps a reactive
 *     `sessions` store, exposes prompt/stop/steer/interact, and emits events.
 *
 * Public surface:
 *   const c = new Pikichannel.Client({ transport: 'websocket' | 'webrtc' })
 *   c.on('status'|'welcome'|'session'|'sessions'|'accepted'|'error', cb)
 *   await c.connect(); c.subscribeAll();
 *   c.prompt({ prompt, sessionKey?, agent?, model?, effort? })
 *   c.stop(key) / c.steer(taskId) / c.recall(taskId) / c.interact(promptId, action, value)
 *   c.sessions  // Map<sessionKey, UniversalSnapshot>
 *   c.stats()   // { transport, state, rtt, framesIn, framesOut, bytesIn, bytesOut }
 */

export const PROTOCOL_VERSION = 1;

const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

// Resolve the ws(s):// base for a target host. `host` may be a bare authority
// ("192.168.1.5:3940"), a full ws(s)/http(s) URL, or empty (same origin). This
// is what makes a client repointable: pass `host` to talk to a different node.
function wsBase(host) {
  const loc = window.location;
  const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  if (!host) return proto + '//' + loc.host;
  if (/^wss?:\/\//.test(host)) return host.replace(/\/$/, '');
  if (/^https:\/\//.test(host)) return 'wss://' + host.slice('https://'.length).replace(/\/$/, '');
  if (/^http:\/\//.test(host)) return 'ws://' + host.slice('http://'.length).replace(/\/$/, '');
  return proto + '//' + host.replace(/\/$/, '');
}

// ---------------------------------------------------------------------------
// L1 transports (browser side)
// ---------------------------------------------------------------------------

class WsTransport {
  constructor(base) {
    this.kind = 'websocket';
    this.base = base;
    this.ws = null;
    this.onopen = null; this.onmessage = null; this.onclose = null; this.onerror = null;
  }
  connect() {
    const ws = new WebSocket(this.base + '/pikichannel/ws');
    this.ws = ws;
    ws.onopen = () => this.onopen && this.onopen();
    ws.onmessage = (e) => this.onmessage && this.onmessage(e.data);
    ws.onclose = () => this.onclose && this.onclose();
    ws.onerror = () => this.onerror && this.onerror(new Error('websocket error'));
  }
  send(frame) { if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(frame); }
  close() { if (this.ws) { try { this.ws.close(); } catch (e) {} } }
  isOpen() { return !!this.ws && this.ws.readyState === WebSocket.OPEN; }
}

// The browser is always the WebRTC offerer (creates the datachannel + offer).
// Two signaling paths share the same PC setup:
//   - direct:     SDP/ICE over `${base}/pikichannel/signal` (reachable host).
//   - rendezvous: dial a NodeID through a broker both peers reach (NAT traversal).
class RtcTransport {
  constructor(cfg) {
    this.kind = 'webrtc';
    this.base = cfg.base;
    this.rendezvous = cfg.rendezvous || null; // broker ws(s):// URL
    this.nodeId = cfg.nodeId || null;         // host NodeID to dial
    this.pc = null; this.dc = null; this.signal = null;
    this.onopen = null; this.onmessage = null; this.onclose = null; this.onerror = null;
  }
  async connect() {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.pc = pc;
    const dc = pc.createDataChannel('piki', { ordered: true });
    this.dc = dc;

    let remoteSet = false;
    const pendingRemote = [];
    const onAnswer = async (sdp) => { await pc.setRemoteDescription({ type: 'answer', sdp }); remoteSet = true; for (const c of pendingRemote.splice(0)) { try { await pc.addIceCandidate(c); } catch (e) {} } };
    const onCandidate = async (cand) => { if (remoteSet) { try { await pc.addIceCandidate(cand); } catch (e) {} } else pendingRemote.push(cand); };

    dc.onopen = () => { this.onopen && this.onopen(); try { this.signal && this.signal.close(); } catch (e) {} };
    dc.onmessage = (e) => this.onmessage && this.onmessage(e.data);
    dc.onclose = () => this.onclose && this.onclose();
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === 'failed' || s === 'closed' || s === 'disconnected') this.onclose && this.onclose();
    };

    const useRendezvous = !!(this.rendezvous && this.nodeId);
    const signal = new WebSocket(useRendezvous ? this.rendezvous : this.base + '/pikichannel/signal');
    this.signal = signal;

    if (useRendezvous) {
      // NAT path: dial the NodeID through the broker; signaling is relayed.
      let sessionId = null;
      pc.onicecandidate = (e) => { if (e.candidate && sessionId && signal.readyState === WebSocket.OPEN) signal.send(JSON.stringify({ t: 'signal', sessionId, data: { kind: 'candidate', candidate: e.candidate.toJSON() } })); };
      signal.onopen = () => signal.send(JSON.stringify({ t: 'dial', nodeId: this.nodeId }));
      signal.onmessage = async (m) => {
        let msg; try { msg = JSON.parse(m.data); } catch (e) { return; }
        if (msg.t === 'dialed') {
          sessionId = msg.sessionId;
          const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
          signal.send(JSON.stringify({ t: 'signal', sessionId, data: { kind: 'offer', type: offer.type, sdp: offer.sdp } }));
        } else if (msg.t === 'signal' && msg.data) {
          const d = msg.data;
          if (d.kind === 'answer') await onAnswer(d.sdp);
          else if (d.kind === 'candidate' && d.candidate) await onCandidate(d.candidate);
          else if (d.kind === 'error') this.onerror && this.onerror(new Error(d.message || 'signaling error'));
        } else if (msg.t === 'error') { this.onerror && this.onerror(new Error(msg.message || 'rendezvous error')); }
        else if (msg.t === 'close') { this.onclose && this.onclose(); }
      };
      signal.onerror = () => this.onerror && this.onerror(new Error('rendezvous socket error'));
    } else {
      // Direct path: SDP/ICE straight to the reachable host.
      pc.onicecandidate = (e) => { if (e.candidate && signal.readyState === WebSocket.OPEN) signal.send(JSON.stringify({ kind: 'candidate', candidate: e.candidate.toJSON() })); };
      signal.onmessage = async (m) => {
        let msg; try { msg = JSON.parse(m.data); } catch (e) { return; }
        if (msg.kind === 'answer') await onAnswer(msg.sdp);
        else if (msg.kind === 'candidate' && msg.candidate) await onCandidate(msg.candidate);
        else if (msg.kind === 'error') this.onerror && this.onerror(new Error(msg.message || 'signaling error'));
      };
      signal.onerror = () => this.onerror && this.onerror(new Error('signaling socket error'));
      signal.onopen = async () => {
        const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
        signal.send(JSON.stringify({ kind: 'offer', type: offer.type, sdp: offer.sdp }));
      };
    }
  }
  send(frame) { if (this.dc && this.dc.readyState === 'open') this.dc.send(frame); }
  close() {
    try { this.dc && this.dc.close(); } catch (e) {}
    try { this.pc && this.pc.close(); } catch (e) {}
    try { this.signal && this.signal.close(); } catch (e) {}
  }
  isOpen() { return !!this.dc && this.dc.readyState === 'open'; }
}

function makeTransport(kind, cfg) {
  if (kind === 'webrtc') return new RtcTransport(cfg);
  return new WsTransport(cfg.base);
}

// Mirror of applySnapshotPatch() in src/pikichannel/protocol.ts — keep in lockstep.
function applyPatch(prev, patch) {
  if (patch.full) return patch.full;
  const next = prev ? Object.assign({}, prev) : { phase: 'idle', updatedAt: 0 };
  if (patch.appendText) next.text = (next.text || '') + patch.appendText;
  if (patch.appendReasoning) next.reasoning = (next.reasoning || '') + patch.appendReasoning;
  if (patch.set) Object.assign(next, patch.set);
  return next;
}

// ---------------------------------------------------------------------------
// L2 client
// ---------------------------------------------------------------------------

export class PikichannelClient {
  constructor(opts) {
    opts = opts || {};
    this.rendezvous = opts.rendezvous || null; // broker URL for NAT traversal
    this.nodeId = opts.nodeId || null;         // host NodeID to dial via the broker
    // A rendezvous dial implies WebRTC (the broker only brokers P2P signaling).
    this.transportKind = (this.rendezvous && this.nodeId) ? 'webrtc' : (opts.transport === 'webrtc' ? 'webrtc' : 'websocket');
    this.token = opts.token || null;
    this.endpoint = opts.host || null;       // target node authority/URL (null = same origin)
    this._base = wsBase(this.endpoint);       // resolved ws(s):// base
    this.transport = null;
    this.state = 'idle'; // idle | connecting | open | closed
    this.host = null;     // HostInfo from welcome
    this.sessions = new Map(); // sessionKey -> UniversalSnapshot (reconstructed from patches)
    this.sessionMetas = []; // SessionMeta[]
    this._seqs = new Map(); // sessionKey -> last applied seq (gap detection)
    this._listeners = new Map();
    this._pending = new Map(); // request id -> {resolve,reject} (control-plane tunnel)
    this._reqSeq = 0;
    this._pingTimer = null;
    this._rtt = null;
    this._stats = { framesIn: 0, framesOut: 0, bytesIn: 0, bytesOut: 0, connectedAt: null };
    this._pendingResolve = null;
  }

  // -- event emitter --
  on(type, cb) {
    let set = this._listeners.get(type);
    if (!set) { set = new Set(); this._listeners.set(type, set); }
    set.add(cb);
    return () => this.off(type, cb);
  }
  off(type, cb) { const set = this._listeners.get(type); if (set) set.delete(cb); }
  _emit(type, payload) { const set = this._listeners.get(type); if (set) for (const cb of set) { try { cb(payload); } catch (e) {} } }

  _setState(state) { this.state = state; this._emit('status', this.stats()); }

  // -- lifecycle --
  connect() {
    return new Promise((resolve, reject) => {
      this._pendingResolve = resolve;
      this._setState('connecting');
      const t = makeTransport(this.transportKind, { base: this._base, rendezvous: this.rendezvous, nodeId: this.nodeId });
      this.transport = t;
      t.onopen = () => {
        this._stats.connectedAt = Date.now();
        const hello = { type: 'hello', v: PROTOCOL_VERSION, client: { name: 'pikichannel-web-sdk', platform: navigator.userAgent } };
        if (this.token) hello.token = this.token;
        this._send(hello);
        this._setState('open');
        this._startPing();
      };
      t.onmessage = (data) => this._onFrame(data);
      t.onclose = () => { this._stopPing(); this._failPending('connection closed'); this._setState('closed'); this._emit('close', null); };
      t.onerror = (err) => { this._emit('error', { message: err && err.message ? err.message : 'transport error' }); if (this._pendingResolve) { reject(err); this._pendingResolve = null; } };
      // resolve connect() on welcome
      const off = this.on('welcome', () => { off(); if (this._pendingResolve) { this._pendingResolve(this.host); this._pendingResolve = null; } });
      Promise.resolve(t.connect()).catch((e) => { this._emit('error', { message: e && e.message ? e.message : 'connect failed' }); reject(e); });
    });
  }

  disconnect() { this._stopPing(); if (this.transport) this.transport.close(); this._setState('closed'); }

  // -- outbound commands --
  subscribeAll() { this._send({ type: 'subscribe', sessionKey: '*' }); }
  subscribe(sessionKey) { this._send({ type: 'subscribe', sessionKey: sessionKey }); }
  unsubscribe(sessionKey) { this._send({ type: 'unsubscribe', sessionKey: sessionKey }); }
  getSnapshot(sessionKey) { this._send({ type: 'getSnapshot', sessionKey: sessionKey }); }
  listSessions() { this._send({ type: 'listSessions' }); }
  prompt(opts) {
    const ref = 'r' + Math.random().toString(36).slice(2, 9);
    this._send(Object.assign({ type: 'prompt', clientRef: ref }, opts));
    return ref;
  }
  stop(sessionKey) { this._send({ type: 'stop', sessionKey: sessionKey }); }
  steer(taskId) { this._send({ type: 'steer', taskId: taskId }); }
  recall(taskId) { this._send({ type: 'recall', taskId: taskId }); }
  interact(promptId, action, value, requestFreeform) {
    this._send({ type: 'interact', promptId: promptId, action: action, value: value, requestFreeform: requestFreeform });
  }

  /**
   * Control-plane HTTP over the channel — full management of the connected host
   * WITHOUT it exposing REST publicly (no CORS, rides the authenticated channel).
   * Only `/api/*` is allowed by the host. Resolves with a fetch-like response:
   * { status, ok, headers, text(), json(), base64(), bytes() }.
   */
  request(method, path, opts) {
    opts = opts || {};
    let body = opts.body;
    if (body != null && typeof body !== 'string') body = JSON.stringify(body);
    const headers = opts.headers || (body != null ? { 'content-type': 'application/json' } : undefined);
    const id = 'q' + (++this._reqSeq);
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      this._send({ type: 'request', id: id, method: method || 'GET', path: path, headers: headers, body: body, encoding: 'utf8' });
      setTimeout(() => { if (this._pending.has(id)) { this._pending.delete(id); reject(new Error('request timeout')); } }, opts.timeout || 20000);
    });
  }

  _failPending(reason) {
    for (const [, p] of this._pending) { try { p.reject(new Error(reason)); } catch (e) {} }
    this._pending.clear();
  }

  // -- inbound --
  _onFrame(data) {
    this._stats.framesIn++;
    this._stats.bytesIn += (data && data.length) ? data.length : 0;
    let msg; try { msg = JSON.parse(data); } catch (e) { return; }
    switch (msg.type) {
      case 'welcome':
        this.host = msg.host;
        this.sessionMetas = msg.sessions || [];
        this._emit('welcome', msg.host);
        this._emit('sessions', this.sessionMetas);
        break;
      case 'session': {
        const key = msg.sessionKey;
        const prev = this.sessions.get(key) || null;
        const lastSeq = this._seqs.get(key);
        const contiguous = lastSeq === undefined || msg.seq === lastSeq + 1 || !!msg.patch.full;
        if (!msg.patch.full && (prev === null || !contiguous)) {
          this.getSnapshot(key); // missing baseline or seq gap → ask for a full resync
          break;                  // don't apply a delta we can't anchor
        }
        const next = applyPatch(prev, msg.patch);
        this.sessions.set(key, next);
        this._seqs.set(key, msg.seq);
        this._emit('session', Object.assign({ sessionKey: key }, next));
        break;
      }
      case 'sessions':
        this.sessionMetas = msg.sessions || [];
        this._emit('sessions', this.sessionMetas);
        break;
      case 'accepted':
        this._emit('accepted', msg);
        break;
      case 'response': {
        const p = this._pending.get(msg.id);
        if (!p) break;
        this._pending.delete(msg.id);
        const enc = msg.encoding || 'utf8';
        const raw = msg.body || '';
        if (msg.error && (msg.status === undefined || msg.status === 0)) { p.reject(new Error(msg.error)); break; }
        p.resolve({
          status: msg.status, ok: msg.status >= 200 && msg.status < 300, headers: msg.headers || {}, error: msg.error || null,
          text: () => raw,
          json: () => JSON.parse(raw),
          base64: () => raw,
          bytes: () => (enc === 'base64' ? Uint8Array.from(atob(raw), (c) => c.charCodeAt(0)) : new TextEncoder().encode(raw)),
        });
        break;
      }
      case 'error':
        this._emit('error', { message: msg.message, code: msg.code, clientRef: msg.clientRef });
        break;
      case 'pong':
        if (typeof msg.t === 'number') { this._rtt = Math.max(0, Math.round(performance.now() - msg.t)); this._emit('status', this.stats()); }
        break;
    }
  }

  _send(msg) {
    if (!this.transport || !this.transport.isOpen()) return;
    const frame = JSON.stringify(msg);
    this._stats.framesOut++;
    this._stats.bytesOut += frame.length;
    this.transport.send(frame);
  }

  _startPing() {
    this._stopPing();
    this._pingTimer = setInterval(() => { this._send({ type: 'ping', t: performance.now() }); }, 3000);
  }
  _stopPing() { if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; } }

  stats() {
    return {
      transport: this.transportKind,
      state: this.state,
      rtt: this._rtt,
      framesIn: this._stats.framesIn,
      framesOut: this._stats.framesOut,
      bytesIn: this._stats.bytesIn,
      bytesOut: this._stats.bytesOut,
      sessions: this.sessions.size,
      host: this.host,
    };
  }
}

if (typeof window !== 'undefined') {
  window.Pikichannel = { Client: PikichannelClient, PROTOCOL_VERSION: PROTOCOL_VERSION };
}
