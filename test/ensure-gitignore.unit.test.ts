import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureGitignore } from '../src/core/utils.js';

describe('ensureGitignore', () => {
  let dir: string;
  let gi: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikiloom-gi-'));
    gi = path.join(dir, '.gitignore');
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('does nothing when there is no .gitignore', () => {
    ensureGitignore(dir);
    expect(fs.existsSync(gi)).toBe(false);
  });

  it('leaves the file byte-for-byte unchanged when managed lines already present, even below user rules', () => {
    const content = [
      'node_modules/',
      '.pikiloom/*',
      '!.pikiloom/skills/',
      '!.pikiloom/skills/**',
      '',
      'products/eval-studio/package-lock.json',
      '',
    ].join('\n');
    fs.writeFileSync(gi, content);
    ensureGitignore(dir);
    // Regression: must NOT relocate its own block to the end (which shuffled the
    // user's trailing rule above it on every run).
    expect(fs.readFileSync(gi, 'utf8')).toBe(content);
  });

  it('preserves blank lines', () => {
    const content = 'node_modules/\n\n.pikiloom/*\n!.pikiloom/skills/\n!.pikiloom/skills/**\n';
    fs.writeFileSync(gi, content);
    ensureGitignore(dir);
    expect(fs.readFileSync(gi, 'utf8')).toBe(content);
  });

  it('appends missing managed lines without disturbing existing content', () => {
    fs.writeFileSync(gi, 'node_modules/\n');
    ensureGitignore(dir);
    const out = fs.readFileSync(gi, 'utf8');
    expect(out.startsWith('node_modules/\n')).toBe(true);
    expect(out).toContain('.pikiloom/*');
    expect(out).toContain('!.pikiloom/skills/');
    expect(out).toContain('!.pikiloom/skills/**');
  });

  it('removes legacy lines while keeping managed ones in place', () => {
    fs.writeFileSync(gi, '.pikiloom/\n.claude/skills/\n.pikiloom/*\n!.pikiloom/skills/\n!.pikiloom/skills/**\n');
    ensureGitignore(dir);
    const out = fs.readFileSync(gi, 'utf8').split('\n');
    expect(out).not.toContain('.pikiloom/');
    expect(out).not.toContain('.claude/skills/');
    expect(out.filter(l => l === '.pikiloom/*')).toHaveLength(1);
  });

  it('is idempotent across repeated runs', () => {
    fs.writeFileSync(gi, 'node_modules/\nproducts/eval-studio/package-lock.json\n');
    ensureGitignore(dir);
    const first = fs.readFileSync(gi, 'utf8');
    ensureGitignore(dir);
    const second = fs.readFileSync(gi, 'utf8');
    expect(second).toBe(first);
  });
});
