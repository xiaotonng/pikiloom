import { describe, it, expect } from 'vitest';
import { diffSnapshot, applySnapshotPatch, emptySnapshot, type UniversalSnapshot } from '../src/protocol/index.js';

describe('snapshot diff/apply', () => {
  it('round-trips append + scalar + struct changes', () => {
    const a: UniversalSnapshot = { phase: 'streaming', text: 'Hello', updatedAt: 1, toolCalls: [] };
    const b: UniversalSnapshot = { phase: 'streaming', text: 'Hello world', updatedAt: 2, toolCalls: [{ id: 't1', name: 'x', summary: 'x', status: 'running' }] };
    const patch = diffSnapshot(a, b);
    expect(patch.appendText).toBe(' world');               // prefix-append, not full resend
    const applied = applySnapshotPatch(a, patch);
    expect(applied.text).toBe('Hello world');
    expect(applied.toolCalls?.[0].id).toBe('t1');
    expect(applied.phase).toBe('streaming');
    expect(applied.updatedAt).toBe(2);
  });

  it('clears a field across the wire via undefined->null coercion', () => {
    const a: UniversalSnapshot = { phase: 'streaming', activity: 'working', updatedAt: 1 };
    const b: UniversalSnapshot = { phase: 'done', activity: undefined, updatedAt: 2 };
    const patch = diffSnapshot(a, b);
    // must survive JSON round-trip (undefined would be dropped by JSON.stringify)
    const wire = JSON.parse(JSON.stringify(patch));
    expect(wire.set).toHaveProperty('activity', null);
    const applied = applySnapshotPatch(a, wire);
    expect(applied.activity).toBeNull();
    expect(applied.phase).toBe('done');
  });

  it('full patch replaces wholesale', () => {
    const full: UniversalSnapshot = { phase: 'done', text: 'final', updatedAt: 5 };
    const applied = applySnapshotPatch(emptySnapshot(), { full });
    expect(applied).toEqual(full);
  });
});
