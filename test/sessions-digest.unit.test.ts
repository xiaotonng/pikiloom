import { describe, expect, it } from 'vitest';
import { formatSessionsDigestText, type SessionsDigestData } from '../src/bot/commands.ts';

describe('formatSessionsDigestText', () => {
  it('returns an empty-workspace hint when there are no sessions', () => {
    const data: SessionsDigestData = {
      workspaceName: 'demo-app',
      agentTotals: {},
      total: 0,
      entries: [],
    };
    expect(formatSessionsDigestText(data)).toContain('No sessions in demo-app');
  });

  it('renders recent sessions with agent totals and switch hints', () => {
    const data: SessionsDigestData = {
      workspaceName: 'demo-app',
      agentTotals: { codex: 2, claude: 1 },
      total: 3,
      entries: [
        {
          index: 1,
          agent: 'codex',
          title: 'Refactor auth module',
          time: '06/18 14:30 · done',
          runState: 'completed',
          runDetail: null,
          isCurrent: true,
          sessionKey: 'sess-1',
        },
        {
          index: 2,
          agent: 'claude',
          title: 'Write release notes',
          time: '06/18 13:10 · running',
          runState: 'running',
          runDetail: 'tool: read',
          isCurrent: false,
          sessionKey: 'sess-2',
        },
      ],
    };

    const text = formatSessionsDigestText(data);
    expect(text).toContain('Session digest — demo-app (3 total · codex×2 · claude×1)');
    expect(text).toContain('1. codex · Refactor auth module [current]');
    expect(text).toContain('2. claude · Write release notes [running]');
    expect(text).toContain('tool: read');
    expect(text).toContain('/sessions <#>');
  });
});
