import { describe, it, expect } from 'vitest';
import { handleClaudeEvent, todoWriteToPlan } from '../src/drivers/claude.js';
import type { DriverEvent } from '../src/contracts/driver.js';

function run(events: any[]): DriverEvent[] {
  const out: DriverEvent[] = [];
  const s: any = { text: '', reasoning: '', streamedText: false, sessionId: null, input: null, output: null, cached: null };
  for (const ev of events) handleClaudeEvent(ev, s, (e) => out.push(e));
  return out;
}

describe('claude stream-json parser (kernel ClaudeDriver parity)', () => {
  it('extracts a UniversalPlan from a TodoWrite tool_use (status mapping)', () => {
    const events = run([
      { type: 'assistant', message: { content: [
        { type: 'tool_use', id: 'tw1', name: 'TodoWrite', input: { todos: [
          { content: 'design', status: 'completed' },
          { content: 'implement', status: 'in_progress' },
          { content: 'verify', status: 'pending' },
          { content: '', status: 'pending' }, // skipped (empty)
        ] } },
      ] } },
    ]);
    const planEv = events.find(e => e.type === 'plan');
    expect(planEv, 'a plan event should be emitted').toBeTruthy();
    const plan = (planEv as any).plan;
    expect(plan.steps).toEqual([
      { text: 'design', status: 'completed' },
      { text: 'implement', status: 'inProgress' },
      { text: 'verify', status: 'pending' },
    ]);
    // The command itself surfaces as an Activity row (matching the CLI's own transcript).
    const toolEv = events.find(e => e.type === 'tool' && (e as any).call.name === 'TodoWrite') as any;
    expect(toolEv, 'TodoWrite should surface as an Activity tool row').toBeTruthy();
    expect(toolEv.call.summary).toBe('Update plan');
  });

  it('emits tool events for non-TodoWrite tool_use', () => {
    const events = run([
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'r1', name: 'Read', input: {} }] } },
    ]);
    const tool = events.find(e => e.type === 'tool') as any;
    expect(tool.call).toMatchObject({ id: 'r1', name: 'Read', status: 'running' });
  });

  it('builds a UniversalPlan from TaskCreate/TaskUpdate (current Claude task-list mechanism)', () => {
    const events = run([
      // Two TaskCreate tool_uses (subjects), then their results assign ids "1" and "2".
      { type: 'assistant', message: { content: [
        { type: 'tool_use', id: 'tc1', name: 'TaskCreate', input: { subject: 'design API' } },
        { type: 'tool_use', id: 'tc2', name: 'TaskCreate', input: { subject: 'write tests' } },
      ] } },
      { type: 'user', toolUseResult: { task: { id: '1' } }, message: { content: [{ type: 'tool_result', tool_use_id: 'tc1', content: 'Task #1 created' }] } },
      { type: 'user', toolUseResult: { task: { id: '2' } }, message: { content: [{ type: 'tool_result', tool_use_id: 'tc2', content: 'Task #2 created' }] } },
      // Flip task 1 to in_progress, then completed.
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'TaskUpdate', input: { taskId: '1', status: 'in_progress' } }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu2', name: 'TaskUpdate', input: { taskId: '1', status: 'completed' } }] } },
    ]);
    const planEvents = events.filter(e => e.type === 'plan') as any[];
    expect(planEvents.length, 'plan events should be emitted as tasks change').toBeGreaterThan(0);
    // The latest plan reflects task 1 completed, task 2 still pending — keyed by `text` (kernel shape).
    expect(planEvents[planEvents.length - 1].plan.steps).toEqual([
      { text: 'design API', status: 'completed' },
      { text: 'write tests', status: 'pending' },
    ]);
    // The commands surface as Activity rows too (matching the CLI's own transcript).
    const createRow = events.find(e => e.type === 'tool' && (e as any).call.name === 'TaskCreate') as any;
    expect(createRow.call.summary).toBe('Create task: design API');
    const updateRow = events.find(e => e.type === 'tool' && (e as any).call.name === 'TaskUpdate') as any;
    expect(updateRow.call.summary).toBe('Update task 1 → in_progress');
    // TaskCreate results close their Activity row.
    expect(events.some(e => e.type === 'tool' && (e as any).call.id === 'tc1' && (e as any).call.status === 'done')).toBe(true);
  });

  it('chronological: a TaskUpdate AFTER a TodoWrite still applies — store id first', () => {
    const events = run([
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tc1', name: 'TaskCreate', input: { subject: 'store task' } }] } },
      { type: 'user', toolUseResult: { task: { id: '1' } }, message: { content: [{ type: 'tool_result', tool_use_id: 'tc1', content: 'Task #1' }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tw1', name: 'TodoWrite', input: { todos: [
        { content: 'fresh todo', status: 'in_progress' },
      ] } }] } },
      // The update's id lives in the TaskCreate store → the plan reflects the store AFTER it.
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'TaskUpdate', input: { taskId: '1', status: 'completed' } }] } },
    ]);
    const planEvents = events.filter(e => e.type === 'plan') as any[];
    expect(planEvents[planEvents.length - 1].plan.steps).toEqual([
      { text: 'store task', status: 'completed' },
    ]);
  });

  it('chronological: a TaskUpdate with an unknown id lands positionally on the latest TodoWrite list', () => {
    const events = run([
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tw1', name: 'TodoWrite', input: { todos: [
        { content: 'first', status: 'completed' },
        { content: 'second', status: 'in_progress' },
        { content: 'third', status: 'pending' },
      ] } }] } },
      // No TaskCreate store: id "2" = the 2nd todo item.
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'TaskUpdate', input: { taskId: '2', status: 'completed' } }] } },
    ]);
    const planEvents = events.filter(e => e.type === 'plan') as any[];
    expect(planEvents.length).toBe(2);
    expect(planEvents[1].plan.steps).toEqual([
      { text: 'first', status: 'completed' },
      { text: 'second', status: 'completed' },
      { text: 'third', status: 'pending' },
    ]);
    // Out-of-range or non-numeric ids stay plan-silent.
    const more = run([
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tw1', name: 'TodoWrite', input: { todos: [
        { content: 'only', status: 'pending' },
      ] } }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu9', name: 'TaskUpdate', input: { taskId: '9', status: 'completed' } }] } },
    ]);
    expect(more.filter(e => e.type === 'plan').length).toBe(1);
  });

  it('drops a TaskUpdate status=deleted task from the plan', () => {
    const events = run([
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tc1', name: 'TaskCreate', input: { subject: 'keep me' } }] } },
      { type: 'user', toolUseResult: { task: { id: '1' } }, message: { content: [{ type: 'tool_result', tool_use_id: 'tc1', content: 'Task #1' }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tc2', name: 'TaskCreate', input: { subject: 'remove me' } }] } },
      { type: 'user', toolUseResult: { task: { id: '2' } }, message: { content: [{ type: 'tool_result', tool_use_id: 'tc2', content: 'Task #2' }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'TaskUpdate', input: { taskId: '2', status: 'deleted' } }] } },
    ]);
    const planEvents = events.filter(e => e.type === 'plan') as any[];
    expect(planEvents[planEvents.length - 1].plan.steps).toEqual([{ text: 'keep me', status: 'pending' }]);
  });

  it('enriches tool calls: human summary on use + done/failed status + detail on result', () => {
    const events = run([
      { type: 'assistant', message: { content: [
        { type: 'tool_use', id: 'rd', name: 'Read', input: { file_path: '/repo/src/foo.ts' } },
        { type: 'tool_use', id: 'sh', name: 'Bash', input: { command: 'npm test' } },
      ] } },
      { type: 'user', message: { content: [
        { type: 'tool_result', tool_use_id: 'rd' },                                  // file tool -> just "done"
        { type: 'tool_result', tool_use_id: 'sh', content: '12 passing\n0 failing' }, // -> first line as detail
      ] } },
    ]);
    const calls = events.filter(e => e.type === 'tool').map(e => (e as any).call);
    // running summaries carry the input detail (the activity vocabulary pikiloom already parses)
    expect(calls.find(c => c.id === 'rd' && c.status === 'running').summary).toBe('Read /repo/src/foo.ts');
    expect(calls.find(c => c.id === 'sh' && c.status === 'running').summary).toBe('Run shell: npm test');
    // results close the call out: file tool -> no detail, shell -> first line of output
    expect(calls.find(c => c.id === 'rd' && c.status === 'done')).toMatchObject({ result: null });
    expect(calls.find(c => c.id === 'sh' && c.status === 'done').result).toBe('12 passing');
  });

  it('captures reasoning from a thinking BLOCK when no thinking_delta streamed', () => {
    // claude can deliver thinking as a complete block in the assistant message instead of
    // streaming thinking_delta; the kernel must still surface it (else thinking vanishes).
    const events = run([
      { type: 'assistant', message: { content: [
        { type: 'thinking', thinking: 'Let me reason about this.' },
        { type: 'text', text: 'Answer.' },
      ] } },
    ]);
    expect(events.filter(e => e.type === 'reasoning').map(e => (e as any).delta).join('')).toBe('Let me reason about this.');
  });

  it('does NOT double-count: streamed thinking_delta suppresses the block fallback', () => {
    const events = run([
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'streamed ' } } },
      { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'streamed (assembled block)' }, { type: 'text', text: 'A' }] } },
    ]);
    // only the streamed delta — the block is ignored because streamedReasoning is set
    expect(events.filter(e => e.type === 'reasoning').map(e => (e as any).delta).join('')).toBe('streamed ');
  });

  it('streams text + reasoning deltas and accumulates usage + session', () => {
    const events = run([
      { type: 'system', session_id: 'sess-abc', model: 'claude-opus-4-8' },
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hmm ' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } } },
      { type: 'stream_event', event: { type: 'message_delta', usage: { input_tokens: 10, output_tokens: 3 }, delta: { stop_reason: 'end_turn' } } },
    ]);
    expect(events.find(e => e.type === 'session')).toMatchObject({ sessionId: 'sess-abc' });
    expect(events.filter(e => e.type === 'reasoning').map(e => (e as any).delta).join('')).toBe('hmm ');
    expect(events.filter(e => e.type === 'text').map(e => (e as any).delta).join('')).toBe('Hello');
    const usage = events.filter(e => e.type === 'usage').pop() as any;
    expect(usage.usage).toMatchObject({ inputTokens: 10, outputTokens: 3 });
  });

  // Regression: consecutive text blocks (one per tool-use round) must be paragraph-separated so
  // the live preview shows line breaks. Without the content_block_start handler the kernel ran
  // them together ("...first.Second...").
  it('inserts a paragraph break between consecutive text blocks (content_block_start)', () => {
    const events = run([
      { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'text' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'First block.' } } },
      // a tool round happens, then claude opens a NEW text block:
      { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'text' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Second block.' } } },
    ]);
    const text = events.filter(e => e.type === 'text').map(e => (e as any).delta).join('');
    expect(text).toBe('First block.\n\nSecond block.');   // no leading break, \n\n between blocks
  });

  // Regression: the kernel path must project the three DERIVED live signals (context %,
  // cumulative context tokens, this-turn output), not just raw input/output. When it only
  // emitted {inputTokens,outputTokens,cachedInputTokens,contextPercent:null} the dashboard's
  // live "xx.x% · NNk · ↑NN" row vanished mid-execution (it keys on exactly these fields).
  it('projects context%, cumulative context tokens, and per-turn output across tool rounds', () => {
    const events = run([
      { type: 'system', session_id: 'sess-ctx', model: 'claude-opus-4-8' },           // sets the effective context window
      // message #1: 50k prompt (+10k cache), 200 output
      { type: 'stream_event', event: { type: 'message_start', message: { usage: { input_tokens: 50_000, cache_read_input_tokens: 10_000 } } } },
      { type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 200 } } },
      // message #2 (a tool round within the same turn): 60k prompt (+12k cache), 150 output
      { type: 'stream_event', event: { type: 'message_start', message: { usage: { input_tokens: 60_000, cache_read_input_tokens: 12_000 } } } },
      { type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 150 } } },
    ]);
    const usage = (events.filter(e => e.type === 'usage').pop() as any).usage;
    expect(usage).toMatchObject({
      inputTokens: 60_000,
      outputTokens: 150,
      cachedInputTokens: 12_000,
      contextUsedTokens: 72_150,   // latest message occupancy: 60000 + 12000 + 0 + 150
      turnOutputTokens: 350,       // SUMS the turn: 200 (carried from msg #1) + 150
    });
    // 72150 / (1_000_000 - 33_000 reserve) -> 7.5%
    expect(usage.contextPercent).toBe(7.5);
  });

  // Regression: the prompt-side counts are known at message_start, so the context row must
  // appear immediately — not minutes later at the first message_delta. Without this emit a
  // long silent thinking phase (subscription accounts stream no plaintext) showed a dead
  // spinner with zero feedback ("looks stuck") on IM + dashboard.
  it('emits usage at message_start so the context row shows before any output', () => {
    const events = run([
      { type: 'system', session_id: 'sess-early', model: 'claude-opus-4-8' },
      { type: 'stream_event', event: { type: 'message_start', message: { usage: { input_tokens: 50_000, cache_read_input_tokens: 10_000 } } } },
    ]);
    const usage = (events.filter(e => e.type === 'usage').pop() as any)?.usage;
    expect(usage).toBeTruthy();
    expect(usage).toMatchObject({ inputTokens: 50_000, cachedInputTokens: 10_000, contextUsedTokens: 60_000 });
    // 60000 / (1_000_000 - 33_000 reserve) -> 6.2%
    expect(usage.contextPercent).toBe(6.2);
  });

  // Regression: during silent extended thinking the CLI's system/thinking_tokens estimates are
  // the ONLY live output signal (no thinking_delta text, no usage until the message settles).
  // Project them into ticking usage; the real per-message output_tokens then supersedes them.
  it('projects system/thinking_tokens estimates while thinking streams silently', () => {
    const events = run([
      { type: 'system', session_id: 'sess-tt', model: 'claude-opus-4-8' },
      { type: 'stream_event', event: { type: 'message_start', message: { usage: { input_tokens: 50_000, cache_read_input_tokens: 10_000 } } } },
      { type: 'system', subtype: 'thinking_tokens', estimated_tokens: 50, estimated_tokens_delta: 50 },
      { type: 'system', subtype: 'thinking_tokens', estimated_tokens: 200, estimated_tokens_delta: 150 },
    ]);
    const live = (events.filter(e => e.type === 'usage').pop() as any).usage;
    expect(live).toMatchObject({
      outputTokens: 0,             // raw reported output stays untouched by the estimate
      turnOutputTokens: 200,       // ...but the live turn tally ticks with the estimate
      contextUsedTokens: 60_200,
    });

    // The settling message_delta reports real output (which already includes thinking tokens):
    // the estimate must be superseded, not added on top.
    const more = run([
      { type: 'system', session_id: 'sess-tt2', model: 'claude-opus-4-8' },
      { type: 'stream_event', event: { type: 'message_start', message: { usage: { input_tokens: 50_000 } } } },
      { type: 'system', subtype: 'thinking_tokens', estimated_tokens: 500, estimated_tokens_delta: 500 },
      { type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 320 } } },
      // next tool round: the carried turn base uses the REAL 320, not the 500 estimate
      { type: 'stream_event', event: { type: 'message_start', message: { usage: { input_tokens: 51_000 } } } },
    ]);
    const settled = (more.filter(e => e.type === 'usage').pop() as any).usage;
    expect(settled).toMatchObject({ inputTokens: 51_000, outputTokens: 0, turnOutputTokens: 320 });
  });

  it('creates a sub-agent on Task and routes child tool_uses into it (parent_tool_use_id)', () => {
    const events = run([
      { type: 'assistant', message: { content: [
        { type: 'tool_use', id: 'task-1', name: 'Task', input: { subagent_type: 'Explore', description: 'find the bug' } },
      ] } },
      // child events tagged with parent_tool_use_id route into the sub-agent, not the main turn
      { type: 'assistant', parent_tool_use_id: 'task-1', message: { model: 'claude-haiku', content: [
        { type: 'tool_use', id: 'g1', name: 'Grep', input: {} },
        { type: 'tool_use', id: 'r2', name: 'Read', input: {} },
      ] } },
    ]);
    const subEvents = events.filter(e => e.type === 'subagent') as any[];
    expect(subEvents.length).toBeGreaterThanOrEqual(2);
    const last = subEvents.at(-1).subagent;
    expect(last).toMatchObject({ id: 'task-1', kind: 'Explore', description: 'find the bug', model: 'claude-haiku', status: 'running' });
    expect(last.tools.map((t: any) => t.name)).toEqual(['Grep', 'Read']);
    // child tool_uses must NOT leak into the main turn as top-level tool calls
    expect(events.some(e => e.type === 'tool' && ['g1', 'r2'].includes((e as any).call.id))).toBe(false);
  });

  it('surfaces base64 image content blocks as artifacts (deduped), from assistant + tool_result', () => {
    const img = (data: string) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data } });
    const events = run([
      { type: 'assistant', message: { content: [img('AAAABBBB'), { type: 'text', text: 'here' }] } },
      { type: 'assistant', message: { content: [img('AAAABBBB')] } },                       // dup -> ignored
      { type: 'user', message: { content: [{ type: 'tool_result', content: [img('CCCCDDDD')] }] } },
    ]);
    const arts = events.filter(e => e.type === 'artifact') as any[];
    expect(arts.length).toBe(2);
    expect(arts[0].artifact).toMatchObject({ mime: 'image/png', kind: 'photo' });
    expect(arts[0].artifact.url.startsWith('data:image/png;base64,AAAABBBB')).toBe(true);
    expect(arts[1].artifact.url).toContain('CCCCDDDD');
  });

  it('does NOT surface Read tool-result images (agent inspecting files), only generating tools', () => {
    const img = (data: string) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data } });
    const events = run([
      { type: 'assistant', message: { content: [
        { type: 'tool_use', id: 'rd', name: 'Read', input: { file_path: '/tmp/frame.png' } },
        { type: 'tool_use', id: 'gen', name: 'mcp__image__generate', input: {} },
      ] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'rd', content: [img('READPNG1')] }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'gen', content: [img('GENPNG22')] }] } },
    ]);
    const arts = events.filter(e => e.type === 'artifact') as any[];
    expect(arts.length).toBe(1);
    expect(arts[0].artifact.url).toContain('GENPNG22');
    // the Read call still closes out as done even though its image was suppressed
    const readDone = events.find(e => e.type === 'tool' && (e as any).call.id === 'rd' && (e as any).call.status === 'done');
    expect(readDone).toBeTruthy();
  });

  it('todoWriteToPlan returns null for empty/invalid input', () => {
    expect(todoWriteToPlan(null)).toBeNull();
    expect(todoWriteToPlan({ todos: [] })).toBeNull();
    expect(todoWriteToPlan({ todos: [{ content: '   ' }] })).toBeNull();
  });

  // ── API-error message classification ──────────────────────────────────────
  // Claude surfaces a failed model call (401 auth, overloaded, quota) as a synthetic assistant text
  // message flagged with a top-level `error`, plus a trailing `result{is_error}`. It must land in
  // `s.error` (→ run-end notice), never in `s.text` (→ reply body / 原文).
  function runState(events: any[]): { state: any; out: DriverEvent[] } {
    const out: DriverEvent[] = [];
    const state: any = { text: '', reasoning: '', streamedText: false, sessionId: null, input: null, output: null, cached: null, error: null };
    for (const ev of events) handleClaudeEvent(ev, state, (e) => out.push(e));
    return { state, out };
  }

  it('routes a synthetic API-error assistant message to s.error, not s.text (no body render)', () => {
    const err = 'Failed to authenticate. API Error: 401 invalid user token';
    const { state, out } = runState([
      { type: 'assistant', error: 'authentication_failed', message: { model: '<synthetic>', content: [{ type: 'text', text: err }] } },
      { type: 'result', subtype: 'success', is_error: true, api_error_status: 401, result: err },
    ]);
    expect(state.text).toBe('');                                   // never becomes the reply body
    expect(out.some((e) => e.type === 'text')).toBe(false);        // and never streams as a text delta
    expect(state.error).toBe(err);                                 // surfaces via the error slot (once)
  });

  it('keeps real streamed narration as the body when an API error ends the turn', () => {
    const err = 'Failed to authenticate. API Error: 401 invalid user token';
    const { state } = runState([
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Here is the plan.' } } },
      { type: 'assistant', error: 'authentication_failed', message: { model: '<synthetic>', content: [{ type: 'text', text: err }] } },
      { type: 'result', subtype: 'success', is_error: true, api_error_status: 401, result: err },
    ]);
    expect(state.text).toBe('Here is the plan.');                  // narration preserved as body
    expect(state.error).toBe(err);                                 // error still surfaces as the notice
  });

  it('leaves an ordinary assistant text reply (no top-level error) as the body', () => {
    const { state } = runState([
      { type: 'assistant', message: { model: 'claude-opus-4-8', content: [{ type: 'text', text: 'All done.' }] } },
    ]);
    expect(state.text).toBe('All done.');
    expect(state.error).toBeNull();
  });
});
