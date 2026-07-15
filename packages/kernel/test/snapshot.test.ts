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

  it('transmits AND clears compaction (a `compact_boundary` belongs to its own turn)', () => {
    // set: a boundary fires mid-turn → the patch must carry it (it rides patches, not only
    // full baselines) so a live surface can mark it.
    const before: UniversalSnapshot = { phase: 'streaming', updatedAt: 1 };
    const compacted: UniversalSnapshot = { phase: 'streaming', updatedAt: 2, compaction: { trigger: 'manual', atTokens: 178_444 } };
    const setPatch = diffSnapshot(before, compacted);
    expect(setPatch.set).toMatchObject({ compaction: { trigger: 'manual', atTokens: 178_444 } });
    expect(applySnapshotPatch(before, setPatch).compaction).toEqual({ trigger: 'manual', atTokens: 178_444 });

    // clear: the next turn has no compaction → the diff must emit an explicit null so it does
    // NOT bleed onto the new turn (regression: phantom "auto-compacted" divider after /compact).
    const nextTurn: UniversalSnapshot = { phase: 'streaming', taskId: 'B', updatedAt: 3 };
    const clearPatch = diffSnapshot(compacted, nextTurn);
    const wire = JSON.parse(JSON.stringify(clearPatch)); // undefined would be dropped by JSON
    expect(wire.set).toHaveProperty('compaction', null);
    expect(applySnapshotPatch(compacted, wire).compaction).toBeNull();
  });
});
