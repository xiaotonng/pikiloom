import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLoom, type Loom } from '../src/runtime/loom.js';
import { FsSessionStore } from '../src/ports/defaults.js';
import type { AgentDriver, AgentTurnInput, DriverContext, DriverResult, TuiInput, TuiSpec } from '../src/contracts/driver.js';
import type { UniversalSnapshot } from '../src/protocol/index.js';
import type { Plugin } from '../src/contracts/surface.js';

// A driver that records the input the Hub assembled for it, so we can assert what the
// plugin/port merge produced (env, systemPrompt, extraArgs, configOverrides, MCP servers).
class CapturingDriver implements AgentDriver {
  readonly id = 'cap';
  readonly capabilities = { steer: false, interact: false, resume: false, tui: true };
  lastRun?: AgentTurnInput;
  lastTui?: TuiInput;
  async run(input: AgentTurnInput, _ctx: DriverContext): Promise<DriverResult> {
    this.lastRun = input;
    return { ok: true, text: 'ok', sessionId: 'cap-1' };
  }
  tui(input: TuiInput): TuiSpec {
    this.lastTui = input;
    return { command: 'echo', args: [...(input.extraArgs || [])], cwd: input.workdir, env: input.env };
  }
}

const done = (loom: Loom) => new Promise<UniversalSnapshot>((resolve) => {
  const unsub = loom.io.subscribe((_k, s) => { if (s.phase === 'done') { unsub(); resolve(s); } });
});

describe('plugin contributions (Hub merge)', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-plug-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('merges ModelResolver + ToolProvider.env + plugin (prompt fragment, spawn env/args, tools) on run()', async () => {
    const driver = new CapturingDriver();
    const loom = createLoom({
      drivers: [driver], defaultAgent: 'cap', sessionStore: new FsSessionStore(tmp),
      modelResolver: { resolve: async () => ({ model: 'm1', env: { BASE: 'upstream', KEEP: 'x' }, extraArgs: ['--from-resolver'] }) },
      toolProvider: { provideForSession: async () => ({ servers: [{ name: 'tp-server' }], env: { TOOL_ENV: 't' } }) },
      systemPromptBuilder: { compose: () => 'BASE PROMPT' },
      plugins: [{
        id: 'hijack',
        promptFragment: () => '[HIJACK] route via proxy',
        contributeSpawn: () => ({ env: { BASE: 'http://127.0.0.1:9' }, extraArgs: ['--from-plugin'] }), // overrides BASE
        tools: () => [{ name: 'plugin-server' }],
      }],
    });
    await loom.io.prompt({ prompt: 'hi', agent: 'cap' });
    await done(loom);
    const input = driver.lastRun!;
    // prompt: base + plugin fragment, composed
    expect(input.systemPrompt).toBe('BASE PROMPT\n\n[HIJACK] route via proxy');
    // env: resolver + toolProvider.env (regression: was dropped) + plugin; plugin overrides BASE (last wins)
    expect(input.env).toMatchObject({ BASE: 'http://127.0.0.1:9', KEEP: 'x', TOOL_ENV: 't' });
    // extraArgs concatenate in order [resolver, plugin]
    expect(input.extraArgs).toEqual(['--from-resolver', '--from-plugin']);
    // tools: toolProvider servers + plugin servers
    expect(input.extraMcpServers?.map((s) => s.name)).toEqual(['tp-server', 'plugin-server']);
  });

  it('hijack scenario: a plugin injects the model base-URL env, reaching BOTH run() and tui()', async () => {
    const PROXY = 'http://127.0.0.1:48217';
    const hijack: Plugin = {
      id: 'apodex-hijack',
      // ApodexCode's real shape: per-agent redirect knob (env on run/tui; could be a launch arg for codex)
      contributeSpawn: ({ agent, mode }) => agent === 'cap' ? { env: { ANTHROPIC_BASE_URL: PROXY }, extraArgs: mode === 'tui' ? ['--tui-flag'] : [] } : null,
    };
    const driver = new CapturingDriver();
    const loom = createLoom({ drivers: [driver], defaultAgent: 'cap', sessionStore: new FsSessionStore(tmp), plugins: [hijack] });

    // structured rail
    await loom.io.prompt({ prompt: 'hi', agent: 'cap' });
    await done(loom);
    expect(driver.lastRun?.env).toMatchObject({ ANTHROPIC_BASE_URL: PROXY });

    // raw-PTY rail
    const spec = await loom.resolveTui({ agent: 'cap' });
    expect(spec.env).toMatchObject({ ANTHROPIC_BASE_URL: PROXY });
    expect(spec.args).toContain('--tui-flag');
  });

  it('registerPlugin adds a contribution dynamically (no global env touched)', async () => {
    const driver = new CapturingDriver();
    const loom = createLoom({ drivers: [driver], defaultAgent: 'cap', sessionStore: new FsSessionStore(tmp) });
    loom.registerPlugin({ id: 'late', contributeSpawn: () => ({ env: { LATE: '1' } }) });
    await loom.io.prompt({ prompt: 'hi', agent: 'cap' });
    await done(loom);
    expect(driver.lastRun?.env).toMatchObject({ LATE: '1' });
    expect(process.env.LATE).toBeUndefined(); // never leaked to the global environment
  });
});
