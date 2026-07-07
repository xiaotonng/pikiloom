import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { getSessionMessages } from '../src/agent/index.ts';
import { withTempHome } from './support/env.ts';
import type { MessageBlock } from '../src/agent/types.ts';

// History-view parity for Claude's two task-list mechanisms (TodoWrite snapshots vs
// TaskCreate/TaskUpdate incremental list): both must surface as plan blocks AND as Activity
// tool rows, and whichever mechanism wrote LAST owns the plan ("latest wins") — a TaskUpdate
// against a list abandoned by a newer TodoWrite must not resurrect the stale plan.

const WORKDIR = '/Users/test/taskplan';

async function parseSession(events: any[]): Promise<MessageBlock[][]> {
  return withTempHome(async (homeDir) => {
    const projectDir = path.join(homeDir, '.claude', 'projects', WORKDIR.replace(/[/\\:]/g, '-'));
    fs.mkdirSync(projectDir, { recursive: true });
    const sessionId = 'sess-task-plan';
    fs.writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), events.map(e => JSON.stringify(e)).join('\n'));
    const result = await getSessionMessages({ agent: 'claude', sessionId, workdir: WORKDIR, rich: true } as any);
    expect(result.ok).toBe(true);
    return (result.richMessages || []).filter(m => m.role === 'assistant').map(m => m.blocks);
  });
}

describe('claude history task-list parsing', () => {
  it('surfaces TodoWrite as both an Activity tool row and a plan block', async () => {
    const [blocks] = await parseSession([
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'go' }] } },
      { type: 'assistant', message: { content: [
        { type: 'text', text: 'updating todos' },
        { type: 'tool_use', id: 'tw1', name: 'TodoWrite', input: { todos: [
          { content: 'design', status: 'completed' },
          { content: 'implement', status: 'in_progress' },
        ] } },
      ] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tw1', content: 'Todos updated' }] } },
    ]);
    const toolRow = blocks.find(b => b.type === 'tool_use' && b.toolName === 'TodoWrite');
    expect(toolRow, 'TodoWrite should surface as an Activity row').toBeTruthy();
    const plan = blocks.find(b => b.type === 'plan');
    expect(plan?.plan?.steps).toEqual([
      { step: 'design', status: 'completed' },
      { step: 'implement', status: 'inProgress' },
    ]);
    // The raw "Todos updated" result stays suppressed (plan tool results are noise).
    expect(blocks.some(b => b.type === 'tool_result' && b.toolId === 'tw1')).toBe(false);
  });

  it('builds plan blocks from TaskCreate/TaskUpdate across turns', async () => {
    const perTurn = await parseSession([
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'go' }] } },
      { type: 'assistant', message: { content: [
        { type: 'text', text: 'creating tasks' },
        { type: 'tool_use', id: 'tc1', name: 'TaskCreate', input: { subject: 'design API' } },
        { type: 'tool_use', id: 'tc2', name: 'TaskCreate', input: { subject: 'write tests' } },
      ] } },
      { type: 'user', toolUseResult: { task: { id: '1' } }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tc1', content: 'Task #1 created' }] } },
      { type: 'user', toolUseResult: { task: { id: '2' } }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tc2', content: 'Task #2 created' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'done for now' }] } },
      // Next turn updates a task created in the PREVIOUS turn — state carries across turns.
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'continue' }] } },
      { type: 'assistant', message: { content: [
        { type: 'text', text: 'continuing' },
        { type: 'tool_use', id: 'tu1', name: 'TaskUpdate', input: { taskId: '1', status: 'completed' } },
      ] } },
    ]);
    const firstTurnPlans = perTurn[0].filter(b => b.type === 'plan');
    expect(firstTurnPlans.length, 'TaskCreate results should emit plan blocks').toBeGreaterThan(0);
    expect(firstTurnPlans[firstTurnPlans.length - 1].plan?.steps).toEqual([
      { step: 'design API', status: 'pending' },
      { step: 'write tests', status: 'pending' },
    ]);
    const secondTurnPlans = perTurn[1].filter(b => b.type === 'plan');
    expect(secondTurnPlans[secondTurnPlans.length - 1].plan?.steps).toEqual([
      { step: 'design API', status: 'completed' },
      { step: 'write tests', status: 'pending' },
    ]);
    // The commands stay visible as Activity rows.
    expect(perTurn[0].some(b => b.type === 'tool_use' && b.toolName === 'TaskCreate')).toBe(true);
    expect(perTurn[1].some(b => b.type === 'tool_use' && b.toolName === 'TaskUpdate')).toBe(true);
  });

  it('chronological: a TaskUpdate AFTER a TodoWrite still applies (store id first)', async () => {
    const perTurn = await parseSession([
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'go' }] } },
      { type: 'assistant', message: { content: [
        { type: 'text', text: 'tasking' },
        { type: 'tool_use', id: 'tc1', name: 'TaskCreate', input: { subject: 'store task' } },
      ] } },
      { type: 'user', toolUseResult: { task: { id: '1' } }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tc1', content: 'Task #1' }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'continue' }] } },
      { type: 'assistant', message: { content: [
        { type: 'text', text: 'switching panels' },
        { type: 'tool_use', id: 'tw1', name: 'TodoWrite', input: { todos: [{ content: 'fresh todo', status: 'in_progress' }] } },
        { type: 'tool_use', id: 'tu1', name: 'TaskUpdate', input: { taskId: '1', status: 'completed' } },
      ] } },
    ]);
    const lastTurnPlans = perTurn[1].filter(b => b.type === 'plan');
    // TodoWrite snapshot first, then the TaskUpdate's resulting store state — latest change wins.
    expect(lastTurnPlans.length).toBe(2);
    expect(lastTurnPlans[0].plan?.steps).toEqual([{ step: 'fresh todo', status: 'inProgress' }]);
    expect(lastTurnPlans[1].plan?.steps).toEqual([{ step: 'store task', status: 'completed' }]);
  });

  it('chronological: a TaskUpdate with an unknown id lands positionally on the latest TodoWrite list', async () => {
    const perTurn = await parseSession([
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'go' }] } },
      { type: 'assistant', message: { content: [
        { type: 'text', text: 'todos' },
        { type: 'tool_use', id: 'tw1', name: 'TodoWrite', input: { todos: [
          { content: 'first', status: 'completed' },
          { content: 'second', status: 'in_progress' },
          { content: 'third', status: 'pending' },
        ] } },
      ] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'continue' }] } },
      // Next turn: no TaskCreate store — id "2" = the 2nd item of the latest todo list.
      { type: 'assistant', message: { content: [
        { type: 'text', text: 'updating' },
        { type: 'tool_use', id: 'tu1', name: 'TaskUpdate', input: { taskId: '2', status: 'completed' } },
      ] } },
    ]);
    const lastTurnPlans = perTurn[1].filter(b => b.type === 'plan');
    expect(lastTurnPlans.length).toBe(1);
    expect(lastTurnPlans[0].plan?.steps).toEqual([
      { step: 'first', status: 'completed' },
      { step: 'second', status: 'completed' },
      { step: 'third', status: 'pending' },
    ]);
  });
});
