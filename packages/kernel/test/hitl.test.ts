import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLoom, type Loom } from '../src/runtime/loom.js';
import { EchoDriver } from '../src/drivers/echo.js';
import { FsSessionStore, AutoCancelInteractionHandler } from '../src/ports/defaults.js';
import type { InteractionHandler } from '../src/contracts/ports.js';
import type { UniversalSnapshot } from '../src/protocol/index.js';
import type { LoomIO } from '../src/contracts/surface.js';

function watch(io: LoomIO) {
  const updates: UniversalSnapshot[] = [];
  let resolveDone: (s: UniversalSnapshot) => void;
  const done = new Promise<UniversalSnapshot>((r) => { resolveDone = r; });
  const unsub = io.subscribe((_k, s) => { updates.push(structuredClone(s)); if (s.phase === 'done') resolveDone(structuredClone(s)); });
  return { updates, done, unsub };
}
const waitFor = async (pred: () => boolean, ms = 5000) => {
  const t0 = Date.now();
  while (!pred()) { if (Date.now() - t0 > ms) throw new Error('waitFor timeout'); await new Promise(r => setTimeout(r, 5)); }
};
function loomWith(tmp: string, handler?: InteractionHandler): Loom {
  return createLoom({ drivers: [new EchoDriver()], defaultAgent: 'echo', sessionStore: new FsSessionStore(tmp), ...(handler ? { interactionHandler: handler } : {}) });
}

describe('HITL interaction handler (hermetic)', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-hitl-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('default defers to the terminal: interaction stays pending until interact()', async () => {
    const loom = loomWith(tmp); await loom.start();
    const w = watch(loom.io);
    await loom.io.prompt({ prompt: 'ASK: favorite color?' });
    await waitFor(() => w.updates.some(u => (u.interactions?.length || 0) > 0));
    const pid = w.updates.flatMap(u => u.interactions || []).find(Boolean)!.promptId;
    expect(loom.io.interact(pid, 'text', 'blue')).toBe(true);
    const final = await w.done;
    expect(final.text).toBe('You said: blue');
    expect(final.interactions).toEqual([]);
    w.unsub(); await loom.stop();
  });

  it('AutoCancelInteractionHandler resolves interactions immediately (headless, no interact())', async () => {
    const loom = loomWith(tmp, new AutoCancelInteractionHandler()); await loom.start();
    const w = watch(loom.io);
    await loom.io.prompt({ prompt: 'ASK: favorite color?' });
    const final = await w.done;
    expect(final.text).toBe('You said: (none)');
    expect(final.interactions).toEqual([]);
    w.unsub(); await loom.stop();
  });

  it('a programmatic handler answers based on the interaction (no interact())', async () => {
    const handler: InteractionHandler = { async askUser(i) { return { [i.questions[0].id]: ['green'] }; } };
    const loom = loomWith(tmp, handler); await loom.start();
    const w = watch(loom.io);
    await loom.io.prompt({ prompt: 'ASK: favorite color?' });
    const final = await w.done;
    expect(final.text).toBe('You said: green');
    w.unsub(); await loom.stop();
  });
});
