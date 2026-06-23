import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { importFilesIntoWorkspace } from '../src/agent/session';

describe('importFilesIntoWorkspace', () => {
  const cleanup: string[] = [];
  afterEach(() => {
    for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true });
    cleanup.length = 0;
  });

  it('recognizes an in-workspace file referenced via a symlinked path (no re-copy)', () => {
    const realRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'imp-real-'));
    cleanup.push(realRoot);
    const ws = path.join(realRoot, 'workspace');
    fs.mkdirSync(ws);
    fs.writeFileSync(path.join(ws, 'pic.png'), 'imgdata');

    const linkRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'imp-link-'));
    cleanup.push(linkRoot);
    const wsViaLink = path.join(linkRoot, 'ws-link');
    fs.symlinkSync(ws, wsViaLink);

    const result = importFilesIntoWorkspace(wsViaLink, [path.join(wsViaLink, 'pic.png')]);

    expect(result).toEqual(['pic.png']);
    expect(fs.readdirSync(ws).filter(f => f.endsWith('.png'))).toEqual(['pic.png']);
  });

  it('still copies a genuinely external file into the workspace', () => {
    const realRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'imp-ext-'));
    cleanup.push(realRoot);
    const ws = path.join(realRoot, 'workspace');
    fs.mkdirSync(ws);
    const outside = path.join(realRoot, 'outside.png');
    fs.writeFileSync(outside, 'imgdata');

    const result = importFilesIntoWorkspace(ws, [outside]);

    expect(result).toEqual(['outside.png']);
    expect(fs.existsSync(path.join(ws, 'outside.png'))).toBe(true);
  });
});
