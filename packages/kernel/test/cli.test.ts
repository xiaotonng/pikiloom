import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLoom, type Loom } from '../src/runtime/loom.js';
import { EchoDriver } from '../src/drivers/echo.js';
import { CliSurface } from '../src/surfaces/cli.js';
import { FsSessionStore } from '../src/ports/defaults.js';
import type { Catalog } from '../src/contracts/ports.js';

const catalog: Catalog = {
  async listModels({ agent }) { return [{ id: `${agent}-m1` }, { id: `${agent}-m2` }]; },
  async listEffort() { return []; },
  async listTools() { return []; },
  async listSkills() { return []; },
};
const waitFor = async (pred: () => boolean, ms = 6000) => {
  const t0 = Date.now();
  while (!pred()) { if (Date.now() - t0 > ms) throw new Error('waitFor timeout'); await new Promise(r => setTimeout(r, 10)); }
};

describe('CliSurface (terminal mode over LoomIO, hermetic)', () => {
  let tmp: string;
  let loom: Loom;
  let input: PassThrough;
  let outBuf = '';

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-cli-'));
    input = new PassThrough();
    const output = new PassThrough();
    outBuf = '';
    output.on('data', d => { outBuf += d.toString(); });
    loom = createLoom({
      drivers: [new EchoDriver()], defaultAgent: 'echo', sessionStore: new FsSessionStore(tmp), catalog,
      surfaces: [new CliSurface({ agent: 'echo', input, output })],
    });
    await loom.start();
  });
  afterEach(async () => { await loom.stop(); fs.rmSync(tmp, { recursive: true, force: true }); });

  it('C1: a typed line runs a turn, prints the response, and keeps one continuous session', async () => {
    input.write('hello cli\n');
    await waitFor(() => outBuf.includes('Echo: hello cli'));
    input.write('again\n');
    await waitFor(() => outBuf.includes('Echo: again'));
    // continuity: both turns landed in the SAME session (one transcript of 2)
    const sessions = loom.io.listSessions().filter(s => s.agent === 'echo');
    expect(sessions).toHaveLength(1);
    const hist = await loom.io.getHistory(sessions[0].sessionKey);
    expect(hist.map(h => h.prompt)).toEqual(['hello cli', 'again']);
  });

  it('C2: /models lists discovery results from the terminal', async () => {
    input.write('/models\n');
    await waitFor(() => outBuf.includes('echo-m1'));
    expect(outBuf).toContain('echo-m1');
    expect(outBuf).toContain('echo-m2');
  });

  it('C3: a HITL question is surfaced and answered from the next line', async () => {
    input.write('ASK: favorite color?\n');
    await waitFor(() => outBuf.includes('[?]') && outBuf.includes('favorite color?'));
    input.write('green\n');
    await waitFor(() => outBuf.includes('You said: green'));
    expect(outBuf).toContain('You said: green');
  });
});
