import { describe, it, expect } from 'vitest';
import { runTurn } from '../src/runtime/turn.js';
import { EchoDriver } from '../src/drivers/echo.js';
import type { AgentDriver, AgentTurnInput, DriverContext, DriverResult } from '../src/contracts/driver.js';

describe('runTurn (bridge primitive, hermetic)', () => {
  it('streams accumulating snapshots and returns the final result', async () => {
    const snaps: any[] = [];
    const { result, snapshot } = await runTurn(new EchoDriver(), { prompt: 'hello', workdir: process.cwd() }, { onSnapshot: s => snaps.push(structuredClone(s)) });
    expect(result.ok).toBe(true);
    expect(result.text).toBe('Echo: hello');
    expect(snapshot.text).toBe('Echo: hello');
    expect(snapshot.phase).toBe('done');
    expect(new Set(snaps.map(s => (s.text || '').length)).size).toBeGreaterThan(2);   // streamed incrementally
  });

  it('auto-cancels HITL by default (a one-shot turn has no terminal) — does not hang', async () => {
    const { snapshot } = await runTurn(new EchoDriver(), { prompt: 'ASK: color?', workdir: process.cwd() });
    expect(snapshot.text).toBe('You said: (none)');
  });

  it('exposes a mid-turn steer handle', async () => {
    let steer: ((p: string) => Promise<boolean>) | undefined;
    const done = runTurn(new EchoDriver(), { prompt: 'HOLD', workdir: process.cwd() }, { onSteer: fn => { steer = fn; } });
    await new Promise(r => setTimeout(r, 50));
    expect(await steer!('EXTRA')).toBe(true);
    const { snapshot } = await done;
    expect(snapshot.text).toContain('steered: EXTRA');
  });

  it('accumulates subagent events into the snapshot (SessionRunner upsert)', async () => {
    const fake: AgentDriver = {
      id: 'fakesub',
      async run(_i: AgentTurnInput, ctx: DriverContext): Promise<DriverResult> {
        ctx.emit({ type: 'subagent', subagent: { id: 's1', kind: 'researcher', description: 'dig', model: null, tools: [], status: 'running' } });
        ctx.emit({ type: 'subagent', subagent: { id: 's1', kind: 'researcher', description: 'dig', model: 'opus', tools: [{ id: 't', name: 'Grep', summary: 'Grep' }], status: 'done' } });
        ctx.emit({ type: 'text', delta: 'ok' });
        return { ok: true, text: 'ok' };
      },
    };
    const { snapshot } = await runTurn(fake, { prompt: 'go', workdir: process.cwd() });
    expect(snapshot.subAgents?.length).toBe(1);          // upserted by id, not duplicated
    expect(snapshot.subAgents?.[0].status).toBe('done');
    expect(snapshot.subAgents?.[0].model).toBe('opus');
  });
});
