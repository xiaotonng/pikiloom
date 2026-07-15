import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaudeDriver, claudeProcessFingerprint } from '../src/drivers/claude.js';
import type { AgentTurnInput, DriverContext, DriverEvent } from '../src/contracts/driver.js';

// A fake multi-turn `claude` CLI: stream-json in/out, one full turn per user message,
// stays alive while stdin is open (exactly the real CLI's -p --input-format stream-json
// contract the warm pool builds on). It stamps its pid into the reply so a test can
// tell process reuse from a respawn without OS-level probing.
const FAKE_CLAUDE = `#!/usr/bin/env node
// Like the real CLI, a --fork-session run mints a NEW session id.
const SID = process.argv.includes('--fork-session') ? 'sess-fork-' + process.pid : (process.env.FAKE_SESSION_ID || 'sess-warm-1');
let buf = '';
let turn = 0;
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
process.stdin.on('data', (d) => {
  buf += d; const lines = buf.split('\\n'); buf = lines.pop() || '';
  for (const line of lines) {
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.type !== 'user') continue;
    turn++;
    out({ type: 'system', subtype: 'init', session_id: SID, model: 'fake-model' });
    out({ type: 'stream_event', session_id: SID, event: { type: 'message_start', message: { usage: { input_tokens: 10 } } } });
    out({ type: 'stream_event', session_id: SID, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'pid=' + process.pid + ' turn=' + turn } } });
    out({ type: 'result', session_id: SID, result: 'pid=' + process.pid + ' turn=' + turn, usage: { input_tokens: 10, output_tokens: 2 } });
  }
});
process.stdin.on('end', () => process.exit(0));
`;

function ctxCollect(): { ctx: DriverContext; events: DriverEvent[]; abort: AbortController } {
  const abort = new AbortController();
  const events: DriverEvent[] = [];
  const ctx: DriverContext = {
    signal: abort.signal,
    emit: (e) => events.push(e),
    askUser: async () => ({}),
    registerSteer: () => {},
  };
  return { ctx, events, abort };
}

const pidOf = (text: string): string => /pid=(\d+)/.exec(text)?.[1] ?? '';

