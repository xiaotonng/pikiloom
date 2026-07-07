import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, chmodSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeDriver, runTurn } from '../packages/kernel/dist/index.js';
// White-box settle heuristics live at the module path, off the public barrel.
import {
  isClaudeSyntheticResumeNoise, claudeProducedRealOutput, claudeResumeNoopRetryLimit,
  handleClaudeEvent,
} from '../packages/kernel/dist/drivers/claude.js';

// Regression: resuming a claude session whose PREVIOUS turn was left incomplete (a background hold
// that reclaimed its sub-agents/workflow — the ultra "no response" report — an interrupt, a stall)
// makes the CLI answer with a synthetic "No response requested." no-op that ran none of our prompt,
// instead of processing the message. The driver used to settle on that empty result → the user saw
// a silent "(no textual response)" in ~0s and had to re-send several times. The driver now detects a
// resume that produced NO real model output and re-issues the prompt over the still-open stdin
// (bounded) so the CLI drives through its repair to a real answer within the one turn.

describe('isClaudeSyntheticResumeNoise', () => {
  it('matches the CLI resume-repair placeholder (case / trailing-dot insensitive)', () => {
    expect(isClaudeSyntheticResumeNoise('No response requested.')).toBe(true);
    expect(isClaudeSyntheticResumeNoise('  no response requested  ')).toBe(true);
    expect(isClaudeSyntheticResumeNoise('No response requested')).toBe(true);
  });
  it('does not match real model text or emptiness', () => {
    expect(isClaudeSyntheticResumeNoise('Here is your answer.')).toBe(false);
    expect(isClaudeSyntheticResumeNoise('')).toBe(false);
    expect(isClaudeSyntheticResumeNoise('No response requested yet, working on it')).toBe(false);
  });
});

describe('claudeProducedRealOutput', () => {
  it('is false for a fresh / pure no-op turn state', () => {
    expect(claudeProducedRealOutput({})).toBe(false);
    expect(claudeProducedRealOutput({ text: '', reasoning: '', tools: new Map(), subAgents: new Map() })).toBe(false);
    expect(claudeProducedRealOutput({ text: '   ' })).toBe(false);
  });
  it('is true once any real output landed (streamed text, whole text, tools, or a sub-agent)', () => {
    expect(claudeProducedRealOutput({ streamedText: true })).toBe(true);
    expect(claudeProducedRealOutput({ streamedReasoning: true })).toBe(true);
    expect(claudeProducedRealOutput({ text: 'hello' })).toBe(true);
    expect(claudeProducedRealOutput({ reasoning: 'thinking' })).toBe(true);
    expect(claudeProducedRealOutput({ tools: new Map([['t1', { name: 'Bash', summary: '' }]]) })).toBe(true);
    expect(claudeProducedRealOutput({ subAgents: new Map([['a1', {}]]) })).toBe(true);
  });
  it('a skipped synthetic resume-repair assistant message leaves the state a no-op', () => {
    const s: any = { text: '', reasoning: '', tools: new Map(), subAgents: new Map() };
    handleClaudeEvent({ type: 'assistant', message: { model: '<synthetic>', content: [{ type: 'text', text: 'No response requested.' }] } }, s, () => {});
    expect(s.text).toBe('');
    expect(claudeProducedRealOutput(s)).toBe(false);
  });
  it('a real assistant text message counts as output', () => {
    const s: any = { text: '', reasoning: '', tools: new Map(), subAgents: new Map() };
    handleClaudeEvent({ type: 'assistant', message: { model: 'claude-opus-4-8', content: [{ type: 'text', text: 'actual reply' }] } }, s, () => {});
    expect(s.text).toBe('actual reply');
    expect(claudeProducedRealOutput(s)).toBe(true);
  });
});

describe('claudeResumeNoopRetryLimit', () => {
  const prev = process.env.PIKILOOM_CLAUDE_RESUME_NOOP_RETRIES;
  afterEach(() => {
    if (prev === undefined) delete process.env.PIKILOOM_CLAUDE_RESUME_NOOP_RETRIES;
    else process.env.PIKILOOM_CLAUDE_RESUME_NOOP_RETRIES = prev;
  });
  it('defaults to 3', () => {
    delete process.env.PIKILOOM_CLAUDE_RESUME_NOOP_RETRIES;
    expect(claudeResumeNoopRetryLimit()).toBe(3);
  });
  it('honors an override, including 0 to disable', () => {
    process.env.PIKILOOM_CLAUDE_RESUME_NOOP_RETRIES = '5';
    expect(claudeResumeNoopRetryLimit()).toBe(5);
    process.env.PIKILOOM_CLAUDE_RESUME_NOOP_RETRIES = '0';
    expect(claudeResumeNoopRetryLimit()).toBe(0);
  });
  it('ignores a negative / garbage override', () => {
    process.env.PIKILOOM_CLAUDE_RESUME_NOOP_RETRIES = '-2';
    expect(claudeResumeNoopRetryLimit()).toBe(3);
    process.env.PIKILOOM_CLAUDE_RESUME_NOOP_RETRIES = 'nope';
    expect(claudeResumeNoopRetryLimit()).toBe(3);
  });
});

