import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  handleClaudeEvent, pollClaudeSubAgentTails, applyClaudeSubAgentResult,
  isFailedTaskStatus, type ClaudeSubTail,
} from '../src/drivers/claude.js';
import type { DriverEvent } from '../src/contracts/driver.js';

function freshState(): any {
  return { text: '', reasoning: '', streamedText: false, sessionId: null, input: null, output: null, cached: null };
}

function run(events: any[], s: any = freshState()): { out: DriverEvent[]; s: any } {
  const out: DriverEvent[] = [];
  for (const ev of events) handleClaudeEvent(ev, s, (e) => out.push(e));
  return { out, s };
}

const SPAWN = {
  type: 'assistant',
  message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Agent', input: { subagent_type: 'Explore', description: 'map the repo', prompt: 'Explore the repo and report back.' } }] },
};

const ASYNC_LAUNCH_TEXT =
  'Async agent launched successfully. (internal metadata)\n'
  + "agentId: abc123def456 (internal ID - do not mention to user. Use SendMessage with to: 'abc123def456' to continue this agent.)\n"
  + 'The agent is working in the background. You will be notified automatically when it completes.\n'
  + 'output_file: /tmp/nonexistent/tasks/abc123def456.output\n'
  + 'Do NOT Read or tail this file via the shell tool.';

const asyncLaunchResult = (outputFile?: string) => ({
  type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'text', text: outputFile ? ASYNC_LAUNCH_TEXT.replace('/tmp/nonexistent/tasks/abc123def456.output', outputFile) : ASYNC_LAUNCH_TEXT }] }] },
});

