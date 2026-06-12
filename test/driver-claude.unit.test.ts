import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { execSyncMock } = vi.hoisted(() => ({
  execSyncMock: vi.fn(),
}));

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execSync: execSyncMock,
  };
});

describe('Claude API retry classification', () => {
  it('retries transient overloads but not quota/rate-limit exhaustion', async () => {
    const { isRetryableClaudeApiError } = await import('../src/agent/utils.ts');
    expect(isRetryableClaudeApiError('Overloaded')).toBe(true);
    expect(isRetryableClaudeApiError('Gateway timeout 504')).toBe(true);
    expect(isRetryableClaudeApiError('Rate limit exceeded')).toBe(false);
    expect(isRetryableClaudeApiError('Usage limit reached')).toBe(false);
    expect(isRetryableClaudeApiError('session limit resets later')).toBe(false);
  });
});

describe('Claude usage resolution', () => {
  const originalHome = process.env.HOME;
  let homeDir = '';

  beforeEach(() => {
    vi.resetModules();
    execSyncMock.mockReset();
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikiclaw-claude-usage-'));
    process.env.HOME = homeDir;
  });

  afterEach(() => {
    if (originalHome == null) delete process.env.HOME;
    else process.env.HOME = originalHome;
  });

  it('falls through to telemetry when OAuth fails and generates age-based labels', async () => {
    // --- OAuth rate_limit_error scenario ---
    {
      const telemetryDir = path.join(homeDir, '.claude', 'telemetry');
      fs.mkdirSync(telemetryDir, { recursive: true });
      fs.writeFileSync(path.join(telemetryDir, 'events.json'), JSON.stringify({
        event_type: 'ClaudeCodeInternalEvent',
        event_data: {
          event_name: 'tengu_claudeai_limits_status_changed',
          client_timestamp: new Date(Date.now() - 60_000).toISOString(), // 1 minute ago
          model: 'claude-opus-4-7',
          additional_metadata: JSON.stringify({ status: 'allowed_warning', hoursTillReset: 39 }),
        },
      }));

      execSyncMock.mockImplementation((cmd: string) => {
        if (cmd.includes('security find-generic-password')) {
          return JSON.stringify({ claudeAiOauth: { accessToken: 'oauth-token' } });
        }
        if (cmd.includes('api/oauth/usage')) {
          return JSON.stringify({
            error: {
              type: 'rate_limit_error',
              message: 'Rate limited. Please try again later.',
            },
          });
        }
        throw new Error(`Unexpected command: ${cmd}`);
      });

      const { getUsage } = await import('../src/agent/index.ts');
      const usage = getUsage({ agent: 'claude', model: 'claude-opus-4-7' });

      // Should fall through to telemetry, not report the OAuth error
      expect(usage.ok).toBe(true);
      expect(usage.source).toBe('telemetry');
      expect(usage.status).toBe('warning');
    }

    // Reset modules and mocks for the next scenario
    vi.resetModules();
    execSyncMock.mockReset();
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikiclaw-claude-usage-'));
    process.env.HOME = homeDir;

    // --- Age-based labels scenario ---
    {
      const telemetryDir = path.join(homeDir, '.claude', 'telemetry');
      fs.mkdirSync(telemetryDir, { recursive: true });
      // Write a recent telemetry event (5 minutes ago) so label is deterministic
      fs.writeFileSync(path.join(telemetryDir, 'events.json'), JSON.stringify({
        event_type: 'ClaudeCodeInternalEvent',
        event_data: {
          event_name: 'tengu_claudeai_limits_status_changed',
          client_timestamp: new Date(Date.now() - 5 * 60_000).toISOString(), // 5 minutes ago
          model: 'claude-opus-4-7',
          additional_metadata: JSON.stringify({ status: 'allowed_warning', hoursTillReset: 39 }),
        },
      }));

      execSyncMock.mockImplementation(() => {
        throw new Error('No OAuth token');
      });

      const { getUsage } = await import('../src/agent/index.ts');
      const usage = getUsage({ agent: 'claude', model: 'claude-opus-4-7' });

      expect(usage.ok).toBe(true);
      expect(usage.source).toBe('telemetry');
      expect(usage.windows[0]?.label).toMatch(/^\d+m ago$/); // e.g. "5m ago"
      expect(usage.windows[0]?.status).toBe('warning');
    }
  });

  it('throttles the OAuth usage query and serves the last good result within the window', async () => {
    // First poll: OAuth returns real utilization → cached as last-good.
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.includes('security find-generic-password')) {
        return JSON.stringify({ claudeAiOauth: { accessToken: 'oauth-token' } });
      }
      if (cmd.includes('api/oauth/usage')) {
        return JSON.stringify({
          five_hour: { utilization: 42, resets_at: new Date(Date.now() + 3_600_000).toISOString() },
        });
      }
      throw new Error(`Unexpected command: ${cmd}`);
    });

    const { getUsage } = await import('../src/agent/index.ts');
    const usageCalls = () => execSyncMock.mock.calls.filter(c => String(c[0]).includes('api/oauth/usage')).length;

    const first = getUsage({ agent: 'claude', model: 'claude-opus-4-7' });
    expect(first.source).toBe('oauth-api');
    expect(first.windows[0]?.usedPercent).toBe(42);
    expect(usageCalls()).toBe(1);

    // Second poll inside the throttle window must NOT re-query the (rate-limited)
    // endpoint, and must keep serving the cached good windows — so a transient
    // 429 between polls can't blank the header ring.
    const second = getUsage({ agent: 'claude', model: 'claude-opus-4-7' });
    expect(second.source).toBe('oauth-api');
    expect(second.windows[0]?.usedPercent).toBe(42);
    expect(usageCalls()).toBe(1); // unchanged → query was throttled
  });
});

