/**
 * Git working-tree status as a cross-platform OS primitive.
 *
 * One bounded `git status --porcelain=v2 --branch` invocation, parsed into a
 * structured {@link GitStatus}. Porcelain v2 is machine-stable across git
 * versions and locales, so we count entry lines rather than scraping human
 * output. A single reader feeds both the IM `/status` command and the Dashboard
 * workspace view — no git logic is duplicated in the channels or the SPA.
 */

import { spawnSync } from 'node:child_process';

import { GIT_STATUS_TIMEOUT_MS } from './constants.js';

export interface GitStatus {
  /** Current branch, or `null` when HEAD is detached. */
  branch: string | null;
  /** True when HEAD is detached (no branch checked out). */
  detached: boolean;
  /** Short HEAD sha — primarily useful to label the detached case. */
  shortSha: string | null;
  /** Upstream tracking ref (e.g. `origin/main`), or `null` when none is set. */
  upstream: string | null;
  /** Commits ahead of the upstream. 0 when no upstream. */
  ahead: number;
  /** Commits behind the upstream. 0 when no upstream. */
  behind: number;
  /** Files with staged (index) changes. */
  staged: number;
  /** Tracked files with unstaged (working-tree) changes, including conflicts. */
  unstaged: number;
  /** Untracked files. */
  untracked: number;
  /** Headline count: staged + unstaged + untracked. 0 means a clean tree. */
  changed: number;
}

/**
 * Read the git status of `dir`. Returns `null` for a non-repo, a missing git
 * binary, or a timeout — callers simply omit the git section. Never throws.
 *
 * Walks up from `dir` like git itself, so a workspace nested below the repo root
 * is still recognised. Uses `GIT_OPTIONAL_LOCKS=0` to avoid contending with
 * other git processes for the index lock.
 */
export function readGitStatus(dir: string): GitStatus | null {
  if (!dir) return null;
  try {
    const result = spawnSync('git', ['status', '--porcelain=v2', '--branch', '--untracked-files=normal'], {
      cwd: dir,
      timeout: GIT_STATUS_TIMEOUT_MS,
      encoding: 'utf-8',
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    });
    if (result.error || result.status !== 0 || typeof result.stdout !== 'string') return null;
    return parseGitStatusV2(result.stdout);
  } catch {
    return null;
  }
}

/** Parse `git status --porcelain=v2 --branch` output. Exported for testing. */
export function parseGitStatusV2(stdout: string): GitStatus {
  let branch: string | null = null;
  let detached = false;
  let shortSha: string | null = null;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;

  for (const line of stdout.split('\n')) {
    if (!line) continue;
    if (line.startsWith('# branch.head ')) {
      const value = line.slice('# branch.head '.length).trim();
      if (value === '(detached)') {
        detached = true;
        branch = null;
      } else {
        branch = value;
      }
    } else if (line.startsWith('# branch.oid ')) {
      const value = line.slice('# branch.oid '.length).trim();
      if (value && value !== '(initial)') shortSha = value.slice(0, 7);
    } else if (line.startsWith('# branch.upstream ')) {
      upstream = line.slice('# branch.upstream '.length).trim() || null;
    } else if (line.startsWith('# branch.ab ')) {
      const m = line.match(/\+(\d+)\s+-(\d+)/);
      if (m) {
        ahead = parseInt(m[1], 10);
        behind = parseInt(m[2], 10);
      }
    } else if (line.startsWith('1 ') || line.startsWith('2 ')) {
      // Ordinary / renamed entry: field 2 is the XY status (X=index, Y=worktree).
      const xy = line.split(' ')[1] || '..';
      if (xy[0] && xy[0] !== '.') staged++;
      if (xy[1] && xy[1] !== '.') unstaged++;
    } else if (line.startsWith('u ')) {
      // Unmerged (conflict) — count as a working-tree change.
      unstaged++;
    } else if (line.startsWith('? ')) {
      untracked++;
    }
  }

  return {
    branch,
    detached,
    shortSha,
    upstream,
    ahead,
    behind,
    staged,
    unstaged,
    untracked,
    changed: staged + unstaged + untracked,
  };
}

/**
 * Render a {@link GitStatus} into a single friendly line (no channel-specific
 * markup), e.g.:
 *
 *   main  ↑2 ↓1  ·  5 changed (3 staged · 2 untracked)
 *   feature/x  ·  no upstream  ·  clean
 *   (detached a1b2c3d)  ·  1 changed
 *
 * Returns `null` when there is no git status to show, so callers can omit the
 * line entirely.
 */
export function formatGitStatusLine(git: GitStatus | null | undefined): string | null {
  if (!git) return null;

  const head = git.detached
    ? `(detached${git.shortSha ? ` ${git.shortSha}` : ''})`
    : git.branch || '(unknown)';

  let lead = head;
  if (git.ahead || git.behind) {
    const ab = [git.ahead ? `↑${git.ahead}` : '', git.behind ? `↓${git.behind}` : '']
      .filter(Boolean)
      .join(' ');
    lead += `  ${ab}`;
  }

  const segments = [lead];
  if (!git.detached && !git.upstream) segments.push('no upstream');

  if (git.changed > 0) {
    const detail = [
      git.staged ? `${git.staged} staged` : '',
      git.unstaged ? `${git.unstaged} unstaged` : '',
      git.untracked ? `${git.untracked} untracked` : '',
    ].filter(Boolean);
    segments.push(`${git.changed} changed${detail.length ? ` (${detail.join(' · ')})` : ''}`);
  } else {
    segments.push('clean');
  }

  return segments.join('  ·  ');
}
