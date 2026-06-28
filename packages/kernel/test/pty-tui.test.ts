import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { PtyBridge, ptyAvailable } from '../src/runtime/pty.js';
import { createLoom } from '../src/runtime/loom.js';
import type { AgentDriver, AgentTurnInput, DriverContext, DriverResult, TuiInput, TuiSpec } from '../src/contracts/driver.js';

// A fake interactive "agent": prints a banner, echoes input, exits on 'Q'. Stands in for
// the real claude/codex TUI so the passthrough mechanics are tested hermetically.
const FAKE = `
process.stdout.write('TUI-READY\\n');
process.stdin.on('data', (d) => {
  const s = d.toString();
  if (s.includes('Q')) { process.stdout.write('BYE\\n'); setTimeout(() => process.exit(0), 10); return; }
  process.stdout.write('GOT:' + JSON.stringify(s) + '\\n');
});
`;

class FakeTuiDriver implements AgentDriver {
  readonly id = 'fake';
  readonly capabilities = { tui: true };
  constructor(private readonly script: string) {}
  async run(_i: AgentTurnInput, _c: DriverContext): Promise<DriverResult> { return { ok: false, text: '', error: 'tui-only' }; }
  tui(input: TuiInput): TuiSpec { return { command: process.execPath, args: [this.script], cwd: input.workdir, env: input.env }; }
}

const waitForData = async (get: () => string, needle: string, ms = 5000) => {
  const t0 = Date.now();
  while (!get().includes(needle)) { if (Date.now() - t0 > ms) throw new Error(`timeout waiting for "${needle}" — got: ${get().slice(0, 200)}`); await new Promise(r => setTimeout(r, 10)); }
};

describe.skipIf(!ptyAvailable())('PtyBridge / TUI passthrough (hermetic)', () => {
  let tmp: string; let script: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-pty-')); script = path.join(tmp, 'fake.mjs'); fs.writeFileSync(script, FAKE); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('passes raw bytes both ways, tees to observers, resizes, and reports exit', async () => {
    const bridge = PtyBridge.open({ command: process.execPath, args: [script], cwd: tmp }, { cols: 80, rows: 24 });
    let primary = ''; let tee = '';
    bridge.onData(d => { primary += d; });
    bridge.onData(d => { tee += d; });            // second observer = tee/mirror
    expect(bridge.pid).toBeGreaterThan(0);

    await waitForData(() => primary, 'TUI-READY');
    bridge.write('hello\r');                       // \r => line delivered (canonical pty mode)
    await waitForData(() => primary, 'GOT:');
    expect(primary).toContain('hello');           // input reached the child, echoed in its output
    expect(tee).toContain('TUI-READY');           // tee observer saw the same stream

    bridge.resize(120, 40);                        // must not throw

    const exit = await new Promise<{ exitCode: number }>((resolve) => {
      bridge.onExit(resolve);
      bridge.write('Q\r');
    });
    expect(exit.exitCode).toBe(0);
    expect(primary).toContain('BYE');
  });

  it('Loom.resolveTui applies the driver spec; Loom.openTui spawns it', async () => {
    const loom = createLoom({ drivers: [new FakeTuiDriver(script)], defaultAgent: 'fake' });
    const spec = await loom.resolveTui({ agent: 'fake', workdir: tmp });
    expect(spec.command).toBe(process.execPath);
    expect(spec.args).toEqual([script]);

    const bridge = await loom.openTui({ agent: 'fake', workdir: tmp });
    let out = '';
    bridge.onData(d => { out += d; });
    await waitForData(() => out, 'TUI-READY');
    bridge.kill();
  });

  it('rejects TUI for a driver that does not support it', async () => {
    const loom = createLoom({ drivers: [{ id: 'nope', async run() { return { ok: true, text: '' }; } } as AgentDriver], defaultAgent: 'nope' });
    await expect(loom.resolveTui({ agent: 'nope' })).rejects.toThrow(/does not support TUI/);
  });
});

// Real claude TUI passthrough — off by default (needs auth/network). Proves real raw
// TUI bytes (ANSI) flow through the kernel's PtyBridge.
function claudePresent(): boolean { try { execSync('command -v claude', { stdio: 'ignore' }); return true; } catch { return false; } }
const realEnabled = process.env.KERNEL_E2E_REAL === '1' && claudePresent() && ptyAvailable();

describe.skipIf(!realEnabled)('real Claude TUI passthrough', () => {
  it('launches the real claude TUI in a PTY and streams raw ANSI frames', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-claude-tui-'));
    const loom = createLoom({ drivers: [new (await import('../src/drivers/claude.js')).ClaudeDriver()], defaultAgent: 'claude' });
    const bridge = await loom.openTui({ agent: 'claude', workdir: tmp });
    let out = '';
    bridge.onData(d => { out += d; });
    await new Promise(r => setTimeout(r, 4000)); // let the TUI paint
    bridge.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
    expect(out.length).toBeGreaterThan(0);
    expect(out).toContain('\x1b');               // ANSI escape => a real full-screen TUI rendered
  }, 30_000);
});
