import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { writeFileSync, chmodSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ClaudeDriver, runTurn, handleClaudeEvent, claudeTurnEndedDangling,
  claudeTruncatedRecoveryEnabled, CLAUDE_TRUNCATED_RECOVERY_PROMPT,
} from '../packages/kernel/dist/index.js';
import { composeKernelFinalPresentation } from '../src/agent/kernel-bridge.js';
import { getSessionMessages } from '../src/agent/index.ts';
import { appendTurnAudit, turnAuditPath } from '../src/core/turn-audit.js';
import { recordDeliveredTurn, loadDeliveredTurns } from '../src/agent/turn-snapshot.ts';
import { withTempHome, makeTmpDir } from './support/env.ts';

// Regression suite for the swallowed-reply family ("吞消息"): a claude turn that ends without
// its closing message must never render as a normal completion.
//  1. driver: an error result with EMPTY errors[] used to settle ok:true — silent.
//  2. driver: a clean result landing on a dangling tool loop (empty final round) used to settle
//     as a plain success; now it self-heals in-process, or settles stopReason 'truncated'.
//  3. bridge: the stalled/truncated note used to show ONLY when the text was empty, so any turn
//     with mid-turn narration swallowed its abnormal ending.
//  4. transcript: the CLI's synthetic resume repair ("No response requested.") was dropped,
//     erasing the only durable marker that a turn was cut off.

// ── driver: pure state helpers ─────────────────────────────────────────────────────────────

describe('claudeTurnEndedDangling', () => {
  it('is false before any tool use, true after a tool_result with no text, false again after text', () => {
    const s: any = { text: '', reasoning: '', streamedText: false, streamedReasoning: false, tools: new Map() };
    const noop = () => {};
    expect(claudeTurnEndedDangling(s)).toBe(false);
    handleClaudeEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } }, s, noop);
    handleClaudeEvent({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } }, s, noop);
    expect(claudeTurnEndedDangling(s)).toBe(true);
    handleClaudeEvent({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'done.' } } }, s, noop);
    expect(claudeTurnEndedDangling(s)).toBe(false);
  });

  it('a closing reply delivered only via the result payload also clears the dangling state', () => {
    const s: any = { text: '', reasoning: '', streamedText: false, streamedReasoning: false, tools: new Map() };
    const noop = () => {};
    handleClaudeEvent({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } }, s, noop);
    expect(claudeTurnEndedDangling(s)).toBe(true);
    handleClaudeEvent({ type: 'result', subtype: 'success', is_error: false, result: 'final answer' }, s, noop);
    expect(claudeTurnEndedDangling(s)).toBe(false);
    expect(s.text).toBe('final answer');
  });
});

describe('handleClaudeEvent result error derivation', () => {
  const noop = () => {};
  it('derives an error from an is_error result with EMPTY errors[] (used to settle ok silently)', () => {
    const s: any = { text: '', error: null };
    handleClaudeEvent({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: [] }, s, noop);
    expect(s.error).toBeTruthy();
    expect(String(s.error)).toContain('error_during_execution');
  });
  it('prefers the errors[] payload when present', () => {
    const s: any = { text: '', error: null };
    handleClaudeEvent({ type: 'result', is_error: true, errors: ['boom', 'again'] }, s, noop);
    expect(s.error).toBe('boom; again');
  });
  it('treats an error_* subtype as an error even without the is_error flag', () => {
    const s: any = { text: '', error: null };
    handleClaudeEvent({ type: 'result', subtype: 'error_max_turns', errors: [] }, s, noop);
    expect(s.error).toBeTruthy();
    expect(String(s.error)).toContain('error_max_turns');
  });
  it('does not copy an error result payload into the reply text', () => {
    const s: any = { text: '', error: null };
    handleClaudeEvent({ type: 'result', is_error: true, errors: [], result: 'Unable to connect to API' }, s, noop);
    expect(s.text).toBe('');
    expect(String(s.error)).toContain('Unable to connect to API');
  });
});

