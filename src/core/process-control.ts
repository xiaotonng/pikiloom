import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { pathContainsSegment } from './platform.js';
import { STATE_DIR_NAME } from './constants.js';

export const PROCESS_RESTART_EXIT_CODE = 75;
export const PROCESS_RESTART_STATE_FILE_ENV = 'PIKILOOM_RESTART_STATE_FILE';

const DAEMON_PID_FILENAME = 'pikiloom.pid';

export function getDaemonPidFilePath(): string {
  return path.join(os.homedir(), STATE_DIR_NAME, DAEMON_PID_FILENAME);
}

export function writeDaemonPidFile(pid: number = process.pid): void {
  const filePath = getDaemonPidFilePath();
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, String(pid), 'utf8');
  } catch {}
}

export function clearDaemonPidFile(): void {
  try { fs.unlinkSync(getDaemonPidFilePath()); } catch {}
}

export function readDaemonPidFile(): number | null {
  try {
    const raw = fs.readFileSync(getDaemonPidFilePath(), 'utf8').trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function isProcessAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    return code === 'EPERM';
  }
}

interface RestartStateFile {
  version: 1;
  env: Record<string, string>;
}

export interface ProcessRuntimeRegistration {
  label?: string;
  prepareForRestart?: () => void | Promise<void>;
  buildRestartEnv?: () => Record<string, string>;
}

export interface ProcessRestartResult {
  ok: boolean;
  restarting: boolean;
  error: string | null;
}

interface ProcessRestartOptions {
  argv?: string[];
  restartCmd?: string;
  log?: (message: string) => void;
  exit?: (code?: number) => never | void;
}

const runtimes = new Map<number, ProcessRuntimeRegistration>();
let nextRuntimeId = 1;
let restartInFlight = false;

export function shellSplit(str: string): string[] {
  const args: string[] = [];
  let cur = '';
  let inSingle = false;
  let inDouble = false;
  for (const ch of str) {
    if (ch === '\'' && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (ch === ' ' && !inSingle && !inDouble) {
      if (cur) args.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur) args.push(cur);
  return args;
}

function isNpxBinary(bin: string): boolean {
  return path.basename(bin, path.extname(bin)).toLowerCase() === 'npx';
}

export function ensureNonInteractiveRestartArgs(bin: string, args: string[]): string[] {
  if (!isNpxBinary(bin)) return args;
  if (args.includes('--yes') || args.includes('-y')) return args;
  return ['--yes', ...args];
}

export function getDefaultRestartCmd(): string {
  const argv0 = process.argv[0] ?? '';
  const argv1 = process.argv[1] ?? '';
  if (argv1.endsWith('.ts') || pathContainsSegment(argv1, 'tsx') || pathContainsSegment(argv1, 'ts-node')) {
    const isTsxLoader = !pathContainsSegment(argv0, 'tsx')
      && process.execArgv?.some(arg => arg.includes('tsx'));
    const parts = isTsxLoader ? ['tsx', argv1] : process.argv.slice(0, 2);
    return parts.map(arg => arg.includes(' ') ? `"${arg}"` : arg).join(' ');
  }
  if (argv1.endsWith('.js') && (argv1.includes('pikiloom') || argv1.includes('pikiloom'))) {
    const nodeBin = argv0.includes(' ') ? `"${argv0}"` : argv0;
    const entry = argv1.includes(' ') ? `"${argv1}"` : argv1;
    return `${nodeBin} ${entry}`;
  }
  return 'npx --yes pikiloom@latest';
}

export function buildRestartCommand(argv: string[], restartCmd = process.env.PIKILOOM_RESTART_CMD || getDefaultRestartCmd()) {
  const [bin, ...rawArgs] = shellSplit(restartCmd);
  return {
    bin,
    args: [...ensureNonInteractiveRestartArgs(bin, rawArgs), ...argv],
  };
}

export function registerProcessRuntime(runtime: ProcessRuntimeRegistration): () => void {
  const id = nextRuntimeId++;
  runtimes.set(id, runtime);
  return () => {
    runtimes.delete(id);
  };
}

export function getRegisteredRuntimeCount(): number {
  return runtimes.size;
}

function readProcessParentMap(): Map<number, number[]> {
  const children = new Map<number, number[]>();
  try {
    const rows: Array<{ pid: number; ppid: number }> = [];
    if (process.platform === 'win32') {
      const out = execFileSync('wmic', ['process', 'get', 'ParentProcessId,ProcessId'], { encoding: 'utf8', windowsHide: true });
      for (const line of out.split(/\r?\n/)) {
        const m = line.trim().match(/^(\d+)\s+(\d+)$/);
        if (m) rows.push({ ppid: Number(m[1]), pid: Number(m[2]) });
      }
    } else {
      const out = execFileSync('ps', ['-Ao', 'pid=,ppid='], { encoding: 'utf8' });
      for (const line of out.split('\n')) {
        const m = line.trim().match(/^(\d+)\s+(\d+)$/);
        if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]) });
      }
    }
    for (const { pid, ppid } of rows) {
      const list = children.get(ppid);
      if (list) list.push(pid);
      else children.set(ppid, [pid]);
    }
  } catch {}
  return children;
}

