import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CodexDriver } from '../src/drivers/codex.js';
import type { DriverContext, DriverEvent } from '../src/contracts/driver.js';

// A fake `codex app-server` speaking the newline-JSON-RPC the driver expects, so the
// codex port is verified end-to-end without the real codex binary / network.
const FAKE_APP_SERVER = `#!/usr/bin/env node
let buf = '';
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc:'2.0', id, result }) + '\\n');
const notify = (method, params) => process.stdout.write(JSON.stringify({ jsonrpc:'2.0', method, params }) + '\\n');
const TID = 'codex-thread-xyz';
process.stdin.on('data', (d) => {
  buf += d; const lines = buf.split('\\n'); buf = lines.pop() || '';
  for (const line of lines) {
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.method === 'initialize') reply(m.id, {});
    else if (m.method === 'thread/start') reply(m.id, { thread: { id: TID } });
    else if (m.method === 'turn/start') {
      reply(m.id, {});
      notify('turn/started', { threadId: TID, turn: { id: 'turn-1' } });
      notify('item/started', { threadId: TID, item: { type: 'agentMessage', id: 'msg1', phase: 'final_answer' } });
      notify('item/reasoning/textDelta', { threadId: TID, delta: 'thinking...' });
      notify('item/agentMessage/delta', { threadId: TID, itemId: 'msg1', delta: 'CODEX-' });
      notify('item/agentMessage/delta', { threadId: TID, itemId: 'msg1', delta: 'KERNEL-OK' });
      notify('item/started', { threadId: TID, item: { type: 'commandExecution', id: 'cmd1', command: 'ls' } });
      notify('item/completed', { threadId: TID, item: { type: 'commandExecution', id: 'cmd1', status: 'completed' } });
      notify('turn/plan/updated', { threadId: TID, plan: { steps: [{ step: 'do the thing', status: 'in_progress' }] } });
      notify('thread/tokenUsage/updated', { threadId: TID, tokenUsage: { input_tokens: 42, output_tokens: 7 } });
      notify('turn/completed', { threadId: TID, turn: { id: 'turn-1', status: 'completed' } });
    }
  }
});
`;

function ctxCollect(): { ctx: DriverContext; events: DriverEvent[] } {
  const events: DriverEvent[] = [];
  const ctx: DriverContext = {
    signal: new AbortController().signal,
    emit: (e) => events.push(e),
    askUser: async () => ({}),
    registerSteer: () => {},
  };
  return { ctx, events };
}

describe('CodexDriver native (app-server JSON-RPC, hermetic via fake server)', () => {
  let tmp: string; let fake: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-codex-'));
    fake = path.join(tmp, 'fake-codex.mjs');
    fs.writeFileSync(fake, FAKE_APP_SERVER);
    fs.chmodSync(fake, 0o755);
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('drives a turn: session id, text, reasoning, tool, plan, usage, completion', async () => {
    const { ctx, events } = ctxCollect();
    const driver = new CodexDriver(fake);
    const result = await driver.run({ prompt: 'hello codex', workdir: tmp, effort: 'high' }, ctx);

    expect(result.ok).toBe(true);
    expect(result.text).toBe('CODEX-KERNEL-OK');
    expect(result.sessionId).toBe('codex-thread-xyz');
    expect(result.usage).toMatchObject({ inputTokens: 42, outputTokens: 7 });

    expect(events.find(e => e.type === 'session')).toMatchObject({ sessionId: 'codex-thread-xyz' });
    expect(events.filter(e => e.type === 'text').map(e => (e as any).delta).join('')).toBe('CODEX-KERNEL-OK');
    expect(events.filter(e => e.type === 'reasoning').map(e => (e as any).delta).join('')).toBe('thinking...');
    const toolStatuses = events.filter(e => e.type === 'tool').map(e => (e as any).call.status);
    expect(toolStatuses).toContain('running');
    expect(toolStatuses).toContain('done');
    const plan = events.find(e => e.type === 'plan') as any;
    expect(plan.plan.steps).toEqual([{ text: 'do the thing', status: 'inProgress' }]);
  }, 20_000);

  it('exposes a TUI spec', () => {
    const spec = new CodexDriver().tui({ workdir: '/tmp/x', model: 'gpt-5.5' });
    expect(spec.command).toBe('codex');
    expect(spec.args).toContain('-m');
    expect(spec.args).toContain('gpt-5.5');
  });
});
