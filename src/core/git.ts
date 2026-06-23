import { spawnSync } from 'node:child_process';

import { GIT_STATUS_TIMEOUT_MS } from './constants.js';

export interface GitStatus {
  branch: string | null;
  detached: boolean;
  shortSha: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: number;
  unstaged: number;
  untracked: number;
  changed: number;
}

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
      const xy = line.split(' ')[1] || '..';
      if (xy[0] && xy[0] !== '.') staged++;
      if (xy[1] && xy[1] !== '.') unstaged++;
    } else if (line.startsWith('u ')) {
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
