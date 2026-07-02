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

vi.mock('../src/core/platform.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/core/platform.ts')>();
  return {
    ...actual,
    IS_MAC: true,
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

describe('Claude -p driver — selected-model-unavailable surfaces as a non-retryable error', () => {
  it('records s.errors + model_error stopReason from the <synthetic> model_not_found event', async () => {
    const { createClaudeStreamState, claudeParse } = await import('../src/agent/drivers/claude.ts');
    const s = createClaudeStreamState({
      agent: 'claude', prompt: '你好', workdir: '/tmp', timeout: 60,
      sessionId: null, model: 'claude-fable-5', thinkingEffort: 'high',
      onText: () => {},
    } as any);
    claudeParse({
      type: 'assistant',
      error: 'model_not_found',
      message: {
        model: '<synthetic>',
        content: [{ type: 'text', text: "There's an issue with the selected model (claude-fable-5). It may not exist or you may not have access to it." }],
      },
    }, s);
    expect(s.stopReason).toBe('model_error');
    expect(Array.isArray(s.errors) && s.errors.length > 0).toBe(true);
    expect(String(s.errors[0])).toContain('(claude-fable-5)');
    expect(String(s.errors[0]).toLowerCase()).toContain('unavailable');
    claudeParse({
      type: 'result', is_error: true, api_error_status: 404, stop_reason: 'stop_sequence',
      result: "There's an issue with the selected model (claude-fable-5).", session_id: 'sess-1',
    }, s);
    expect(s.stopReason).toBe('model_error');
    expect(String(s.errors[0])).toContain('(claude-fable-5)');
  });
});

describe('Claude -p driver — live thinking-token estimates (system/thinking_tokens)', () => {
  it('ticks the preview turn output + context during silent thinking, superseded by real usage', async () => {
    const { createClaudeStreamState, claudeParse } = await import('../src/agent/drivers/claude.ts');
    const { buildStreamPreviewMeta } = await import('../src/agent/utils.ts');
    const s = createClaudeStreamState({
      agent: 'claude', prompt: 'hi', workdir: '/tmp', timeout: 60,
      sessionId: null, model: 'claude-opus-4-8', thinkingEffort: 'high',
      onText: () => {},
    } as any);
    claudeParse({ type: 'system', session_id: 'sess-tt', model: 'claude-opus-4-8' }, s);
    claudeParse({ type: 'stream_event', event: { type: 'message_start', message: { usage: { input_tokens: 50_000, cache_read_input_tokens: 10_000 } } } }, s);
    // prompt-side counts are visible immediately, before any output
    expect(buildStreamPreviewMeta(s).contextPercent).toBe(6.2);
    // silent extended thinking: only the CLI's estimates arrive (no thinking_delta, no usage)
    claudeParse({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 50, estimated_tokens_delta: 50 }, s);
    claudeParse({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 200, estimated_tokens_delta: 150 }, s);
    const live = buildStreamPreviewMeta(s);
    expect(live.turnOutputTokens).toBe(200);
    expect(live.contextUsedTokens).toBe(60_200);
    expect(s.outputTokens).toBe(0); // the raw reported output stays untouched by the estimate
    // the settling message_delta reports real output (already includes thinking): supersede, don't add
    claudeParse({ type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 120 } } }, s);
    const settled = buildStreamPreviewMeta(s);
    expect(settled.turnOutputTokens).toBe(120);
    expect(settled.contextUsedTokens).toBe(60_120);
  });
});

