import { Hono } from 'hono';
import { execFile } from 'node:child_process';
import {
  addGlobalMcpExtension, removeGlobalMcpExtension, updateGlobalMcpExtension,
  addWorkspaceMcpExtension, removeWorkspaceMcpExtension, updateWorkspaceMcpExtension,
  getCatalogItems, buildInstalledConfigFromRecommended,
  checkMcpHealth, getCachedHealth, cacheHealth,
  getRecommendedMcpServer,
  listSkills, installSkill, removeSkill,
  recordSkillInstall, getSkillLedgerEntry,
  getRecommendedSkillRepos, searchSkillRepos, searchMcpServers,
  startAuthorization, completeAuthorization, deleteMcpToken, getMcpToken,
} from '../../agent/index.js';
import type { McpServerConfig } from '../../core/config/user-config.js';
import { loadUserConfig, saveUserConfig } from '../../core/config/user-config.js';
import { ensurePeekabooWarm } from '../../agent/mcp/bridge.js';
import { runtime } from '../runtime.js';
import path from 'node:path';
import fs from 'node:fs';

function setBuiltinEnabled(catalogId: string, enabled: boolean): boolean {
  if (catalogId === 'pikiloom-browser') {
    saveUserConfig({ ...loadUserConfig(), browserEnabled: enabled });
    return true;
  }
  if (catalogId === 'peekaboo') {
    saveUserConfig({ ...loadUserConfig(), peekabooEnabled: enabled });
    if (enabled) ensurePeekabooWarm();
    return true;
  }
  return false;
}

const app = new Hono();

function isValidWorkdir(dir: string | undefined | null): dir is string {
  if (!dir || typeof dir !== 'string') return false;
  if (!path.isAbsolute(dir)) return false;
  try { return fs.statSync(dir).isDirectory(); } catch { return false; }
}

function getCallbackRedirectUri(c: { req: { url: string } }): string {
  const origin = new URL(c.req.url).origin;
  return `${origin}/api/extensions/mcp/oauth/callback`;
}

app.get('/api/extensions/mcp/catalog', (c) => {
  const workdir = c.req.query('workdir') || runtime.getRequestWorkdir();
  const scopeParam = c.req.query('scope');
  const scope = scopeParam === 'global' || scopeParam === 'workspace' || scopeParam === 'both'
    ? scopeParam
    : undefined;
  const items = getCatalogItems({ workdir, scope });
  return c.json({ ok: true, items });
});

app.post('/api/extensions/mcp/install', async (c) => {
  try {
    const body = await c.req.json();
    const {
      catalogId,
      scope = 'global',
      workdir: reqWorkdir,
      credentials,
      enable = true,
    } = body as {
      catalogId: string;
      scope?: 'global' | 'workspace';
      workdir?: string;
      credentials?: Record<string, string>;
      enable?: boolean;
    };
    if (!catalogId?.trim()) return c.json({ ok: false, error: 'catalogId is required' }, 400);
    const rec = getRecommendedMcpServer(catalogId.trim());
    if (!rec) return c.json({ ok: false, error: `unknown catalogId: ${catalogId}` }, 404);
    if (rec.isBuiltin) {
      const ok = setBuiltinEnabled(rec.id, enable !== false);
      return c.json({ ok, enabled: ok && enable !== false });
    }

    let shouldEnable = enable;
    if (rec.auth.type === 'mcp-oauth' && !getMcpToken(rec.id)) shouldEnable = false;
    if (rec.auth.type === 'credentials') {
      for (const f of rec.auth.fields) {
        if (f.required && !(credentials || {})[f.key]?.trim()) {
          shouldEnable = false;
          break;
        }
      }
    }

    const config = buildInstalledConfigFromRecommended(rec, { enabled: shouldEnable, credentials });

    if (scope === 'workspace') {
      const wd = reqWorkdir || runtime.getRequestWorkdir();
      if (!isValidWorkdir(wd)) return c.json({ ok: false, error: 'valid workdir is required for workspace scope' }, 400);
      addWorkspaceMcpExtension(wd, rec.id, config);
    } else {
      addGlobalMcpExtension(rec.id, config);
    }
    return c.json({ ok: true, enabled: shouldEnable });
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message || 'internal error' }, 500);
  }
});

