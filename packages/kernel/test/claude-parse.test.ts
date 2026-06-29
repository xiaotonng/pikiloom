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
    // TodoWrite must NOT also surface as a generic tool call
    expect(events.some(e => e.type === 'tool' && (e as any).call.name === 'TodoWrite')).toBe(false);
  });

  it('emits tool events for non-TodoWrite tool_use', () => {
    const events = run([
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'r1', name: 'Read', input: {} }] } },
    ]);
    const tool = events.find(e => e.type === 'tool') as any;
    expect(tool.call).toMatchObject({ id: 'r1', name: 'Read', status: 'running' });
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

  it('todoWriteToPlan returns null for empty/invalid input', () => {
    expect(todoWriteToPlan(null)).toBeNull();
    expect(todoWriteToPlan({ todos: [] })).toBeNull();
    expect(todoWriteToPlan({ todos: [{ content: '   ' }] })).toBeNull();
  });
});
