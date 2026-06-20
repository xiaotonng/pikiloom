/**
 * The session list / swim-lane endpoints (`/api/sessions`, `/api/sessions/:agent`)
 * cap the heavy preview text fields so a session whose last turn dumped a huge
 * tool output or long answer doesn't ship tens of KB per card that the list never
 * renders (the cards only show the head via firstMeaningfulLine / slice / sanitize
 * and use the text for client-side substring search). Full text stays available
 * from the session-detail / messages endpoints. Guard the contract here.
 */

import { describe, expect, it } from 'vitest';
import { projectSessionForList } from '../src/dashboard/routes/sessions.ts';
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
    // The retained slice is the *head*, so previews/search over the start still work.
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
