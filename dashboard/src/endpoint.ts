/**
 * endpoint.ts — which pikichannel host this dashboard controls, and how it reaches it.
 *
 * Three modes (plain-language in the UI):
 *   - local   "本机 / This computer"     → same origin (default, unchanged behavior)
 *   - direct  "局域网 / Same network"     → WebSocket to a reachable host:port
 *   - remote  "互联网 / Over the internet" → WebRTC via a rendezvous broker (NAT traversal)
 *
 * The choice persists in localStorage so it survives navigation. It can be set
 * from the Connection panel (UI), a `?host=/?token=/?rendezvous=/?node=` query,
 * or a single `?code=` (a shareable connection code that packs all of them).
 */

export type ConnMode = 'local' | 'direct' | 'remote';

export interface Endpoint {
  mode: ConnMode;
  host?: string;       // direct: authority ("192.168.1.5:3940") or ws(s)/http(s) URL
  rendezvous?: string; // remote: broker ws(s):// URL
  nodeId?: string;     // remote: host NodeID to dial
  token?: string;      // access token (required for non-local)
}

const K = { host: 'pikichannel.host', token: 'pikichannel.token', rdv: 'pikichannel.rendezvous', node: 'pikichannel.node' };

let cached: Endpoint | null | undefined;

function read(k: string): string { try { return (localStorage.getItem(k) || '').trim(); } catch { return ''; } }
function write(k: string, v: string | undefined): void { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch { /* no DOM */ } }

export function getEndpoint(): Endpoint | null {
  if (cached !== undefined) return cached;
  cached = resolve();
  return cached;
}

function resolve(): Endpoint | null {
  try {
    const u = new URL(window.location.href);
    const code = u.searchParams.get('code');
    if (code) { const d = decodeCode(code); if (d) persist(d); }
    const map: Array<[string, string]> = [['host', K.host], ['token', K.token], ['rendezvous', K.rdv], ['node', K.node]];
    for (const [p, k] of map) if (u.searchParams.has(p)) write(k, u.searchParams.get(p) || '');
  } catch { /* SSR / no DOM */ }
  const host = read(K.host), token = read(K.token) || undefined, rendezvous = read(K.rdv), nodeId = read(K.node);
  if (rendezvous && nodeId) return { mode: 'remote', rendezvous, nodeId, token };
  if (host) return { mode: 'direct', host, token };
  return null; // local (same origin)
}

export function getMode(): ConnMode { const e = getEndpoint(); return e ? e.mode : 'local'; }

/** True when pointed at another host (control must go over the channel/tunnel). */
export function isRemote(): boolean { return getEndpoint() !== null; }

function persist(d: Partial<Endpoint>): void {
  write(K.host, d.host); write(K.token, d.token); write(K.rdv, d.rendezvous); write(K.node, d.nodeId);
}

/** Set the target (call `location.reload()` after to re-point the whole console). */
export function setEndpoint(d: Partial<Endpoint>): void { persist(d); cached = undefined; }

/** Back to local (this computer). */
export function clearEndpoint(): void { persist({}); cached = undefined; }

// -- Shareable connection code: one string a host shows and a client pastes. --

export function encodeCode(d: Partial<Endpoint>): string {
  const lean: Record<string, string> = {};
  if (d.host) lean.h = d.host;
  if (d.rendezvous) lean.r = d.rendezvous;
  if (d.nodeId) lean.n = d.nodeId;
  if (d.token) lean.t = d.token;
  try { return btoa(unescape(encodeURIComponent(JSON.stringify(lean)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
  catch { return ''; }
}

export function decodeCode(s: string): Partial<Endpoint> | null {
  try {
    const b = s.trim().replace(/-/g, '+').replace(/_/g, '/');
    const json = decodeURIComponent(escape(atob(b)));
    const o = JSON.parse(json);
    const d: Partial<Endpoint> = {};
    if (o.h) d.host = String(o.h);
    if (o.r) d.rendezvous = String(o.r);
    if (o.n) d.nodeId = String(o.n);
    if (o.t) d.token = String(o.t);
    return (d.host || (d.rendezvous && d.nodeId)) ? d : null;
  } catch { return null; }
}
