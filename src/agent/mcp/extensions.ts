import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { loadUserConfig, saveUserConfig } from '../../core/config/user-config.js';
import type { McpServerConfig } from '../../core/config/user-config.js';
import { terminateProcessTree } from '../../core/process-control.js';
import {
  getRecommendedMcpServers,
  type RecommendedMcpServer,
  type McpAuthSpec,
  type McpCategory,
  type RecommendedScope,
} from './registry.js';
import { hasValidMcpToken, injectOAuthHeaders } from './oauth.js';

export type ExtensionScope = 'global' | 'workspace' | 'builtin';

export interface McpExtensionEntry {
  name: string;
  config: McpServerConfig;
  scope: ExtensionScope;
  source?: string;
}

export interface McpHealthResult {
  ok: boolean;
  tools?: string[];
  error?: string;
  elapsedMs?: number;
}

export type McpCatalogState =
  | 'recommended'
  | 'needs_auth'
  | 'disabled'
  | 'ready'
  | 'unhealthy';

export interface McpCatalogItem {
  id: string;
  name: string;
  description: string;
  descriptionZh: string;
  category: McpCategory | 'custom';
  iconSlug?: string;
  iconUrl?: string;
  homepage?: string;
  transport: { type: 'stdio' | 'http'; summary: string };
  auth: McpAuthSpec;
  state: McpCatalogState;
  isRecommended: boolean;
  installed: boolean;
  scope?: ExtensionScope;
  config?: McpServerConfig;
  installedKey?: string;
  recommendedScope?: RecommendedScope;
  isBuiltin?: boolean;
}

interface RegisteredMcpServer {
  name: string;
  type?: 'stdio' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export function loadGlobalMcpExtensions(): McpExtensionEntry[] {
  const config = loadUserConfig();
  const mcp = config.extensions?.mcp;
  if (!mcp || typeof mcp !== 'object') return [];
  return Object.entries(mcp).map(([name, cfg]) => ({
    name,
    config: cfg,
    scope: 'global' as const,
  }));
}

export function addGlobalMcpExtension(name: string, config: McpServerConfig): void {
  const userConfig = loadUserConfig();
  const extensions = userConfig.extensions ?? {};
  const mcp = { ...(extensions.mcp ?? {}) };
  mcp[name] = config;
  saveUserConfig({ ...userConfig, extensions: { ...extensions, mcp } });
}

export function removeGlobalMcpExtension(name: string): boolean {
  const userConfig = loadUserConfig();
  const mcp = { ...(userConfig.extensions?.mcp ?? {}) };
  if (!(name in mcp)) return false;
  delete mcp[name];
  saveUserConfig({
    ...userConfig,
    extensions: { ...userConfig.extensions, mcp },
  });
  return true;
}

export function updateGlobalMcpExtension(name: string, patch: Partial<McpServerConfig>): boolean {
  const userConfig = loadUserConfig();
  const mcp = { ...(userConfig.extensions?.mcp ?? {}) };
  if (!(name in mcp)) return false;
  mcp[name] = { ...mcp[name], ...patch };
  saveUserConfig({
    ...userConfig,
    extensions: { ...userConfig.extensions, mcp },
  });
  return true;
}

function workspaceMcpJsonPath(workdir: string): string {
  return path.join(workdir, '.mcp.json');
}

function readMcpJson(filePath: string): Record<string, McpServerConfig> {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    const servers = parsed?.mcpServers ?? parsed;
    if (typeof servers === 'object' && servers !== null && !Array.isArray(servers)) {
      return servers as Record<string, McpServerConfig>;
    }
  } catch {  }
  return {};
}

