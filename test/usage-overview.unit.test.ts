import { describe, it, expect } from 'vitest';
import { buildUsageOverviewLines, formatUsageWindowsSummary, freshestUsageCapturedAt } from '../src/bot/render-shared.ts';
import type { UsageOverview } from '../src/bot/commands.ts';
import type { UsageResult } from '../src/agent/types.ts';

function usage(windows: Array<[string, number]>): UsageResult {
  return {
    ok: true,
    agent: 'claude',
    source: 'ratelimit-headers',
    capturedAt: '2026-06-30T00:00:00.000Z',
    status: 'allowed',
    windows: windows.map(([label, usedPercent]) => ({
      label, usedPercent, remainingPercent: 100 - usedPercent, resetAt: null, resetAfterSeconds: null,
      status: usedPercent >= 80 ? 'warning' : 'allowed',
    })),
    error: null,
  };
}

const unavailable: UsageResult = {
  ok: false, agent: 'claude', source: null, capturedAt: null, status: null, windows: [], error: 'boom',
};

// Fixed "now" = 5 minutes after the usage() capturedAt, so the freshness stamp is deterministic.
const NOW = Date.parse('2026-06-30T00:05:00.000Z');
const texts = (o: UsageOverview) => buildUsageOverviewLines(o, NOW).map(l => l.text);

describe('formatUsageWindowsSummary', () => {
  it('joins windows compactly and rounds percents', () => {
    expect(formatUsageWindowsSummary(usage([['5h', 42.4], ['7d', 18.6]]))).toBe('5h 42% · 7d 19%');
  });
  it('adds per-window reset countdowns, preferring resetAt over stale resetAfterSeconds', () => {
    const u = usage([['5h', 42.4], ['7d', 100]]);
    u.windows[0].resetAt = '2026-06-30T01:35:00.000Z';
    u.windows[0].resetAfterSeconds = 0;
    u.windows[1].resetAfterSeconds = 3600;
    expect(formatUsageWindowsSummary(u, NOW)).toBe('5h 42% (reset 1h30m) · 7d 100% (reset 1h)');
  });
  it('shows reset now once the reset instant has elapsed', () => {
    const u = usage([['5h', 100]]);
    u.windows[0].resetAt = '2026-06-30T00:04:00.000Z';
    expect(formatUsageWindowsSummary(u, NOW)).toBe('5h 100% (reset now)');
  });
  it('keeps reset time when telemetry has status but no percent', () => {
    const u = usage([]);
    u.status = 'warning';
    u.windows = [{
      label: '<1m ago',
      usedPercent: null,
      remainingPercent: null,
      resetAt: '2026-06-30T02:05:00.000Z',
      resetAfterSeconds: null,
      status: 'warning',
    }];
    expect(formatUsageWindowsSummary(u, NOW)).toBe('status=warning (reset 2h)');
  });
  it('reports unavailable for null or errored usage', () => {
    expect(formatUsageWindowsSummary(null)).toBe('unavailable');
    expect(formatUsageWindowsSummary(unavailable)).toBe('unavailable');
  });
  it('falls back to status when ok but no windows have a percent', () => {
    expect(formatUsageWindowsSummary({ ...usage([]), status: 'allowed' })).toBe('status=allowed');
  });
});

