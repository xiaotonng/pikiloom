import fs from 'node:fs';
import path from 'node:path';
import type { LoomPaths, LoomScope } from './paths.js';
import { searchNpmPackages } from './npm-search.js';

// ---- SkillsManager: the unified skills registry ("注册到全局目录然后给各 agent 做软链") ----
//
// Skills live ONCE under the top-level dir's `skills/` (canonical), and each agent's native
// skills dir (~/.claude/skills, ~/.agents/skills, or the per-workspace equivalents) is a
// symlink to it. So a skill registered in one place is visible to every agent, and the kernel
// owns the listing + discovery + search. Faithful, generalized port of pikiloom's skills.ts.

export interface SkillInfo {
  name: string;
  label: string | null;
  description: string | null;
  scope: LoomScope;
  path: string;
  mcpRequires?: string[];
}

export interface SkillSearchResult {
  name: string;
  description: string | null;
  source: string;
  author?: string | null;
  homepage?: string | null;
  version?: string | null;
}

export interface SkillsManagerOptions {
  paths: LoomPaths;
  /** Agent skills dirs (relative to the scope's agentHome) to symlink to the canonical dir. */
  agentSkillDirs?: string[];
  log?: (msg: string) => void;
}

const DEFAULT_AGENT_SKILL_DIRS = ['.claude/skills', '.agents/skills'];

export interface SkillMeta {
  label: string | null;
  description: string | null;
  mcpRequires?: string[];
}

/**
 * Parse a SKILL.md's frontmatter (label/name + description + mcp_requires), falling back
 * to the first `# heading` for the label. Exported so an app scanning additional skill
 * stores (e.g. an agent's own ~/.claude/skills) reads them with the same rules.
 */
export function parseSkillMeta(content: string): SkillMeta {
  let label: string | null = null;
  let description: string | null = null;
  let mcpRequires: string[] | undefined;
  const fm = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (fm) {
    // Both frontmatter dialects: pikiloom's `label:` and the agent-native `name:`.
    const lm = fm[1].match(/^label:\s*(.+)/m) || fm[1].match(/^name:\s*(.+)/m);
    if (lm) label = lm[1].trim();
    const dm = fm[1].match(/^description:\s*(.+)/m);
    if (dm) description = dm[1].trim();
    const mr = fm[1].match(/^mcp_requires:\s*\n((?:\s+-\s+.+\n?)+)/m);
    if (mr) {
      mcpRequires = mr[1].split('\n').map(l => l.replace(/^\s*-\s*/, '').replace(/["']/g, '').trim()).filter(Boolean);
    }
  }
  if (!label) {
    const hm = content.match(/^#\s+(.+)$/m);
    if (hm) label = hm[1].trim();
  }
  return { label, description, mcpRequires };
}

function realPathOrNull(p: string): string | null {
  try { return fs.realpathSync(p); } catch { return null; }
}

/** Make `linkPath` a symlink to `targetDir` (idempotent; replaces a stale link/dir). */
export function ensureDirSymlink(linkPath: string, targetDir: string): void {
  const desiredTarget = path.relative(path.dirname(linkPath), targetDir) || '.';
  try {
    const stat = fs.lstatSync(linkPath);
    if (stat.isSymbolicLink()) {
      const currentTarget = fs.readlinkSync(linkPath);
      const currentReal = realPathOrNull(path.resolve(path.dirname(linkPath), currentTarget));
      const desiredReal = realPathOrNull(targetDir);
      if (currentTarget === desiredTarget || (currentReal && desiredReal && currentReal === desiredReal)) return;
      fs.unlinkSync(linkPath);
    } else {
      fs.rmSync(linkPath, { recursive: true, force: true });
    }
  } catch { /* nothing there yet */ }
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  try {
    fs.symlinkSync(desiredTarget, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST' || fs.readlinkSync(linkPath) !== desiredTarget) throw err;
  }
}

function discoverSkillsFromDir(dir: string, scope: LoomScope, seen: Set<string>): SkillInfo[] {
  let entries: string[];
  try { entries = fs.readdirSync(dir).sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' })); }
  catch { return []; }
  const out: SkillInfo[] = [];
  for (const name of entries) {
    if (!name || seen.has(name)) continue;
    const skillDir = path.join(dir, name);
    const skillFile = path.join(skillDir, 'SKILL.md');
    try { if (!fs.statSync(skillDir).isDirectory()) continue; } catch { continue; }
    try { if (!fs.statSync(skillFile).isFile()) continue; } catch { continue; }
    let meta: SkillMeta = { label: null, description: null };
    try { meta = parseSkillMeta(fs.readFileSync(skillFile, 'utf8')); } catch { /* keep defaults */ }
    out.push({ name, label: meta.label, description: meta.description, scope, path: skillDir, mcpRequires: meta.mcpRequires });
    seen.add(name);
  }
  return out;
}

export class SkillsManager {
  private readonly paths: LoomPaths;
  private readonly agentSkillDirs: string[];
  private readonly log?: (msg: string) => void;

  constructor(opts: SkillsManagerOptions) {
    this.paths = opts.paths;
    this.agentSkillDirs = opts.agentSkillDirs?.length ? opts.agentSkillDirs : DEFAULT_AGENT_SKILL_DIRS;
    this.log = opts.log;
  }

  /** The canonical skills dir for a scope, e.g. <workdir>/.pikiloom/skills or ~/.pikiloom/skills. */
  canonicalDir(scope: LoomScope, workdir?: string): string {
    return this.paths.skillsDir(scope, workdir);
  }

  /** Absolute paths of the per-agent skill dirs that link to the canonical dir for a scope. */
  agentLinkPaths(scope: LoomScope, workdir?: string): string[] {
    const base = this.paths.agentHome(scope, workdir);
    return this.agentSkillDirs.map(rel => path.join(base, rel));
  }

  /** Ensure the canonical dir exists and each agent skills dir symlinks to it. */
  ensureLinks(scope: LoomScope, workdir?: string): void {
    const canonical = this.canonicalDir(scope, workdir);
    fs.mkdirSync(canonical, { recursive: true });
    for (const link of this.agentLinkPaths(scope, workdir)) {
      try { ensureDirSymlink(link, canonical); }
      catch (e: any) { this.log?.(`[skills] link ${link} -> ${canonical} failed: ${e?.message || e}`); }
    }
  }

  /** List skills. scope 'all' (default) = workspace (if workdir) then global, project wins on name clash. */
  list(opts: { workdir?: string; scope?: LoomScope | 'all' } = {}): SkillInfo[] {
    const scope = opts.scope ?? 'all';
    const seen = new Set<string>();
    const out: SkillInfo[] = [];
    if ((scope === 'workspace' || scope === 'all') && opts.workdir) {
      out.push(...discoverSkillsFromDir(this.paths.skillsDir('workspace', opts.workdir), 'workspace', seen));
    }
    if (scope === 'global' || scope === 'all') {
      out.push(...discoverSkillsFromDir(this.paths.skillsDir('global'), 'global', seen));
    }
    return out;
  }

  /** Search installable skills on the npm registry (best-effort; [] on failure). */
  async search(query: string, limit = 20): Promise<SkillSearchResult[]> {
    const q = (query || '').trim();
    try {
      const hits = await searchNpmPackages(`agent skill ${q}`.trim(), Math.max(1, Math.min(50, limit)), fetch);
      return hits.map(h => ({
        name: h.name, description: h.description, source: 'npm',
        author: h.author, homepage: h.homepage, version: h.version,
      }));
    } catch (e: any) {
      this.log?.(`[skills] search failed: ${e?.message || e}`);
      return [];
    }
  }
}
