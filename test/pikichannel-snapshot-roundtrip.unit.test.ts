import { describe, expect, it } from 'vitest';
import { projectSnapshot } from '../src/pikichannel/adapter-pikiloom.ts';
import { diffSnapshot, applySnapshotPatch, type UniversalSnapshot } from '../src/pikichannel/protocol.ts';

// A maximal StreamSnapshot exercising every field a remote client renders.
function maximalSnapshot(): any {
  return {
    phase: 'streaming',
    taskId: 't1',
    sessionId: 'native-id-123',
    queuedTaskIds: ['q1'],
    queuedTasks: [{ taskId: 'q1', prompt: 'queued one' }],
    question: 'the running prompt',
    incomplete: true,
    text: 'partial answer',
    thinking: 'partial reasoning',
    activity: 'Editing files',
    plan: { explanation: 'why', steps: [{ step: 'do A', status: 'inProgress' }] },
    model: 'claude-opus-4-8',
    effort: 'max',
    error: 'oops',
    artifacts: [{ url: '/a.png', fileName: 'a.png', fileSize: 10, mime: 'image/png', kind: 'photo', caption: 'c' }],
    startedAt: 1000,
    updatedAt: 2000,
    interactions: [{
      promptId: 'h1', kind: 'user-input', title: 'T', hint: 'hint', currentIndex: 0,
      questions: [{ id: 'ask-user', header: 'H', prompt: 'pick', options: [{ label: 'A', description: 'd', value: 'A' }], allowFreeform: true }],
    }],
    previewMeta: {
      inputTokens: 5, outputTokens: 6, cachedInputTokens: 1, contextUsedTokens: 100,
      contextPercent: 12, turnOutputTokens: 6, providerName: 'anthropic', generatingImages: 1,
      toolCalls: [{ id: 'c1', name: 'Read', summary: 'Read x', input: '{}', result: 'ok', status: 'done' }],
      subAgents: [{ id: 's1', kind: 'worker', description: 'sub', model: 'm', tools: [{ id: 'tt', name: 'Grep', summary: 'g' }], status: 'running' }],
    },
  };
}

describe('pikichannel snapshot round-trip (local fields → remote projection)', () => {
  it('carries every field a remote client renders', () => {
    const u = projectSnapshot('claude:s1', maximalSnapshot());
    // scalars / promotion id
    expect(u.sessionId).toBe('native-id-123');     // #3 regression: session promotion id
    expect(u.taskId).toBe('t1');
    expect(u.model).toBe('claude-opus-4-8');
    expect(u.effort).toBe('max');
    expect(u.prompt).toBe('the running prompt');
    expect(u.error).toBe('oops');
    expect(u.incomplete).toBe(true);
    expect(u.text).toBe('partial answer');
    expect(u.reasoning).toBe('partial reasoning');
    expect(u.activity).toBe('Editing files');
    // structured
    expect(u.plan?.steps?.[0]).toMatchObject({ text: 'do A', status: 'inProgress' });
    expect(u.queued?.[0]).toMatchObject({ taskId: 'q1', prompt: 'queued one' });
    expect(u.artifacts?.[0]).toMatchObject({ fileName: 'a.png', kind: 'photo' });
    expect(u.toolCalls?.[0]).toMatchObject({ name: 'Read', status: 'done' });
    expect(u.subAgents?.[0]).toMatchObject({ id: 's1', status: 'running' });
    expect(u.usage?.contextPercent).toBe(12);
    // interaction (#1 regression)
    const q = u.interactions?.[0]?.questions?.[0] as any;
    expect(q.text).toBe('pick');
    expect(q.choices?.[0]).toMatchObject({ label: 'A', value: 'A' });
  });

  it('#2 regression: keeps toolCalls/subAgents even when token usage is empty', () => {
    const snap = maximalSnapshot();
    snap.previewMeta = { inputTokens: null, outputTokens: null, cachedInputTokens: null, contextPercent: null,
      toolCalls: [{ id: 'c1', name: 'Bash', summary: 'b', status: 'running' }],
      subAgents: [{ id: 's1', kind: null, description: null, model: null, tools: [], status: 'running' }] };
    const u = projectSnapshot('claude:s1', snap);
    // usage may be compacted away, but toolCalls/subAgents are top-level and must survive
    expect(u.toolCalls?.[0]?.name).toBe('Bash');
    expect(u.subAgents?.[0]?.id).toBe('s1');
  });

  it('#3 regression: session promotion (pending→native) propagates through a patch', () => {
    const prev = projectSnapshot('claude:pending', { ...maximalSnapshot(), sessionId: 'pending' }) as UniversalSnapshot;
    const next = projectSnapshot('claude:pending', { ...maximalSnapshot(), sessionId: 'native-id-123' }) as UniversalSnapshot;
    const patch = diffSnapshot(prev, next);
    expect((patch.set as any)?.sessionId).toBe('native-id-123');
    expect(applySnapshotPatch(prev, patch).sessionId).toBe('native-id-123');
  });

  it('#4 regression: a new turn clears the previous turn\'s volatile fields ACROSS THE WIRE (no stale bleed)', () => {
    // prev: a rich running turn; next: a fresh turn whose activity/toolCalls/usage/queued/plan are all empty.
    const prev = projectSnapshot('claude:s1', maximalSnapshot()) as UniversalSnapshot;
    const next = projectSnapshot('claude:s1', {
      phase: 'streaming', taskId: 't2', sessionId: 'native-id-123', updatedAt: 3000,
    }) as UniversalSnapshot;
    const patch = diffSnapshot(prev, next);
    // Critical: simulate the actual WS transport — JSON drops undefined-valued keys.
    const wirePatch = JSON.parse(JSON.stringify(patch));
    const received = applySnapshotPatch(prev, wirePatch);
    expect(received.activity ?? null).toBeNull();
    expect(received.toolCalls ?? null).toBeNull();
    expect(received.subAgents ?? null).toBeNull();
    expect(received.usage ?? null).toBeNull();
    expect(received.plan ?? null).toBeNull();
    expect(received.queued ?? null).toBeNull();   // also the phantom-queued-row root cause
    expect(received.text || '').toBe('');
    expect(received.taskId).toBe('t2');
  });
});