describe('claudeTruncatedRecoveryEnabled', () => {
  const prev = process.env.PIKILOOM_CLAUDE_TRUNCATED_RECOVERY;
  afterEach(() => {
    if (prev === undefined) delete process.env.PIKILOOM_CLAUDE_TRUNCATED_RECOVERY;
    else process.env.PIKILOOM_CLAUDE_TRUNCATED_RECOVERY = prev;
  });
  it('defaults on; 0/false/off disable it', () => {
    delete process.env.PIKILOOM_CLAUDE_TRUNCATED_RECOVERY;
    expect(claudeTruncatedRecoveryEnabled()).toBe(true);
    for (const v of ['0', 'false', 'off']) {
      process.env.PIKILOOM_CLAUDE_TRUNCATED_RECOVERY = v;
      expect(claudeTruncatedRecoveryEnabled()).toBe(false);
    }
  });
});

// ── driver: integration against a fake claude CLI ──────────────────────────────────────────
// The fake reads stream-json user messages off stdin (like claude -p with stdin held open):
// message #1 runs a tool round then ends the turn WITHOUT a closing reply; what happens next
// is scripted per test via ON_RECOVERY.

function writeFakeClaude(onRecovery: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'kernel-truncated-'));
  const bin = join(dir, 'fake-claude.mjs');
  writeFileSync(bin, `#!/usr/bin/env node
const emit = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
emit({ type: 'system', subtype: 'init', session_id: 'sess-truncated', model: 'claude-opus-4-8' });
let msgCount = 0;
let buf = '';
process.stdin.on('data', (c) => {
  buf += c.toString();
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg?.type !== 'user') continue;
    msgCount++;
    if (msgCount === 1) {
      emit({ type: 'stream_event', event: { type: 'message_start', message: { usage: { input_tokens: 10 } } } });
      emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Enabling the setting now:' } } });
      emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'gh api -X PATCH' } }], stop_reason: 'tool_use' } });
      emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'true' }] } });
      // The model's closing round comes back EMPTY — the swallowed-reply shape.
      emit({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn' });
    } else {
      ONRECOVERY(msg);
    }
  }
});
function ONRECOVERY(msg) {
${onRecovery}
}
process.stdin.on('end', () => process.exit(0));
process.stdin.on('close', () => process.exit(0));
`);
  chmodSync(bin, 0o755);
  return bin;
}

