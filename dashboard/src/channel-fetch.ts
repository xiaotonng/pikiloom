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
    if (u.origin !== window.location.origin) return null;
    if (!u.pathname.startsWith('/api/')) return null;
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
    else return originalFetch(input as RequestInfo, init);
  } else if (req && method !== 'GET' && method !== 'HEAD') {
    try { body = await req.clone().text(); } catch {  }
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