describe('buildUsageOverviewLines', () => {
  it('marks the active account and always lists the default login for account agents', () => {
    const overview: UsageOverview = {
      agents: [{
        agent: 'claude', label: 'Claude Code', isCurrent: true, usage: usage([['5h', 12], ['7d', 5]]),
        accounts: [
          { id: 'a1', label: 'Work', active: true, usage: usage([['5h', 42], ['7d', 18]]) },
          { id: 'a2', label: 'Personal', active: false, usage: usage([['5h', 90], ['7d', 70]]) },
          { id: null, label: 'Default login', active: false, usage: usage([['5h', 12], ['7d', 5]]) },
        ],
      }],
    };
    expect(texts(overview)).toEqual([
      '',
      'Provider Usage',
      '  Updated: 5m 0s ago',
      'Claude Code (current)',
      '  ● Work: 5h 42% · 7d 18%',
      '  ○ Personal: 5h 90% · 7d 70%',
      '  ○ Default login: 5h 12% · 7d 5%',
    ]);
  });

  it('includes reset countdowns in account rows', () => {
    const work = usage([['5h', 100], ['7d', 19]]);
    work.windows[0].resetAt = '2026-06-30T00:35:00.000Z';
    work.windows[1].resetAt = '2026-07-01T06:05:00.000Z';
    const overview: UsageOverview = {
      agents: [{
        agent: 'claude', label: 'Claude Code', isCurrent: true, usage: usage([['5h', 12]]),
        accounts: [
          { id: 'a1', label: 'Work', active: true, usage: work },
        ],
      }],
    };
    expect(texts(overview)).toEqual([
      '',
      'Provider Usage',
      '  Updated: 5m 0s ago',
      'Claude Code (current)',
      '  ● Work: 5h 100% (reset 30m) · 7d 19% (reset 1d6h)',
    ]);
  });

  it('renders a single line for an agent without accounts', () => {
    const overview: UsageOverview = {
      agents: [{ agent: 'codex', label: 'Codex', isCurrent: false, usage: usage([['5h', 30]]), accounts: [] }],
    };
    expect(texts(overview)).toEqual(['', 'Provider Usage', '  Updated: 5m 0s ago', 'Codex', '  5h 30%']);
  });

  it('skips agents with neither usage nor accounts, and returns [] when nothing is left', () => {
    const overview: UsageOverview = {
      agents: [
        { agent: 'gemini', label: 'Gemini CLI', isCurrent: false, usage: unavailable, accounts: [] },
        { agent: 'codex', label: 'Codex', isCurrent: true, usage: usage([['5h', 7]]), accounts: [] },
      ],
    };
    // gemini (no usage, no accounts) is dropped; codex remains.
    expect(texts(overview)).toEqual(['', 'Provider Usage', '  Updated: 5m 0s ago', 'Codex (current)', '  5h 7%']);
    expect(buildUsageOverviewLines({ agents: [
      { agent: 'gemini', label: 'Gemini CLI', isCurrent: false, usage: unavailable, accounts: [] },
    ] })).toEqual([]);
  });

  it('keeps an account agent even when its accounts have no usage yet (still actionable)', () => {
    const overview: UsageOverview = {
      agents: [{
        agent: 'claude', label: 'Claude Code', isCurrent: true, usage: null,
        accounts: [{ id: 'a1', label: 'Work', active: true, usage: null }],
      }],
    };
    expect(texts(overview)).toEqual([
      '', 'Provider Usage', 'Claude Code (current)', '  ● Work: unavailable',
    ]);
  });

  it('omits the freshness stamp when no usage carries a capturedAt', () => {
    const overview: UsageOverview = {
      agents: [{ agent: 'codex', label: 'Codex', isCurrent: false, usage: { ...usage([['5h', 30]]), capturedAt: null }, accounts: [] }],
    };
    expect(texts(overview)).toEqual(['', 'Provider Usage', 'Codex', '  5h 30%']);
  });
});

describe('freshestUsageCapturedAt', () => {
  it('returns the latest capturedAt across agents and their accounts', () => {
    const overview: UsageOverview = {
      agents: [{
        agent: 'claude', label: 'Claude Code', isCurrent: true,
        usage: { ...usage([['5h', 1]]), capturedAt: '2026-06-30T00:00:00.000Z' },
        accounts: [
          { id: 'a1', label: 'Work', active: true, usage: { ...usage([['5h', 2]]), capturedAt: '2026-06-30T00:02:00.000Z' } },
          { id: 'a2', label: 'Old', active: false, usage: { ...usage([['5h', 3]]), capturedAt: '2026-06-29T00:00:00.000Z' } },
        ],
      }],
    };
    expect(freshestUsageCapturedAt(overview.agents)).toBe('2026-06-30T00:02:00.000Z');
  });

  it('ignores null timestamps and returns null when none are present', () => {
    expect(freshestUsageCapturedAt([])).toBeNull();
    const overview: UsageOverview = {
      agents: [{
        agent: 'claude', label: 'Claude Code', isCurrent: true, usage: null,
        accounts: [{ id: 'a1', label: 'Work', active: true, usage: null }],
      }],
    };
    expect(freshestUsageCapturedAt(overview.agents)).toBeNull();
  });
});
