import { describe, expect, it } from 'vitest';
import { queuedIdsToDeferForSteer } from '../src/bot/queue-steer';

// Mirrors queueSessionTask's runner: a task flagged deferForSteer skips its turn
// once (flag cleared) and re-appends to the tail. Simulating it proves the
// emergent run order from a given defer-set.
function simulateRunOrder(queuedIds: string[], deferIds: string[]): string[] {
  const chain = [...queuedIds];
  const deferred = new Set(deferIds);
  const runOrder: string[] = [];
  let guard = 0;
  while (chain.length && guard++ < 1000) {
    const head = chain.shift()!;
    if (deferred.has(head)) {
      deferred.delete(head);
      chain.push(head);
    } else {
      runOrder.push(head);
    }
  }
  return runOrder;
}

describe('queuedIdsToDeferForSteer', () => {
  it('defers every queued task except the steered target', () => {
    expect(queuedIdsToDeferForSteer(['a', 'b', 'c'], 'b')).toEqual(['a', 'c']);
    expect(queuedIdsToDeferForSteer(['a', 'b', 'c'], 'a')).toEqual(['b', 'c']);
    expect(queuedIdsToDeferForSteer(['a', 'b', 'c'], 'c')).toEqual(['a', 'b']);
  });

  it('defers nothing when the target is not actually queued', () => {
    expect(queuedIdsToDeferForSteer(['a', 'b'], 'z')).toEqual([]);
    expect(queuedIdsToDeferForSteer([], 'a')).toEqual([]);
  });
});

describe('steer run order (target jumps to front, rest keep relative order)', () => {
  const cases: Array<{ queue: string[]; target: string; expected: string[] }> = [
    { queue: ['a', 'b'], target: 'b', expected: ['b', 'a'] },
    { queue: ['a', 'b'], target: 'a', expected: ['a', 'b'] },
    // the 3+ regression: steering the middle task must not throw 'a' behind 'c'
    { queue: ['a', 'b', 'c'], target: 'b', expected: ['b', 'a', 'c'] },
    { queue: ['a', 'b', 'c'], target: 'c', expected: ['c', 'a', 'b'] },
    { queue: ['a', 'b', 'c', 'd'], target: 'c', expected: ['c', 'a', 'b', 'd'] },
  ];
  for (const { queue, target, expected } of cases) {
    it(`steer ${target} from [${queue.join(',')}] → [${expected.join(',')}]`, () => {
      const deferIds = queuedIdsToDeferForSteer(queue, target);
      expect(simulateRunOrder(queue, deferIds)).toEqual(expected);
    });
  }
});
