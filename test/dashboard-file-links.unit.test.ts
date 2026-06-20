import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { isFileLocator, splitTextFileLinks } from '../dashboard/src/pages/sessions/markdown.tsx';
import { resolveOpenPathLocator } from '../src/dashboard/routes/config.ts';
import { makeTmpDir } from './support/env.ts';

describe('dashboard file link parsing', () => {
  it('recognizes relative paths, line suffixes, and single file names', () => {
    expect(isFileLocator('dashboard/src/pages/sessions/markdown.tsx:42')).toBe(true);
    expect(isFileLocator('./src/dashboard/routes/config.ts:12:3')).toBe(true);
    expect(isFileLocator('package.json')).toBe(true);
    expect(isFileLocator('AGENTS.md')).toBe(true);

    expect(isFileLocator('https://example.com/file.ts')).toBe(false);
    expect(isFileLocator('github.com/openai')).toBe(false);
    expect(isFileLocator('v0.4.15')).toBe(false);
  });

  it('splits bare file paths without swallowing punctuation', () => {
    const parts = splitTextFileLinks('Updated dashboard/src/api.ts:392, package.json and src/dashboard/routes/config.ts.');

    expect(parts).toEqual([
      { kind: 'text', text: 'Updated ' },
      { kind: 'file', text: 'dashboard/src/api.ts:392' },
      { kind: 'text', text: ', ' },
      { kind: 'file', text: 'package.json' },
      { kind: 'text', text: ' and ' },
      { kind: 'file', text: 'src/dashboard/routes/config.ts' },
      { kind: 'text', text: '.' },
    ]);
  });
});

describe('dashboard open path resolution', () => {
  it('resolves relative paths against the session workdir and preserves line/column', () => {
    const workdir = makeTmpDir('dash-open-path-');
    const file = path.join(workdir, 'src', 'app.ts');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'export const ok = true;\n');

    expect(resolveOpenPathLocator('src/app.ts:7:2', workdir)).toEqual({
      filePath: file,
      line: 7,
      column: 2,
    });
  });

  it('resolves single file names relative to the session workdir', () => {
    const workdir = makeTmpDir('dash-open-file-');
    const file = path.join(workdir, 'package.json');
    fs.writeFileSync(file, '{}\n');

    expect(resolveOpenPathLocator('package.json', workdir)).toEqual({
      filePath: file,
      line: null,
      column: null,
    });
  });
});
