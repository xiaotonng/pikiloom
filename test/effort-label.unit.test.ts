import { describe, expect, it } from 'vitest';
import { effortLabel, effortOptionsFor } from '../src/core/config/runtime-config.js';

describe('effortLabel — one canonical name per effort token', () => {
  it('returns the raw token, trimmed + lowercased (never a prose label)', () => {
    expect(effortLabel('xhigh')).toBe('xhigh');
    expect(effortLabel(' MAX ')).toBe('max');
    expect(effortLabel('Ultra')).toBe('ultra');
    expect(effortLabel(null)).toBe('');
    expect(effortLabel(undefined)).toBe('');
  });
});

describe('effortOptionsFor — picker labels stay identical to the token', () => {
  // The dashboard composer/turn-header and the IM picker/agent-status all render the same
  // string, so a level must read the same everywhere. Guards against reintroducing "Very High".
  for (const agent of ['claude', 'codex', 'hermes'] as const) {
    it(`${agent}: every label equals its id`, () => {
      const levels = effortOptionsFor(agent);
      expect(levels.length).toBeGreaterThan(0);
      for (const l of levels) {
        expect(l.label).toBe(l.id);
        expect(l.label).toBe(effortLabel(l.id));
      }
      expect(levels.map(l => l.label)).not.toContain('Very High');
    });
  }

  it('codex exposes the xhigh rung as "xhigh"', () => {
    expect(effortOptionsFor('codex').find(l => l.id === 'xhigh')?.label).toBe('xhigh');
  });

  it('gemini has no UI-exposed effort levels', () => {
    expect(effortOptionsFor('gemini')).toEqual([]);
  });
});
