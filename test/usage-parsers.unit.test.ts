import { describe, it, expect } from 'vitest';
import { buildClaudeOAuthUsage } from '../src/agent/drivers/claude.ts';
import { codexUsageFromRateLimits, codexUsageFromLiveRateLimitsResult } from '../src/agent/drivers/codex.ts';
import { labelFromWindowMinutes, normalizeUsageStatus } from '../src/agent/utils.ts';

// Real payloads captured 2026-07-06 from api.anthropic.com /api/oauth/usage and
// codex-cli 0.142.4 (app-server account/rateLimits/read + session-history event_msg).
// These pin the CURRENT upstream schemas; the legacy fixtures pin the fallback path.

const CLAUDE_OAUTH_2026 = {
  five_hour: { utilization: 3.0, resets_at: '2026-07-06T18:40:00.231467+00:00', limit_dollars: null, used_dollars: null, remaining_dollars: null },
  seven_day: { utilization: 0.0, resets_at: '2026-07-13T12:00:00.231490+00:00', limit_dollars: null, used_dollars: null, remaining_dollars: null },
  seven_day_oauth_apps: null,
  seven_day_opus: null,
  seven_day_sonnet: null,
  extra_usage: {
    is_enabled: true, monthly_limit: 50000, used_credits: 10161.0, utilization: 20.322,
    currency: 'USD', decimal_places: 2, disabled_reason: null, daily: null, weekly: null,
  },
  limits: [
    { kind: 'session', group: 'session', percent: 3, severity: 'normal', resets_at: '2026-07-06T18:40:00.231467+00:00', scope: null, is_active: true },
    { kind: 'weekly_all', group: 'weekly', percent: 0, severity: 'normal', resets_at: '2026-07-13T12:00:00.231490+00:00', scope: null, is_active: false },
    { kind: 'weekly_scoped', group: 'weekly', percent: 0, severity: 'normal', resets_at: '2026-07-13T12:00:00.231798+00:00', scope: { model: { id: null, display_name: 'Fable' }, surface: null }, is_active: false },
  ],
  spend: {
    used: { amount_minor: 10161, currency: 'USD', exponent: 2 },
    limit: { amount_minor: 50000, currency: 'USD', exponent: 2 },
    percent: 20, severity: 'normal', enabled: true, disabled_reason: null,
    cap: { money: null, credits: { amount_minor: 50000, exponent: 2 } },
    balance: null, auto_reload: null, disclaimer: 'Usage credits …', can_purchase_credits: false, can_toggle: false,
  },
  member_dashboard_available: false,
};

const CLAUDE_OAUTH_LEGACY = {
  five_hour: { utilization: 42.4, resets_at: '2026-07-06T18:00:00.000000+00:00' },
  seven_day: { utilization: 18.6, resets_at: '2026-07-13T12:00:00.000000+00:00' },
  seven_day_opus: { utilization: 55.0, resets_at: '2026-07-13T12:00:00.000000+00:00' },
  seven_day_sonnet: null,
  extra_usage: { is_enabled: true, monthly_limit: 50000, used_credits: 0, utilization: 0, currency: 'USD', decimal_places: 2 },
};

