import { describe, it, expect } from 'vitest';
import { parseGeminiEvent } from '../src/drivers/gemini.js';
import { parseAgyEvent } from '../src/drivers/agy.js';
import { applyAcpUpdate } from '../src/drivers/acp.js';
import type { DriverEvent } from '../src/contracts/driver.js';

function agyRun(events: any[]): DriverEvent[] {
  const out: DriverEvent[] = []; const s: any = { text: '', sessionId: null }; const tools = new Map<string, { name: string; summary: string }>();
  for (const ev of events) parseAgyEvent(ev, s, tools, (e) => out.push(e));
  return out;
}
function geminiRun(events: any[]): DriverEvent[] {
  const out: DriverEvent[] = []; const s: any = { text: '', sessionId: null }; const tools = new Map<string, { name: string; summary: string }>();
  for (const ev of events) parseGeminiEvent(ev, s, tools, (e) => out.push(e));
  return out;
}
function hermesRun(updates: any[]): DriverEvent[] {
  const out: DriverEvent[] = []; const s: any = { text: '', reasoning: '' }; const tools = new Set<string>();
  for (const u of updates) applyAcpUpdate(u, s, tools, (e) => out.push(e));
  return out;
}

describe('AgyDriver stream-json parser', () => {
  it('maps init/step_update/result events to DriverEvents', () => {
    const events = agyRun([
      { event: 'init', conversation_id: 'agy-1', init: { cwd: '/work', tools: ['run_command'] } },
      { event: 'step_update', step_update: { conversation_id: 'agy-1', step_index: 0, state: 'DONE', step_type: 'user_input' } },
      { event: 'step_update', step_update: { conversation_id: 'agy-1', step_index: 1, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command' } },
      { event: 'step_update', step_update: { conversation_id: 'agy-1', step_index: 1, state: 'DONE', step_type: 'tool', tool_name: 'run_command', tool_info: { output: 'date output' } } },
      { event: 'step_update', step_update: { conversation_id: 'agy-1', step_index: 2, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'Agy-' } },
      { event: 'step_update', step_update: { conversation_id: 'agy-1', step_index: 2, state: 'DONE', step_type: 'agent_response', text_delta: 'OK', usage: { input_tokens: 100, output_tokens: 10, cache_read_tokens: 5 } } },
      { event: 'result', result: { conversation_id: 'agy-1', status: 'SUCCESS', response: 'Agy-OK', usage: { input_tokens: 100, output_tokens: 10, cache_read_tokens: 5 } } },
    ]);
    expect(events.find(e => e.type === 'session')).toMatchObject({ sessionId: 'agy-1' });
    expect(events.filter(e => e.type === 'text').map(e => (e as any).delta).join('')).toBe('Agy-OK');
    const tStatuses = events.filter(e => e.type === 'tool').map(e => (e as any).call.status);
    expect(tStatuses).toEqual(['running', 'done']);
    expect((events.filter(e => e.type === 'usage').pop() as any).usage).toMatchObject({ inputTokens: 100, outputTokens: 10, cachedInputTokens: 5 });
  });

  it('maps legacy gemini format for backwards compatibility', () => {
    const events = geminiRun([
      { type: 'init', session_id: 'gem-1', model: 'gemini-3.1-pro' },
      { type: 'message', role: 'assistant', delta: true, content: 'Gem-' },
      { type: 'message', role: 'assistant', delta: true, content: 'OK' },
      { type: 'tool_use', tool_id: 't1', tool_name: 'read_file' },
      { type: 'tool_result', tool_id: 't1' },
      { type: 'result', session_id: 'gem-1', status: 'success', stats: { input_tokens: 12, output_tokens: 4 } },
    ]);
    expect(events.find(e => e.type === 'session')).toMatchObject({ sessionId: 'gem-1' });
    expect(events.filter(e => e.type === 'text').map(e => (e as any).delta).join('')).toBe('Gem-OK');
    const tStatuses = events.filter(e => e.type === 'tool').map(e => (e as any).call.status);
    expect(tStatuses).toEqual(['running', 'done']);
    expect((events.filter(e => e.type === 'usage').pop() as any).usage).toMatchObject({ inputTokens: 12, outputTokens: 4 });
  });
});

describe('HermesDriver ACP session/update parser', () => {
  it('maps agent/thought/tool/usage chunks to DriverEvents', () => {
    const events = hermesRun([
      { sessionUpdate: 'agent_thought_chunk', content: { text: 'pondering ' } },
      { sessionUpdate: 'agent_message_chunk', content: { text: 'Hermes-' } },
      { sessionUpdate: 'agent_message_chunk', content: { text: 'OK' } },
      { sessionUpdate: 'tool_call', toolCallId: 'tc1', title: 'grep' },
      { sessionUpdate: 'tool_call_update', toolCallId: 'tc1', status: 'completed', title: 'grep' },
      { sessionUpdate: 'usage_update', size: 200000, used: 1234 },
    ]);
    expect(events.filter(e => e.type === 'reasoning').map(e => (e as any).delta).join('')).toBe('pondering ');
    expect(events.filter(e => e.type === 'text').map(e => (e as any).delta).join('')).toBe('Hermes-OK');
    const tStatuses = events.filter(e => e.type === 'tool').map(e => (e as any).call.status);
    expect(tStatuses).toEqual(['running', 'done']);
    expect((events.find(e => e.type === 'usage') as any).usage).toMatchObject({ contextUsedTokens: 1234 });
  });
});