app.post('/api/extensions/mcp/toggle', async (c) => {
  try {
    const body = await c.req.json();
    const { name, enabled, scope = 'global', workdir: reqWorkdir } = body as {
      name: string;
      enabled: boolean;
      scope?: 'global' | 'workspace';
      workdir?: string;
    };
    if (!name?.trim()) return c.json({ ok: false, error: 'name is required' }, 400);

    if (setBuiltinEnabled(name.trim(), !!enabled)) {
      return c.json({ ok: true, updated: true });
    }

    const patch: Partial<McpServerConfig> = { enabled: !!enabled };
    let updated: boolean;
    if (scope === 'workspace') {
      const wd = reqWorkdir || runtime.getRequestWorkdir();
      if (!isValidWorkdir(wd)) return c.json({ ok: false, error: 'valid workdir is required' }, 400);
      updated = updateWorkspaceMcpExtension(wd, name.trim(), patch);
    } else {
      updated = updateGlobalMcpExtension(name.trim(), patch);
    }
    return c.json({ ok: true, updated });
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message || 'internal error' }, 500);
  }
});

app.post('/api/extensions/mcp/update', async (c) => {
  try {
    const body = await c.req.json();
    const { name, patch, scope = 'global', workdir: reqWorkdir } = body as {
      name: string;
      patch: Partial<McpServerConfig>;
      scope?: 'global' | 'workspace';
      workdir?: string;
    };
    if (!name?.trim()) return c.json({ ok: false, error: 'name is required' }, 400);

    let updated: boolean;
    if (scope === 'workspace') {
      const wd = reqWorkdir || runtime.getRequestWorkdir();
      if (!isValidWorkdir(wd)) return c.json({ ok: false, error: 'valid workdir is required' }, 400);
      updated = updateWorkspaceMcpExtension(wd, name.trim(), patch);
    } else {
      updated = updateGlobalMcpExtension(name.trim(), patch);
    }
    return c.json({ ok: true, updated });
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message || 'internal error' }, 500);
  }
});

app.post('/api/extensions/mcp/remove', async (c) => {
  try {
    const body = await c.req.json();
    const { name, scope = 'global', workdir: reqWorkdir, catalogId } = body as {
      name: string;
      scope?: 'global' | 'workspace';
      workdir?: string;
      catalogId?: string;
    };
    if (!name?.trim()) return c.json({ ok: false, error: 'name is required' }, 400);

    if (setBuiltinEnabled(name.trim(), false)) {
      return c.json({ ok: true, removed: true });
    }

    let removed: boolean;
    if (scope === 'workspace') {
      const wd = reqWorkdir || runtime.getRequestWorkdir();
      if (!isValidWorkdir(wd)) return c.json({ ok: false, error: 'valid workdir is required' }, 400);
      removed = removeWorkspaceMcpExtension(wd, name.trim());
    } else {
      removed = removeGlobalMcpExtension(name.trim());
    }
    if (catalogId) deleteMcpToken(catalogId);
    return c.json({ ok: true, removed });
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message || 'internal error' }, 500);
  }
});

app.post('/api/extensions/mcp/custom', async (c) => {
  try {
    const body = await c.req.json();
    const { name, config, scope = 'global', workdir: reqWorkdir } = body as {
      name: string;
      config: McpServerConfig;
      scope?: 'global' | 'workspace';
      workdir?: string;
    };
    if (!name?.trim()) return c.json({ ok: false, error: 'name is required' }, 400);
    if (!config) return c.json({ ok: false, error: 'config is required' }, 400);

    const clean: McpServerConfig = { ...config };
    delete (clean as any).catalogId;
    if (clean.enabled === undefined) clean.enabled = true;

    if (scope === 'workspace') {
      const wd = reqWorkdir || runtime.getRequestWorkdir();
      if (!isValidWorkdir(wd)) return c.json({ ok: false, error: 'valid workdir is required for workspace scope' }, 400);
      addWorkspaceMcpExtension(wd, name.trim(), clean);
    } else {
      addGlobalMcpExtension(name.trim(), clean);
    }
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message || 'internal error' }, 500);
  }
});

