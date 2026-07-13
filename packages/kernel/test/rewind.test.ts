import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLoom, type Loom } from '../src/runtime/loom.js';
import { FsSessionStore } from '../src/ports/defaults.js';
import { claudeResumeArgs } from '../src/drivers/claude.js';
import type { AgentDriver, AgentTurnInput, DriverContext, DriverResult } from '../src/contracts/driver.js';

const flushTurns = () => new Promise((r) => setTimeout(r, 50));

// A scripted driver that keeps a STABLE native id across turns (a rewind resumes the same
// session), records every AgentTurnInput, and stamps a per-turn anchor. `canRewind` toggles
// the capability so the rejection path is exercised too.
class RewindDriver implements AgentDriver {
  readonly runs: AgentTurnInput[] = [];
  nativeId = 'native-parent';
  turn = 0;
  constructor(readonly id: string, private readonly canRewind: boolean) {}
  get capabilities() { return { steer: false, interact: false, resume: true, tui: false, fork: false, rewind: this.canRewind }; }
  async run(input: AgentTurnInput, ctx: DriverContext): Promise<DriverResult> {
    this.runs.push(input);
    ctx.emit({ type: 'session', sessionId: this.nativeId });
    const text = `reply to: ${input.prompt.slice(0, 40)}`;
    ctx.emit({ type: 'text', delta: text });
    return { ok: true, text, sessionId: this.nativeId, anchor: `${this.nativeId}/a${++this.turn}`, stopReason: 'end_turn' };
  }
}

describe('claudeResumeArgs (rewind flag contract)', () => {
  it('rewind resumes the SAME session at the anchor WITHOUT --fork-session', () => {
    expect(claudeResumeArgs('sid', null, { anchor: 'uuid-3' }))
      .toEqual(['--resume', 'sid', '--resume-session-at', 'uuid-3']);
  });
  it('a fork wins over a rewind (mutually exclusive — never emits both)', () => {
    expect(claudeResumeArgs('sid', { anchor: 'f' }, { anchor: 'r' }))
      .toEqual(['--resume', 'sid', '--fork-session', '--resume-session-at', 'f']);
  });
  it('a rewind without an anchor is a plain resume (nothing to rebranch)', () => {
    expect(claudeResumeArgs('sid', null, { anchor: null })).toEqual(['--resume', 'sid']);
    expect(claudeResumeArgs('sid', null, null)).toEqual(['--resume', 'sid']);
  });
});

describe('Hub.rewindSession', () => {
  let tmp: string;
  let loom: Loom;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-rewind-')); });
  afterEach(async () => { await loom?.stop(); fs.rmSync(tmp, { recursive: true, force: true }); });

  async function seedParent(driver: RewindDriver): Promise<{ sessionKey: string; taskIds: string[] }> {
    loom = createLoom({ drivers: [driver as AgentDriver], defaultAgent: driver.id, sessionStore: new FsSessionStore(tmp), workdir: tmp });
    const first = await loom.io.prompt({ prompt: 'first question' });
    await flushTurns();
    const second = await loom.io.prompt({ prompt: 'second question', sessionKey: first.sessionKey });
    await flushTurns();
    return { sessionKey: first.sessionKey, taskIds: [first.taskId, second.taskId] };
  }

  it('drops the tip, keeps the SAME session id, and rewind-dispatches at the kept boundary', async () => {
    const driver = new RewindDriver('rewindy', true);
    const { sessionKey, taskIds } = await seedParent(driver);
    const id = sessionKey.split(':')[1];
    const store = new FsSessionStore(tmp);

    // Rewind to turn 1 (drop turn 2). Same key back; the managed transcript loses the tip.
    const { sessionKey: back } = await loom.io.rewindSession({ sessionKey, atTaskId: taskIds[0] });
    expect(back).toBe(sessionKey);                                    // NOT a new session
    expect((await store.history('rewindy', id)).map(t => t.prompt)).toEqual(['first question']);

    const rewound = (await store.get('rewindy', id))!;
    expect(rewound.pendingRewind).toEqual({ anchor: 'native-parent/a1' });   // turn 1's recorded anchor
    expect(rewound.nativeSessionId).toBe('native-parent');           // native id unchanged
    expect(rewound.forkedFrom ?? null).toBeNull();                   // a rewind is not a fork
    expect(rewound.runState).toBe('completed');                      // no live turn yet

    // The re-issued prompt consumes the rewind: driver sees THIS session's native id + rewind
    // anchor + NO fork + a clean prompt (no seed prepend).
    await loom.io.prompt({ prompt: 'regenerated answer', sessionKey });
    await flushTurns();
    const run = driver.runs.at(-1)!;
    expect(run.sessionId).toBe('native-parent');
    expect(run.rewind).toEqual({ anchor: 'native-parent/a1' });
    expect(run.fork ?? null).toBeNull();
    expect(run.prompt).toBe('regenerated answer');

    // Settled: intent consumed, id still the same, transcript is [kept tip, regenerated].
    const settled = (await store.get('rewindy', id))!;
    expect(settled.pendingRewind ?? null).toBeNull();
    expect(settled.nativeSessionId).toBe('native-parent');
    expect((await store.history('rewindy', id)).map(t => t.prompt)).toEqual(['first question', 'regenerated answer']);

    // A follow-up now appends normally — no rewind flag lingers.
    await loom.io.prompt({ prompt: 'follow-up', sessionKey });
    await flushTurns();
    expect(driver.runs.at(-1)!.rewind ?? null).toBeNull();
  });

  it('rejects rewinding at the tail (nothing to regenerate)', async () => {
    const driver = new RewindDriver('rewindy', true);
    const { sessionKey, taskIds } = await seedParent(driver);
    await expect(loom.io.rewindSession({ sessionKey, atTaskId: taskIds[1] })).rejects.toThrow(/tail/);
  });

  it('rejects an unknown rewind point', async () => {
    const driver = new RewindDriver('rewindy', true);
    const { sessionKey } = await seedParent(driver);
    await expect(loom.io.rewindSession({ sessionKey, atTaskId: 'nope' })).rejects.toThrow(/not found/);
  });

  it('rejects a driver without capabilities.rewind (caller falls back to append/fork)', async () => {
    const driver = new RewindDriver('plain', false);
    const { sessionKey, taskIds } = await seedParent(driver);
    await expect(loom.io.rewindSession({ sessionKey, atTaskId: taskIds[0] })).rejects.toThrow(/no in-place rewind/);
    // The transcript is untouched by a rejected rewind.
    expect((await new FsSessionStore(tmp).history('plain', sessionKey.split(':')[1])).length).toBe(2);
  });
});