describe('ClaudeDriver warm pool (hermetic via fake multi-turn CLI)', () => {
  let tmp: string;
  let fake: string;
  let driver: ClaudeDriver | null;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-claude-warm-'));
    fake = path.join(tmp, 'fake-claude.js');
    fs.writeFileSync(fake, FAKE_CLAUDE, { mode: 0o755 });
    driver = null;
  });
  afterEach(() => {
    driver?.dispose();
    delete process.env.PIKILOOM_CLAUDE_WARM_IDLE_MS;
    delete process.env.PIKILOOM_CLAUDE_WARM_MAX;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const turnInput = (extra: Partial<AgentTurnInput> = {}): AgentTurnInput => ({
    prompt: 'ping', workdir: tmp, ...extra,
  });
  it('reuses the same process for a continuation turn and reports transport', async () => {
    const d = new ClaudeDriver(fake, { warmPool: true });
    driver = d;
    const { ctx } = ctxCollect();
    const r1 = await d.run(turnInput(), ctx);
    expect(r1.ok).toBe(true);
    expect(r1.transport).toBe('cold');
    expect(r1.sessionId).toBe('sess-warm-1');
    expect(d.warmPoolSize()).toBe(1);

    const r2 = await d.run(turnInput({ sessionId: r1.sessionId }), ctxCollect().ctx);
    expect(r2.ok).toBe(true);
    expect(r2.transport).toBe('warm');
    expect(pidOf(r2.text)).toBe(pidOf(r1.text));
    expect(r2.text).toContain('turn=2'); // same process, same in-memory conversation
    expect(d.warmPoolSize()).toBe(1);
  });

  it('never parks when the pool is disabled', async () => {
    const d = new ClaudeDriver(fake);
    driver = d;
    const r1 = await d.run(turnInput(), ctxCollect().ctx);
    expect(r1.ok).toBe(true);
    expect(r1.transport).toBe('cold');
    expect(d.warmPoolSize()).toBe(0);
    const r2 = await d.run(turnInput({ sessionId: r1.sessionId }), ctxCollect().ctx);
    expect(r2.transport).toBe('cold');
    expect(pidOf(r2.text)).not.toBe(pidOf(r1.text));
  });

  it('goes cold (and replaces the parked process) when the fingerprint drifts', async () => {
    const d = new ClaudeDriver(fake, { warmPool: true });
    driver = d;
    const r1 = await d.run(turnInput({ model: 'model-a' }), ctxCollect().ctx);
    const r2 = await d.run(turnInput({ model: 'model-b', sessionId: r1.sessionId }), ctxCollect().ctx);
    expect(r2.transport).toBe('cold');
    expect(pidOf(r2.text)).not.toBe(pidOf(r1.text));
    expect(d.warmPoolSize()).toBe(1); // the new process parked under the new fingerprint
    const r3 = await d.run(turnInput({ model: 'model-b', sessionId: r1.sessionId }), ctxCollect().ctx);
    expect(r3.transport).toBe('warm');
    expect(pidOf(r3.text)).toBe(pidOf(r2.text));
  });

  it('a rewind evicts the parked process (stale in-memory context) and goes cold', async () => {
    const d = new ClaudeDriver(fake, { warmPool: true });
    driver = d;
    const r1 = await d.run(turnInput(), ctxCollect().ctx);
    expect(d.warmPoolSize()).toBe(1);
    const r2 = await d.run(turnInput({ sessionId: r1.sessionId, rewind: { anchor: null } }), ctxCollect().ctx);
    expect(r2.transport).toBe('cold');
    expect(pidOf(r2.text)).not.toBe(pidOf(r1.text));
  });

  it('a fork turn goes cold but leaves the parent parked', async () => {
    const d = new ClaudeDriver(fake, { warmPool: true });
    driver = d;
    const r1 = await d.run(turnInput(), ctxCollect().ctx);
    const r2 = await d.run(turnInput({ sessionId: r1.sessionId, fork: { anchor: null } }), ctxCollect().ctx);
    expect(r2.transport).toBe('cold');
    expect(pidOf(r2.text)).not.toBe(pidOf(r1.text));
    // Parent's warm process is still valid for a plain continuation.
    const r3 = await d.run(turnInput({ sessionId: r1.sessionId }), ctxCollect().ctx);
    expect(r3.transport).toBe('warm');
    expect(pidOf(r3.text)).toBe(pidOf(r1.text));
  });

  it('idle TTL destroys a parked process', async () => {
    process.env.PIKILOOM_CLAUDE_WARM_IDLE_MS = '60';
    const d = new ClaudeDriver(fake, { warmPool: true });
    driver = d;
    const r1 = await d.run(turnInput(), ctxCollect().ctx);
    expect(d.warmPoolSize()).toBe(1);
    await new Promise((r) => setTimeout(r, 200));
    expect(d.warmPoolSize()).toBe(0);
    const r2 = await d.run(turnInput({ sessionId: r1.sessionId }), ctxCollect().ctx);
    expect(r2.transport).toBe('cold');
  });

  it('dispose destroys every parked process', async () => {
    const d = new ClaudeDriver(fake, { warmPool: true });
    driver = d;
    await d.run(turnInput(), ctxCollect().ctx);
    expect(d.warmPoolSize()).toBe(1);
    d.dispose();
    expect(d.warmPoolSize()).toBe(0);
  });

  it('fingerprint covers the facts that must force a cold spawn', () => {
    const base = turnInput({ model: 'm', effort: 'high', env: { A: '1' } });
    const same = claudeProcessFingerprint('claude', { ...base, sessionId: 'x', systemPrompt: 'sys' });
    expect(claudeProcessFingerprint('claude', base)).toBe(same); // sessionId + systemPrompt excluded
    expect(claudeProcessFingerprint('claude', { ...base, model: 'other' })).not.toBe(same);
    expect(claudeProcessFingerprint('claude', { ...base, effort: 'low' })).not.toBe(same);
    expect(claudeProcessFingerprint('claude', { ...base, env: { A: '2' } })).not.toBe(same);
    expect(claudeProcessFingerprint('claude', { ...base, permissionMode: 'plan' })).not.toBe(same);
    // --session-id names the session (first-turn-only contribution) — not config material.
    expect(claudeProcessFingerprint('claude', { ...base, extraArgs: ['--session-id', 'u-u-i-d'] })).toBe(same);
    expect(claudeProcessFingerprint('claude', { ...base, extraArgs: ['--session-id', 'u-u-i-d', '--mcp-config', '/x'] }))
      .toBe(claudeProcessFingerprint('claude', { ...base, extraArgs: ['--mcp-config', '/x'] }));
    expect(claudeProcessFingerprint('claude', { ...base, extraArgs: ['--mcp-config', '/x'] })).not.toBe(same);
  });
});