// A fake `claude` that emits `onFirstResult` immediately (the resume no-op repair), then runs
// `perStdin(count)` for each user message it receives on stdin (count is 1-based). Stays alive
// until stdin closes, mirroring `claude -p` with stdin held open.
function writeFakeClaude(onStart: string, perStdin: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'kernel-noop-'));
  const bin = join(dir, 'fake-claude.mjs');
  writeFileSync(bin, `#!/usr/bin/env node
const emit = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
emit({ type: 'system', subtype: 'init', session_id: 'sess-test', model: 'claude-opus-4-8' });
${onStart}
let count = 0, buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  const lines = buf.split('\\n'); buf = lines.pop() || '';
  for (const line of lines) {
    if (!line.trim()) continue;
    count++;
    (function(count){ ${perStdin} })(count);
  }
});
process.stdin.on('end', () => process.exit(0));
process.stdin.on('close', () => process.exit(0));
`);
  chmodSync(bin, 0o755);
  return bin;
}

const REAL_ANSWER = `
emit({ type: 'stream_event', event: { type: 'message_start', message: { usage: { input_tokens: 10 } } } });
emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'real answer' } } });
emit({ type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: 'end_turn' } } });
emit({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', result: 'real answer' });
`;

describe('no-op resume recovery (integration)', () => {
  const prevRetries = process.env.PIKILOOM_CLAUDE_RESUME_NOOP_RETRIES;
  const prevStall = process.env.PIKILOOM_CLAUDE_MODEL_STALL_MS;
  afterEach(() => {
    if (prevRetries === undefined) delete process.env.PIKILOOM_CLAUDE_RESUME_NOOP_RETRIES;
    else process.env.PIKILOOM_CLAUDE_RESUME_NOOP_RETRIES = prevRetries;
    if (prevStall === undefined) delete process.env.PIKILOOM_CLAUDE_MODEL_STALL_MS;
    else process.env.PIKILOOM_CLAUDE_MODEL_STALL_MS = prevStall;
  });

  it('re-issues the prompt when a resume no-ops, then delivers the real answer', async () => {
    // Immediate empty no-op result (the synthetic repair); the real answer only comes once the
    // driver re-injects the prompt (the 2nd stdin message).
    const bin = writeFakeClaude(
      `emit({ type: 'result', subtype: 'success', is_error: false });`,
      `if (count === 2) { ${REAL_ANSWER} }`,
    );
    const driver = new ClaudeDriver(bin);
    const { result } = await runTurn(driver, { prompt: 'do the thing', workdir: process.cwd(), sessionId: 'sess-existing' } as any);
    expect(result.ok).toBe(true);
    expect(result.text).toContain('real answer');
  }, 8000);

  it('does NOT re-issue on a fresh session (no sessionId) — an empty result settles as-is', async () => {
    // Same immediate empty result, but with no sessionId it is a fresh turn, not a poisoned resume,
    // so the driver must settle rather than loop.
    const bin = writeFakeClaude(
      `emit({ type: 'result', subtype: 'success', is_error: false });`,
      `if (count === 2) { ${REAL_ANSWER} }`,
    );
    const driver = new ClaudeDriver(bin);
    const { result } = await runTurn(driver, { prompt: 'first message', workdir: process.cwd() } as any);
    expect((result.text || '').trim()).toBe('');
    expect(result.text).not.toContain('real answer');
  }, 8000);

  it('does not re-issue when the resume answers for real on the first try', async () => {
    const bin = writeFakeClaude(``, `if (count === 1) { ${REAL_ANSWER} }`);
    const driver = new ClaudeDriver(bin);
    const { result } = await runTurn(driver, { prompt: 'hi again', workdir: process.cwd(), sessionId: 'sess-existing' } as any);
    expect(result.ok).toBe(true);
    expect(result.text).toContain('real answer');
  }, 8000);

  it('is bounded — a session that always no-ops settles empty instead of looping forever', async () => {
    process.env.PIKILOOM_CLAUDE_RESUME_NOOP_RETRIES = '2';
    process.env.PIKILOOM_CLAUDE_MODEL_STALL_MS = '400';
    // Every stdin message answered with an empty no-op result: the driver re-injects up to the
    // limit, then gives up and settles (must terminate, not hang).
    const bin = writeFakeClaude(
      `emit({ type: 'result', subtype: 'success', is_error: false });`,
      `emit({ type: 'result', subtype: 'success', is_error: false });`,
    );
    const driver = new ClaudeDriver(bin);
    const { result } = await runTurn(driver, { prompt: 'poisoned', workdir: process.cwd(), sessionId: 'sess-existing' } as any);
    expect((result.text || '').trim()).toBe('');
  }, 8000);
});