describe('truncated-turn self-heal (integration)', () => {
  const prevRecovery = process.env.PIKILOOM_CLAUDE_TRUNCATED_RECOVERY;
  const prevStall = process.env.PIKILOOM_CLAUDE_MODEL_STALL_MS;
  afterEach(() => {
    if (prevRecovery === undefined) delete process.env.PIKILOOM_CLAUDE_TRUNCATED_RECOVERY;
    else process.env.PIKILOOM_CLAUDE_TRUNCATED_RECOVERY = prevRecovery;
    if (prevStall === undefined) delete process.env.PIKILOOM_CLAUDE_MODEL_STALL_MS;
    else process.env.PIKILOOM_CLAUDE_MODEL_STALL_MS = prevStall;
  });

  it('injects one recovery prompt and delivers the closing reply in the same process', async () => {
    delete process.env.PIKILOOM_CLAUDE_TRUNCATED_RECOVERY;
    const bin = writeFakeClaude(`
  const text = JSON.stringify(msg);
  if (!text.includes('pikiloom-recover')) { emit({ type: 'result', subtype: 'success', is_error: false }); return; }
  emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Done — auto-delete is now enabled.' } } });
  emit({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', result: '' });
`);
    const driver = new ClaudeDriver(bin);
    const { result } = await runTurn(driver, { prompt: 'enable it', workdir: process.cwd() } as any);
    expect(result.ok).toBe(true);
    expect(result.stopReason).not.toBe('truncated');
    expect(result.text).toContain('Enabling the setting now:');
    expect(result.text).toContain('Done — auto-delete is now enabled.');
  }, 8000);

  it('settles stopReason "truncated" when recovery is disabled', async () => {
    process.env.PIKILOOM_CLAUDE_TRUNCATED_RECOVERY = '0';
    const bin = writeFakeClaude('  emit({ type: "result", subtype: "success", is_error: false });');
    const driver = new ClaudeDriver(bin);
    const { result } = await runTurn(driver, { prompt: 'enable it', workdir: process.cwd() } as any);
    expect(result.ok).toBe(true);
    expect(result.stopReason).toBe('truncated');
    expect(result.text).toContain('Enabling the setting now:');
  }, 8000);

  it('attempts recovery at most once — a still-dangling second result settles truncated', async () => {
    delete process.env.PIKILOOM_CLAUDE_TRUNCATED_RECOVERY;
    const bin = writeFakeClaude(`
  // Recovery round also comes back empty — must NOT loop.
  emit({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn' });
`);
    const driver = new ClaudeDriver(bin);
    const { result } = await runTurn(driver, { prompt: 'enable it', workdir: process.cwd() } as any);
    expect(result.ok).toBe(true);
    expect(result.stopReason).toBe('truncated');
  }, 8000);

  it('lets the CLI finish post-result persistence instead of SIGTERMing it at settle', async () => {
    // Regression: the CLI writes the turn into the session jsonl AFTER emitting `result`; on a
    // large session that flush is slow, and an immediate SIGTERM killed it mid-write — the reply
    // was delivered live but vanished from the transcript on the next re-render. The fake
    // simulates the late flush with a 150ms-delayed marker file: it only survives a graceful
    // (stdin-end) shutdown.
    delete process.env.PIKILOOM_CLAUDE_TRUNCATED_RECOVERY;
    const dir = mkdtempSync(join(tmpdir(), 'kernel-flush-'));
    const marker = join(dir, 'flushed');
    const bin = join(dir, 'fake-claude.mjs');
    writeFileSync(bin, `#!/usr/bin/env node
import fs from 'node:fs';
const emit = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
emit({ type: 'system', subtype: 'init', session_id: 'sess-flush', model: 'claude-opus-4-8' });
let buf = '';
process.stdin.on('data', (c) => {
  buf += c.toString();
  if (!buf.includes('\\n')) return;
  buf = '';
  emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'the reply' } } });
  emit({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn' });
  // Simulate the CLI's post-result transcript flush (slow on big sessions).
  setTimeout(() => { fs.writeFileSync(${JSON.stringify(marker)}, 'ok'); process.exit(0); }, 150);
});
process.stdin.resume();
`);
    chmodSync(bin, 0o755);
    const driver = new ClaudeDriver(bin);
    const { result } = await runTurn(driver, { prompt: 'say hi', workdir: process.cwd() } as any);
    expect(result.ok).toBe(true);
    expect(result.text).toContain('the reply');
    await new Promise(r => setTimeout(r, 600));
    expect(fs.existsSync(marker)).toBe(true);
  }, 8000);

  it('an error result with empty errors[] settles as an error (no silent ok, no recovery)', async () => {
    delete process.env.PIKILOOM_CLAUDE_TRUNCATED_RECOVERY;
    const dir = mkdtempSync(join(tmpdir(), 'kernel-err-'));
    const bin = join(dir, 'fake-claude.mjs');
    writeFileSync(bin, `#!/usr/bin/env node
const emit = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
emit({ type: 'system', subtype: 'init', session_id: 'sess-err', model: 'claude-opus-4-8' });
let buf = '';
process.stdin.on('data', (c) => {
  buf += c.toString();
  if (!buf.includes('\\n')) return;
  emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }], stop_reason: 'tool_use' } });
  emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] } });
  emit({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: [] });
  buf = '';
});
process.stdin.on('end', () => process.exit(0));
process.stdin.on('close', () => process.exit(0));
`);
    chmodSync(bin, 0o755);
    const driver = new ClaudeDriver(bin);
    const { result } = await runTurn(driver, { prompt: 'ls', workdir: process.cwd() } as any);
    expect(result.ok).toBe(false);
    expect(String(result.error || '')).toContain('error_during_execution');
  }, 8000);
});

