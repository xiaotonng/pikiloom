import { describe, it, expect } from 'vitest';
import { toPikiloomPlan } from '../src/agent/kernel-bridge.js';

// Regression: the kernel emits plan steps keyed { text }, but pikiloom's StreamPlan and the whole
// dashboard pipeline (pikichannel adapter -> ws.ts -> PlanProgressCard) key them { step }. The
// bridge must translate at the seam, else the task list renders the progress count but blank rows
// (the codex "0/4 项任务已完成" with empty dots bug).
describe('kernel-bridge toPikiloomPlan (text -> step)', () => {
  it('maps kernel { text } plan steps to pikiloom { step }', () => {
    const out = toPikiloomPlan({
      explanation: 'doing work',
      steps: [
        { text: 'read code', status: 'completed' },
        { text: 'apply fix', status: 'inProgress' },
        { text: 'verify', status: 'pending' },
      ],
    });
    expect(out).toEqual({
      explanation: 'doing work',
      steps: [
        { step: 'read code', status: 'completed' },
        { step: 'apply fix', status: 'inProgress' },
        { step: 'verify', status: 'pending' },
      ],
    });
  });

  it('drops empty-text steps and normalizes unknown status to pending', () => {
    const out = toPikiloomPlan({
      explanation: null,
      steps: [
        { text: 'keep', status: 'weird' },
        { text: '   ', status: 'completed' },
        { text: '', status: 'pending' },
      ],
    });
    expect(out).toEqual({ explanation: null, steps: [{ step: 'keep', status: 'pending' }] });
  });

  it('returns null for missing / empty / all-blank plans', () => {
    expect(toPikiloomPlan(null)).toBeNull();
    expect(toPikiloomPlan({ steps: [] })).toBeNull();
    expect(toPikiloomPlan({ steps: [{ text: '  ', status: 'pending' }] })).toBeNull();
    expect(toPikiloomPlan({})).toBeNull();
  });

  it('accepts an already-pikiloom-shaped { step } plan idempotently', () => {
    const out = toPikiloomPlan({ explanation: null, steps: [{ step: 'already', status: 'completed' }] });
    expect(out).toEqual({ explanation: null, steps: [{ step: 'already', status: 'completed' }] });
  });
});