describe('Claude context fallback', () => {
  const originalPath = process.env.PATH;

  afterEach(() => {
    if (originalPath == null) delete process.env.PATH;
    else process.env.PATH = originalPath;
  });

  it('derives context window via 1M fallback and accumulates turnOutputTokens across calls', async () => {
    // --- uses 1M fallback for Opus and Sonnet base models ---
    {
    const { doClaudeStream } = await import('../src/agent/index.ts');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikiclaw-claude-context-'));
    const fakeBin = path.join(tmpDir, 'bin');
    fs.mkdirSync(fakeBin, { recursive: true });
    process.env.PATH = `${fakeBin}:${process.env.PATH}`;

    const writeFakeScript = (jsonLines: object[]) => {
      const payload = jsonLines.map(j => JSON.stringify(j)).join('\n');
      const script = `#!/bin/sh\ncat <<'JSONL_EOF'\n${payload}\nJSONL_EOF\n`;
      fs.writeFileSync(path.join(fakeBin, 'claude'), script, { mode: 0o755 });
    };

    const baseOpts = {
      agent: 'claude' as const,
      prompt: 'test prompt',
      workdir: tmpDir,
      timeout: 10,
      sessionId: null,
      model: null,
      thinkingEffort: 'high' as const,
      onText: () => {},
    };

    writeFakeScript([
      { type: 'system', session_id: 's-ctx', model: 'claude-sonnet-4-6' },
      {
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: { usage: { input_tokens: 25_000, cache_read_input_tokens: 1_000, cache_creation_input_tokens: 0 } },
        },
      },
      { type: 'result', session_id: 's-ctx', usage: { input_tokens: 25_000, cache_read_input_tokens: 1_000, output_tokens: 1 } },
    ]);

    const result = await doClaudeStream(baseOpts);
    // contextWindow stores the *effective* usable window: advertised 1M minus
    // 20K max-output reserve and 13K auto-compact buffer (matches cc 2.1.112's
    // `Yn() − t_7` denominator).
    expect(result.contextWindow).toBe(967_000);
    // 26000 used / 967000 = 2.689... → 2.7
    expect(result.contextPercent).toBe(2.7);
    }

    // --- accumulates turnOutputTokens across per-call message_start resets ---
    {
    const { doClaudeStream } = await import('../src/agent/index.ts');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikiclaw-claude-turnout-'));
    const fakeBin = path.join(tmpDir, 'bin');
    fs.mkdirSync(fakeBin, { recursive: true });
    process.env.PATH = `${fakeBin}:${process.env.PATH}`;

    const jsonLines = [
      { type: 'system', session_id: 's-turnout', model: 'claude-opus-4-8' },
      // Call 1: thinking burns 500 output tokens, ends in tool_use.
      { type: 'stream_event', event: { type: 'message_start', message: { usage: { input_tokens: 10_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } } },
      { type: 'stream_event', event: { type: 'message_delta', delta: {}, usage: { output_tokens: 500 } } },
      // Call 2 (after the tool roundtrip): per-call counters reset, 300 more.
      { type: 'stream_event', event: { type: 'message_start', message: { usage: { input_tokens: 11_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } } },
      { type: 'stream_event', event: { type: 'message_delta', delta: {}, usage: { output_tokens: 300 } } },
      { type: 'result', session_id: 's-turnout', usage: { input_tokens: 11_000, output_tokens: 300 } },
    ];
    const payload = jsonLines.map(j => JSON.stringify(j)).join('\n');
    fs.writeFileSync(path.join(fakeBin, 'claude'), `#!/bin/sh\ncat <<'JSONL_EOF'\n${payload}\nJSONL_EOF\n`, { mode: 0o755 });

    let lastMeta: any = null;
    await doClaudeStream({
      agent: 'claude' as const,
      prompt: 'test prompt',
      workdir: tmpDir,
      timeout: 10,
      sessionId: null,
      model: null,
      thinkingEffort: 'high' as const,
      onText: (_text: string, _thinking: string, _activity?: string, meta?: any) => { if (meta) lastMeta = meta; },
    });

    // Per-call output reflects the latest call only; the turn-cumulative
    // counter keeps climbing across the message_start reset (500 + 300).
    expect(lastMeta?.outputTokens).toBe(300);
    expect(lastMeta?.turnOutputTokens).toBe(800);
    }
  });
});

describe('Claude session-context env scrub', () => {
  it('removes the markers a parent claude session exports, keeps user config', async () => {
    const { scrubClaudeSessionContextEnv } = await import('../src/agent/drivers/claude.ts');
    const env: Record<string, string | undefined> = {
      // Runtime context markers — leak from an agent-launched daemon and flip
      // spawned claudes into child-session mode (transcript never written).
      CLAUDECODE: '1',
      CLAUDE_CODE_CHILD_SESSION: 'true',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_CODE_EXECPATH: '/opt/homebrew/bin/claude',
      CLAUDE_CODE_SESSION_ID: 'abc-123',
      CLAUDE_CODE_SSE_PORT: '12345',
      CLAUDE_EFFORT: 'max',
      CLAUDE_PERMISSION_MODE: 'bypassPermissions',
      // Deliberate user config — must survive the scrub.
      CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: '8192',
      ANTHROPIC_BASE_URL: 'https://proxy.example.com',
      PATH: '/usr/bin',
    };
    scrubClaudeSessionContextEnv(env);
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.CLAUDE_CODE_CHILD_SESSION).toBeUndefined();
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(env.CLAUDE_CODE_EXECPATH).toBeUndefined();
    expect(env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
    expect(env.CLAUDE_CODE_SSE_PORT).toBeUndefined();
    expect(env.CLAUDE_EFFORT).toBeUndefined();
    expect(env.CLAUDE_PERMISSION_MODE).toBeUndefined();
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBe('1');
    expect(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe('8192');
    expect(env.ANTHROPIC_BASE_URL).toBe('https://proxy.example.com');
    expect(env.PATH).toBe('/usr/bin');
  });
});