// ── bridge: final presentation ──────────────────────────────────────────────────────────────

describe('composeKernelFinalPresentation', () => {
  it('appends the truncated note to a non-empty narration (the exact swallow shape)', () => {
    const p = composeKernelFinalPresentation({
      bodyText: 'mirasim 这个库上有 admin 权限，直接把"合并后自动删分支"也开了：',
      finalError: null, ok: true, stopReason: 'truncated',
    });
    expect(p.message).toContain('也开了：');
    expect(p.message).toContain('⚠️');
    expect(p.message).toContain('without a closing message');
    expect(p.incomplete).toBe(true);
  });
  it('appends the stalled note to a non-empty narration', () => {
    const p = composeKernelFinalPresentation({ bodyText: 'checking…', finalError: null, ok: false, stopReason: 'stalled' });
    expect(p.message).toContain('checking…');
    expect(p.message).toContain('stalled');
    expect(p.incomplete).toBe(true);
  });
  it('keeps the empty-text substitutions intact (stalled / background / clean / failed)', () => {
    expect(composeKernelFinalPresentation({ bodyText: '', finalError: null, ok: false, stopReason: 'stalled' }).message)
      .toContain('stalled');
    expect(composeKernelFinalPresentation({ bodyText: '', finalError: null, ok: true, stopReason: 'background' }).message)
      .toContain('background');
    expect(composeKernelFinalPresentation({ bodyText: '', finalError: null, ok: true, stopReason: null }).message)
      .toBe('(no textual response)');
    expect(composeKernelFinalPresentation({ bodyText: '', finalError: null, ok: false, stopReason: null }).message)
      .toBe('(no output)');
    expect(composeKernelFinalPresentation({ bodyText: '', finalError: 'boom', ok: false, stopReason: null }).message)
      .toBe('boom');
  });
  it('leaves a normal completed turn untouched', () => {
    const p = composeKernelFinalPresentation({ bodyText: 'all done.', finalError: null, ok: true, stopReason: 'end_turn' });
    expect(p.message).toBe('all done.');
    expect(p.incomplete).toBe(false);
  });
});

// ── transcript: the synthetic resume pair becomes a visible incomplete-turn notice ─────────

