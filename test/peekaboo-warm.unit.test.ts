import { describe, expect, it, vi } from 'vitest';

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(() => ({ on: vi.fn(), unref: vi.fn() })),
}));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: spawnMock };
});

import {
  PEEKABOO_NPX_PACKAGE,
  PEEKABOO_MCP_ARGV,
  PEEKABOO_WARM_ARGV,
  ensurePeekabooWarm,
} from '../src/agent/mcp/bridge.js';

const pkgAfterFlag = (argv: readonly string[]) => argv[argv.indexOf('-p') + 1];

describe('Peekaboo npx warm', () => {
  it('warms the SAME package the MCP server launches, so the cache is reused', () => {
    expect(pkgAfterFlag(PEEKABOO_MCP_ARGV)).toBe(PEEKABOO_NPX_PACKAGE);
    expect(pkgAfterFlag(PEEKABOO_WARM_ARGV)).toBe(PEEKABOO_NPX_PACKAGE);
  });

  it('runs the long-lived server bin for MCP but a quick-exit bin for warming', () => {
    expect(PEEKABOO_MCP_ARGV).toContain('peekaboo-mcp');
    expect(PEEKABOO_WARM_ARGV).not.toContain('peekaboo-mcp');
    expect(PEEKABOO_WARM_ARGV).toContain('--version');
  });

  it('spawns a detached warm once on darwin and is a process-singleton', () => {
    const original = process.platform;
    const originalOpenAi = process.env.OPENAI_API_KEY;
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    process.env.OPENAI_API_KEY = 'sk-should-not-leak';
    try {
      spawnMock.mockClear();
      ensurePeekabooWarm();
      ensurePeekabooWarm();
      expect(spawnMock).toHaveBeenCalledTimes(1);
      const [cmd, args, opts] = spawnMock.mock.calls[0] as unknown as [string, string[], Record<string, unknown>];
      expect(cmd).toBe('npx');
      expect(args).toEqual(PEEKABOO_WARM_ARGV);
      expect(opts).toMatchObject({ detached: true, stdio: 'ignore' });
      expect((opts.env as Record<string, string>).OPENAI_API_KEY).toBeUndefined();
      expect((opts.env as Record<string, string>).PIKILOOM_MCP_SERVER).toBe('peekaboo');
    } finally {
      Object.defineProperty(process, 'platform', { value: original, configurable: true });
      if (originalOpenAi == null) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = originalOpenAi;
    }
  });
});