describe('claude sub-agent lifecycle (background/run_in_background default)', () => {
  it('captures the task prompt at spawn', () => {
    const { out } = run([SPAWN]);
    const ev = out.find((e) => e.type === 'subagent') as any;
    expect(ev.subagent.prompt).toBe('Explore the repo and report back.');
    expect(ev.subagent.status).toBe('running');
  });

  it('a SYNC tool_result settles the sub with report (+ sidecar cost facts)', () => {
    const { out, s } = run([
      SPAWN,
      {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'text', text: 'Final report: all mapped.' }] }] },
        toolUseResult: { status: 'completed', agentId: 'zz9', resolvedModel: 'claude-opus-4-8', totalDurationMs: 61_000, totalTokens: 12345 },
      },
    ]);
    const sub = s.subAgents.get('tu1');
    expect(sub.status).toBe('done');
    expect(sub.report).toBe('Final report: all mapped.');
    expect(sub.model).toBe('claude-opus-4-8');
    expect(sub.durationMs).toBe(61_000);
    expect(sub.totalTokens).toBe(12345);
    // no tool row leaked for the Task/Agent call itself
    expect(out.filter((e) => e.type === 'tool')).toHaveLength(0);
    // settle emitted a subagent update
    const last = out.filter((e) => e.type === 'subagent').at(-1) as any;
    expect(last.subagent.status).toBe('done');
  });

  it('a sync error tool_result settles the sub as failed', () => {
    const { s } = run([
      SPAWN,
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', is_error: true, content: [{ type: 'text', text: 'boom' }] }] } },
    ]);
    expect(s.subAgents.get('tu1').status).toBe('failed');
  });

  it('an ASYNC launch notice keeps the sub running and registers a transcript tail', () => {
    const { out, s } = run([SPAWN, asyncLaunchResult()]);
    const sub = s.subAgents.get('tu1');
    expect(sub.status).toBe('running');
    expect(sub.report).toBeUndefined(); // the launch notice is metadata, not a report
    const tail = s.subTails.get('tu1') as ClaudeSubTail;
    expect(tail.agentId).toBe('abc123def456');
    expect(tail.file).toBe('/tmp/nonexistent/tasks/abc123def456.output');
    expect(s.bgTaskSub.get('abc123def456')).toBe('tu1');
    // the launch acknowledgement still surfaces live
    expect(out.filter((e) => e.type === 'subagent').length).toBeGreaterThanOrEqual(2);
  });

  it('sidecar-shaped async launch (isAsync/status) is recognized without the text markers', () => {
    const s = freshState();
    run([SPAWN], s);
    const out: DriverEvent[] = [];
    applyClaudeSubAgentResult(
      s.subAgents.get('tu1'),
      { tool_use_id: 'tu1', content: 'launched' },
      { toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'x1', resolvedModel: 'claude-opus-4-8[1m]', prompt: 'do the thing' } },
      s, (e) => out.push(e),
    );
    const sub = s.subAgents.get('tu1');
    expect(sub.status).toBe('running');
    expect(sub.model).toBe('claude-opus-4-8[1m]');
    expect(sub.prompt).toBe('Explore the repo and report back.'); // spawn prompt wins
    expect(s.subTails.get('tu1').agentId).toBe('x1');
  });

  it('a <task-notification> user message flips the sub terminal and takes the <result> report', () => {
    const { out, s } = run([
      SPAWN,
      asyncLaunchResult(),
      {
        type: 'user',
        message: { content: [{ type: 'text', text: '<task-notification>\n<task-id>abc123def456</task-id>\n<tool-use-id>tu1</tool-use-id>\n<status>completed</status>\n<result>Here is the full map.\nSection two.</result>\n</task-notification>' }] },
      },
    ]);
    const sub = s.subAgents.get('tu1');
    expect(sub.status).toBe('done');
    expect(sub.report).toBe('Here is the full map.\nSection two.');
    const last = out.filter((e) => e.type === 'subagent').at(-1) as any;
    expect(last.subagent.status).toBe('done');
    // background accounting untouched
    expect(s.bgTerminal.has('abc123def456')).toBe(true);
  });

  it('a killed notification flips the sub to failed', () => {
    const { s } = run([
      SPAWN,
      asyncLaunchResult(),
      { type: 'user', message: { content: [{ type: 'text', text: '<task-notification><task-id>abc123def456</task-id><tool-use-id>tu1</tool-use-id><status>killed</status></task-notification>' }] } },
    ]);
    expect(s.subAgents.get('tu1').status).toBe('failed');
  });

  it('system task events map task→sub and a terminal task_updated flips it', () => {
    const { out, s } = run([
      SPAWN,
      asyncLaunchResult(),
      { type: 'system', subtype: 'task_started', task_id: 'abc123def456', tool_use_id: 'tu1', description: 'map the repo' },
      { type: 'system', subtype: 'task_updated', task_id: 'abc123def456', patch: { status: 'failed' } },
    ]);
    expect(s.subAgents.get('tu1').status).toBe('failed');
    expect(s.bgAgentTasks.has('abc123def456')).toBe(true);
    const last = out.filter((e) => e.type === 'subagent').at(-1) as any;
    expect(last.subagent.status).toBe('failed');
  });

  it('notification after a settle is idempotent (no duplicate flip, report still lands)', () => {
    const { s } = run([
      SPAWN,
      asyncLaunchResult(),
      { type: 'system', subtype: 'task_notification', task_id: 'abc123def456', status: 'completed' },
    ]);
    expect(s.subAgents.get('tu1').status).toBe('done');
    const out: DriverEvent[] = [];
    handleClaudeEvent(
      { type: 'user', message: { content: [{ type: 'text', text: '<task-notification><task-id>abc123def456</task-id><status>completed</status><result>late report</result></task-notification>' }] } },
      s, (e) => out.push(e),
    );
    expect(s.subAgents.get('tu1').status).toBe('done');
    expect(s.subAgents.get('tu1').report).toBe('late report');
  });

  it('tails the sub transcript incrementally: tools, model, duration, tokens', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sub-tail-'));
    const file = join(dir, 'agent-abc.jsonl');
    const rec = (o: any) => JSON.stringify(o) + '\n';
    writeFileSync(file,
      rec({ type: 'user', timestamp: '2026-07-24T10:00:00.000Z', message: { role: 'user', content: 'task' } })
      + rec({ type: 'assistant', timestamp: '2026-07-24T10:00:05.000Z', message: { model: 'claude-opus-4-8', usage: { input_tokens: 10, cache_read_input_tokens: 1000, output_tokens: 50 }, content: [
        { type: 'tool_use', id: 's1', name: 'Bash', input: { command: 'ls -la' } },
        { type: 'tool_use', id: 's2', name: 'Read', input: { file_path: '/repo/a.ts' } },
      ] } }),
    );
    const { s } = run([SPAWN, asyncLaunchResult(file)]);
    const events: DriverEvent[] = [];
    pollClaudeSubAgentTails(s, (e) => events.push(e));
    const sub = s.subAgents.get('tu1');
    expect(sub.tools.map((t: any) => t.name)).toEqual(['Bash', 'Read']);
    expect(sub.model).toBe('claude-opus-4-8');
    expect(sub.durationMs).toBe(5000);
    expect(sub.totalTokens).toBe(50 + 1010);
    expect(events.filter((e) => e.type === 'subagent')).toHaveLength(1);

    // append → only the NEW tool lands (no re-read, no duplicates)
    appendFileSync(file, rec({ type: 'assistant', timestamp: '2026-07-24T10:01:00.000Z', message: { model: 'claude-opus-4-8', usage: { input_tokens: 10, cache_read_input_tokens: 2000, output_tokens: 30 }, content: [
      { type: 'tool_use', id: 's3', name: 'Grep', input: { pattern: 'foo' } },
    ] } }));
    pollClaudeSubAgentTails(s, (e) => events.push(e));
    expect(sub.tools.map((t: any) => t.id)).toEqual(['s1', 's2', 's3']);
    expect(sub.durationMs).toBe(60_000);
    expect(sub.totalTokens).toBe(80 + 2010);

    // quiet tick → no event
    const before = events.length;
    pollClaudeSubAgentTails(s, (e) => events.push(e));
    expect(events.length).toBe(before);
  });

  it('tail survives a missing file (keeps trying) and goes dormant after settle', () => {
    const { s } = run([SPAWN, asyncLaunchResult('/nonexistent/nowhere.jsonl')]);
    const events: DriverEvent[] = [];
    pollClaudeSubAgentTails(s, (e) => events.push(e)); // must not throw
    expect(events).toHaveLength(0);
    // settle, then one grace pass, then dormant
    handleClaudeEvent({ type: 'system', subtype: 'task_notification', task_id: 'abc123def456', status: 'completed' }, s, () => {});
    pollClaudeSubAgentTails(s, (e) => events.push(e));
    expect(s.subTails.get('tu1').done).toBe(true);
  });

  it('isFailedTaskStatus separates failure from completion', () => {
    for (const bad of ['killed', 'failed', 'error', 'cancelled', 'aborted', 'timeout', 'timed_out']) expect(isFailedTaskStatus(bad)).toBe(true);
    for (const ok of ['completed', 'done', 'success', 'finished']) expect(isFailedTaskStatus(ok)).toBe(false);
  });
});
