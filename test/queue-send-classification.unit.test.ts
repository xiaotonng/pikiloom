import { describe, expect, it } from 'vitest';
import { sendWillQueue, optimisticSendWasQueued } from '../dashboard/src/pages/sessions/queue-logic';

const base = {
  streaming: false,
  liveStreamPhase: null as 'streaming' | 'done' | null,
  streamPhase: null as string | null,
  queuedTaskCount: 0,
  pendingQueuedCount: 0,
};

describe('sendWillQueue', () => {
  it('starts a fresh turn on an idle session', () => {
    expect(sendWillQueue({ ...base })).toBe(false);
  });

  it('queues while a turn is actively streaming', () => {
    expect(sendWillQueue({ ...base, streaming: true })).toBe(true);
    expect(sendWillQueue({ ...base, liveStreamPhase: 'streaming' })).toBe(true);
  });

  it('queues while a task is waiting in the snapshot', () => {
    expect(sendWillQueue({ ...base, streamPhase: 'queued' })).toBe(true);
    expect(sendWillQueue({ ...base, queuedTaskCount: 1 })).toBe(true);
    expect(sendWillQueue({ ...base, pendingQueuedCount: 1 })).toBe(true);
  });

  it('starts a fresh turn when only a FROZEN done preview lingers', () => {
    expect(sendWillQueue({ ...base, liveStreamPhase: 'done' })).toBe(false);
    expect(sendWillQueue({ ...base, liveStreamPhase: 'done', streamPhase: 'done' })).toBe(false);
  });

  it('still queues behind a frozen preview that has live followers queued', () => {
    expect(sendWillQueue({ ...base, liveStreamPhase: 'done', queuedTaskCount: 1 })).toBe(true);
    expect(sendWillQueue({ ...base, liveStreamPhase: 'done', pendingQueuedCount: 1 })).toBe(true);
  });
});

describe('optimisticSendWasQueued', () => {
  it('is false with no optimistic send in flight', () => {
    expect(optimisticSendWasQueued({ pendingTaskId: null, streamTaskId: 'a', queuedTaskIds: ['a'] })).toBe(false);
  });

  it('is false when the optimistic send is the active stream (genuinely running)', () => {
    expect(optimisticSendWasQueued({ pendingTaskId: 'b', streamTaskId: 'b', queuedTaskIds: [] })).toBe(false);
  });

  it('demotes when the optimistic send was queued behind a different running task', () => {
    expect(optimisticSendWasQueued({ pendingTaskId: 'b', streamTaskId: 'a', queuedTaskIds: ['b'] })).toBe(true);
    expect(optimisticSendWasQueued({ pendingTaskId: 'b', streamTaskId: 'a', queuedTaskIds: ['a', 'b'] })).toBe(true);
  });

  it('is false when the server snapshot does not list the optimistic send as queued', () => {
    expect(optimisticSendWasQueued({ pendingTaskId: 'b', streamTaskId: 'a', queuedTaskIds: ['c'] })).toBe(false);
    expect(optimisticSendWasQueued({ pendingTaskId: 'b', streamTaskId: 'a', queuedTaskIds: null })).toBe(false);
    expect(optimisticSendWasQueued({ pendingTaskId: 'b', streamTaskId: 'a', queuedTaskIds: undefined })).toBe(false);
  });
});