describe('transcript rendering of a dangling turn', () => {
  it('surfaces "No response requested." as an incomplete-turn notice and hides the repair prompt', async () => {
    await withTempHome(async (homeDir) => {
      const workdir = '/Users/test/dangling';
      const projectDir = path.join(homeDir, '.claude', 'projects', '-Users-test-dangling');
      const sessionId = 'sess-dangling';
      fs.mkdirSync(projectDir, { recursive: true });
      const events = [
        { type: 'user', message: { role: 'user', content: [{ type: 'text', text: '你切换到 mirofish-ai 吧' }] } },
        { type: 'assistant', message: { content: [{ type: 'text', text: '好，先看看现在哪些地方还指向 ApodexCode：' }] } },
        { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'gh repo set-default' } }] } },
        { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] }, isMeta: false },
        // The CLI's resume-time repair pair for the dangling turn:
        { type: 'user', isMeta: true, message: { role: 'user', content: [{ type: 'text', text: 'Continue from where you left off.' }] } },
        { type: 'assistant', message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: 'No response requested.' }] } },
        { type: 'user', message: { role: 'user', content: [{ type: 'text', text: '还是有很多啊' }] } },
        { type: 'assistant', message: { content: [{ type: 'text', text: '分支数已经从 48 降到 8 了' }] } },
      ];
      fs.writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), events.map(e => JSON.stringify(e)).join('\n'));

      const result = await getSessionMessages({ agent: 'claude', sessionId, workdir, rich: true } as any);
      expect(result.ok).toBe(true);
      const rich = result.richMessages || [];
      const notices = rich.flatMap(m => m.blocks || []).filter((b: any) => b.type === 'system_notice');
      expect(notices.length).toBe(1);
      expect(String(notices[0].content)).toContain('ended before a closing message');
      // The raw tombstone strings must not leak into any bubble.
      const allText = rich.map(m => m.text).join('\n');
      expect(allText).not.toContain('Continue from where you left off.');
      expect(allText).not.toContain('No response requested.');
      // The real user messages are untouched.
      const userMsgs = rich.filter(m => m.role === 'user').map(m => m.text);
      expect(userMsgs).toEqual(['你切换到 mirofish-ai 吧', '还是有很多啊']);
    });
  });

  it('hides the driver-injected <pikiloom-recover> prompt from the transcript', async () => {
    await withTempHome(async (homeDir) => {
      const workdir = '/Users/test/recover';
      const projectDir = path.join(homeDir, '.claude', 'projects', '-Users-test-recover');
      const sessionId = 'sess-recover';
      fs.mkdirSync(projectDir, { recursive: true });
      const events = [
        { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'do the thing' }] } },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'working on it:' }] } },
        { type: 'user', message: { role: 'user', content: [{ type: 'text', text: CLAUDE_TRUNCATED_RECOVERY_PROMPT }] } },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'done — here is the summary.' }] } },
      ];
      fs.writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), events.map(e => JSON.stringify(e)).join('\n'));

      const result = await getSessionMessages({ agent: 'claude', sessionId, workdir, rich: true } as any);
      expect(result.ok).toBe(true);
      const rich = result.richMessages || [];
      const userMsgs = rich.filter(m => m.role === 'user').map(m => m.text);
      expect(userMsgs).toEqual(['do the thing']);
      expect(rich.map(m => m.text).join('\n')).not.toContain('pikiloom-recover');
    });
  });

  it('restores a swallowed reply from the delivery snapshot at a tombstone', async () => {
    await withTempHome(async (homeDir) => {
      const workdir = '/Users/test/swallow';
      const projectDir = path.join(homeDir, '.claude', 'projects', '-Users-test-swallow');
      const sessionId = 'sess-swallow';
      fs.mkdirSync(projectDir, { recursive: true });
      // The exact bug shape: a user prompt whose (delivered) assistant reply never landed in the
      // jsonl, followed by the CLI's resume-repair tombstone, then the next turn.
      const events = [
        { type: 'user', message: { role: 'user', content: [{ type: 'text', text: '你帮我针对这个用户起草一份回复邮件' }] } },
        { type: 'user', isMeta: true, message: { role: 'user', content: [{ type: 'text', text: 'Continue from where you left off.' }] } },
        { type: 'assistant', message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: 'No response requested.' }] } },
        { type: 'user', message: { role: 'user', content: [{ type: 'text', text: '结果呢' }] } },
        { type: 'assistant', message: { content: [{ type: 'text', text: '这封邮件顺带证实了……' }] } },
      ];
      fs.writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), events.map(e => JSON.stringify(e)).join('\n'));

      const draft = 'Subject: RE: payment confirmation\n\nHi PK,\n\n这是我为你起草的回复邮件正文……';
      recordDeliveredTurn({
        sessionId, prompt: '你帮我针对这个用户起草一份回复邮件',
        message: draft, model: 'claude-opus-4-8', ok: true, stopReason: 'end_turn',
      });

      const result = await getSessionMessages({ agent: 'claude', sessionId, workdir, rich: true } as any);
      expect(result.ok).toBe(true);
      const rich = result.richMessages || [];
      // The tombstone turn now carries the restored draft, not the "ended before a closing" notice.
      const allText = rich.map(m => m.text).join('\n');
      expect(allText).toContain('这是我为你起草的回复邮件正文');
      expect(allText).not.toContain('ended before a closing message');
      expect(allText).not.toContain('No response requested.');
      const notices = rich.flatMap(m => m.blocks || []).filter((b: any) => b.type === 'system_notice');
      expect(notices.length).toBe(1);
      expect(String(notices[0].content)).toContain('Restored by pikiloom');
      // The follow-up turn ("结果呢") is untouched and not double-restored.
      const userMsgs = rich.filter(m => m.role === 'user').map(m => m.text);
      expect(userMsgs).toEqual(['你帮我针对这个用户起草一份回复邮件', '结果呢']);
    });
  });

  it('leaves the incomplete-turn notice when no delivery snapshot exists for the prompt', async () => {
    await withTempHome(async (homeDir) => {
      const workdir = '/Users/test/nosnap';
      const projectDir = path.join(homeDir, '.claude', 'projects', '-Users-test-nosnap');
      const sessionId = 'sess-nosnap';
      fs.mkdirSync(projectDir, { recursive: true });
      const events = [
        { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'draft me an email' }] } },
        { type: 'user', isMeta: true, message: { role: 'user', content: [{ type: 'text', text: 'Continue from where you left off.' }] } },
        { type: 'assistant', message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: 'No response requested.' }] } },
      ];
      fs.writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), events.map(e => JSON.stringify(e)).join('\n'));

      const result = await getSessionMessages({ agent: 'claude', sessionId, workdir, rich: true } as any);
      const rich = result.richMessages || [];
      const notices = rich.flatMap(m => m.blocks || []).filter((b: any) => b.type === 'system_notice');
      expect(notices.length).toBe(1);
      expect(String(notices[0].content)).toContain('ended before a closing message');
    });
  });
});