app.post('/api/extensions/mcp/health', async (c) => {
  try {
    const body = await c.req.json();
    const { id, config, noCache } = body as { id: string; config: McpServerConfig; noCache?: boolean };
    if (!id?.trim()) return c.json({ ok: false, error: 'id is required' }, 400);
    if (!config) return c.json({ ok: false, error: 'config is required' }, 400);

    if (!noCache) {
      const cached = getCachedHealth(id, config);
      if (cached) return c.json({ ...cached, cached: true });
    }

    const result = await checkMcpHealth(config);
    cacheHealth(id, config, result);
    return c.json(result);
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message || 'internal error' }, 500);
  }
});

app.get('/api/extensions/mcp/search', async (c) => {
  const query = c.req.query('q') || '';
  const parsed = parseInt(c.req.query('limit') || '20', 10);
  const limit = Math.min(Number.isFinite(parsed) ? parsed : 20, 50);
  try {
    const results = await searchMcpServers(query, limit);
    return c.json({ ok: true, results });
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message, results: [] });
  }
});

app.post('/api/extensions/mcp/oauth/start', async (c) => {
  try {
    const body = await c.req.json();
    const { catalogId } = body as { catalogId: string };
    if (!catalogId?.trim()) return c.json({ ok: false, error: 'catalogId is required' }, 400);
    const rec = getRecommendedMcpServer(catalogId.trim());
    if (!rec) return c.json({ ok: false, error: `unknown catalogId: ${catalogId}` }, 404);
    if (rec.auth.type !== 'mcp-oauth') {
      return c.json({ ok: false, error: 'this server does not use OAuth' }, 400);
    }
    if (rec.transport.type !== 'http') {
      return c.json({ ok: false, error: 'OAuth is only supported for http transport' }, 400);
    }

    const redirectUri = getCallbackRedirectUri(c);
    const { authUrl, state } = await startAuthorization({
      serverId: rec.id,
      auth: rec.auth,
      resourceUrl: rec.transport.url,
      redirectUri,
      clientName: 'Pikiloom',
    });
    return c.json({ ok: true, authUrl, state });
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message || 'oauth start failed' }, 500);
  }
});

