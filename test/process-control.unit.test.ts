import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.fn(() => ({ pid: 4321, unref: vi.fn() }));
const execFileSyncMock = vi.fn(() => '');

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: spawnMock,
    execFileSync: execFileSyncMock,
  };
});

const ORIGINAL_ENV = { ...process.env };

async function loadModule() {
  return import('../src/core/process-control.ts');
}

function resetEnv() {
  process.env = { ...ORIGINAL_ENV };
  delete process.env.PIKILOOM_DAEMON_CHILD;
  delete process.env.PIKILOOM_RESTART_STATE_FILE;
  delete process.env.PIKILOOM_RESTART_CMD;
  delete process.env.TELEGRAM_ALLOWED_CHAT_IDS;
  delete process.env.FEISHU_ALLOWED_CHAT_IDS;
  delete process.env.npm_config_yes;
}

beforeEach(() => {
  vi.resetModules();
  spawnMock.mockReset();
  spawnMock.mockReturnValue({ pid: 4321, unref: vi.fn() } as any);
  execFileSyncMock.mockReset();
  execFileSyncMock.mockReturnValue('');
  resetEnv();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('process-control restart flow', () => {
  it('restarts without consulting task counts and hands off to the supervisor in daemon mode', async () => {
    const mod = await loadModule();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikiloom-restart-'));
    const stateFile = path.join(tmpDir, 'restart.json');
    process.env.PIKILOOM_DAEMON_CHILD = '1';
    process.env.PIKILOOM_RESTART_STATE_FILE = stateFile;

    const cleanupSpy = vi.fn();
    const unregister = mod.registerProcessRuntime({
      label: 'telegram',
      prepareForRestart: cleanupSpy,
      buildRestartEnv: () => ({ TELEGRAM_ALLOWED_CHAT_IDS: '1001,1002' }),
    });
    const exitSpy = vi.fn();

    try {
      const result = await mod.requestProcessRestart({ exit: exitSpy as any });
      expect(result.ok).toBe(true);
      expect(result.restarting).toBe(true);
      expect(cleanupSpy).toHaveBeenCalledTimes(1);
      expect(exitSpy).toHaveBeenCalledWith(mod.PROCESS_RESTART_EXIT_CODE);
      expect(spawnMock).not.toHaveBeenCalled();
      expect(mod.consumeRestartStateFile(stateFile)).toEqual({
        TELEGRAM_ALLOWED_CHAT_IDS: '1001,1002',
      });
    } finally {
      unregister();
    }
  });

  it('spawns a replacement process in no-daemon mode', async () => {
    const mod = await loadModule();
    const cleanupSpy = vi.fn();
    const unregisterTelegram = mod.registerProcessRuntime({
      label: 'telegram',
      prepareForRestart: cleanupSpy,
      buildRestartEnv: () => ({ TELEGRAM_ALLOWED_CHAT_IDS: '1001' }),
    });
    const unregisterFeishu = mod.registerProcessRuntime({
      label: 'feishu',
      buildRestartEnv: () => ({ FEISHU_ALLOWED_CHAT_IDS: 'ou_abc' }),
    });
    const exitSpy = vi.fn();

    try {
      const result = await mod.requestProcessRestart({
        argv: ['--no-daemon', '-c', 'telegram'],
        restartCmd: 'npx tsx src/cli.ts',
        exit: exitSpy as any,
      });
      expect(result.ok).toBe(true);
      expect(cleanupSpy).toHaveBeenCalledTimes(1);
      expect(exitSpy).toHaveBeenCalledWith(0);
      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(spawnMock).toHaveBeenCalledWith(
        'npx',
        ['--yes', 'tsx', 'src/cli.ts', '--no-daemon', '-c', 'telegram'],
        expect.objectContaining({
          stdio: 'inherit',
          detached: true,
          env: expect.objectContaining({
            TELEGRAM_ALLOWED_CHAT_IDS: '1001',
            FEISHU_ALLOWED_CHAT_IDS: 'ou_abc',
            npm_config_yes: 'true',
          }),
        }),
      );
      const env = spawnMock.mock.calls[0]?.[2]?.env ?? {};
      expect(env.PIKILOOM_DAEMON_CHILD).toBeUndefined();
      expect(env.PIKILOOM_RESTART_STATE_FILE).toBeUndefined();
    } finally {
      unregisterFeishu();
      unregisterTelegram();
    }
  });

  it('killChildProcesses signals only descendants — never the root pid or unrelated processes', async () => {
    // `ps -Ao pid=,ppid=` style table: "<pid> <ppid>" per line.
    // 100 -> 200 -> 300 is the tree under root 100; 999 is unrelated.
    execFileSyncMock.mockReturnValueOnce('  100     1\n  200   100\n  300   200\n  999     1\n');
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((_pid: number, _signal?: any) => true) as any);

    try {
      const mod = await loadModule();
      const count = await mod.killChildProcesses(100, { graceMs: 0 });

      const calls = killSpy.mock.calls.map(call => [Number(call[0]), call[1]] as const);
      const termTargets = calls.filter(([, sig]) => sig === 'SIGTERM').map(([pid]) => pid).sort((a, b) => a - b);

      expect(count).toBe(2);
      expect(termTargets).toEqual([200, 300]);
      expect(calls.some(([pid]) => pid === 100)).toBe(false); // never the root itself
      expect(calls.some(([pid]) => pid === 999)).toBe(false); // never an unrelated process
    } finally {
      killSpy.mockRestore();
    }
  });

  it('killChildProcesses is a no-op when the process has no children', async () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((() => true) as any);
    try {
      const mod = await loadModule();
      const count = await mod.killChildProcesses(100, { graceMs: 0 });
      expect(count).toBe(0);
      expect(killSpy).not.toHaveBeenCalled();
    } finally {
      killSpy.mockRestore();
    }
  });
});