function collectDescendantPids(rootPid: number): number[] {
  const children = readProcessParentMap();
  const descendants: number[] = [];
  const seen = new Set<number>([rootPid]);
  const stack = [rootPid];
  while (stack.length) {
    const current = stack.pop() as number;
    for (const child of children.get(current) || []) {
      if (seen.has(child)) continue;
      seen.add(child);
      descendants.push(child);
      stack.push(child);
    }
  }
  return descendants;
}

export async function killChildProcesses(rootPid = process.pid, opts: { graceMs?: number; log?: (message: string) => void } = {}): Promise<number> {
  const pids = collectDescendantPids(rootPid);
  if (!pids.length) return 0;
  opts.log?.(`restart: terminating ${pids.length} child process(es) before restart`);
  for (const pid of pids) {
    try { process.kill(pid, 'SIGTERM'); } catch {}
  }
  const graceMs = opts.graceMs ?? 1500;
  if (graceMs > 0) await new Promise(resolve => setTimeout(resolve, graceMs));
  for (const pid of pids) {
    if (isProcessAlive(pid)) {
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
  }
  return pids.length;
}

export function createRestartStateFilePath(ownerPid = process.pid): string {
  const dir = path.join(os.tmpdir(), 'pikiloom');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `restart-${ownerPid}.json`);
}

export function clearRestartStateFile(filePath: string | null | undefined): void {
  if (!filePath) return;
  try { fs.unlinkSync(filePath); } catch {}
}

export function writeRestartStateFile(filePath: string, env: Record<string, string>): void {
  const payload: RestartStateFile = { version: 1, env };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload), 'utf8');
}

export function consumeRestartStateFile(filePath: string | null | undefined): Record<string, string> {
  if (!filePath) return {};
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as RestartStateFile;
    if (parsed?.version !== 1 || !parsed.env || typeof parsed.env !== 'object') return {};
    return Object.fromEntries(
      Object.entries(parsed.env)
        .filter((entry): entry is [string, string] => typeof entry[0] === 'string' && typeof entry[1] === 'string')
        .map(([key, value]) => [key, value.trim()]),
    );
  } catch {
    return {};
  } finally {
    clearRestartStateFile(filePath);
  }
}

function mergeEnvValues(target: Record<string, string>, patch: Record<string, string>) {
  for (const [key, rawValue] of Object.entries(patch)) {
    const value = rawValue.trim();
    if (!value) continue;
    if (!target[key]) {
      target[key] = value;
      continue;
    }
    const merged = new Set([
      ...target[key].split(',').map(item => item.trim()).filter(Boolean),
      ...value.split(',').map(item => item.trim()).filter(Boolean),
    ]);
    target[key] = [...merged].join(',');
  }
}

function collectRestartEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const runtime of runtimes.values()) {
    const patch = runtime.buildRestartEnv?.() || {};
    mergeEnvValues(env, patch);
  }
  return env;
}

