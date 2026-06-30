import { describe, it, expect, afterEach } from 'vitest';
import {
  isTerminalTaskStatus, trackClaudeBackgroundTask, pendingClaudeBackgroundTasks,
  decideClaudeResultSettle, claudeBgHoldCapMs,
} from '../packages/kernel/dist/index.js';

// Regression: the kernel claude driver used to end the turn (and hard-SIGTERM the process) at the
// first `result`. But `claude -p`, with stdin kept open, launches detached background work, ends a
// turn with `result`, then wakes itself up to report when the work finishes. Killing on the first
// `result` destroyed the background work and the wake-up (and showed "(no output)"). The driver now
// tracks the run_in_background lifecycle (task_started → terminal task_updated/task_notification)
// and HOLDS the turn while any task is pending, settling on the wake-up's result. These are the pure
// pieces of that decision. Event shapes below are taken verbatim from claude 2.1.196 stream-json.

function freshState() { return { bgStarted: new Set<string>(), bgTerminal: new Set<string>() }; }
function feed(s: any, ...events: any[]) { for (const ev of events) trackClaudeBackgroundTask(ev, s); }

describe('isTerminalTaskStatus', () => {
  it('treats finished/aborted statuses as terminal', () => {
    for (const s of ['completed', 'complete', 'done', 'success', 'succeeded', 'killed', 'failed',
      'fail', 'error', 'stopped', 'stop', 'cancelled', 'canceled', 'aborted', 'timed_out', 'timedout', 'timeout']) {
      expect(isTerminalTaskStatus(s), s).toBe(true);
    }
    expect(isTerminalTaskStatus('COMPLETED')).toBe(true); // case-insensitive
  });
  it('treats in-flight / unknown statuses as NOT terminal', () => {
    for (const s of ['running', 'in_progress', 'pending', 'queued', 'started', 'requesting', '', null, undefined]) {
      expect(isTerminalTaskStatus(s as any), String(s)).toBe(false);
    }
  });
});

describe('background task tracking (trackClaudeBackgroundTask + pendingClaudeBackgroundTasks)', () => {
  it('counts a task pending from task_started', () => {
    const s = freshState();
    feed(s, { type: 'system', subtype: 'task_started', task_id: 't1', tool_use_id: 'toolu_a', description: 'Sleep' });
    expect(pendingClaudeBackgroundTasks(s)).toBe(1);
  });

  it('clears pending on a terminal task_updated', () => {
    const s = freshState();
    feed(s,
      { type: 'system', subtype: 'task_started', task_id: 'blrb1jxuz', tool_use_id: 'toolu_a' },
      { type: 'system', subtype: 'task_updated', task_id: 'blrb1jxuz', patch: { status: 'completed' } });
    expect(pendingClaudeBackgroundTasks(s)).toBe(0);
  });

  it('clears pending on a terminal task_notification', () => {
    const s = freshState();
    feed(s,
      { type: 'system', subtype: 'task_started', task_id: 'bna8ekfwh', tool_use_id: 'toolu_b' },
      { type: 'system', subtype: 'task_notification', task_id: 'bna8ekfwh', status: 'stopped', output_file: '' });
    expect(pendingClaudeBackgroundTasks(s)).toBe(0);
  });

  it('keeps pending on a NON-terminal task_updated (progress only)', () => {
    const s = freshState();
    feed(s,
      { type: 'system', subtype: 'task_started', task_id: 't1' },
      { type: 'system', subtype: 'task_updated', task_id: 't1', patch: { status: 'running' } });
    expect(pendingClaudeBackgroundTasks(s)).toBe(1);
  });

  it('tracks multiple tasks independently', () => {
    const s = freshState();
    feed(s,
      { type: 'system', subtype: 'task_started', task_id: 't1' },
      { type: 'system', subtype: 'task_started', task_id: 't2' },
      { type: 'system', subtype: 'task_started', task_id: 't3' },
      { type: 'system', subtype: 'task_updated', task_id: 't2', patch: { status: 'completed' } });
    expect(pendingClaudeBackgroundTasks(s)).toBe(2);
  });

  it('nets to settled even if the terminal event arrives before task_started (out of order)', () => {
    const s = freshState();
    feed(s,
      { type: 'system', subtype: 'task_notification', task_id: 't1', status: 'completed' },
      { type: 'system', subtype: 'task_started', task_id: 't1' });
    expect(pendingClaudeBackgroundTasks(s)).toBe(0);
  });

  it('ignores non-task system events and id-less task events', () => {
    const s = freshState();
    feed(s,
      { type: 'system', subtype: 'init', session_id: 'x' },
      { type: 'system', subtype: 'status', status: 'requesting' },
      { type: 'system', subtype: 'task_started' }); // no task_id / tool_use_id
    expect(pendingClaudeBackgroundTasks(s)).toBe(0);
  });

  it('replays the captured claude 2.1.196 background→completion sequence', () => {
    const s = freshState();
    // launch (result #1 would HOLD here — task still pending)
    feed(s, { type: 'system', subtype: 'task_started', task_id: 'blrb1jxuz', tool_use_id: 'toolu_01', description: 'sleep 6 then echo' });
    expect(pendingClaudeBackgroundTasks(s)).toBe(1);
    // background finished → wake-up (result #2 would SETTLE here)
    feed(s,
      { type: 'system', subtype: 'task_updated', task_id: 'blrb1jxuz', patch: { status: 'completed' } },
      { type: 'system', subtype: 'task_notification', task_id: 'blrb1jxuz', status: 'completed' });
    expect(pendingClaudeBackgroundTasks(s)).toBe(0);
  });
});

describe('decideClaudeResultSettle', () => {
  it('holds the turn while background work is pending', () => {
    expect(decideClaudeResultSettle({ hasError: false, pendingBackground: 1 })).toBe('hold');
    expect(decideClaudeResultSettle({ hasError: false, pendingBackground: 3 })).toBe('hold');
  });
  it('settles when no background work is pending', () => {
    expect(decideClaudeResultSettle({ hasError: false, pendingBackground: 0 })).toBe('settle');
  });
  it('always settles on error, even with background pending (never hang a failed turn)', () => {
    expect(decideClaudeResultSettle({ hasError: true, pendingBackground: 5 })).toBe('settle');
  });
});

describe('claudeBgHoldCapMs', () => {
  const prev = process.env.PIKILOOM_CLAUDE_BG_HOLD_MS;
  afterEach(() => {
    if (prev === undefined) delete process.env.PIKILOOM_CLAUDE_BG_HOLD_MS;
    else process.env.PIKILOOM_CLAUDE_BG_HOLD_MS = prev;
  });
  it('defaults to 10 minutes', () => {
    delete process.env.PIKILOOM_CLAUDE_BG_HOLD_MS;
    expect(claudeBgHoldCapMs()).toBe(10 * 60_000);
  });
  it('honors a positive override', () => {
    process.env.PIKILOOM_CLAUDE_BG_HOLD_MS = '120000';
    expect(claudeBgHoldCapMs()).toBe(120_000);
  });
  it('ignores a non-positive / non-numeric override', () => {
    process.env.PIKILOOM_CLAUDE_BG_HOLD_MS = 'nonsense';
    expect(claudeBgHoldCapMs()).toBe(10 * 60_000);
    process.env.PIKILOOM_CLAUDE_BG_HOLD_MS = '0';
    expect(claudeBgHoldCapMs()).toBe(10 * 60_000);
  });
});
