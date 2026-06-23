import crypto from 'node:crypto';
import {
  loadUserConfig,
  saveUserConfig,
  type McpOAuthTokenRecord,
} from '../../core/config/user-config.js';
import type { McpAuthSpec } from './registry.js';

export interface OAuthAuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
  response_types_supported?: string[];
  grant_types_supported?: string[];
  code_challenge_methods_supported?: string[];
}

export interface OAuthProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  scopes_supported?: string[];
  bearer_methods_supported?: string[];
}

interface PendingOAuthFlow {
  state: string;
  codeVerifier: string;
  serverId: string;
  resource: string;
  clientId: string;
  clientSecret?: string;
  tokenEndpoint: string;
  authorizationEndpoint: string;
  registrationEndpoint?: string;
  redirectUri: string;
  createdAt: number;
}

export interface StartOAuthResult {
  authUrl: string;
  state: string;
}

export interface CompleteOAuthResult {
  ok: true;
  serverId: string;
}

export function getMcpToken(serverId: string): McpOAuthTokenRecord | undefined {
  const cfg = loadUserConfig();
  return cfg.extensions?.mcpTokens?.[serverId];
}

export function saveMcpToken(serverId: string, token: McpOAuthTokenRecord): void {
  const cfg = loadUserConfig();
  const extensions = cfg.extensions ?? {};
  const mcpTokens = { ...(extensions.mcpTokens ?? {}) };
  mcpTokens[serverId] = token;
  saveUserConfig({ ...cfg, extensions: { ...extensions, mcpTokens } });
}

export function deleteMcpToken(serverId: string): boolean {
  const cfg = loadUserConfig();
  const tokens = { ...(cfg.extensions?.mcpTokens ?? {}) };
  if (!(serverId in tokens)) return false;
  delete tokens[serverId];
  saveUserConfig({ ...cfg, extensions: { ...cfg.extensions, mcpTokens: tokens } });
  return true;
}

export function hasValidMcpToken(serverId: string): boolean {
  const token = getMcpToken(serverId);
  if (!token?.accessToken) return false;
  if (token.expiresAt && token.expiresAt < Date.now() + 30_000) return false;
  return true;
}

function randomUrlSafe(bytes: number): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

function pkceChallenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

async function fetchJson<T>(url: string, init?: RequestInit, timeoutMs = 8_000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) throw new Error(`${url} responded ${res.status}`);
    return await res.json() as T;
  } finally {
    clearTimeout(timer);
  }
}

interface DiscoveredResource {
  authorizationServer: string;
  canonicalResource: string;
}

async function discoverAuthorizationServer(resourceUrl: string): Promise<DiscoveredResource> {
  const origin = new URL(resourceUrl).origin;

  const adopt = (meta: OAuthProtectedResourceMetadata): DiscoveredResource | null => {
    const as = meta.authorization_servers?.[0];
    if (!as) return null;
    return {
      authorizationServer: as,
      canonicalResource: meta.resource || resourceUrl,
    };
  };

  try {
    const meta = await fetchJson<OAuthProtectedResourceMetadata>(
      `${origin}/.well-known/oauth-protected-resource`,
    );
    const out = adopt(meta);
    if (out) return out;
  } catch {  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    const res = await fetch(resourceUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {} }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (res.status === 401) {
      const auth = res.headers.get('www-authenticate') || '';
      const matches = [...auth.matchAll(/resource_metadata="([^"]+)"/gi)];
      const link = matches.length ? matches[matches.length - 1][1] : null;
      if (link) {
        const meta = await fetchJson<OAuthProtectedResourceMetadata>(link);
        const out = adopt(meta);
        if (out) return out;
      }
    }
  } catch {  }

  return { authorizationServer: origin, canonicalResource: resourceUrl };
}

