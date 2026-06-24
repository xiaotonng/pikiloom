import { describe, it, expect } from 'vitest';
import { formatFooterParts } from '../src/bot/render-shared.js';

describe('formatFooterParts — BYOK profile name + provider', () => {
  it('shows the profile display name (not the raw modelId) and the provider on the final footer', () => {
    const parts = formatFooterParts('codex', 3000, null, null, {
      model: 'doubao-seed-2-1-pro-260628',
      effort: 'high',
      provider: '豆包 (Volcengine Ark)',
      profileName: '豆包 Seed 2.1',
    });
    expect(parts.identity).toBe('codex · 豆包 Seed 2.1');
    expect(parts.identity).not.toContain('doubao-seed-2-1-pro');
    expect(parts.runtime).toContain('high');
    expect(parts.runtime).toContain('via 豆包 (Volcengine Ark)');
  });

  it('takes profileName + providerName from live meta during streaming', () => {
    const parts = formatFooterParts('codex', 1000, { profileName: '豆包 Seed 2.1', providerName: '豆包 (Volcengine Ark)' } as any, null, {
      model: 'gpt-5.5',
      effort: 'high',
    });
    expect(parts.identity).toBe('codex · 豆包 Seed 2.1');
    expect(parts.runtime).toContain('via 豆包 (Volcengine Ark)');
  });

  it('falls back to the raw model label when no profile is bound', () => {
    const parts = formatFooterParts('claude', 2000, null, null, { model: 'sonnet-4-6', effort: 'high' });
    expect(parts.identity).toBe('claude · sonnet-4-6');
    expect(parts.runtime).not.toContain('via');
  });
});