async function prepareRuntimesForRestart(log?: (message: string) => void) {
  for (const runtime of [...runtimes.values()]) {
    const label = runtime.label ? `${runtime.label}: ` : '';
    try {
      await runtime.prepareForRestart?.();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log?.(`restart cleanup failed (${label}${message})`);
    }
  }
}

function buildRestartEnvForSpawn(extraEnv: Record<string, string>) {
  const env = {
    ...process.env,
    ...extraEnv,
    npm_config_yes: process.env.npm_config_yes || 'true',
  } as Record<string, string>;
  delete env.PIKILOOM_DAEMON_CHILD;
  delete env[PROCESS_RESTART_STATE_FILE_ENV];
  return env;
}

function spawnReplacementProcess(bin: string, args: string[], env: Record<string, string>, log?: (message: string) => void) {
  const needsShell = process.platform === 'win32' && !bin.endsWith('node.exe');
  const child = spawn(needsShell ? `"${bin}"` : bin, args, {
    stdio: 'inherit',
    detached: true,
    shell: needsShell || undefined,
    env,
    cwd: process.cwd(),
  });
  child.unref();
  log?.(`restart: new process spawned (PID ${child.pid})`);
  return child;
}

export async function requestProcessRestart(opts: ProcessRestartOptions = {}): Promise<ProcessRestartResult> {
  if (restartInFlight) {
    return { ok: true, restarting: true, error: null };
  }

  restartInFlight = true;
  const log = opts.log;
  const exit = opts.exit || process.exit;

  try {
    const extraEnv = collectRestartEnv();
    await prepareRuntimesForRestart(log);
    await killChildProcesses(process.pid, { log });

    if (process.env.PIKILOOM_DAEMON_CHILD === '1') {
      const restartStateFile = process.env[PROCESS_RESTART_STATE_FILE_ENV];
      if (restartStateFile) {
        if (Object.keys(extraEnv).length) writeRestartStateFile(restartStateFile, extraEnv);
        else clearRestartStateFile(restartStateFile);
      }
      log?.('restart: handing off to daemon supervisor');
      exit(PROCESS_RESTART_EXIT_CODE);
      return { ok: true, restarting: true, error: null };
    }

    const { bin, args } = buildRestartCommand(opts.argv || process.argv.slice(2), opts.restartCmd);
    log?.(`restart: spawning \`${bin} ${args.join(' ')}\``);
    spawnReplacementProcess(bin, args, buildRestartEnvForSpawn(extraEnv), log);
    exit(0);
    return { ok: true, restarting: true, error: null };
  } catch (err) {
    restartInFlight = false;
    return { ok: false, restarting: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface TerminateProcessTreeOptions {
  signal?: NodeJS.Signals | number;
  forceSignal?: NodeJS.Signals | number | null;
  forceAfterMs?: number;
}

export function terminateProcessTree(target: ChildProcess | { pid?: number | undefined } | number | null | undefined, opts: TerminateProcessTreeOptions = {}) {
  const pid = typeof target === 'number' ? target : target?.pid;
  if (!pid || pid <= 0) return;

  const signal = opts.signal ?? 'SIGTERM';
  const forceSignal = opts.forceSignal ?? null;
  const forceAfterMs = opts.forceAfterMs ?? 0;

  const killPid = (targetPid: number, nextSignal: NodeJS.Signals | number) => {
    try {
      if (process.platform === 'win32') {
        const args = ['/pid', String(targetPid), '/t'];
        if (nextSignal === 'SIGKILL') args.push('/f');
        const killer = spawn('taskkill', args, { stdio: 'ignore', windowsHide: true });
        killer.unref();
        return;
      }
      process.kill(-targetPid, nextSignal);
    } catch {
      try { process.kill(targetPid, nextSignal); } catch {}
    }
  };

  killPid(pid, signal);

  if (forceSignal == null || forceAfterMs <= 0 || forceSignal === signal) return;
  const timer = setTimeout(() => killPid(pid, forceSignal), forceAfterMs);
  timer.unref?.();
}
