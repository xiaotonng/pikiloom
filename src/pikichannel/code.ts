export interface CodeParts { host?: string; rendezvous?: string; nodeId?: string; token?: string }

export function encodeConnectionCode(d: CodeParts): string {
  const lean: Record<string, string> = {};
  if (d.host) lean.h = d.host;
  if (d.rendezvous) lean.r = d.rendezvous;
  if (d.nodeId) lean.n = d.nodeId;
  if (d.token) lean.t = d.token;
  return Buffer.from(JSON.stringify(lean), 'utf8').toString('base64url');
}

export interface ServerCode {
  mode: 'direct' | 'remote' | 'none';
  code: string;
  detail: string;
}

export function buildServerCode(opts: {
  token?: string;
  nodeId?: string;
  publicHost?: string;
  rendezvous?: string;
}): ServerCode {
  const token = (opts.token || '').trim();
  const publicHost = (opts.publicHost || '').trim();
  const rendezvous = (opts.rendezvous || '').trim();
  const nodeId = (opts.nodeId || '').trim();
  if (publicHost) return { mode: 'direct', code: encodeConnectionCode({ host: publicHost, token }), detail: publicHost };
  if (rendezvous && nodeId) return { mode: 'remote', code: encodeConnectionCode({ rendezvous, nodeId, token }), detail: rendezvous };
  return { mode: 'none', code: '', detail: '' };
}
