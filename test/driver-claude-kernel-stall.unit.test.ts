import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, chmodSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeDriver, runTurn } from '../packages/kernel/dist/index.js';
// White-box settle heuristics live at the module path, off the public barrel.
import { claudeModelStallMs, claudeUserEventHasToolResult } from '../packages/kernel/dist/drivers/claude.js';

// Regression: the kernel claude driver settled a turn ONLY on `result`, abort, or process close.
// `claude -p` (stdin kept open) emits exactly one `result` at end_turn and otherwise stays alive,
// so if the model went silent AFTER a tool_result (a provider stall / rate-limit backoff) the turn
// hung forever — the tools finished but the answer was never delivered ("结果被吞掉了"). The driver
// now arms a post-tool stall watchdog: armed on a tool_result with no background pending, cleared
// the moment the model streams anything, and — if it fires — settles the turn as an INCOMPLETE
// 'stalled' result instead of hanging. It must NEVER arm while a tool or background task is still
// running (those legitimately produce no stream events), which is why arming keys off tool_result.

describe('claudeUserEventHasToolResult', () => {
  it('is true for a user event carrying a tool_result block', () => {
    expect(claudeUserEventHasToolResult({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] },
    })).toBe(true);
  });
  it('is false for a plain user text turn (no control handed back to the model)', () => {
    expect(claudeUserEventHasToolResult({
      type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    })).toBe(false);
  });
  it('is false for malformed / non-array content', () => {
    expect(claudeUserEventHasToolResult({ type: 'user', message: { role: 'user', content: 'hi' } })).toBe(false);
    expect(claudeUserEventHasToolResult({})).toBe(false);
    expect(claudeUserEventHasToolResult(null)).toBe(false);
  });
});

describe('claudeModelStallMs', () => {
  const prev = process.env.PIKILOOM_CLAUDE_MODEL_STALL_MS;
  afterEach(() => {
    if (prev === undefined) delete process.env.PIKILOOM_CLAUDE_MODEL_STALL_MS;
    else process.env.PIKILOOM_CLAUDE_MODEL_STALL_MS = prev;
  });
  it('defaults to 120s', () => {
    delete process.env.PIKILOOM_CLAUDE_MODEL_STALL_MS;
    expect(claudeModelStallMs()).toBe(120_000);
  });
  it('honors a positive env override', () => {
    process.env.PIKILOOM_CLAUDE_MODEL_STALL_MS = '5000';
    expect(claudeModelStallMs()).toBe(5000);
  });
  it('ignores a non-positive / garbage override', () => {
    process.env.PIKILOOM_CLAUDE_MODEL_STALL_MS = '-1';
    expect(claudeModelStallMs()).toBe(120_000);
    process.env.PIKILOOM_CLAUDE_MODEL_STALL_MS = 'nope';
    expect(claudeModelStallMs()).toBe(120_000);
  });
});

// Drive the real ClaudeDriver against a fake `claude` binary that emits a tool round then goes
// silent — the watchdog must settle the turn as an incomplete 'stalled' result.
function writeFakeClaude(bodyAfterInit: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'kernel-stall-'));
  const bin = join(dir, 'fake-claude.mjs');
  writeFileSync(bin, `#!/usr/bin/env node
const emit = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
emit({ type: 'system', subtype: 'init', session_id: 'sess-test', model: 'claude-opus-4-8' });
emit({ type: 'stream_event', event: { type: 'message_start', message: { usage: { input_tokens: 10 } } } });
${bodyAfterInit}
// Stay alive until the driver closes stdin (mirrors claude -p with stdin held open).
process.stdin.resume();
process.stdin.on('end', () => process.exit(0));
process.stdin.on('close', () => process.exit(0));
`);
  chmodSync(bin, 0o755);
  return bin;
}

describe('post-tool model-stall watchdog (integration)', () => {
  const prev = process.env.PIKILOOM_CLAUDE_MODEL_STALL_MS;
  afterEach(() => {
    if (prev === undefined) delete process.env.PIKILOOM_CLAUDE_MODEL_STALL_MS;
    else process.env.PIKILOOM_CLAUDE_MODEL_STALL_MS = prev;
  });

  it('settles an incomplete "stalled" result when the model goes silent after a tool_result', async () => {
    process.env.PIKILOOM_CLAUDE_MODEL_STALL_MS = '200';
    const bin = writeFakeClaude(`
emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'grep x a.txt' } }], stop_reason: 'tool_use' } });
emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'match', is_error: false }] } });
// then silence — never deliver the model's reply
`);
    const driver = new ClaudeDriver(bin);
    const { result } = await runTurn(driver, { prompt: 'find x', workdir: process.cwd() } as any);
    expect(result.stopReason).toBe('stalled');
    expect(result.ok).toBe(false);
    expect((result.text || '').trim()).toBe('');
  }, 8000);

  it('does NOT stall when the model replies after the tool_result', async () => {
    process.env.PIKILOOM_CLAUDE_MODEL_STALL_MS = '400';
    const bin = writeFakeClaude(`
emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'grep x a.txt' } }], stop_reason: 'tool_use' } });
emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'match', is_error: false }] } });
// model replies well within the stall window, then ends the turn cleanly
setTimeout(() => {
  emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'found it' } } });
  emit({ type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: 'end_turn' } } });
  emit({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', result: 'found it' });
}, 80);
`);
    const driver = new ClaudeDriver(bin);
    const { result } = await runTurn(driver, { prompt: 'find x', workdir: process.cwd() } as any);
    expect(result.ok).toBe(true);
    expect(result.stopReason).not.toBe('stalled');
    expect(result.text).toContain('found it');
  }, 8000);
});
