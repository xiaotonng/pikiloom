import { describe, expect, it } from 'vitest';
import { projectSnapshot } from '../src/pikichannel/adapter-pikiloom.ts';

function snapWithInteraction(): any {
  return {
    phase: 'streaming',
    taskId: 't1',
    updatedAt: 1,
    interactions: [{
      promptId: 'h1',
      kind: 'user-input',
      title: 'Pick one',
      hint: 'a hint',
      currentIndex: 0,
      questions: [{
        id: 'ask-user',
        header: 'Scope',
        prompt: 'Which option?',
        options: [
          { label: 'A', description: 'first', value: 'A' },
          { label: 'B', description: 'second', value: 'B' },
        ],
        allowFreeform: true,
      }],
    }],
  };
}

describe('pikichannel projectInteractions', () => {
  it('preserves prompt, options, header and allowFreeform for remote clients', () => {
    const u = projectSnapshot('claude:s1', snapWithInteraction());
    const q = u.interactions?.[0]?.questions?.[0] as any;
    expect(q).toBeTruthy();
    // regression: prompt text must survive (was read from non-existent q.text)
    expect(q.text).toBe('Which option?');
    expect(q.header).toBe('Scope');
    // regression: options must survive (were read from non-existent q.choices)
    expect(q.choices).toHaveLength(2);
    expect(q.choices[0]).toMatchObject({ label: 'A', description: 'first', value: 'A' });
    expect(q.allowFreeform).toBe(true);
  });

  it('does not drop options when only label is present', () => {
    const snap = snapWithInteraction();
    snap.interactions[0].questions[0].options = [{ label: 'Only', value: 'Only' }];
    const u = projectSnapshot('claude:s1', snap);
    const q = u.interactions?.[0]?.questions?.[0] as any;
    expect(q.choices).toHaveLength(1);
    expect(q.choices[0].label).toBe('Only');
  });
});