describe('buildClaudeOAuthUsage (2026 limits[] schema)', () => {
  it('parses every limits[] window including the model-scoped weekly one', () => {
    const usage = buildClaudeOAuthUsage(CLAUDE_OAUTH_2026)!;
    expect(usage.ok).toBe(true);
    expect(usage.source).toBe('oauth-api');
    expect(usage.windows.map(w => w.label)).toEqual(['5h', '7d', '7d Fable', 'Extra']);
    expect(usage.windows[0].usedPercent).toBe(3);
    expect(usage.windows[0].status).toBe('allowed');
    expect(usage.windows[0].resetAt).toBe('2026-07-06T18:40:00.231467+00:00');
    expect(usage.windows[2].usedPercent).toBe(0);
    expect(usage.status).toBe('allowed');
  });

  it('keeps the Extra credit spend as a dollar detail', () => {
    const usage = buildClaudeOAuthUsage(CLAUDE_OAUTH_2026)!;
    const extra = usage.windows.find(w => w.label === 'Extra')!;
    expect(extra.usedPercent).toBe(20.3);
    expect(extra.detail).toBe('$101.61 / $500.00');
    expect(extra.status).toBe('allowed');
  });

  it('maps upstream severity onto window status ahead of percent thresholds', () => {
    const data = {
      ...CLAUDE_OAUTH_2026,
      limits: [
        { kind: 'session', percent: 50, severity: 'warning', resets_at: '2026-07-06T18:40:00.000000+00:00' },
        { kind: 'weekly_all', percent: 10, severity: 'exceeded', resets_at: '2026-07-13T12:00:00.000000+00:00' },
      ],
    };
    const usage = buildClaudeOAuthUsage(data)!;
    expect(usage.windows[0].status).toBe('warning');
    expect(usage.windows[1].status).toBe('limit_reached');
    expect(usage.status).toBe('limit_reached');
  });

  it('skips the Extra window when extra usage is disabled', () => {
    const data = {
      ...CLAUDE_OAUTH_2026,
      extra_usage: { ...CLAUDE_OAUTH_2026.extra_usage, is_enabled: false },
      spend: { ...CLAUDE_OAUTH_2026.spend, enabled: false },
    };
    const usage = buildClaudeOAuthUsage(data)!;
    expect(usage.windows.map(w => w.label)).toEqual(['5h', '7d', '7d Fable']);
  });

  it('falls back to legacy top-level keys when limits[] is absent', () => {
    const usage = buildClaudeOAuthUsage(CLAUDE_OAUTH_LEGACY)!;
    expect(usage.windows.map(w => w.label)).toEqual(['5h', '7d', '7d Opus', 'Extra']);
    expect(usage.windows[0].usedPercent).toBe(42.4);
    expect(usage.windows[2].usedPercent).toBe(55);
  });

  it('returns null for API error payloads', () => {
    expect(buildClaudeOAuthUsage({ error: { type: 'rate_limit_error' } })).toBeNull();
    expect(buildClaudeOAuthUsage({})).toBeNull();
  });
});

const CODEX_SESSION_RATE_LIMITS_2026 = {
  limit_id: 'codex', limit_name: null,
  primary: { used_percent: 37.0, window_minutes: 43800, resets_at: 1785433571 },
  secondary: null, credits: null, individual_limit: null,
  plan_type: 'team', rate_limit_reached_type: null,
};

const CODEX_LIVE_RESULT_2026 = {
  rateLimits: {
    limitId: 'codex', limitName: null,
    primary: { usedPercent: 37, windowDurationMins: 43800, resetsAt: 1785433572 },
    secondary: null,
    credits: { hasCredits: true, unlimited: false, balance: null },
    individualLimit: null, planType: 'team', rateLimitReachedType: null,
  },
  rateLimitsByLimitId: {
    codex: {
      limitId: 'codex', limitName: null,
      primary: { usedPercent: 37, windowDurationMins: 43800, resetsAt: 1785433572 },
      secondary: null,
      credits: { hasCredits: true, unlimited: false, balance: null },
      individualLimit: null, planType: 'team', rateLimitReachedType: null,
    },
  },
  rateLimitResetCredits: { availableCount: 1 },
};