// ── delivery snapshot store ─────────────────────────────────────────────────────────────────

describe('recordDeliveredTurn', () => {
  it('persists real prose, strips a trailing incomplete-notice, and skips placeholders', async () => {
    await withTempHome(async () => {
      const sessionId = 'sess-store';
      recordDeliveredTurn({ sessionId, prompt: 'p1', message: 'the real answer\n\n⚠️ The turn stopped responding after tool use. Send any message to continue.', model: 'm', ok: false, stopReason: 'stalled' });
      recordDeliveredTurn({ sessionId, prompt: 'p2', message: '(no textual response)', model: 'm', ok: true, stopReason: 'end_turn' });
      recordDeliveredTurn({ sessionId, prompt: 'p3', message: '   ', model: 'm', ok: true, stopReason: 'end_turn' });
      const turns = loadDeliveredTurns(sessionId);
      expect(turns.map(t => t.prompt)).toEqual(['p1']);
      expect(turns[0].text).toBe('the real answer');
    });
  });

  it('no-ops without a sessionId', async () => {
    await withTempHome(async () => {
      recordDeliveredTurn({ sessionId: null, prompt: 'p', message: 'x', model: null, ok: true, stopReason: null });
      expect(loadDeliveredTurns(null)).toEqual([]);
    });
  });
});

// ── turn-end audit trail ────────────────────────────────────────────────────────────────────

describe('turn-end audit log', () => {
  const prev = process.env.PIKILOOM_CONFIG;
  afterEach(() => {
    if (prev === undefined) delete process.env.PIKILOOM_CONFIG;
    else process.env.PIKILOOM_CONFIG = prev;
  });

  it('appends one JSON line per turn under the active config home', () => {
    const dir = makeTmpDir('turn-audit');
    process.env.PIKILOOM_CONFIG = path.join(dir, 'setting.json');
    appendTurnAudit({
      agent: 'claude', sessionId: 'sess-1', ok: true, stopReason: 'truncated',
      incomplete: true, error: null, elapsedS: 12.3, model: 'claude-fable-5', promptPreview: '你切换到 mirofish-ai 吧',
    });
    const file = turnAuditPath();
    expect(file).toBe(path.join(dir, 'logs', 'turn-audit.jsonl'));
    const lines = fs.readFileSync(file, 'utf-8').trim().split('\n');
    expect(lines.length).toBe(1);
    const entry = JSON.parse(lines[0]);
    expect(entry.agent).toBe('claude');
    expect(entry.stopReason).toBe('truncated');
    expect(entry.incomplete).toBe(true);
    expect(typeof entry.ts).toBe('string');
  });
});
