/**
 * Unit coverage for the shared git-status helper (#28). Both the IM /status
 * command and the Dashboard workspace view render from this single source, so
 * the porcelain-v2 parser and the friendly one-line formatter are pinned here.
 */
import { describe, expect, it } from 'vitest';
import { parseGitStatusV2, formatGitStatusLine } from '../src/core/git.ts';

describe('parseGitStatusV2', () => {
  it('parses a clean branch tracking a remote', () => {
    const out = [
      '# branch.oid 1111111111111111111111111111111111111111',
      '# branch.head main',
      '# branch.upstream origin/main',
      '# branch.ab +0 -0',
    ].join('\n');
    const g = parseGitStatusV2(out);
    expect(g.branch).toBe('main');
    expect(g.detached).toBe(false);
    expect(g.upstream).toBe('origin/main');
    expect(g.ahead).toBe(0);
    expect(g.behind).toBe(0);
    expect(g.changed).toBe(0);
  });

  it('counts staged / unstaged / untracked and ahead-behind', () => {
    const out = [
      '# branch.oid 2222222222222222222222222222222222222222',
      '# branch.head feature/x',
      '# branch.upstream origin/feature/x',
      '# branch.ab +2 -1',
      '1 M. N... 100644 100644 100644 aaa bbb staged.txt',
      '1 .M N... 100644 100644 100644 aaa bbb unstaged.txt',
      '1 MM N... 100644 100644 100644 aaa bbb both.txt',
      'u UU N... 100644 100644 100644 100644 aaa bbb ccc conflict.txt',
      '? untracked.txt',
    ].join('\n');
    const g = parseGitStatusV2(out);
    expect(g.ahead).toBe(2);
    expect(g.behind).toBe(1);
    expect(g.staged).toBe(2); // M. + MM
    expect(g.unstaged).toBe(3); // .M + MM + conflict (u)
    expect(g.untracked).toBe(1);
    expect(g.changed).toBe(6);
  });

  it('handles a detached HEAD', () => {
    const out = [
      '# branch.oid a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0',
      '# branch.head (detached)',
    ].join('\n');
    const g = parseGitStatusV2(out);
    expect(g.detached).toBe(true);
    expect(g.branch).toBeNull();
    expect(g.shortSha).toBe('a1b2c3d');
    expect(g.upstream).toBeNull();
  });

  it('handles a local branch with no upstream', () => {
    const out = ['# branch.oid 3333333333333333333333333333333333333333', '# branch.head local-only'].join('\n');
    const g = parseGitStatusV2(out);
    expect(g.branch).toBe('local-only');
    expect(g.upstream).toBeNull();
    expect(g.ahead).toBe(0);
    expect(g.behind).toBe(0);
  });
});

describe('formatGitStatusLine', () => {
  it('returns null for no status', () => {
    expect(formatGitStatusLine(null)).toBeNull();
    expect(formatGitStatusLine(undefined)).toBeNull();
  });

  it('renders a clean tracked branch', () => {
    const line = formatGitStatusLine({
      branch: 'main', detached: false, shortSha: null, upstream: 'origin/main',
      ahead: 0, behind: 0, staged: 0, unstaged: 0, untracked: 0, changed: 0,
    });
    expect(line).toBe('main  ·  clean');
  });

  it('renders ahead/behind with a change breakdown', () => {
    const line = formatGitStatusLine({
      branch: 'feature/x', detached: false, shortSha: null, upstream: 'origin/feature/x',
      ahead: 2, behind: 1, staged: 3, unstaged: 0, untracked: 2, changed: 5,
    });
    expect(line).toBe('feature/x  ↑2 ↓1  ·  5 changed (3 staged · 2 untracked)');
  });

  it('flags a local branch with no upstream', () => {
    const line = formatGitStatusLine({
      branch: 'local-only', detached: false, shortSha: null, upstream: null,
      ahead: 0, behind: 0, staged: 0, unstaged: 0, untracked: 0, changed: 0,
    });
    expect(line).toBe('local-only  ·  no upstream  ·  clean');
  });

  it('labels a detached HEAD without a no-upstream note', () => {
    const line = formatGitStatusLine({
      branch: null, detached: true, shortSha: 'a1b2c3d', upstream: null,
      ahead: 0, behind: 0, staged: 0, unstaged: 1, untracked: 0, changed: 1,
    });
    expect(line).toBe('(detached a1b2c3d)  ·  1 changed (1 unstaged)');
  });
});
