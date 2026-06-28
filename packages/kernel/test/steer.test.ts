import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaudeDriver } from '../src/drivers/claude.js';
import { CodexDriver } from '../src/drivers/codex.js';
import type { DriverContext, DriverEvent } from '../src/contracts/driver.js';

const waitFor = async (pred: () => boolean, ms = 5000) => {
  const t0 = Date.now();
  while (!pred()) { if (Date.now() - t0 > ms) throw new Error('waitFor timeout'); await new Promise(r => setTimeout(r, 10)); }
};

// Fake claude in stream-json INPUT mode: echoes each stdin user message's text as a
// text_delta; emits `result` after the 2nd message (the steer). Proves mid-turn steer.
const FAKE_CLAUDE = `#!/usr/bin/env node
let buf = ''; let count = 0;
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
out({ type:'system', session_id:'cl-steer-1', model:'claude-opus-4-8' });
process.stdin.on('data', (d) => {
  buf += d; const lines = buf.split('\\n'); buf = lines.pop() || '';
  for (const line of lines) {
    if (!line.trim()) continue; let m; try { m = JSON.parse(line); } catch { continue; }
    const text = m?.message?.content?.[0]?.text || '';
    count++;
    out({ type:'stream_event', event:{ type:'content_block_delta', delta:{ type:'text_delta', text:'['+text+']' } } });
    if (count >= 2) out({ type:'result', session_id:'cl-steer-1', is_error:false, stop_reason:'end_turn', usage:{ input_tokens:5, output_tokens:2 } });
  }
});
`;

// Fake codex app-server that holds the turn open until turn/steer arrives.
const FAKE_CODEX = `#!/usr/bin/env node
let buf = ''; const TID='codex-steer-1';
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc:'2.0', id, result }) + '\\n');
const notify = (method, params) => process.stdout.write(JSON.stringify({ jsonrpc:'2.0', method, params }) + '\\n');
process.stdin.on('data', (d) => {
  buf += d; const lines = buf.split('\\n'); buf = lines.pop() || '';
  for (const line of lines) {
    if (!line.trim()) continue; let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.method === 'initialize') reply(m.id, {});
    else if (m.method === 'thread/start') reply(m.id, { thread: { id: TID } });
    else if (m.method === 'turn/start') {
      reply(m.id, {});
      notify('turn/started', { threadId: TID, turn: { id: 'turn-1' } });
      notify('item/started', { threadId: TID, item: { type:'agentMessage', id:'msg1', phase:'final_answer' } });
      notify('item/agentMessage/delta', { threadId: TID, itemId:'msg1', delta:'base' });
      // intentionally NOT completing — waits for steer
    } else if (m.method === 'turn/steer') {
      reply(m.id, { turnId: 'turn-2' });
      notify('item/agentMessage/delta', { threadId: TID, itemId:'msg1', delta:'-steered' });
      notify('turn/completed', { threadId: TID, turn: { id:'turn-2', status:'completed' } });
    }
  }
});
`;

function steerCtx(): { ctx: DriverContext; events: DriverEvent[]; steer: () => ((p: string) => Promise<boolean>) | null } {
  const events: DriverEvent[] = [];
  let steerFn: ((p: string) => Promise<boolean>) | null = null;
  const ctx: DriverContext = {
    signal: new AbortController().signal,
    emit: (e) => events.push(e),
    askUser: async () => ({}),
    registerSteer: (fn) => { steerFn = fn as any; },
  };
  return { ctx, events, steer: () => steerFn };
}

describe('mid-turn steer', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-steer-')); });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('claude: stream-json input mode injects a steer message mid-turn', async () => {
    const fake = path.join(tmp, 'fake-claude.mjs'); fs.writeFileSync(fake, FAKE_CLAUDE); fs.chmodSync(fake, 0o755);
    const { ctx, events, steer } = steerCtx();
    const p = new ClaudeDriver(fake).run({ prompt: 'first', workdir: tmp, steerable: true }, ctx);
    await waitFor(() => !!steer() && events.some(e => e.type === 'text'));
    expect(await steer()!('STEERED')).toBe(true);
    const result = await p;
    expect(result.text).toBe('[first][STEERED]');
    expect(result.sessionId).toBe('cl-steer-1');
  }, 20_000);

  it('codex: turn/steer continues the open turn', async () => {
    const fake = path.join(tmp, 'fake-codex.mjs'); fs.writeFileSync(fake, FAKE_CODEX); fs.chmodSync(fake, 0o755);
    const { ctx, events, steer } = steerCtx();
    const p = new CodexDriver(fake).run({ prompt: 'go', workdir: tmp }, ctx);
    await waitFor(() => !!steer() && events.some(e => e.type === 'text'));
    expect(await steer()!('more')).toBe(true);
    const result = await p;
    expect(result.ok).toBe(true);
    expect(result.text).toBe('base-steered');
  }, 20_000);
});
