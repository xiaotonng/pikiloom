import { describe, expect, it } from 'vitest';
import { applyTurnWindow, type TailMessage } from '../src/agent/index.ts';

function conversation(turns: number): TailMessage[] {
  const messages: TailMessage[] = [];
  for (let i = 1; i <= turns; i++) {
    messages.push({ role: 'user', text: `user ${i}` });
    messages.push({ role: 'assistant', text: `assistant ${i}` });
  }
  return messages;
}

describe('applyTurnWindow', () => {
  it('returns a windowed slice with pagination metadata and returns all turns when no window is requested', () => {
    // returns a stable turn window with pagination metadata
    const windowed = applyTurnWindow(conversation(4), { turnOffset: 1, turnLimit: 2 });
    expect(windowed.ok).toBe(true);
    expect(windowed.totalTurns).toBe(4);
    expect(windowed.messages.map(message => message.text)).toEqual([
      'user 2',
      'assistant 2',
      'user 3',
      'assistant 3',
    ]);
    expect(windowed.richMessages?.map(message => message.text)).toEqual([
      'user 2',
      'assistant 2',
      'user 3',
      'assistant 3',
    ]);
    expect(windowed.window).toEqual({
      offset: 1,
      limit: 2,
      returnedTurns: 2,
      totalTurns: 4,
      hasOlder: true,
      hasNewer: true,
      startTurn: 1,
      endTurn: 3,
    });

    // returns all turns when no window is requested
    const all = applyTurnWindow(conversation(3), {});
    expect(all.ok).toBe(true);
    expect(all.messages).toHaveLength(6);
    expect(all.window).toEqual({
      offset: 0,
      limit: 3,
      returnedTurns: 3,
      totalTurns: 3,
      hasOlder: false,
      hasNewer: false,
      startTurn: 0,
      endTurn: 3,
    });
  });
});