async function fetchAuthorizationServerMetadata(issuer: string): Promise<OAuthAuthorizationServerMetadata> {
  const candidates = [
    `${issuer.replace(/\/$/, '')}/.well-known/oauth-authorization-server`,
    `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`,
  ];
  let lastErr: unknown;
  for (const url of candidates) {
    try {
      return await fetchJson<OAuthAuthorizationServerMetadata>(url);
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`no AS metadata at ${issuer}: ${lastErr}`);
}

interface DynamicRegistrationResponse {
  client_id: string;
  client_secret?: string;
  client_id_issued_at?: number;
  client_secret_expires_at?: number;
  redirect_uris?: string[];
}

async function registerClient(
  registrationEndpoint: string,
  redirectUri: string,
  clientName: string,
): Promise<DynamicRegistrationResponse> {
  const body = {
    client_name: clientName,
    redirect_uris: [redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    application_type: 'native',
  };
  return fetchJson<DynamicRegistrationResponse>(registrationEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

interface ResolvedEndpoints {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  issuer?: string;
  canonicalResource: string;
}

async function resolveEndpoints(auth: McpAuthSpec, resourceUrl: string): Promise<ResolvedEndpoints> {
  if (auth.type !== 'mcp-oauth') throw new Error('not an mcp-oauth auth spec');

  if (auth.authorizationEndpoint && auth.tokenEndpoint) {
    return {
      authorizationEndpoint: auth.authorizationEndpoint,
      tokenEndpoint: auth.tokenEndpoint,
      registrationEndpoint: auth.registrationEndpoint,
      canonicalResource: resourceUrl,
    };
  }

  const discovered = await discoverAuthorizationServer(resourceUrl);
  const meta = await fetchAuthorizationServerMetadata(discovered.authorizationServer);

  return {
    authorizationEndpoint: meta.authorization_endpoint,
    tokenEndpoint: meta.token_endpoint,
    registrationEndpoint: meta.registration_endpoint,
    issuer: meta.issuer,
    canonicalResource: discovered.canonicalResource,
  };
}

const pendingFlows = new Map<string, PendingOAuthFlow>();
const PENDING_TTL_MS = 10 * 60 * 1000;

function sweepPending(): void {
  const now = Date.now();
  for (const [state, flow] of pendingFlows) {
    if (now - flow.createdAt > PENDING_TTL_MS) pendingFlows.delete(state);
  }
}

export async function startAuthorization(opts: {
  serverId: string;
  auth: McpAuthSpec;
  resourceUrl: string;
  redirectUri: string;
  clientName: string;
}): Promise<StartOAuthResult> {
  sweepPending();
  const { serverId, auth, resourceUrl, redirectUri, clientName } = opts;
  if (auth.type !== 'mcp-oauth') throw new Error(`server ${serverId} is not mcp-oauth`);

  const endpoints = await resolveEndpoints(auth, resourceUrl);
  const canonicalResource = endpoints.canonicalResource;

  let clientId = auth.clientId;
  let clientSecret: string | undefined;

  if (!clientId) {
    if (!endpoints.registrationEndpoint) {
      throw new Error(`server ${serverId} has no client_id and no dynamic registration endpoint`);
    }
    const reg = await registerClient(endpoints.registrationEndpoint, redirectUri, clientName);
    clientId = reg.client_id;
    clientSecret = reg.client_secret;
  }

  const state = randomUrlSafe(32);
  const codeVerifier = randomUrlSafe(48);
  const codeChallenge = pkceChallenge(codeVerifier);

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    resource: canonicalResource,
  });
  if (auth.scopes?.length) params.set('scope', auth.scopes.join(' '));

  const authUrl = `${endpoints.authorizationEndpoint}${endpoints.authorizationEndpoint.includes('?') ? '&' : '?'}${params.toString()}`;

  pendingFlows.set(state, {
    state,
    codeVerifier,
    serverId,
    resource: canonicalResource,
    clientId,
    clientSecret,
    tokenEndpoint: endpoints.tokenEndpoint,
    authorizationEndpoint: endpoints.authorizationEndpoint,
    registrationEndpoint: endpoints.registrationEndpoint,
    redirectUri,
    createdAt: Date.now(),
  });

  return { authUrl, state };
}

interface TokenResponse {
  access_token: string;
  token_type?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

export async function completeAuthorization(opts: {
  state: string;
  code: string;
}): Promise<CompleteOAuthResult> {
  const flow = pendingFlows.get(opts.state);
  if (!flow) throw new Error('unknown or expired oauth state');
  pendingFlows.delete(opts.state);

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: opts.code,
    redirect_uri: flow.redirectUri,
    client_id: flow.clientId,
    code_verifier: flow.codeVerifier,
    resource: flow.resource,
  });
  if (flow.clientSecret) body.set('client_secret', flow.clientSecret);

  const res = await fetch(flow.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`token exchange failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const token = await res.json() as TokenResponse;

  const record: McpOAuthTokenRecord = {
    accessToken: token.access_token,
    tokenType: token.token_type || 'Bearer',
    refreshToken: token.refresh_token,
    expiresAt: token.expires_in ? Date.now() + (token.expires_in * 1000) : undefined,
    scope: token.scope,
    clientId: flow.clientId,
    clientSecret: flow.clientSecret,
    authorizationEndpoint: flow.authorizationEndpoint,
    tokenEndpoint: flow.tokenEndpoint,
    registrationEndpoint: flow.registrationEndpoint,
    resource: flow.resource,
  };
  saveMcpToken(flow.serverId, record);

  return { ok: true, serverId: flow.serverId };
}

export async function refreshMcpToken(serverId: string): Promise<McpOAuthTokenRecord | null> {
  const token = getMcpToken(serverId);
  if (!token?.refreshToken) return null;

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: token.refreshToken,
    client_id: token.clientId,
    resource: token.resource,
  });
  if (token.clientSecret) body.set('client_secret', token.clientSecret);

  try {
    const res = await fetch(token.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: body.toString(),
    });
    if (!res.ok) return null;
    const next = await res.json() as TokenResponse;
    const updated: McpOAuthTokenRecord = {
      ...token,
      accessToken: next.access_token,
      tokenType: next.token_type || token.tokenType,
      refreshToken: next.refresh_token || token.refreshToken,
      expiresAt: next.expires_in ? Date.now() + (next.expires_in * 1000) : undefined,
      scope: next.scope || token.scope,
    };
    saveMcpToken(serverId, updated);
    return updated;
  } catch {
    return null;
  }
}

export function injectOAuthHeaders(name: string, config: { headers?: Record<string, string> }): Record<string, string> {
  const token = getMcpToken(name);
  if (!token?.accessToken) return config.headers || {};
  return {
    ...(config.headers || {}),
    Authorization: `${token.tokenType || 'Bearer'} ${token.accessToken}`,
  };
}
