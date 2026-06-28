import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { createLoom, type Loom } from '../src/runtime/loom.js';
import { EchoDriver } from '../src/drivers/echo.js';
import { WebSurface } from '../src/surfaces/web.js';
import { FsSessionStore } from '../src/ports/defaults.js';
import { ptyAvailable } from '../src/runtime/pty.js';

const waitFor = async (pred: () => boolean, ms = 6000) => {
  const t0 = Date.now();
  while (!pred()) { if (Date.now() - t0 > ms) throw new Error('waitFor timeout'); await new Promise(r => setTimeout(r, 10)); }
};

describe.skipIf(!ptyAvailable())('WebSurface Lane R — raw PTY / TUI over ws (hermetic)', () => {
  let tmp: string; let loom: Loom; let web: WebSurface;
  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-webtui-'));
    web = new WebSurface({ port: 0 });
    loom = createLoom({ drivers: [new EchoDriver()], defaultAgent: 'echo', sessionStore: new FsSessionStore(tmp), surfaces: [web] });
    await loom.start();
  });
  afterEach(async () => { await loom.stop(); fs.rmSync(tmp, { recursive: true, force: true }); });

  it('opens a TUI, streams raw bytes both ways, resizes, and reports exit', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${web.port}`);
    await new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej); });
    const frames: any[] = []; let tuiData = '';
    ws.on('message', d => { const m = JSON.parse(d.toString()); frames.push(m); if (m.type === 'tuiData') tuiData += m.data; });
    const send = (o: any) => ws.send(JSON.stringify(o));

    send({ type: 'hello', v: 1 });
    await waitFor(() => frames.some(f => f.type === 'welcome'));
    expect(frames.find(f => f.type === 'welcome').host.capabilities).toContain('tui');   // Lane R advertised

    send({ type: 'openTui', agent: 'echo', workdir: tmp, cols: 80, rows: 24, ref: 't1' });
    await waitFor(() => frames.some(f => f.type === 'tuiOpened'));
    const opened = frames.find(f => f.type === 'tuiOpened');
    expect(opened.ref).toBe('t1');
    const tuiId = opened.tuiId;

    await waitFor(() => tuiData.includes('ECHO-TUI-READY'));        // PTY -> client raw bytes
    send({ type: 'tuiInput', tuiId, data: 'hi\r' });
    await waitFor(() => tuiData.includes('GOT:'));                  // client -> PTY raw bytes reached child
    send({ type: 'tuiResize', tuiId, cols: 120, rows: 40 });        // must not throw

    const exit = await new Promise<any>((resolve) => {
      const h = (d: any) => { const m = JSON.parse(d.toString()); if (m.type === 'tuiExit') { ws.off('message', h); resolve(m); } };
      ws.on('message', h);
      send({ type: 'tuiInput', tuiId, data: 'Q\r' });
    });
    expect(exit.tuiId).toBe(tuiId);
    expect(exit.exitCode).toBe(0);
    ws.close();
  });

  it('rejects openTui when TUI is gated off (allowTui:false)', async () => {
    const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-webtui2-'));
    const web2 = new WebSurface({ port: 0, allowTui: false });
    const loom2 = createLoom({ drivers: [new EchoDriver()], defaultAgent: 'echo', sessionStore: new FsSessionStore(tmp2), surfaces: [web2] });
    await loom2.start();
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${web2.port}`);
      await new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej); });
      const frames: any[] = [];
      ws.on('message', d => frames.push(JSON.parse(d.toString())));
      ws.send(JSON.stringify({ type: 'hello', v: 1 }));
      await waitFor(() => frames.some(f => f.type === 'welcome'));
      expect(frames.find(f => f.type === 'welcome').host.capabilities).not.toContain('tui');
      ws.send(JSON.stringify({ type: 'openTui', agent: 'echo', workdir: tmp2, ref: 'x' }));
      await waitFor(() => frames.some(f => f.type === 'error' && f.code === 'tui'));
      ws.close();
    } finally { await loom2.stop(); fs.rmSync(tmp2, { recursive: true, force: true }); }
  });

  it('AccessPolicy: readonly drops keystrokes (spectator); prompt:false denies turns', async () => {
    const tmp3 = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-acc-'));
    const web3 = new WebSurface({ port: 0, access: { tuiReadonly: true, prompt: false } });
    const loom3 = createLoom({ drivers: [new EchoDriver()], defaultAgent: 'echo', sessionStore: new FsSessionStore(tmp3), surfaces: [web3] });
    await loom3.start();
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${web3.port}`);
      await new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej); });
      const frames: any[] = []; let tuiData = '';
      ws.on('message', d => { const m = JSON.parse(d.toString()); frames.push(m); if (m.type === 'tuiData') tuiData += m.data; });
      const send = (o: any) => ws.send(JSON.stringify(o));
      send({ type: 'hello', v: 1 });
      await waitFor(() => frames.some(f => f.type === 'welcome'));
      const caps = frames.find(f => f.type === 'welcome').host.capabilities;
      expect(caps).not.toContain('prompt');                        // prompt:false → not advertised
      expect(caps).toContain('tui');                               // tui still allowed (read-only)
      send({ type: 'prompt', prompt: 'hi', agent: 'echo', clientRef: 'p' });
      await waitFor(() => frames.some(f => f.type === 'error' && f.code === 'access'));
      send({ type: 'openTui', agent: 'echo', workdir: tmp3, ref: 'r' });
      await waitFor(() => frames.some(f => f.type === 'tuiOpened'));
      const tuiId = frames.find(f => f.type === 'tuiOpened').tuiId;
      await waitFor(() => tuiData.includes('ECHO-TUI-READY'));      // output streams (spectator sees it)
      send({ type: 'tuiInput', tuiId, data: 'hi\r' });
      await new Promise(r => setTimeout(r, 400));
      expect(tuiData.includes('GOT:')).toBe(false);                // keystrokes dropped (read-only)
      ws.close();
    } finally { await loom3.stop(); fs.rmSync(tmp3, { recursive: true, force: true }); }
  });
});
