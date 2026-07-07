import { describe, it, expect, afterEach } from 'vitest';
// White-box settle heuristics live at the module path, off the public barrel.
import {
  isTerminalTaskStatus, trackClaudeBackgroundTask, pendingClaudeBackgroundTasks,
  markClaudeTaskNotificationTerminal,
  decideClaudeResultSettle, claudeBgHoldCapMs, claudeBgSettleQuietMs,
} from '../packages/kernel/dist/drivers/claude.js';

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

describe('markClaudeTaskNotificationTerminal (wake-up delivery signal in user messages)', () => {
  it('marks a task terminal from a `<task-notification>` string (verbatim claude 2.1.197 shape)', () => {
    const s: any = { bgStarted: new Set(['a39ed8594ca33c5b9']), bgTerminal: new Set() };
    markClaudeTaskNotificationTerminal(
      '<task-notification>\n<task-id>a39ed8594ca33c5b9</task-id>\n<tool-use-id>toolu_01KDTWSPrnjpfBjibq3yNwhm</tool-use-id>\n<status>completed</status>\n<summary>Agent finished</summary>\n</task-notification>',
      s);
    expect(pendingClaudeBackgroundTasks(s)).toBe(0);
  });
  it('treats a "process exited" failed notification as terminal too', () => {
    const s: any = { bgStarted: new Set(['aa2f3b3d6013f7351']), bgTerminal: new Set() };
    markClaudeTaskNotificationTerminal(
      '<task-notification> <task-id>aa2f3b3d6013f7351</task-id> <status>failed</status> <summary>Background agent was running when the previous Claude Code process exited</summary> </task-notification>',
      s);
    expect(pendingClaudeBackgroundTasks(s)).toBe(0);
  });
  it('accepts a text-block array as well as a raw string', () => {
    const s: any = { bgStarted: new Set(['t1']), bgTerminal: new Set() };
    markClaudeTaskNotificationTerminal([{ type: 'text', text: '<task-notification><task-id>t1</task-id><status>completed</status></task-notification>' }], s);
    expect(pendingClaudeBackgroundTasks(s)).toBe(0);
  });
  it('ignores a non-terminal status and plain user messages', () => {
    const s: any = { bgStarted: new Set(['t1']), bgTerminal: new Set() };
    markClaudeTaskNotificationTerminal('<task-notification><task-id>t1</task-id><status>running</status></task-notification>', s);
    markClaudeTaskNotificationTerminal('你不要后台执行，一直在前台执行', s);
    markClaudeTaskNotificationTerminal([{ type: 'tool_result', content: 'ok' }], s);
    expect(pendingClaudeBackgroundTasks(s)).toBe(1);
  });
});

describe('decideClaudeResultSettle', () => {
  it('holds the turn while background work is pending', () => {
    expect(decideClaudeResultSettle({ hasError: false, pendingBackground: 1, sawBackground: true })).toBe('hold');
    expect(decideClaudeResultSettle({ hasError: false, pendingBackground: 3, sawBackground: true })).toBe('hold');
  });
  it('settles immediately for a plain turn that never launched background work', () => {
    expect(decideClaudeResultSettle({ hasError: false, pendingBackground: 0, sawBackground: false })).toBe('settle');
  });
  it('quiet-settles (does NOT hard-exit) when background finished but this turn used background', () => {
    // The fix: at pending==0 on a background turn, wait for Claude to go quiet rather than exiting
    // — a trailing wake-up turn may still be undelivered.
    expect(decideClaudeResultSettle({ hasError: false, pendingBackground: 0, sawBackground: true })).toBe('quiet-settle');
  });
  it('always settles on error, even with background pending (never hang a failed turn)', () => {
    expect(decideClaudeResultSettle({ hasError: true, pendingBackground: 5, sawBackground: true })).toBe('settle');
  });
});

describe('regression: 3 parallel agents finishing together must NOT kill the last wake-up', () => {
  // Verbatim ordering from a captured claude 2.1.197 run (3 Agent(run_in_background) fan-out).
  // The completion STATUS of the last agent lands BEFORE the previous agent's wake-up `result`, so
  // "all tasks terminal" (pending==0) is reached while Claude still has a wake-up turn to deliver.
  // Exiting at that result is exactly what orphaned the background agents ("was running when the
  // previous Claude Code process exited"). The decision there must be 'quiet-settle', not 'settle'.
  it('holds through every wake-up and only quiet-settles once truly done', () => {
    const s = freshState();
    const decide = (hasError = false) =>
      decideClaudeResultSettle({ hasError, pendingBackground: pendingClaudeBackgroundTasks(s), sawBackground: s.bgStarted.size > 0 });

    feed(s,
      { type: 'system', subtype: 'task_started', task_id: 'ad2571a', tool_use_id: 'toolu_1' },
      { type: 'system', subtype: 'task_started', task_id: 'af0d07b', tool_use_id: 'toolu_2' },
      { type: 'system', subtype: 'task_started', task_id: 'a22ac35', tool_use_id: 'toolu_3' });
    expect(decide()).toBe('hold'); // result "WAITING" — 3 pending

    feed(s,
      { type: 'system', subtype: 'task_updated', task_id: 'ad2571a', patch: { status: 'completed' } },
      { type: 'system', subtype: 'task_updated', task_id: 'af0d07b', patch: { status: 'completed' } });
    expect(decide()).toBe('hold'); // result wake-up#1 "ONE" — a22ac35 still pending

    // a22ac35's completion STATUS races ahead of its wake-up delivery:
    feed(s, { type: 'system', subtype: 'task_updated', task_id: 'a22ac35', patch: { status: 'completed' } });
    // result wake-up#2 "TWO": pending==0 but wake-up#3 not delivered yet — the old 'settle' here
    // hard-killed the process and lost "THREE / DONE-ALL". Now we quiet-settle instead.
    expect(decide()).toBe('quiet-settle');

    // result wake-up#3 "THREE / DONE-ALL": still quiet-settle; the grace timer closes it gracefully.
    expect(decide()).toBe('quiet-settle');
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

describe('claudeBgSettleQuietMs', () => {
  const prev = process.env.PIKILOOM_CLAUDE_BG_SETTLE_QUIET_MS;
  afterEach(() => {
    if (prev === undefined) delete process.env.PIKILOOM_CLAUDE_BG_SETTLE_QUIET_MS;
    else process.env.PIKILOOM_CLAUDE_BG_SETTLE_QUIET_MS = prev;
  });
  it('defaults to 15 seconds', () => {
    delete process.env.PIKILOOM_CLAUDE_BG_SETTLE_QUIET_MS;
    expect(claudeBgSettleQuietMs()).toBe(15_000);
  });
  it('honors a positive override and ignores a bad one', () => {
    process.env.PIKILOOM_CLAUDE_BG_SETTLE_QUIET_MS = '3000';
    expect(claudeBgSettleQuietMs()).toBe(3_000);
    process.env.PIKILOOM_CLAUDE_BG_SETTLE_QUIET_MS = '0';
    expect(claudeBgSettleQuietMs()).toBe(15_000);
  });
});
