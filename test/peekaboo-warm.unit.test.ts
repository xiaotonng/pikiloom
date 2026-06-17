import { describe, expect, it, vi } from 'vitest';

// Observe ensurePeekabooWarm's detached spawn without launching npx in CI.
// vi.hoisted so the mock fn exists before the hoisted vi.mock factory runs.
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
    // Both invocations pin the package via `-p`, so npx resolves them to one
    // cache entry — warming peekaboo-mcp's package is what makes startup instant.
    // If these drift, the warm downloads a different entry and fixes nothing.
    expect(pkgAfterFlag(PEEKABOO_MCP_ARGV)).toBe(PEEKABOO_NPX_PACKAGE);
    expect(pkgAfterFlag(PEEKABOO_WARM_ARGV)).toBe(PEEKABOO_NPX_PACKAGE);
  });

  it('runs the long-lived server bin for MCP but a quick-exit bin for warming', () => {
    // The server bin (peekaboo-mcp) never exits; the warm must NOT use it or the
    // warm process would hang forever instead of populating the cache and exiting.
    expect(PEEKABOO_MCP_ARGV).toContain('peekaboo-mcp');
    expect(PEEKABOO_WARM_ARGV).not.toContain('peekaboo-mcp');
    expect(PEEKABOO_WARM_ARGV).toContain('--version');
  });

  it('spawns a detached warm once on darwin and is a process-singleton', () => {
    const original = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    try {
      spawnMock.mockClear();
      ensurePeekabooWarm();
      ensurePeekabooWarm(); // repeated stream-start calls must not re-spawn
      expect(spawnMock).toHaveBeenCalledTimes(1);
      const [cmd, args, opts] = spawnMock.mock.calls[0] as unknown as [string, string[], Record<string, unknown>];
      expect(cmd).toBe('npx');
      expect(args).toEqual(PEEKABOO_WARM_ARGV);
      expect(opts).toMatchObject({ detached: true, stdio: 'ignore' });
    } finally {
      Object.defineProperty(process, 'platform', { value: original, configurable: true });
    }
  });
});
