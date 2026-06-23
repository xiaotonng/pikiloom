import os from 'node:os';
import path from 'node:path';
import which from 'which';

export const IS_WIN = process.platform === 'win32';
export const IS_MAC = process.platform === 'darwin';
export const IS_LINUX = process.platform === 'linux';

export function getHome(): string {
  return os.homedir();
}

export function expandTilde(p: string): string {
  if (!p || p[0] !== '~') return p;
  const home = getHome();
  if (p === '~') return home;
  if (p.startsWith('~/') || (IS_WIN && p.startsWith('~\\'))) {
    return path.join(home, p.slice(2));
  }
  return p;
}

export function whichSync(cmd: string): string | null {
  return which.sync(cmd, { nothrow: true }) || null;
}

export function encodePathAsDirName(p: string): string {
  return p.replace(/[^a-zA-Z0-9]/g, '-');
}

export function pathContainsSegment(p: string, segment: string): boolean {
  const escaped = segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`[\\\\/]${escaped}([\\\\/]|$)`).test(p);
}

export const DEV_NULL_REDIRECT = IS_WIN ? '2>nul' : '2>/dev/null';
