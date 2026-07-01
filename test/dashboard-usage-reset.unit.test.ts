import { describe, it, expect } from 'vitest';
import { resetDisplay } from '../dashboard/src/usage.ts';
import type { UsageWindowInfo } from '../dashboard/src/types.ts';

function window(over: Partial<UsageWindowInfo>): UsageWindowInfo {
  return {
    label: '5h',
    usedPercent: 100,
    remainingPercent: 0,
    resetAt: null,
    resetAfterSeconds: null,
    status: 'limit_reached',
    ...over,
  };
}

describe('resetDisplay', () => {
  it('shows a countdown while the reset instant is still ahead', () => {
    expect(resetDisplay(window({ resetAfterSeconds: 3600 }))).toEqual({ kind: 'countdown', text: '1h' });
  });

  it('flags a maxed window whose reset instant already passed as resetting (not blank)', () => {
    // Backend clamps resetAfterSeconds to >= 0, so an elapsed 5h window arrives as 0.
    expect(resetDisplay(window({ usedPercent: 100, resetAfterSeconds: 0 }))).toEqual({ kind: 'elapsed' });
  });

  it('treats a resetAt timestamp in the past as elapsed', () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    expect(resetDisplay(window({ resetAt: past }))).toEqual({ kind: 'elapsed' });
  });

  it('reports none when the window carries no reset information at all', () => {
    expect(resetDisplay(window({ resetAt: null, resetAfterSeconds: null }))).toEqual({ kind: 'none' });
  });

  it('prefers the absolute resetAt over resetAfterSeconds when both are present', () => {
    const future = new Date(Date.now() + 90 * 60_000).toISOString();
    expect(resetDisplay(window({ resetAt: future, resetAfterSeconds: 0 }))).toEqual({ kind: 'countdown', text: '1h30m' });
  });
});
