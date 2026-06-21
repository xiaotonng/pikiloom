/**
 * channel-fetch.ts — route the dashboard's control plane over the channel when
 * it is pointed at a remote host.
 *
 * Imported once for its side effect (installs a `window.fetch` wrapper). The
 * wrapper is GATED: with no remote endpoint configured it is a pure pass-through,
 * so the local dashboard behaves exactly as before. When `?host=` is set, every
 * same-origin `/api/*` call is tunneled over the pikichannel connection to that
 * host — no public REST, no CORS, one authenticated channel. The SPA shell and
 * static assets still load from wherever the page was served.
 *
 * String/JSON bodies (the entire api.ts surface) tunnel; the rare non-string
 * body (FormData upload) falls back to the original fetch.
 */

import { isRemote } from './endpoint';
import { channelRequest } from './ws';

const originalFetch = window.fetch.bind(window);

function sameOriginApiPath(input: RequestInfo | URL): string | null {
  let url: string;
  if (typeof input === 'string') url = input;
  else if (input instanceof URL) url = input.toString();
  else url = input.url;
  try {
    const u = new URL(url, window.location.href);
    if (u.origin !== window.location.origin) return null; // cross-origin → leave it
    if (!u.pathname.startsWith('/api/')) return null;      // only the management API
    return u.pathname + u.search;
  } catch {
    return null;
  }
}

window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  if (!isRemote()) return originalFetch(input as RequestInfo, init);
  const path = sameOriginApiPath(input);
  if (!path) return originalFetch(input as RequestInfo, init);

  const req = input instanceof Request ? input : null;
  const method = (init?.method || req?.method || 'GET').toUpperCase();

  let body: string | undefined;
  const rawBody = init?.body;
  if (rawBody != null) {
    if (typeof rawBody === 'string') body = rawBody;
    else return originalFetch(input as RequestInfo, init); // FormData/Blob → don't tunnel
  } else if (req && method !== 'GET' && method !== 'HEAD') {
    try { body = await req.clone().text(); } catch { /* no body */ }
  }

  const headers: Record<string, string> = {};
  const h = init?.headers || (req ? req.headers : undefined);
  if (h) new Headers(h).forEach((v, k) => { headers[k] = v; });

  try {
    const r = await channelRequest(method, path, { headers, body });
    const out: BodyInit = r.encoding === 'base64'
      ? Uint8Array.from(atob(r.body), (c) => c.charCodeAt(0))
      : r.body;
    return new Response(out, { status: r.status || 200, headers: r.headers });
  } catch (e) {
    return new Response(
      JSON.stringify({ ok: false, error: (e as Error)?.message || 'channel tunnel failed' }),
      { status: 502, headers: { 'content-type': 'application/json' } },
    );
  }
};
