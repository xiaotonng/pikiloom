import { describe, expect, it } from 'vitest';
import { liveStreamFailureLabelKey } from '../dashboard/src/pages/sessions/LivePreview.tsx';
import { getSessionRunFailureDetail } from '../dashboard/src/utils.ts';

describe('dashboard session failure display', () => {
  it('shows errors correctly: done-stream error, persisted detail, and no duplication while live stream owns the turn', () => {
    // keeps a done-stream error visible even when partial output exists
    expect(liveStreamFailureLabelKey({
      phase: 'done',
      text: 'Partial answer before the agent failed.',
      thinking: '',
      error: 'Claude exited before completing the turn.',
    })).toBe('hub.streamErrored');

    // surfaces persisted incomplete run detail after the live stream is gone
    const detail = "You're now using usage credits · Your session limit resets 5pm (Asia/Shanghai)";
    expect(getSessionRunFailureDetail({
      running: false,
      runState: 'incomplete',
      runDetail: detail,
      awaiting: null,
    }, {
      streaming: false,
      hasLiveStream: false,
      streamPhase: null,
      queuedTaskCount: 0,
    })).toBe(detail);

    // does not duplicate the persisted failure while live stream UI owns the turn
    expect(getSessionRunFailureDetail({
      running: false,
      runState: 'incomplete',
      runDetail: 'Timed out.',
      awaiting: null,
    }, {
      streaming: false,
      hasLiveStream: true,
      streamPhase: 'done',
      queuedTaskCount: 0,
    })).toBeNull();
  });
});
