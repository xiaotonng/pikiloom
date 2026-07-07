import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, chmodSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ClaudeDriver, runTurn, trackClaudeBackgroundTask,
  claudeTurnHasAgentBackground, claudeBgAgentHoldCapMs, claudeBgHoldRecheckMs,
} from '../packages/kernel/dist/index.js';
import { composeKernelFinalPresentation } from '../src/agent/kernel-bridge.js';

// Regression 2026-07-06 ("停止不再继续生成"): a research turn with 4 background Explore
// sub-agents hit the 10-minute background hold cap MID-FLIGHT — 22s after its last
// tool_result, while wake-ups were still being processed — and settled 'background'.
// The graceful close then killed the still-running agents, and the bridge showed nothing
// because the turn had narration text. Three fixes under test here:
//   1. sub-agent-backed holds use the (much longer) agent hold cap;
//   2. a cap firing while events still flow defers instead of cutting a working turn;
//   3. a 'background' settle WITH narration appends a visible note (incomplete=true).

const BG_ENV = [
  'PIKILOOM_CLAUDE_BG_HOLD_MS',
  'PIKILOOM_CLAUDE_BG_AGENT_HOLD_MS',
  'PIKILOOM_CLAUDE_BG_SETTLE_QUIET_MS',
  'PIKILOOM_CLAUDE_BG_HOLD_RECHECK_MS',
  'PIKILOOM_CLAUDE_TRUNCATED_RECOVERY',
] as const;

function snapshotEnv(): Record<string, string | undefined> {
  const snap: Record<string, string | undefined> = {};
  for (const k of BG_ENV) snap[k] = process.env[k];
  return snap;
}
function restoreEnv(snap: Record<string, string | undefined>) {
  for (const k of BG_ENV) {
    if (snap[k] === undefined) delete process.env[k];
    else process.env[k] = snap[k]!;
  }
}

describe('agent-type background tracking', () => {
  it('marks a task launched by a Task/Agent tool as agent-backed', () => {
    const s: any = { subAgents: new Map([['toolu_agent1', { id: 'toolu_agent1' }]]) };
    trackClaudeBackgroundTask({ type: 'system', subtype: 'task_started', task_id: 'bg1', tool_use_id: 'toolu_agent1' }, s);
    expect(claudeTurnHasAgentBackground(s)).toBe(true);
  });

  it('a detached shell task is NOT agent-backed (keeps the short daemon cap)', () => {
    const s: any = { subAgents: new Map() };
    trackClaudeBackgroundTask({ type: 'system', subtype: 'task_started', task_id: 'bg2', tool_use_id: 'toolu_bash1' }, s);
    expect(claudeTurnHasAgentBackground(s)).toBe(false);
    expect(claudeTurnHasAgentBackground({})).toBe(false);
  });
});

describe('hold-cap knobs', () => {
  const snap = snapshotEnv();
  afterEach(() => restoreEnv(snap));

  it('agent hold cap defaults to 45min and honors its env override', () => {
    delete process.env.PIKILOOM_CLAUDE_BG_AGENT_HOLD_MS;
    expect(claudeBgAgentHoldCapMs()).toBe(45 * 60_000);
    process.env.PIKILOOM_CLAUDE_BG_AGENT_HOLD_MS = '1234';
    expect(claudeBgAgentHoldCapMs()).toBe(1234);
  });

  it('hold recheck defaults to 30s and honors its env override', () => {
    delete process.env.PIKILOOM_CLAUDE_BG_HOLD_RECHECK_MS;
    expect(claudeBgHoldRecheckMs()).toBe(30_000);
    process.env.PIKILOOM_CLAUDE_BG_HOLD_RECHECK_MS = '150';
    expect(claudeBgHoldRecheckMs()).toBe(150);
  });
});

describe('bridge presentation of a background settle', () => {
  it('appends a visible note when narration exists (the silent-stop shape)', () => {
    const p = composeKernelFinalPresentation({
      bodyText: '我先做全面调研——摸清两个项目的现状,然后设计分层方案再动手迁移。',
      finalError: null, ok: true, stopReason: 'background',
    });
    expect(p.message).toContain('调研');
    expect(p.message).toContain('hold limit');
    expect(p.incomplete).toBe(true);
  });

  it('keeps the friendly substitution for an intentional detached launch (no narration)', () => {
    const p = composeKernelFinalPresentation({ bodyText: '', finalError: null, ok: true, stopReason: 'background' });
    expect(p.message).toContain('running in the background');
    expect(p.incomplete).toBe(false);
  });
});

// ── integration: fake claude with background lifecycle ─────────────────────────────────────

function writeBgFakeClaude(script: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'kernel-bghold-'));
  const bin = join(dir, 'fake-claude.mjs');
  writeFileSync(bin, `#!/usr/bin/env node
const emit = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
emit({ type: 'system', subtype: 'init', session_id: 'sess-bghold', model: 'claude-opus-4-8' });
let buf = '';
let started = false;
process.stdin.on('data', (c) => {
  buf += c.toString();
  if (!buf.includes('\\n') || started) return;
  started = true;
  ${script}
});
process.stdin.resume();
process.stdin.on('end', () => process.exit(0));
process.stdin.on('close', () => process.exit(0));
`);
  chmodSync(bin, 0o755);
  return bin;
}