describe('Claude usage resolution', () => {
  const originalHome = process.env.HOME;
  let homeDir = '';

  beforeEach(() => {
    vi.resetModules();
    execSyncMock.mockReset();
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikiloom-claude-usage-'));
    process.env.HOME = homeDir;
  });

  afterEach(() => {
    if (originalHome == null) delete process.env.HOME;
    else process.env.HOME = originalHome;
  });

  it('falls through to telemetry when OAuth fails and generates age-based labels', async () => {
    {
      const telemetryDir = path.join(homeDir, '.claude', 'telemetry');
      fs.mkdirSync(telemetryDir, { recursive: true });
      fs.writeFileSync(path.join(telemetryDir, 'events.json'), JSON.stringify({
        event_type: 'ClaudeCodeInternalEvent',
        event_data: {
          event_name: 'tengu_claudeai_limits_status_changed',
          client_timestamp: new Date(Date.now() - 60_000).toISOString(),
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

      expect(usage.ok).toBe(true);
      expect(usage.source).toBe('telemetry');
      expect(usage.status).toBe('warning');
    }

    vi.resetModules();
    execSyncMock.mockReset();
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikiloom-claude-usage-'));
    process.env.HOME = homeDir;

    {
      const telemetryDir = path.join(homeDir, '.claude', 'telemetry');
      fs.mkdirSync(telemetryDir, { recursive: true });
      fs.writeFileSync(path.join(telemetryDir, 'events.json'), JSON.stringify({
        event_type: 'ClaudeCodeInternalEvent',
        event_data: {
          event_name: 'tengu_claudeai_limits_status_changed',
          client_timestamp: new Date(Date.now() - 5 * 60_000).toISOString(),
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
      expect(usage.windows[0]?.label).toMatch(/^\d+m ago$/);
      expect(usage.windows[0]?.status).toBe('warning');
    }
  });

  it('throttles the OAuth usage query and serves the last good result within the window', async () => {
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

    const second = getUsage({ agent: 'claude', model: 'claude-opus-4-7' });
    expect(second.source).toBe('oauth-api');
    expect(second.windows[0]?.usedPercent).toBe(42);
    expect(usageCalls()).toBe(1);
  });
});

describe('Claude context fallback', () => {
  const originalPath = process.env.PATH;

  afterEach(() => {
    if (originalPath == null) delete process.env.PATH;
    else process.env.PATH = originalPath;
  });

  it('derives context window via 1M fallback and accumulates turnOutputTokens across calls', async () => {
    {
    const { doClaudeStream } = await import('../src/agent/index.ts');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikiloom-claude-context-'));
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
    expect(result.contextWindow).toBe(967_000);
    expect(result.contextPercent).toBe(2.7);
    }

    {
    const { doClaudeStream } = await import('../src/agent/index.ts');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikiloom-claude-turnout-'));
    const fakeBin = path.join(tmpDir, 'bin');
    fs.mkdirSync(fakeBin, { recursive: true });
    process.env.PATH = `${fakeBin}:${process.env.PATH}`;

    const jsonLines = [
      { type: 'system', session_id: 's-turnout', model: 'claude-opus-4-8' },
      { type: 'stream_event', event: { type: 'message_start', message: { usage: { input_tokens: 10_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } } },
      { type: 'stream_event', event: { type: 'message_delta', delta: {}, usage: { output_tokens: 500 } } },
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

    expect(lastMeta?.outputTokens).toBe(300);
    expect(lastMeta?.turnOutputTokens).toBe(800);
    }
  });
});

describe('Claude session-context env scrub', () => {
  it('removes the markers a parent claude session exports, keeps user config', async () => {
    const { scrubClaudeSessionContextEnv } = await import('../src/agent/drivers/claude.ts');
    const env: Record<string, string | undefined> = {
      CLAUDECODE: '1',
      CLAUDE_CODE_CHILD_SESSION: 'true',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_CODE_EXECPATH: '/opt/homebrew/bin/claude',
      CLAUDE_CODE_SESSION_ID: 'abc-123',
      CLAUDE_CODE_SSE_PORT: '12345',
      CLAUDE_EFFORT: 'max',
      CLAUDE_PERMISSION_MODE: 'bypassPermissions',
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

describe('normalizeClaudeSessionEntrypoint — surface Pikiloom sessions in --resume + VSCode ext', () => {
  it('flips entrypoint sdk-cli→cli in the transcript and leaves an already-clean file untouched', async () => {
    const { normalizeClaudeSessionEntrypoint, claudeProjectDirName } = await import('../src/agent/drivers/claude.ts');
    const os = await import('node:os');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const prevHome = process.env.HOME;
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'piki-ep-'));
    try {
      process.env.HOME = tmpHome;
      const workdir = '/tmp/some-workspace';
      const dir = path.join(tmpHome, '.claude', 'projects', claudeProjectDirName(workdir));
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'sess-1234.jsonl');
      fs.writeFileSync(file, [
        '{"type":"user","entrypoint":"sdk-cli","userType":"external"}',
        '{"type":"assistant","entrypoint":"sdk-cli"}',
      ].join('\n'));

      normalizeClaudeSessionEntrypoint(workdir, 'sess-1234');
      const out = fs.readFileSync(file, 'utf-8');
      expect(out).not.toContain('"entrypoint":"sdk-cli"');
      expect(out.match(/"entrypoint":"cli"/g)?.length).toBe(2);

      const mtimeBefore = fs.statSync(file).mtimeMs;
      normalizeClaudeSessionEntrypoint(workdir, 'sess-1234');
      expect(fs.statSync(file).mtimeMs).toBe(mtimeBefore);

      normalizeClaudeSessionEntrypoint(workdir, null);
      normalizeClaudeSessionEntrypoint(workdir, 'missing-session');
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});

describe('claudeUsageForToken — per-token cache + force bypass', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => ({
      headers: new Headers({
        'anthropic-ratelimit-unified-5h-utilization': '0.42',
        'anthropic-ratelimit-unified-7d-utilization': '0.10',
      }),
      text: async () => '',
    }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  // Guards the freshness fix: a freshly-switched account must re-probe instead of serving the
  // previous (cached) account's usage. Without force the per-token cache is reused.
  it('reuses the cache within TTL but re-probes when force is set', async () => {
    const { claudeUsageForToken } = await import('../src/agent/drivers/claude.ts');
    const token = 'sk-ant-oat01-force-bypass-fixture';

    const first = await claudeUsageForToken(token);
    expect(first?.ok).toBe(true);
    expect(first?.windows.find(w => w.label === '5h')?.usedPercent).toBe(42);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await claudeUsageForToken(token);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await claudeUsageForToken(token, { force: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // Guards the freshness debounce: user-facing surfaces (fresh) re-probe after a short window so
  // the popover shows current numbers, while background readers keep the long TTL — and repeated
  // fresh reads inside the window coalesce into one probe instead of stampeding.
  it('fresh tier re-probes after its short window while the default tier keeps the long TTL', async () => {
    const { claudeUsageForToken } = await import('../src/agent/drivers/claude.ts');
    vi.useFakeTimers();
    try {
      const base = Date.now();
      vi.setSystemTime(base);
      const token = 'sk-ant-oat01-fresh-tier-fixture';

      await claudeUsageForToken(token, { fresh: true });
      expect(fetchMock).toHaveBeenCalledTimes(1);

      vi.setSystemTime(base + 10_000);
      await claudeUsageForToken(token, { fresh: true });
      expect(fetchMock).toHaveBeenCalledTimes(1);

      vi.setSystemTime(base + 25_000);
      await claudeUsageForToken(token);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      await claudeUsageForToken(token, { fresh: true });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
