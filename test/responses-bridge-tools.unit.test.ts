import { describe, it, expect } from 'vitest';
import { toChatRequest } from '../src/model/responses-bridge.js';

const fn = (name: string) => ({ type: 'function', name, parameters: { type: 'object', properties: {} } });

describe('responses-bridge toChatRequest — tool translation', () => {
  it('flattens namespace tools into their nested function tools and drops untranslatable types', () => {
    const body = {
      model: 'doubao-seed-2-1-pro-260628',
      input: [{ type: 'message', role: 'user', content: 'hi' }],
      tools: [
        fn('exec_command'),
        fn('update_plan'),
        { type: 'namespace', name: 'multi_agent_v1', tools: [fn('spawn_agent'), fn('wait_agent')] },
        { type: 'namespace', name: 'mcp__everme', tools: [fn('mem_search')] },
        { type: 'web_search' },
        { type: 'image_generation' },
      ],
    };
    const req = toChatRequest(body);
    const names = req.tools.map((t: any) => t.function.name);
    expect(req.tools.every((t: any) => t.type === 'function')).toBe(true);
    expect(names).toEqual(['exec_command', 'update_plan', 'spawn_agent', 'wait_agent', 'mem_search']);
    expect(names).not.toContain(''); // web_search / image_generation carry no function name → dropped
  });

  it('dedupes tool names that collide across namespaces', () => {
    const body = {
      model: 'm',
      input: [],
      tools: [
        fn('search'),
        { type: 'namespace', name: 'a', tools: [fn('search'), fn('open')] },
        { type: 'namespace', name: 'b', tools: [fn('search'), fn('close')] },
      ],
    };
    const names = toChatRequest(body).tools.map((t: any) => t.function.name);
    expect(names).toEqual(['search', 'open', 'close']);
  });

  it('preserves function_call / function_call_output round-trip translation', () => {
    const body = {
      model: 'm',
      input: [
        { type: 'message', role: 'user', content: 'do it' },
        { type: 'function_call', call_id: 'c1', name: 'exec_command', arguments: '{"cmd":"ls"}' },
        { type: 'function_call_output', call_id: 'c1', output: 'file.txt' },
      ],
      tools: [fn('exec_command')],
    };
    const req = toChatRequest(body);
    const assistant = req.messages.find((m: any) => m.role === 'assistant' && m.tool_calls);
    expect(assistant.tool_calls[0]).toMatchObject({ id: 'c1', type: 'function', function: { name: 'exec_command' } });
    const tool = req.messages.find((m: any) => m.role === 'tool');
    expect(tool).toMatchObject({ tool_call_id: 'c1', content: 'file.txt' });
  });
});