app.get('/api/extensions/mcp/oauth/callback', async (c) => {
  const code = c.req.query('code') || '';
  const state = c.req.query('state') || '';
  const providerError = c.req.query('error') || '';
  const providerDesc = c.req.query('error_description') || '';

  const render = (opts: { ok: boolean; title: string; detail: string }) => c.html(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${opts.ok ? 'Authorized' : 'Authorization failed'}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #0f1115; color: #d4d4d8; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 24px; }
    .card { max-width: 420px; padding: 28px; border: 1px solid #262a33; border-radius: 14px; background: #161922; text-align: center; }
    .icon { font-size: 40px; margin-bottom: 12px; }
    h1 { font-size: 17px; margin: 0 0 6px; font-weight: 600; color: #f4f4f5; }
    p { font-size: 13px; line-height: 1.55; color: #a1a1aa; margin: 0; }
    .close { display: inline-block; margin-top: 16px; font-size: 12px; color: #6366f1; text-decoration: none; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">${opts.ok ? '✅' : '⚠️'}</div>
    <h1>${opts.title}</h1>
    <p>${opts.detail}</p>
    <a class="close" href="javascript:window.close()">Close window</a>
  </div>
  <script>
    try {
      if (window.opener) {
        window.opener.postMessage({ type: 'mcp-oauth', ok: ${opts.ok}, state: ${JSON.stringify(state)} }, '*');
      }
    } catch (e) {}
    setTimeout(function () { try { window.close(); } catch (e) {} }, 1500);
  </script>
</body>
</html>`);

  if (providerError) {
    return render({
      ok: false,
      title: 'Authorization was cancelled',
      detail: providerDesc || providerError,
    });
  }
  if (!code || !state) {
    return render({
      ok: false,
      title: 'Missing code or state',
      detail: 'The provider did not return the expected parameters.',
    });
  }
  try {
    const result = await completeAuthorization({ state, code });
    return render({
      ok: true,
      title: 'Authorized successfully',
      detail: `Pikiloom can now connect to ${result.serverId}. You can close this window and return to the dashboard.`,
    });
  } catch (e: any) {
    return render({
      ok: false,
      title: 'Token exchange failed',
      detail: e?.message || 'Unknown error',
    });
  }
});

app.post('/api/extensions/mcp/oauth/revoke', async (c) => {
  try {
    const body = await c.req.json();
    const { catalogId } = body as { catalogId: string };
    if (!catalogId?.trim()) return c.json({ ok: false, error: 'catalogId is required' }, 400);
    const removed = deleteMcpToken(catalogId.trim());
    return c.json({ ok: true, removed });
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message || 'internal error' }, 500);
  }
});

interface SkillCatalogItem {
  id: string;
  name: string;
  description: string;
  descriptionZh: string;
  source: string;
  category: string;
  recommendedScope: 'global' | 'workspace' | 'both';
  homepage?: string;
  installed: boolean;
  scope?: 'global' | 'project';
  installedNames: string[];
  stars?: number;
  pushedAt?: string;
  iconUrl?: string;
  totalCount?: number;
  partial?: boolean;
  pinned?: boolean;
  updateAvailable?: boolean;
  installedSha?: string | null;
  latestSha?: string | null;
}

function extractGithubOwner(source: string): string | null {
  if (!source) return null;
  const cleaned = source.trim().replace(/^https?:\/\/(www\.)?github\.com\//i, '');
  const owner = cleaned.split('/')[0]?.trim();
  if (!owner) return null;
  return /^[a-z0-9](?:[a-z0-9-]{0,38})$/i.test(owner) ? owner : null;
}

interface RepoMeta { stars: number; pushedAt: string }
const githubMetaCache = new Map<string, { value: RepoMeta; cachedAt: number }>();
const GITHUB_META_TTL_MS = 24 * 60 * 60 * 1000;
let githubMetaInflight: Promise<void> | null = null;

export interface RemoteSkillInfo {
  name: string;
  description?: string;
  path: string;
}
interface RemoteSkillsResult {
  skills: RemoteSkillInfo[];
  partial: boolean;
}
const remoteSkillsCache = new Map<string, { value: RemoteSkillsResult; cachedAt: number }>();
const REMOTE_SKILLS_TTL_MS = 24 * 60 * 60 * 1000;
const remoteSkillsInflight = new Map<string, Promise<RemoteSkillsResult | null>>();

let githubTokenCache: { value: string; resolvedAt: number } | null = null;
let githubTokenInflight: Promise<string | null> | null = null;
const GITHUB_TOKEN_TTL_MS = 10 * 60 * 1000;

async function resolveGithubToken(): Promise<string | null> {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  if (githubTokenCache && Date.now() - githubTokenCache.resolvedAt < GITHUB_TOKEN_TTL_MS) {
    return githubTokenCache.value;
  }
  if (githubTokenInflight) return githubTokenInflight;
  githubTokenInflight = (async () => {
    const value = await new Promise<string | null>((resolve) => {
      try {
        execFile('gh', ['auth', 'token'], { timeout: 3_000 }, (err, stdout) => {
          if (err) { resolve(null); return; }
          const out = (stdout?.toString() || '').trim();
          resolve(out || null);
        });
      } catch { resolve(null); }
    });
    if (value) githubTokenCache = { value, resolvedAt: Date.now() };
    return value;
  })().finally(() => { githubTokenInflight = null; });
  return githubTokenInflight;
}

function parseSourceToOwnerRepo(source: string): { owner: string; repo: string } | null {
  if (!source) return null;
  const cleaned = source.trim().replace(/^https?:\/\/(www\.)?github\.com\//i, '').replace(/\.git$/, '');
  const [owner, repo] = cleaned.split('/');
  if (!owner || !repo) return null;
  if (!/^[a-z0-9](?:[a-z0-9-]{0,38})$/i.test(owner)) return null;
  if (!/^[a-z0-9._-]+$/i.test(repo)) return null;
  return { owner, repo };
}

interface GhContentEntry {
  name: string;
  path: string;
  type: 'dir' | 'file' | 'symlink' | 'submodule';
}

async function fetchGithubContents(owner: string, repo: string, path: string): Promise<GhContentEntry[] | null> {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURI(path)}`;
  try {
    const headers: Record<string, string> = {
      'User-Agent': 'pikiloom-dashboard',
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    const token = await resolveGithubToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 8_000);
    const res = await fetch(url, { headers, signal: ctrl.signal });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const data = await res.json();
    if (!Array.isArray(data)) return null;
    return data as GhContentEntry[];
  } catch { return null; }
}

async function listRemoteSkillsFromGithub(source: string): Promise<RemoteSkillsResult | null> {
  const cached = remoteSkillsCache.get(source);
  if (cached && Date.now() - cached.cachedAt < REMOTE_SKILLS_TTL_MS) return cached.value;

  const inflight = remoteSkillsInflight.get(source);
  if (inflight) return inflight;

  const promise = (async () => {
    const parsed = parseSourceToOwnerRepo(source);
    if (!parsed) return null;
    const { owner, repo } = parsed;

    let listing = await fetchGithubContents(owner, repo, 'skills');
    let basePath = 'skills';
    if (!listing || listing.length === 0) {
      listing = await fetchGithubContents(owner, repo, '');
      basePath = '';
    }
    if (!listing) return null;

    const directories = listing.filter(e => e.type === 'dir' && !e.name.startsWith('.'));

    const skills: RemoteSkillInfo[] = directories.map(d => ({
      name: d.name,
      path: d.path,
    }));

    const partial = directories.length >= 1000;
    const result: RemoteSkillsResult = { skills, partial };
    remoteSkillsCache.set(source, { value: result, cachedAt: Date.now() });
    return result;
  })().finally(() => remoteSkillsInflight.delete(source));

  remoteSkillsInflight.set(source, promise);
  return promise;
}

app.get('/api/extensions/skills/list', async (c) => {
  const source = c.req.query('source')?.trim();
  if (!source) return c.json({ ok: false, error: 'source is required', skills: [] }, 400);
  const result = await listRemoteSkillsFromGithub(source);
  if (!result) {
    return c.json({
      ok: false,
      error: 'failed to list remote skills',
      skills: [],
      partial: false,
    }, 502);
  }
  return c.json({ ok: true, skills: result.skills, partial: result.partial });
});

async function fetchOneRepoMeta(source: string): Promise<RepoMeta | null> {
  const slug = source.replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '');
  if (!/^[^/]+\/[^/]+$/.test(slug)) return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    const token = await resolveGithubToken();
    const res = await fetch(`https://api.github.com/repos/${slug}`, {
      signal: controller.signal,
      headers: {
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'pikiloom-dashboard',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = await res.json() as { stargazers_count?: number; pushed_at?: string };
    if (typeof data.stargazers_count !== 'number') return null;
    return { stars: data.stargazers_count, pushedAt: data.pushed_at || '' };
  } catch { return null; }
}

const repoHeadShaCache = new Map<string, { value: string; cachedAt: number }>();
const REPO_HEAD_SHA_TTL_MS = 10 * 60 * 1000;
const repoHeadShaInflight = new Map<string, Promise<string | null>>();

async function fetchRepoHeadSha(source: string): Promise<string | null> {
  const parsed = parseSourceToOwnerRepo(source);
  if (!parsed) return null;
  const slug = `${parsed.owner}/${parsed.repo}`;

  const cached = repoHeadShaCache.get(slug);
  if (cached && Date.now() - cached.cachedAt < REPO_HEAD_SHA_TTL_MS) return cached.value;

  const inflight = repoHeadShaInflight.get(slug);
  if (inflight) return inflight;

  const promise = (async () => {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5_000);
      const token = await resolveGithubToken();
      const res = await fetch(`https://api.github.com/repos/${slug}/commits?per_page=1`, {
        signal: controller.signal,
        headers: {
          'Accept': 'application/vnd.github+json',
          'User-Agent': 'pikiloom-dashboard',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });
      clearTimeout(timer);
      if (!res.ok) return null;
      const data = await res.json();
      const sha = Array.isArray(data) && data[0]?.sha ? String(data[0].sha) : null;
      if (sha) repoHeadShaCache.set(slug, { value: sha, cachedAt: Date.now() });
      return sha;
    } catch { return null; }
  })().finally(() => repoHeadShaInflight.delete(slug));

  repoHeadShaInflight.set(slug, promise);
  return promise;
}

async function ensureRepoMeta(sources: string[]): Promise<void> {
  const now = Date.now();
  const stale = sources.filter(s => {
    const hit = githubMetaCache.get(s);
    return !hit || now - hit.cachedAt > GITHUB_META_TTL_MS;
  });
  if (stale.length === 0) return;
  if (githubMetaInflight) { await githubMetaInflight; return; }
  githubMetaInflight = (async () => {
    await Promise.all(stale.map(async s => {
      const meta = await fetchOneRepoMeta(s);
      if (meta) githubMetaCache.set(s, { value: meta, cachedAt: now });
    }));
  })();
  try { await githubMetaInflight; } finally { githubMetaInflight = null; }
}

app.get('/api/extensions/skills/catalog', async (c) => {
  const workdir = c.req.query('workdir') || runtime.getRequestWorkdir();
  const scopeParam = c.req.query('scope');
  const scope = scopeParam === 'global' || scopeParam === 'workspace' || scopeParam === 'both'
    ? scopeParam
    : undefined;

  if (scope === 'workspace' && !workdir) {
    return c.json({ ok: false, error: 'workdir is required', items: [], installed: [] }, 400);
  }

  const installedResult = listSkills(workdir);
  const installed = installedResult.skills || [];
  const recommended = getRecommendedSkillRepos();

  const filtered = recommended.filter(repo => {
    if (!scope) return true;
    return repo.recommendedScope === scope || repo.recommendedScope === 'both';
  });

  const sources = filtered.map(r => r.source);
  const allCached = sources.every(s => githubMetaCache.has(s));
  if (allCached) {
  } else {
    await ensureRepoMeta(sources).catch(() => {  });
  }

  for (const s of sources) {
    if (!remoteSkillsCache.has(s) && !remoteSkillsInflight.has(s)) {
      void listRemoteSkillsFromGithub(s).catch(() => {  });
    }
  }

  const scopedInstalled = scope === 'global'
    ? installed.filter(s => s.scope === 'global')
    : scope === 'workspace'
      ? installed.filter(s => s.scope === 'project')
      : installed;
  const installedByName = new Map<string, typeof scopedInstalled[number]>();
  for (const s of scopedInstalled) installedByName.set(s.name.toLowerCase(), s);

  const computeInstalledNames = (repo: typeof filtered[number]): string[] => {
    const remote = remoteSkillsCache.get(repo.source)?.value;
    if (remote) {
      return remote.skills
        .map(s => s.name)
        .filter(name => installedByName.has(name.toLowerCase()));
    }
    const hints = (repo.skills || []).map(s => s.toLowerCase());
    return scopedInstalled
      .filter(s => hints.includes(s.name.toLowerCase()))
      .map(s => s.name);
  };
  const perRepo = filtered.map(repo => ({ repo, installedNames: computeInstalledNames(repo) }));

  const ledgerScope = scope === 'workspace' ? { workdir } : { global: true };
  interface UpdateInfo { installedSha: string | null; latestSha: string | null; updateAvailable: boolean }
  const updateBySource = new Map<string, UpdateInfo>();
  await Promise.all(perRepo.map(async ({ repo, installedNames }) => {
    if (installedNames.length === 0) return;
    const latestSha = await fetchRepoHeadSha(repo.source).catch(() => null);
    const entry = getSkillLedgerEntry(repo.source, ledgerScope);
    let installedSha = entry?.sha ?? null;
    if (!entry && latestSha) {
      recordSkillInstall(repo.source, { ...ledgerScope, sha: latestSha, names: installedNames });
      installedSha = latestSha;
    }
    updateBySource.set(repo.source, {
      installedSha,
      latestSha,
      updateAvailable: !!(installedSha && latestSha && installedSha !== latestSha),
    });
  }));

  const items: SkillCatalogItem[] = perRepo.map(({ repo, installedNames }) => {
    const meta = githubMetaCache.get(repo.source)?.value;
    const remote = remoteSkillsCache.get(repo.source)?.value;
    const owner = extractGithubOwner(repo.source);
    const iconUrl = repo.iconUrl
      ?? (owner ? `https://github.com/${owner}.png?size=80` : undefined);
    const firstMatch = installedNames[0]
      ? installedByName.get(installedNames[0].toLowerCase())
      : undefined;
    const upd = updateBySource.get(repo.source);

    return {
      id: repo.id,
      name: repo.name,
      description: repo.description,
      descriptionZh: repo.descriptionZh,
      source: repo.source,
      category: repo.category,
      recommendedScope: repo.recommendedScope,
      homepage: repo.homepage,
      installed: installedNames.length > 0,
      scope: firstMatch?.scope,
      installedNames,
      stars: meta?.stars,
      pushedAt: meta?.pushedAt,
      iconUrl,
      totalCount: remote?.skills.length,
      partial: remote?.partial,
      pinned: repo.pinned,
      updateAvailable: upd?.updateAvailable,
      installedSha: upd?.installedSha,
      latestSha: upd?.latestSha,
    };
  });

  items.sort((a, b) => {
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
    return (b.stars ?? -1) - (a.stars ?? -1);
  });

  return c.json({ ok: true, items, installed });
});

app.post('/api/extensions/skills/install', async (c) => {
  try {
    const body = await c.req.json();
    const { source, global: isGlobal, skill, workdir: reqWorkdir } = body as {
      source: string;
      global?: boolean;
      skill?: string;
      workdir?: string;
    };
    if (!source?.trim()) return c.json({ ok: false, error: 'source is required' }, 400);

    const workdir = reqWorkdir || runtime.getRequestWorkdir();
    if (!isGlobal && !isValidWorkdir(workdir)) {
      return c.json({ ok: false, error: 'valid workdir is required for project-scoped install' }, 400);
    }

    const sourceSha = await fetchRepoHeadSha(source.trim()).catch(() => null);
    const result = await installSkill(source.trim(), { global: isGlobal, skill, workdir, sourceSha });
    return c.json(result);
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message || 'installation failed' }, 500);
  }
});

app.post('/api/extensions/skills/update', async (c) => {
  try {
    const body = await c.req.json();
    const { source, global: isGlobal, workdir: reqWorkdir } = body as {
      source: string;
      global?: boolean;
      workdir?: string;
    };
    if (!source?.trim()) return c.json({ ok: false, error: 'source is required' }, 400);

    const workdir = reqWorkdir || runtime.getRequestWorkdir();
    if (!isGlobal && !isValidWorkdir(workdir)) {
      return c.json({ ok: false, error: 'valid workdir is required for project-scoped update' }, 400);
    }

    const sourceSha = await fetchRepoHeadSha(source.trim()).catch(() => null);
    const result = await installSkill(source.trim(), { global: isGlobal, workdir, sourceSha });
    return c.json({ ...result, sha: sourceSha });
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message || 'update failed' }, 500);
  }
});

app.post('/api/extensions/skills/remove', async (c) => {
  try {
    const body = await c.req.json();
    const { name, global: isGlobal, workdir: reqWorkdir } = body as {
      name: string;
      global?: boolean;
      workdir?: string;
    };
    if (!name?.trim()) return c.json({ ok: false, error: 'name is required' }, 400);

    const workdir = reqWorkdir || runtime.getRequestWorkdir();
    const result = removeSkill(name.trim(), { global: isGlobal, workdir });
    return c.json(result);
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message || 'removal failed' }, 500);
  }
});

app.get('/api/extensions/skills/search', async (c) => {
  const query = c.req.query('q') || '';
  try {
    const results = await searchSkillRepos(query);
    return c.json({ ok: true, results });
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message, results: [] });
  }
});

export default app;
