export type ConnMode = 'local' | 'direct' | 'remote';

export interface Endpoint {
  mode: ConnMode;
  host?: string;
  rendezvous?: string;
  nodeId?: string;
  token?: string;
}

const K = { host: 'pikichannel.host', token: 'pikichannel.token', rdv: 'pikichannel.rendezvous', node: 'pikichannel.node' };

let cached: Endpoint | null | undefined;

function read(k: string): string { try { return (localStorage.getItem(k) || '').trim(); } catch { return ''; } }
function write(k: string, v: string | undefined): void { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch {  } }

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
  } catch {  }
  const host = read(K.host), token = read(K.token) || undefined, rendezvous = read(K.rdv), nodeId = read(K.node);
  if (rendezvous && nodeId) return { mode: 'remote', rendezvous, nodeId, token };
  if (host) return { mode: 'direct', host, token };
  return null;
}

export function getMode(): ConnMode { const e = getEndpoint(); return e ? e.mode : 'local'; }

export function isRemote(): boolean { return getEndpoint() !== null; }

function persist(d: Partial<Endpoint>): void {
  write(K.host, d.host); write(K.token, d.token); write(K.rdv, d.rendezvous); write(K.node, d.nodeId);
}

export function setEndpoint(d: Partial<Endpoint>): void { persist(d); cached = undefined; }

export function clearEndpoint(): void { persist({}); cached = undefined; }

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
