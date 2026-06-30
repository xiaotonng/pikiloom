import os from 'node:os';
import path from 'node:path';

// ---- The top-level directory ("顶级目录") ----
//
// One explicitly-configurable root governs where the kernel keeps its session index,
// skills registry and per-agent symlinks. It resolves in two scopes:
//   - global:    ~/.<stateDirName>            (default ~/.pikiloom)
//   - workspace: <workdir>/.<stateDirName>    (default <workdir>/.pikiloom)
//
// The name defaults to 'pikiloom' (so the dotted dir is `.pikiloom`) and is overridable
// per Loom via `createLoom({ stateDirName })`. Everything else (sessions, skills, mcp
// config, native-agent symlinks) is derived from this one knob so a consuming app gets a
// single, unified directory to manage — the same model pikiloom itself uses.

export type LoomScope = 'global' | 'workspace';

export interface LoomPaths {
  /** The bare name (no leading dot), e.g. 'pikiloom'. */
  readonly stateDirName: string;
  /** The dotted directory name, e.g. '.pikiloom'. */
  readonly dirName: string;
  readonly home: string;
  /** ~/.<stateDirName> */
  readonly globalRoot: string;
  /** <workdir>/.<stateDirName> */
  workspaceRoot(workdir: string): string;
  /** The root for a scope (workspace requires a workdir). */
  root(scope: LoomScope, workdir?: string): string;
  /** <root>/sessions */
  sessionsDir(scope: LoomScope, workdir?: string): string;
  /** <root>/skills — the canonical skills registry that agent dirs symlink to. */
  skillsDir(scope: LoomScope, workdir?: string): string;
  /** <root>/mcp.json — the unified MCP server config for a scope. */
  mcpConfigPath(scope: LoomScope, workdir?: string): string;
  /**
   * The base under which an agent keeps its own dotfiles for a scope:
   *   global    -> ~        (so ~/.claude, ~/.agents)
   *   workspace -> <workdir> (so <workdir>/.claude, <workdir>/.agents)
   * Used to resolve symlink targets for native agents.
   */
  agentHome(scope: LoomScope, workdir?: string): string;
}

/** Normalize a state dir name to its bare form: strip a leading dot, trim. */
export function normalizeStateDirName(name: string | null | undefined): string {
  const trimmed = (name ?? '').trim().replace(/^\.+/, '');
  return trimmed || 'pikiloom';
}

export function resolveLoomPaths(opts: { stateDirName?: string | null; home?: string } = {}): LoomPaths {
  const stateDirName = normalizeStateDirName(opts.stateDirName);
  const dirName = `.${stateDirName}`;
  const home = opts.home || os.homedir();
  const globalRoot = path.join(home, dirName);

  const workspaceRoot = (workdir: string): string => path.join(path.resolve(workdir), dirName);
  const root = (scope: LoomScope, workdir?: string): string => {
    if (scope === 'global') return globalRoot;
    if (!workdir) throw new Error('workspace scope requires a workdir');
    return workspaceRoot(workdir);
  };
  const agentHome = (scope: LoomScope, workdir?: string): string => {
    if (scope === 'global') return home;
    if (!workdir) throw new Error('workspace scope requires a workdir');
    return path.resolve(workdir);
  };

  return {
    stateDirName,
    dirName,
    home,
    globalRoot,
    workspaceRoot,
    root,
    agentHome,
    sessionsDir: (scope, workdir) => path.join(root(scope, workdir), 'sessions'),
    skillsDir: (scope, workdir) => path.join(root(scope, workdir), 'skills'),
    mcpConfigPath: (scope, workdir) => path.join(root(scope, workdir), 'mcp.json'),
  };
}
