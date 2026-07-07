import { describe, expect, it } from 'vitest';
import {
  isRemovableWorkspacePath,
  projectSessionForList,
  projectWorkspacesForDashboard,
} from '../src/dashboard/routes/sessions.ts';
import type { SessionInfo } from '../src/agent/types.ts';

const CAP = 2048;

function makeSession(overrides: Partial<SessionInfo>): SessionInfo {
  return {
    sessionId: 's1', agent: 'claude', workdir: '/w', workspacePath: '/w',
    model: 'claude-opus-4-8', createdAt: '2026-06-20T00:00:00Z', title: 'Title',
    running: false, runState: 'completed', runDetail: null, runUpdatedAt: null,
    classification: null, userStatus: 'active', userNote: null,
    lastQuestion: null, lastAnswer: null, lastMessageText: null,
    migratedFrom: null, migratedTo: null, linkedSessions: [], numTurns: 3,
    ...overrides,
  } as SessionInfo;
}

describe('projectSessionForList', () => {
  it('caps oversized preview fields to the preview length', () => {
    const huge = 'x'.repeat(50_000);
    const out = projectSessionForList(makeSession({
      lastQuestion: huge, lastAnswer: huge, lastMessageText: huge, runDetail: huge,
    }) as any);
    expect(out.lastQuestion!.length).toBe(CAP);
    expect(out.lastAnswer!.length).toBe(CAP);
    expect(out.lastMessageText!.length).toBe(CAP);
    expect(out.runDetail!.length).toBe(CAP);
    expect(out.lastAnswer).toBe(huge.slice(0, CAP));
  });

  it('leaves short fields and null fields untouched', () => {
    const short = 'a short preview line';
    const out = projectSessionForList(makeSession({
      lastQuestion: short, lastAnswer: null, lastMessageText: undefined as any,
    }) as any);
    expect(out.lastQuestion).toBe(short);
    expect(out.lastAnswer).toBeNull();
  });

  it('preserves all non-preview fields verbatim', () => {
    const session = makeSession({ lastAnswer: 'y'.repeat(9000), numTurns: 42, title: 'Keep me' });
    const out = projectSessionForList(session as any);
    expect(out.sessionId).toBe('s1');
    expect(out.model).toBe('claude-opus-4-8');
    expect(out.numTurns).toBe(42);
    expect(out.title).toBe('Keep me');
    expect(out.userStatus).toBe('active');
  });
});

describe('projectWorkspacesForDashboard', () => {
  it('adds the runtime workdir as the default non-removable workspace when missing', () => {
    const out = projectWorkspacesForDashboard([], '/repo/current', '2026-07-07T00:00:00.000Z');
    expect(out).toEqual([
      {
        path: '/repo/current',
        name: 'current',
        order: -1,
        addedAt: '2026-07-07T00:00:00.000Z',
        isDefault: true,
        removable: false,
      },
    ]);
  });

  it('marks an existing runtime workspace as default and keeps other workspaces removable', () => {
    const out = projectWorkspacesForDashboard([
      { path: '/repo/other', name: 'Other', order: 0, addedAt: '2026-07-01T00:00:00.000Z' },
      { path: '/repo/current', name: 'Current', order: 1, addedAt: '2026-07-02T00:00:00.000Z' },
    ], '/repo/current');

    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ path: '/repo/other', removable: true });
    expect(out[1]).toMatchObject({ path: '/repo/current', isDefault: true, removable: false });
  });
});

describe('isRemovableWorkspacePath', () => {
  it('refuses to remove the runtime default workspace', () => {
    expect(isRemovableWorkspacePath('/repo/current', '/repo/current')).toBe(false);
    expect(isRemovableWorkspacePath('/repo/current/../current', '/repo/current')).toBe(false);
  });

  it('allows non-default workspaces', () => {
    expect(isRemovableWorkspacePath('/repo/other', '/repo/current')).toBe(true);
  });
});
