import { describe, expect, it } from 'vitest';
import {
  CODEX_56_MODEL_IDS,
  effortLabel,
  effortOptionsFor,
  splitEffortForAgent,
} from '../src/core/config/runtime-config.js';

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

  it('codex with no model keeps the base low→xhigh ladder (no max/ultra)', () => {
    expect(effortOptionsFor('codex').map(l => l.id)).toEqual(['low', 'medium', 'high', 'xhigh']);
  });

  it('GPT-5.6 sol/terra unlock the native max + ultra rungs', () => {
    for (const model of ['gpt-5.6-sol', 'gpt-5.6-terra']) {
      expect(effortOptionsFor('codex', model).map(l => l.id))
        .toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
    }
  });

  it('GPT-5.6-luna unlocks max but not ultra', () => {
    expect(effortOptionsFor('codex', 'gpt-5.6-luna').map(l => l.id))
      .toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(CODEX_56_MODEL_IDS).toContain('gpt-5.6-luna');
  });

  it('an unknown / BYOK codex model falls back to the base ladder', () => {
    expect(effortOptionsFor('codex', 'gpt-4o').map(l => l.id)).toEqual(['low', 'medium', 'high', 'xhigh']);
    expect(effortOptionsFor('codex', 'gpt-5.5').map(l => l.id)).toEqual(['low', 'medium', 'high', 'xhigh']);
  });
});

describe('splitEffortForAgent — reconciles the two meanings of the effort token', () => {
  it('codex sends max/ultra verbatim and never triggers workflow', () => {
    expect(splitEffortForAgent('codex', 'ultra')).toEqual({ effort: 'ultra', workflow: false });
    expect(splitEffortForAgent('codex', 'max')).toEqual({ effort: 'max', workflow: false });
    expect(splitEffortForAgent('codex', ' XHIGH ')).toEqual({ effort: 'xhigh', workflow: false });
  });

  it('claude keeps ultra as a display alias: max effort + workflow orchestration', () => {
    expect(splitEffortForAgent('claude', 'ultra')).toEqual({ effort: 'max', workflow: true });
    expect(splitEffortForAgent('claude', 'max')).toEqual({ effort: 'max', workflow: false });
    expect(splitEffortForAgent('claude', 'high')).toEqual({ effort: 'high', workflow: false });
  });

  it('hermes decomposes like claude (its ladder never reaches max/ultra anyway)', () => {
    expect(splitEffortForAgent('hermes', 'high')).toEqual({ effort: 'high', workflow: false });
  });
});