function writeMcpJson(filePath: string, servers: Record<string, McpServerConfig>): void {
  const content = JSON.stringify({ mcpServers: servers }, null, 2) + '\n';
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

export function loadWorkspaceMcpExtensions(workdir: string): McpExtensionEntry[] {
  const mcpPath = workspaceMcpJsonPath(workdir);
  const servers = readMcpJson(mcpPath);
  return Object.entries(servers).map(([name, cfg]) => ({
    name,
    config: cfg,
    scope: 'workspace' as const,
    source: mcpPath,
  }));
}

export function addWorkspaceMcpExtension(workdir: string, name: string, config: McpServerConfig): void {
  const mcpPath = workspaceMcpJsonPath(workdir);
  const servers = readMcpJson(mcpPath);
  servers[name] = config;
  writeMcpJson(mcpPath, servers);
}

export function removeWorkspaceMcpExtension(workdir: string, name: string): boolean {
  const mcpPath = workspaceMcpJsonPath(workdir);
  const servers = readMcpJson(mcpPath);
  if (!(name in servers)) return false;
  delete servers[name];
  writeMcpJson(mcpPath, servers);
  return true;
}

export function updateWorkspaceMcpExtension(workdir: string, name: string, patch: Partial<McpServerConfig>): boolean {
  const mcpPath = workspaceMcpJsonPath(workdir);
  const servers = readMcpJson(mcpPath);
  if (!(name in servers)) return false;
  servers[name] = { ...servers[name], ...patch };
  writeMcpJson(mcpPath, servers);
  return true;
}

export function listAllMcpExtensions(workdir?: string): McpExtensionEntry[] {
  const global = loadGlobalMcpExtensions();
  const workspace = workdir ? loadWorkspaceMcpExtensions(workdir) : [];
  const claudeMcp: McpExtensionEntry[] = [];
  if (workdir) {
    const claudePath = path.join(workdir, '.claude', '.mcp.json');
    const servers = readMcpJson(claudePath);
    for (const [name, cfg] of Object.entries(servers)) {
      claudeMcp.push({ name, config: cfg, scope: 'workspace', source: claudePath });
    }
  }
  return [...global, ...workspace, ...claudeMcp];
}

function cmdSummary(config: McpServerConfig): string {
  if (config.type === 'http' && config.url) return config.url;
  const cmd = config.command || '';
  const args = (config.args || []).filter(a => a !== '-y');
  return [cmd, ...args].join(' ').trim();
}

const HIDDEN_GENERIC_DEMO_PACKAGES = new Set([
  '@modelcontextprotocol/server-time',
  '@modelcontextprotocol/server-fetch',
  '@modelcontextprotocol/server-memory',
  'mcp-server-time',
  'mcp-server-fetch',
  'mcp-server-memory',
]);
const HIDDEN_GENERIC_DEMO_NAMES = new Set(['time', 'fetch', 'memory']);

function isGenericDemoEntry(entry: McpExtensionEntry): boolean {
  if (HIDDEN_GENERIC_DEMO_NAMES.has(entry.name.toLowerCase())) return true;
  const args = entry.config.args || [];
  return args.some(a => HIDDEN_GENERIC_DEMO_PACKAGES.has(a));
}

function transportSummary(transport: RecommendedMcpServer['transport']): string {
  if (transport.type === 'http') return transport.url;
  return [transport.command, ...transport.args.filter(a => a !== '-y')].join(' ');
}

function hasRequiredCredentials(config: McpServerConfig, auth: McpAuthSpec): boolean {
  if (auth.type !== 'credentials') return true;
  const bag = { ...(config.env || {}), ...(config.headers || {}) };
  for (const field of auth.fields) {
    if (!field.required) continue;
    if (!bag[field.key] || !String(bag[field.key]).trim()) return false;
  }
  return true;
}

function computeStateForInstalled(
  config: McpServerConfig,
  auth: McpAuthSpec,
  id: string,
  unhealthyIds?: Set<string>,
): McpCatalogState {
  if (config.enabled === false || config.disabled === true) return 'disabled';
  if (auth.type === 'credentials' && !hasRequiredCredentials(config, auth)) return 'needs_auth';
  if (auth.type === 'mcp-oauth' && !hasValidMcpToken(id)) return 'needs_auth';
  if (unhealthyIds?.has(id)) return 'unhealthy';
  return 'ready';
}

export function getCatalogItems(opts: {
  workdir?: string;
  unhealthyIds?: Set<string>;
  scope?: RecommendedScope;
} = {}): McpCatalogItem[] {
  const recommended = getRecommendedMcpServers();
  const installed: McpExtensionEntry[] = [
    ...loadGlobalMcpExtensions(),
    ...(opts.workdir ? loadWorkspaceMcpExtensions(opts.workdir) : []),
  ];

  const installedByCatalogId = new Map<string, McpExtensionEntry>();
  const customEntries: McpExtensionEntry[] = [];

  for (const entry of installed) {
    const catalogId = entry.config.catalogId;
    if (catalogId && recommended.some(r => r.id === catalogId)) {
      if (!installedByCatalogId.has(catalogId)) installedByCatalogId.set(catalogId, entry);
    } else {
      customEntries.push(entry);
    }
  }

  const scopeMatchesRec = (rec: RecommendedMcpServer): boolean => {
    if (!opts.scope) return true;
    return rec.recommendedScope === opts.scope || rec.recommendedScope === 'both';
  };

  const scopeMatchesEntry = (entry: McpExtensionEntry): boolean => {
    if (!opts.scope) return true;
    if (opts.scope === 'both') return true;
    return entry.scope === opts.scope;
  };

  const items: McpCatalogItem[] = [];
  const userConfig = loadUserConfig();
  const builtinInstalled = (catalogId: string): boolean => {
    if (catalogId === 'pikiloom-browser') return userConfig.browserEnabled === true;
    if (catalogId === 'peekaboo') return userConfig.peekabooEnabled === true;
    return false;
  };

  for (const rec of recommended) {
    if (!scopeMatchesRec(rec)) continue;
    const entry = installedByCatalogId.get(rec.id);
    let state: McpCatalogState;
    let installed: boolean;
    let installedKey: string | undefined;
    let scope: ExtensionScope | undefined;
    let config: McpServerConfig | undefined;
    if (rec.isBuiltin) {
      installed = builtinInstalled(rec.id);
      state = installed ? 'ready' : 'recommended';
      installedKey = installed ? rec.id : undefined;
      scope = undefined;
    } else {
      state = entry
        ? computeStateForInstalled(entry.config, rec.auth, rec.id, opts.unhealthyIds)
        : 'recommended';
      installed = !!entry;
      installedKey = entry?.name;
      scope = entry?.scope;
      config = entry?.config;
    }
    items.push({
      id: rec.id,
      name: rec.name,
      description: rec.description,
      descriptionZh: rec.descriptionZh,
      category: rec.category,
      iconSlug: rec.iconSlug,
      iconUrl: rec.iconUrl,
      homepage: rec.homepage,
      transport: { type: rec.transport.type, summary: transportSummary(rec.transport) },
      auth: rec.auth,
      state,
      isRecommended: true,
      installed,
      scope,
      config,
      installedKey,
      recommendedScope: rec.recommendedScope,
      isBuiltin: rec.isBuiltin,
    });
  }

  for (const entry of customEntries) {
    if (!scopeMatchesEntry(entry)) continue;
    if (isGenericDemoEntry(entry)) continue;
    const auth: McpAuthSpec = { type: 'none' };
    const state = computeStateForInstalled(entry.config, auth, entry.name, opts.unhealthyIds);
    items.push({
      id: entry.name,
      name: entry.name,
      description: cmdSummary(entry.config),
      descriptionZh: cmdSummary(entry.config),
      category: 'custom',
      transport: {
        type: entry.config.type === 'http' ? 'http' : 'stdio',
        summary: cmdSummary(entry.config),
      },
      auth,
      state,
      isRecommended: false,
      installed: true,
      scope: entry.scope,
      config: entry.config,
      installedKey: entry.name,
    });
  }

  return items;
}

export function getCatalogItem(id: string, opts: { workdir?: string } = {}): McpCatalogItem | undefined {
  return getCatalogItems(opts).find(i => i.id === id);
}

export function buildInstalledConfigFromRecommended(
  rec: RecommendedMcpServer,
  opts: { enabled: boolean; credentials?: Record<string, string> } = { enabled: false },
): McpServerConfig {
  const creds = opts.credentials || {};

  if (rec.transport.type === 'stdio') {
    const env: Record<string, string> = {};
    if (rec.auth.type === 'credentials') {
      for (const f of rec.auth.fields) if (creds[f.key]) env[f.key] = creds[f.key];
    }
    return {
      type: 'stdio',
      command: rec.transport.command,
      args: rec.transport.args,
      ...(Object.keys(env).length ? { env } : {}),
      enabled: opts.enabled,
      catalogId: rec.id,
    };
  }

  const headers: Record<string, string> = {};
  if (rec.auth.type === 'credentials') {
    const first = rec.auth.fields.find(f => creds[f.key]);
    if (first) headers.Authorization = `Bearer ${creds[first.key]}`;
  }
  return {
    type: 'http',
    url: rec.transport.url,
    ...(Object.keys(headers).length ? { headers } : {}),
    enabled: opts.enabled,
    catalogId: rec.id,
  };
}

export function mergeExtensionsForSession(
  builtinServers: RegisteredMcpServer[],
  workdir?: string,
): Record<string, any> {
  const merged: Record<string, any> = {};

  const userConfig = loadUserConfig();
  const globalMcp = userConfig.extensions?.mcp;
  if (globalMcp) {
    for (const [name, cfg] of Object.entries(globalMcp)) {
      if (cfg.enabled === false || cfg.disabled) continue;
      if (cfg.type === 'http' && cfg.url) {
        const oauthKey = cfg.catalogId || name;
        const headers = injectOAuthHeaders(oauthKey, { headers: cfg.headers });
        merged[name] = {
          type: 'http',
          url: cfg.url,
          ...(Object.keys(headers).length ? { headers } : {}),
        };
      } else if (cfg.command) {
        merged[name] = {
          type: 'stdio',
          command: cfg.command,
          args: cfg.args || [],
          ...(cfg.env ? { env: cfg.env } : {}),
        };
      }
    }
  }

  if (workdir) {
    for (const candidate of [
      path.join(workdir, '.mcp.json'),
      path.join(workdir, '.claude', '.mcp.json'),
      path.join(os.homedir(), '.claude', '.mcp.json'),
    ]) {
      try {
        const raw = fs.readFileSync(candidate, 'utf-8');
        const parsed = JSON.parse(raw);
        const servers = parsed?.mcpServers ?? parsed;
        if (servers && typeof servers === 'object') {
          for (const [name, cfg] of Object.entries(servers) as [string, any][]) {
            if (cfg?.disabled === true) {
              delete merged[name];
            } else {
              Object.assign(merged, { [name]: cfg });
            }
          }
        }
      } catch {  }
    }
  }

  for (const server of builtinServers) {
    merged[server.name] = {
      type: 'stdio',
      command: server.command,
      args: server.args,
      ...(server.env ? { env: server.env } : {}),
    };
  }

  for (const [name, cfg] of Object.entries(merged)) {
    if (cfg?.disabled === true || cfg?.enabled === false) {
      delete merged[name];
    }
  }

  return merged;
}

export function getGlobalExtensionsAsServers(workdir?: string): RegisteredMcpServer[] {
  const merged: Map<string, RegisteredMcpServer> = new Map();

  const toEntry = (name: string, cfg: McpServerConfig): RegisteredMcpServer | null => {
    if (cfg.type === 'http' && cfg.url) {
      const oauthKey = cfg.catalogId || name;
      const headers = injectOAuthHeaders(oauthKey, { headers: cfg.headers });
      return {
        name,
        type: 'http',
        url: cfg.url,
        ...(Object.keys(headers).length ? { headers } : {}),
      };
    }
    if (cfg.command) {
      return {
        name,
        type: 'stdio',
        command: cfg.command,
        args: cfg.args || [],
        ...(cfg.env ? { env: cfg.env } : {}),
      };
    }
    return null;
  };

  const userConfig = loadUserConfig();
  const globalMcp = userConfig.extensions?.mcp;
  if (globalMcp) {
    for (const [name, cfg] of Object.entries(globalMcp)) {
      if (cfg.enabled === false || cfg.disabled) continue;
      const entry = toEntry(name, cfg);
      if (entry) merged.set(name, entry);
    }
  }

  if (workdir) {
    const wsServers = readMcpJson(workspaceMcpJsonPath(workdir));
    for (const [name, cfg] of Object.entries(wsServers)) {
      if (cfg.disabled) {
        merged.delete(name);
        continue;
      }
      const entry = toEntry(name, cfg);
      if (entry) merged.set(name, entry);
    }
  }

  return [...merged.values()];
}

interface CachedHealth {
  result: McpHealthResult;
  fingerprint: string;
  cachedAt: number;
}

const HEALTH_CACHE_TTL_MS = 10 * 60 * 1000;
const healthCache = new Map<string, CachedHealth>();

function healthFingerprint(config: McpServerConfig): string {
  return JSON.stringify({
    type: config.type || 'stdio',
    url: config.url,
    command: config.command,
    args: config.args,
    hasEnv: !!config.env && Object.keys(config.env).length > 0,
  });
}

export function getCachedHealth(id: string, config: McpServerConfig): McpHealthResult | undefined {
  const entry = healthCache.get(id);
  if (!entry) return undefined;
  if (Date.now() - entry.cachedAt > HEALTH_CACHE_TTL_MS) return undefined;
  if (entry.fingerprint !== healthFingerprint(config)) return undefined;
  return entry.result;
}

export function cacheHealth(id: string, config: McpServerConfig, result: McpHealthResult): void {
  healthCache.set(id, { result, fingerprint: healthFingerprint(config), cachedAt: Date.now() });
}

export async function checkMcpHealth(config: McpServerConfig, timeoutMs = 10_000): Promise<McpHealthResult> {
  if (config.type === 'http') {
    try {
      const start = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetch(config.url!, { signal: controller.signal, method: 'GET' });
      clearTimeout(timer);
      return { ok: res.ok || res.status === 405 || res.status === 401, elapsedMs: Date.now() - start };
    } catch (e: any) {
      return { ok: false, error: e?.message || 'unreachable' };
    }
  }

  if (!config.command) return { ok: false, error: 'no command specified' };

  return new Promise((resolve) => {
    const start = Date.now();
    let checkInterval: ReturnType<typeof setInterval> | null = null;
    let settled = false;

    const cleanup = () => {
      if (checkInterval) { clearInterval(checkInterval); checkInterval = null; }
      clearTimeout(timer);
    };
    const stopChildTree = () => {
      terminateProcessTree(child, { signal: 'SIGTERM', forceSignal: 'SIGKILL', forceAfterMs: 1500 });
    };
    const finish = (result: McpHealthResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const child = spawn(config.command!, config.args || [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...config.env },
      detached: process.platform !== 'win32',
    });

    const timer = setTimeout(() => {
      stopChildTree();
      finish({ ok: false, error: `timeout after ${timeoutMs}ms`, elapsedMs: Date.now() - start });
    }, timeoutMs);

    let stdout = '';
    child.stdout?.on('data', (data: Buffer) => { stdout += data.toString(); });

    child.on('error', (err) => {
      finish({ ok: false, error: err.message, elapsedMs: Date.now() - start });
    });

    const initRequest = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'pikiloom-health-check', version: '1.0.0' },
      },
    });
    const header = `Content-Length: ${Buffer.byteLength(initRequest)}\r\n\r\n`;

    try {
      child.stdin?.write(header + initRequest);
    } catch {
      stopChildTree();
      finish({ ok: false, error: 'failed to write to stdin', elapsedMs: Date.now() - start });
      return;
    }

    checkInterval = setInterval(() => {
      const hasResponse = stdout.includes('"result"') || stdout.includes('"serverInfo"');
      if (!hasResponse) return;

      cleanup();

      const toolsRequest = JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {},
      });
      const toolsHeader = `Content-Length: ${Buffer.byteLength(toolsRequest)}\r\n\r\n`;

      try { child.stdin?.write(toolsHeader + toolsRequest); } catch {  }

      setTimeout(() => {
        stopChildTree();
        const tools: string[] = [];
        try {
          const jsonMatches = stdout.match(/\{[^{}]*"tools"\s*:\s*\[[\s\S]*?\]\s*[^{}]*\}/g);
          if (jsonMatches) {
            for (const m of jsonMatches) {
              try {
                const parsed = JSON.parse(m);
                if (Array.isArray(parsed.tools)) {
                  for (const tool of parsed.tools) if (tool.name) tools.push(tool.name);
                }
                if (parsed.result?.tools) {
                  for (const tool of parsed.result.tools) if (tool.name) tools.push(tool.name);
                }
              } catch {  }
            }
          }
        } catch {  }

        finish({ ok: true, tools: tools.length ? tools : undefined, elapsedMs: Date.now() - start });
      }, 1500);
    }, 100);
  });
}
