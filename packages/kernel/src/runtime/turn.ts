import type { UniversalSnapshot } from '../protocol/index.js';
import type { AgentDriver, AgentTurnInput, DriverResult } from '../contracts/driver.js';
import type { InteractionHandler } from '../contracts/ports.js';
import { SessionRunner } from './session-runner.js';
import { AutoCancelInteractionHandler } from '../ports/defaults.js';

// The "bridge primitive": run ONE turn through ONE driver, reusing SessionRunner's event
// accumulation, and get back streamed UniversalSnapshots + the final result — WITHOUT
// adopting the full Hub/multi-session/transport. This is what a product's own bridge maps
// onto: request -> AgentTurnInput -> runTurn -> map snapshot to its UI + result to its shape.

export interface RunTurnOptions {
  prompt?: string;                 // snapshot.prompt label (defaults to input.prompt)
  model?: string | null;
  effort?: string | null;
  onSnapshot?: (snapshot: UniversalSnapshot) => void;                          // streamed accumulating snapshot
  onSteer?: (steer: (prompt: string, attachments?: string[]) => Promise<boolean>) => void; // mid-turn steer handle
  signal?: AbortSignal;            // abort => stop the turn
  interactionHandler?: InteractionHandler; // default: auto-cancel (a one-shot turn has no terminal to answer HITL)
}

export interface TurnOutcome {
  result: DriverResult;
  snapshot: UniversalSnapshot;     // final accumulated snapshot (stable once resolved)
}

export async function runTurn(driver: AgentDriver, input: AgentTurnInput, opts: RunTurnOptions = {}): Promise<TurnOutcome> {
  const handler = opts.interactionHandler ?? new AutoCancelInteractionHandler();
  const runner = new SessionRunner('turn', driver.id, 'turn', (snap) => { opts.onSnapshot?.(snap); }, handler);
  if (opts.onSteer) opts.onSteer((p, a) => runner.steer(p, a));
  if (opts.signal) {
    if (opts.signal.aborted) runner.stop();
    else opts.signal.addEventListener('abort', () => runner.stop(), { once: true });
  }
  const result = await runner.run(
    driver, input,
    opts.prompt ?? input.prompt,
    opts.model ?? input.model ?? null,
    opts.effort ?? input.effort ?? null,
  );
  return { result, snapshot: runner.snapshot };
}
