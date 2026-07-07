import type { McpServerSpec } from '../contracts/driver.js';
import { searchNpmPackages } from './npm-search.js';

// ---- McpRegistry: the unified MCP catalog + discovery ----
//
// The kernel ships a small curated catalog of well-known MCP servers and a search over the
// public MCP registry / npm, so a consuming app can offer "recommended" servers and a search
// box without hardcoding either. ENABLING a server (writing per-session config / injecting it
// into a spawn) stays on the existing Plugin.tools()/ToolProvider seam — this manager is the
// catalog + search half of "unified mcp management".

export interface McpCatalogEntry {
  id: string;
  name: string;
  description?: string;
  category?: string;
  brand?: string;
  transport:
    | { type: 'stdio'; command: string; args?: string[] }
    | { type: 'http'; url: string };
  /** Required credential env var names (so a UI can prompt for them). */
  envKeys?: string[];
  homepage?: string;
}

export interface McpSearchResult {
  name: string;
  description: string | null;
  source: 'registry' | 'npm';
  npmPackage?: string | null;
  homepage?: string | null;
}

export interface McpRegistryOptions {
  /** Replace/extend the built-in recommended catalog. */
  recommended?: McpCatalogEntry[];
  fetchImpl?: typeof fetch;
  log?: (msg: string) => void;
}

const BUILTIN_RECOMMENDED: McpCatalogEntry[] = [
  { id: 'filesystem', name: 'Filesystem', description: 'Read/write files under allowed directories.', category: 'core', transport: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'] }, homepage: 'https://github.com/modelcontextprotocol/servers' },
  { id: 'github', name: 'GitHub', description: 'GitHub repos, issues, and PRs.', category: 'dev', brand: 'github', transport: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] }, envKeys: ['GITHUB_PERSONAL_ACCESS_TOKEN'], homepage: 'https://github.com/modelcontextprotocol/servers' },
  { id: 'fetch', name: 'Fetch', description: 'Fetch and convert web pages to markdown.', category: 'web', transport: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-fetch'] }, homepage: 'https://github.com/modelcontextprotocol/servers' },
  { id: 'git', name: 'Git', description: 'Local git repository operations.', category: 'dev', transport: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-git'] }, homepage: 'https://github.com/modelcontextprotocol/servers' },
  { id: 'memory', name: 'Memory', description: 'A knowledge-graph memory store.', category: 'core', transport: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] }, homepage: 'https://github.com/modelcontextprotocol/servers' },
  { id: 'playwright', name: 'Playwright', description: 'Drive a real browser for automation.', category: 'web', brand: 'playwright', transport: { type: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest'] }, homepage: 'https://github.com/microsoft/playwright-mcp' },
  { id: 'context7', name: 'Context7', description: 'Up-to-date library docs & code examples.', category: 'docs', transport: { type: 'http', url: 'https://mcp.context7.com/mcp' }, homepage: 'https://context7.com' },
];

export class McpRegistry {
  private readonly _recommended: McpCatalogEntry[];
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly log?: (msg: string) => void;

  constructor(opts: McpRegistryOptions = {}) {
    this._recommended = opts.recommended?.length ? opts.recommended : BUILTIN_RECOMMENDED;
    this.fetchImpl = opts.fetchImpl ?? (typeof fetch === 'function' ? fetch : undefined);
    this.log = opts.log;
  }

  /** The curated catalog of well-known servers. */
  recommended(): McpCatalogEntry[] {
    return this._recommended.map(e => ({ ...e }));
  }

  /** Turn a catalog entry into a kernel McpServerSpec ready to hand to a driver/plugin. */
  toServerSpec(entry: McpCatalogEntry, env?: Record<string, string>): McpServerSpec {
    if (entry.transport.type === 'http') {
      return { name: entry.id, type: 'http', url: entry.transport.url };
    }
    return { name: entry.id, type: 'stdio', command: entry.transport.command, args: entry.transport.args, env };
  }

  /** Search the public MCP registry, falling back to npm. Best-effort; [] on failure. */
  async search(query: string, limit = 20): Promise<McpSearchResult[]> {
    const q = (query || '').trim();
    const n = Math.max(1, Math.min(50, limit));
    const fetchImpl = this.fetchImpl;
    if (!fetchImpl) return [];

    // 1) Official MCP registry.
    try {
      const url = `https://registry.modelcontextprotocol.io/v0/servers?search=${encodeURIComponent(q)}&limit=${n}`;
      const res = await fetchImpl(url, { headers: { accept: 'application/json' } });
      if (res.ok) {
        const data = await res.json() as any;
        const servers: any[] = Array.isArray(data?.servers) ? data.servers : Array.isArray(data?.data) ? data.data : [];
        const mapped = servers.map((s) => ({
          name: String(s?.name ?? s?.id ?? ''),
          description: s?.description ?? null,
          source: 'registry' as const,
          npmPackage: s?.packages?.[0]?.identifier ?? s?.npm ?? null,
          homepage: s?.repository?.url ?? s?.homepage ?? null,
        })).filter(s => s.name);
        if (mapped.length) return mapped.slice(0, n);
      }
    } catch (e: any) { this.log?.(`[mcp] registry search failed: ${e?.message || e}`); }

    // 2) npm fallback.
    try {
      const hits = await searchNpmPackages(`mcp server ${q}`.trim(), n, fetchImpl);
      return hits.map(h => ({
        name: h.name, description: h.description, source: 'npm' as const,
        npmPackage: h.name, homepage: h.homepage,
      })).slice(0, n);
    } catch (e: any) {
      this.log?.(`[mcp] npm search failed: ${e?.message || e}`);
      return [];
    }
  }
}
