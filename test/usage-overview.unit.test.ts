import { describe, it, expect } from 'vitest';
import { buildUsageOverviewLines, formatUsageWindowsSummary } from '../src/bot/render-shared.ts';
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

const texts = (o: UsageOverview) => buildUsageOverviewLines(o).map(l => l.text);

describe('formatUsageWindowsSummary', () => {
  it('joins windows compactly and rounds percents', () => {
    expect(formatUsageWindowsSummary(usage([['5h', 42.4], ['7d', 18.6]]))).toBe('5h 42% · 7d 19%');
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
      'Claude Code (current)',
      '  ● Work: 5h 42% · 7d 18%',
      '  ○ Personal: 5h 90% · 7d 70%',
      '  ○ Default login: 5h 12% · 7d 5%',
    ]);
  });

  it('renders a single line for an agent without accounts', () => {
    const overview: UsageOverview = {
      agents: [{ agent: 'codex', label: 'Codex', isCurrent: false, usage: usage([['5h', 30]]), accounts: [] }],
    };
    expect(texts(overview)).toEqual(['', 'Provider Usage', 'Codex', '  5h 30%']);
  });

  it('skips agents with neither usage nor accounts, and returns [] when nothing is left', () => {
    const overview: UsageOverview = {
      agents: [
        { agent: 'gemini', label: 'Gemini CLI', isCurrent: false, usage: unavailable, accounts: [] },
        { agent: 'codex', label: 'Codex', isCurrent: true, usage: usage([['5h', 7]]), accounts: [] },
      ],
    };
    // gemini (no usage, no accounts) is dropped; codex remains.
    expect(texts(overview)).toEqual(['', 'Provider Usage', 'Codex (current)', '  5h 7%']);
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
});
