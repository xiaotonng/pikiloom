import { describe, it, expect } from 'vitest';
import { projectActivity } from '../src/runtime/session-runner.js';
import type { UniversalSnapshot } from '../src/protocol/index.js';

const snap = (over: Partial<UniversalSnapshot>): UniversalSnapshot => ({ phase: 'streaming', updatedAt: 0, ...over });

describe('projectActivity (kernel activity-line contract)', () => {
  it('renders one line per tool call with a status suffix', () => {
    const out = projectActivity(snap({ toolCalls: [
      { id: '1', name: 'Read', summary: 'Read foo.ts', status: 'running' },
      { id: '2', name: 'Edit', summary: 'Edit bar.ts', status: 'done' },
      { id: '3', name: 'Bash', summary: 'Run shell: npm test', status: 'done', result: '12 passing' },
      { id: '4', name: 'Grep', summary: 'Search text: TODO', status: 'failed', result: 'no matches' },
    ] }));
    expect(out.split('\n')).toEqual([
      'Read foo.ts',                       // running -> bare summary
      'Edit bar.ts done',                  // done, no detail
      'Run shell: npm test -> 12 passing', // done, with detail
      'Search text: TODO failed: no matches',
    ]);
  });

  it('renders sub-agents as Run task lines', () => {
    const out = projectActivity(snap({ subAgents: [
      { id: 's1', kind: 'Explore', description: 'find the bug', model: null, tools: [], status: 'running' },
    ] }));
    expect(out).toBe('Run task: find the bug');
  });

  it('is empty when there is nothing to project', () => {
    expect(projectActivity(snap({}))).toBe('');
  });
});