describe('codexUsageFromRateLimits (session/state-db shape)', () => {
  it('parses the 2026 monthly team window with plan type and allowed status', () => {
    const usage = codexUsageFromRateLimits(CODEX_SESSION_RATE_LIMITS_2026, '2026-07-02T06:58:43.474Z', 'session-history')!;
    expect(usage.windows.map(w => w.label)).toEqual(['1mo']);
    expect(usage.windows[0].usedPercent).toBe(37);
    expect(usage.status).toBe('allowed');
    expect(usage.planType).toBe('team');
    expect(usage.capturedAt).toBe('2026-07-02T06:58:43.474Z');
  });

  it('reports limit_reached from rate_limit_reached_type', () => {
    const usage = codexUsageFromRateLimits({ ...CODEX_SESSION_RATE_LIMITS_2026, rate_limit_reached_type: 'primary' }, null, 'session-history')!;
    expect(usage.status).toBe('limit_reached');
  });

  it('still honors the legacy limit_reached/allowed booleans', () => {
    const legacy = {
      primary: { used_percent: 42, window_minutes: 300, resets_at: 1785433571 },
      secondary: { used_percent: 10, window_minutes: 10080, resets_at: 1785433571 },
      limit_reached: true,
    };
    const usage = codexUsageFromRateLimits(legacy, null, 'state-db')!;
    expect(usage.windows.map(w => w.label)).toEqual(['5h', '7d']);
    expect(usage.status).toBe('limit_reached');
    expect(usage.planType).toBeNull();
  });

  it('adds per-member windows from individual_limit', () => {
    const data = {
      ...CODEX_SESSION_RATE_LIMITS_2026,
      individual_limit: { primary: { used_percent: 12, window_minutes: 43800, resets_at: 1785433571 } },
    };
    const usage = codexUsageFromRateLimits(data, null, 'session-history')!;
    expect(usage.windows.map(w => w.label)).toEqual(['1mo', '1mo (individual)']);
    expect(usage.windows[1].usedPercent).toBe(12);
  });
});

describe('codexUsageFromLiveRateLimitsResult (app-server shape)', () => {
  it('parses the 2026 live result with plan, status and reset credits', () => {
    const usage = codexUsageFromLiveRateLimitsResult(CODEX_LIVE_RESULT_2026, '2026-07-06T00:00:00.000Z')!;
    expect(usage.ok).toBe(true);
    expect(usage.windows.map(w => w.label)).toEqual(['1mo']);
    expect(usage.windows[0].usedPercent).toBe(37);
    expect(usage.status).toBe('allowed');
    expect(usage.planType).toBe('team');
    expect(usage.creditsSummary).toBeNull();
    expect(usage.resetCreditsAvailable).toBe(1);
  });

  it('prefixes labels when multiple limit ids are reported', () => {
    const result = {
      rateLimitsByLimitId: {
        codex: { primary: { usedPercent: 37, windowDurationMins: 43800, resetsAt: 1785433572 }, rateLimitReachedType: null },
        'codex-mini': { primary: { usedPercent: 5, windowDurationMins: 300, resetsAt: 1785433572 }, rateLimitReachedType: 'primary' },
      },
    };
    const usage = codexUsageFromLiveRateLimitsResult(result, '2026-07-06T00:00:00.000Z')!;
    expect(usage.windows.map(w => w.label)).toEqual(['codex 1mo', 'codex-mini 5h']);
    expect(usage.status).toBe('limit_reached');
  });

  it('summarizes unlimited credits', () => {
    const result = {
      rateLimits: {
        primary: { usedPercent: 1, windowDurationMins: 300, resetsAt: 1785433572 },
        credits: { hasCredits: true, unlimited: true, balance: null },
        rateLimitReachedType: null,
      },
    };
    const usage = codexUsageFromLiveRateLimitsResult(result, '2026-07-06T00:00:00.000Z')!;
    expect(usage.creditsSummary).toBe('unlimited');
  });

  it('returns null when no rate limits are present', () => {
    expect(codexUsageFromLiveRateLimitsResult({}, '2026-07-06T00:00:00.000Z')).toBeNull();
    expect(codexUsageFromLiveRateLimitsResult(null, '2026-07-06T00:00:00.000Z')).toBeNull();
  });
});

describe('usage label/status helpers', () => {
  it('labels the codex monthly window as 1mo instead of 730h', () => {
    expect(labelFromWindowMinutes(43800, 'Primary')).toBe('1mo');
  });
  it('maps the new "normal" severity to allowed', () => {
    expect(normalizeUsageStatus('normal')).toBe('allowed');
  });
});
