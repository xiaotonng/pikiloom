import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { STATE_DIR_NAME } from '../core/constants.js';

export interface SkillInstallOpts {
  global?: boolean;
  skill?: string;
  workdir?: string;
  sourceSha?: string | null;
  sourceNames?: string[];
}

export interface SkillInstallResult {
  ok: boolean;
  error?: string;
  output?: string;
}

export interface SkillRemoveResult {
  ok: boolean;
  error?: string;
}

const GLOBAL_SKILLS_DIR = path.join(os.homedir(), STATE_DIR_NAME, 'skills');
const INSTALL_TIMEOUT_MS = 60_000;
const REMOVE_TIMEOUT_MS = 10_000;

const SKILL_LEDGER_FILE = '.pikiloom-skills-ledger.json';

export interface SkillLedgerEntry {
  source: string;
  sha: string | null;
  installedAt: number;
  names?: string[];
}

interface SkillLedger {
  version: 1;
  entries: Record<string, SkillLedgerEntry>;
}

interface LedgerScope { global?: boolean; workdir?: string }

function ledgerPath(opts: LedgerScope): string | null {
  if (opts.global) return path.join(GLOBAL_SKILLS_DIR, SKILL_LEDGER_FILE);
  if (opts.workdir) return path.join(opts.workdir, STATE_DIR_NAME, 'skills', SKILL_LEDGER_FILE);
  return null;
}

export function normalizeSkillSourceKey(source: string): string {
  return String(source || '')
    .trim()
    .replace(/^https?:\/\/(www\.)?github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

function readLedger(opts: LedgerScope): SkillLedger {
  const p = ledgerPath(opts);
  if (!p) return { version: 1, entries: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf-8'));
    if (parsed && typeof parsed === 'object' && parsed.entries && typeof parsed.entries === 'object') {
      return { version: 1, entries: parsed.entries as Record<string, SkillLedgerEntry> };
    }
  } catch {  }
  return { version: 1, entries: {} };
}

function writeLedger(ledger: SkillLedger, opts: LedgerScope): void {
  const p = ledgerPath(opts);
  if (!p) return;
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(ledger, null, 2));
  } catch {  }
}

export function getSkillLedgerEntry(source: string, opts: LedgerScope): SkillLedgerEntry | null {
  const key = normalizeSkillSourceKey(source);
  if (!key) return null;
  return readLedger(opts).entries[key] || null;
}

export function recordSkillInstall(
  source: string,
  opts: LedgerScope & { sha?: string | null; names?: string[] },
): void {
  const key = normalizeSkillSourceKey(source);
  if (!key) return;
  const ledger = readLedger(opts);
  const prev = ledger.entries[key];
  ledger.entries[key] = {
    source: source.trim(),
    sha: opts.sha ?? prev?.sha ?? null,
    installedAt: Date.now(),
    names: opts.names && opts.names.length ? opts.names : prev?.names,
  };
  writeLedger(ledger, opts);
}

export function forgetSkillInstall(source: string, opts: LedgerScope): void {
  const key = normalizeSkillSourceKey(source);
  if (!key) return;
  const ledger = readLedger(opts);
  if (ledger.entries[key]) {
    delete ledger.entries[key];
    writeLedger(ledger, opts);
  }
}

function ensureGlobalSkillsDir(): void {
  fs.mkdirSync(GLOBAL_SKILLS_DIR, { recursive: true });
  for (const linkDir of [
    path.join(os.homedir(), '.claude', 'skills'),
    path.join(os.homedir(), '.agents', 'skills'),
  ]) {
    try {
      const stat = fs.lstatSync(linkDir);
      if (stat.isSymbolicLink()) {
        const real = fs.realpathSync(linkDir);
        if (real === fs.realpathSync(GLOBAL_SKILLS_DIR)) continue;
      }
      continue;
    } catch {
      try {
        fs.mkdirSync(path.dirname(linkDir), { recursive: true });
        fs.symlinkSync(GLOBAL_SKILLS_DIR, linkDir, 'dir');
      } catch {  }
    }
  }
}

function runNpx(args: string[], cwd: string, timeoutMs: number): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile('npx', args, {
      cwd,
      timeout: timeoutMs,
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
      shell: process.platform === 'win32',
    }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        stdout: stdout?.toString() || '',
        stderr: stderr?.toString() || '',
      });
    });
    child.unref?.();
  });
}

export async function installSkill(source: string, opts: SkillInstallOpts = {}): Promise<SkillInstallResult> {
  const { global: isGlobal, skill, workdir } = opts;

  if (!isGlobal && !workdir) {
    return { ok: false, error: 'workdir is required for project-scoped skill installation' };
  }

  const cwd = isGlobal ? os.homedir() : workdir!;
  const args = ['-y', 'skills', 'add', source, '--yes', '--agent', 'claude-code'];

  if (isGlobal) {
    args.push('-g');
    ensureGlobalSkillsDir();
  }

  if (skill) {
    args.push('-s', skill);
  }

  const result = await runNpx(args, cwd, INSTALL_TIMEOUT_MS);

  if (!result.ok) {
    const errorMsg = result.stderr.trim().split('\n').pop()?.trim() || 'installation failed';
    return { ok: false, error: errorMsg, output: result.stdout + result.stderr };
  }

  recordSkillInstall(source, {
    global: isGlobal,
    workdir,
    sha: opts.sourceSha ?? null,
    names: opts.sourceNames ?? (skill ? [skill] : undefined),
  });

  return { ok: true, output: result.stdout };
}

export function removeSkill(skillName: string, opts: { global?: boolean; workdir?: string } = {}): SkillRemoveResult {
  const { global: isGlobal, workdir } = opts;

  if (!isGlobal && !workdir) {
    return { ok: false, error: 'workdir is required for project-scoped skill removal' };
  }

  const sanitized = path.basename(skillName);
  if (!sanitized || sanitized === '.' || sanitized === '..' || sanitized !== skillName) {
    return { ok: false, error: 'invalid skill name' };
  }

  const parentDir = isGlobal
    ? GLOBAL_SKILLS_DIR
    : path.join(workdir!, STATE_DIR_NAME, 'skills');
  const skillDir = path.join(parentDir, sanitized);

  const realParent = path.resolve(parentDir);
  const realSkill = path.resolve(skillDir);
  if (!realSkill.startsWith(realParent + path.sep)) {
    return { ok: false, error: 'invalid skill path' };
  }

  try {
    if (!fs.existsSync(skillDir)) {
      return { ok: false, error: `skill "${sanitized}" not found` };
    }
    fs.rmSync(skillDir, { recursive: true, force: true });
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message || 'removal failed' };
  }
}

export function getGlobalSkillsDir(): string {
  return GLOBAL_SKILLS_DIR;
}

export async function checkSkillUpdates(opts: { global?: boolean; workdir?: string } = {}): Promise<SkillInstallResult> {
  const cwd = opts.global ? os.homedir() : (opts.workdir || process.cwd());
  const args = ['-y', 'skills', 'check'];
  if (opts.global) args.push('-g');
  return runNpx(args, cwd, INSTALL_TIMEOUT_MS).then(r => ({
    ok: r.ok,
    output: r.stdout,
    error: r.ok ? undefined : r.stderr,
  }));
}