describe('background hold cap (integration)', () => {
  const snap = snapshotEnv();
  afterEach(() => restoreEnv(snap));

  it('an agent-backed hold survives past the short daemon cap and delivers the wake-up', async () => {
    process.env.PIKILOOM_CLAUDE_BG_HOLD_MS = '250';          // daemon cap: would fire long before the wake-up
    process.env.PIKILOOM_CLAUDE_BG_AGENT_HOLD_MS = '5000';   // agent cap: comfortably after it
    process.env.PIKILOOM_CLAUDE_BG_SETTLE_QUIET_MS = '120';
    process.env.PIKILOOM_CLAUDE_BG_HOLD_RECHECK_MS = '100';
    delete process.env.PIKILOOM_CLAUDE_TRUNCATED_RECOVERY;
    const bin = writeBgFakeClaude(`
  emit({ type: 'assistant', message: { role: 'assistant', content: [
    { type: 'text', text: '派出研究代理:' },
    { type: 'tool_use', id: 'toolu_ag', name: 'Task', input: { description: 'map repo', subagent_type: 'Explore' } },
  ] } });
  emit({ type: 'system', subtype: 'task_started', task_id: 'bg1', tool_use_id: 'toolu_ag', description: 'map repo' });
  emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_ag', content: 'launched' }] } });
  emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '等待代理结果。' } } });
  emit({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn' });
  setTimeout(() => {
    emit({ type: 'system', subtype: 'task_notification', task_id: 'bg1', status: 'completed' });
    emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '代理完成:两个仓库已摸清。' } } });
    emit({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn' });
  }, 900);
`);
    const driver = new ClaudeDriver(bin);
    const { result } = await runTurn(driver, { prompt: 'research', workdir: process.cwd() } as any);
    expect(result.ok).toBe(true);
    expect(result.stopReason).not.toBe('background');
    expect(result.text).toContain('代理完成');
  }, 10000);

  it('the cap still settles a genuinely silent daemon hold as background', async () => {
    process.env.PIKILOOM_CLAUDE_BG_HOLD_MS = '250';
    process.env.PIKILOOM_CLAUDE_BG_SETTLE_QUIET_MS = '80';
    process.env.PIKILOOM_CLAUDE_BG_HOLD_RECHECK_MS = '100';
    delete process.env.PIKILOOM_CLAUDE_TRUNCATED_RECOVERY;
    const bin = writeBgFakeClaude(`
  emit({ type: 'assistant', message: { role: 'assistant', content: [
    { type: 'text', text: '启动守护进程:' },
    { type: 'tool_use', id: 'toolu_sh', name: 'Bash', input: { command: 'server --daemon', run_in_background: true } },
  ] } });
  emit({ type: 'system', subtype: 'task_started', task_id: 'bgd', tool_use_id: 'toolu_sh', description: 'daemon' });
  emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_sh', content: 'started' }] } });
  emit({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn' });
  // then silence forever — the daemon never completes
`);
    const driver = new ClaudeDriver(bin);
    const { result } = await runTurn(driver, { prompt: 'start daemon', workdir: process.cwd() } as any);
    expect(result.stopReason).toBe('background');
    expect(result.ok).toBe(true);
  }, 10000);

  it('a cap firing while events still flow defers instead of cutting the turn', async () => {
    process.env.PIKILOOM_CLAUDE_BG_HOLD_MS = '200';           // fires almost immediately
    process.env.PIKILOOM_CLAUDE_BG_SETTLE_QUIET_MS = '400';   // "recently active" window
    process.env.PIKILOOM_CLAUDE_BG_HOLD_RECHECK_MS = '120';
    delete process.env.PIKILOOM_CLAUDE_TRUNCATED_RECOVERY;
    const bin = writeBgFakeClaude(`
  emit({ type: 'assistant', message: { role: 'assistant', content: [
    { type: 'tool_use', id: 'toolu_sh', name: 'Bash', input: { command: 'work', run_in_background: true } },
  ] } });
  emit({ type: 'system', subtype: 'task_started', task_id: 'bgw', tool_use_id: 'toolu_sh' });
  emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_sh', content: 'started' }] } });
  emit({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn' });
  // keep the stream ACTIVE past several cap rechecks, then finish properly
  let ticks = 0;
  const iv = setInterval(() => {
    ticks++;
    emit({ type: 'system', subtype: 'task_updated', task_id: 'bgw', patch: { status: 'running' } });
    if (ticks >= 5) {
      clearInterval(iv);
      emit({ type: 'system', subtype: 'task_notification', task_id: 'bgw', status: 'completed' });
      emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '后台完成。' } } });
      emit({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn' });
    }
  }, 150);
`);
    const driver = new ClaudeDriver(bin);
    const { result } = await runTurn(driver, { prompt: 'work', workdir: process.cwd() } as any);
    expect(result.ok).toBe(true);
    expect(result.stopReason).not.toBe('background');
    expect(result.text).toContain('后台完成');
  }, 10000);
});
