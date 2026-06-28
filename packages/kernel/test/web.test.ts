import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { createLoom, type Loom } from '../src/runtime/loom.js';
import { EchoDriver } from '../src/drivers/echo.js';
import { WebSurface } from '../src/surfaces/web.js';
import { FsSessionStore } from '../src/ports/defaults.js';
import type { Catalog } from '../src/contracts/ports.js';
import { applySnapshotPatch, type UniversalSnapshot } from '../src/protocol/index.js';

async function waitFrame(frames: any[], type: string, ms = 4000): Promise<any> {
  const t0 = Date.now();
  while (true) {
    const f = frames.find(x => x.type === type);
    if (f) return f;
    if (Date.now() - t0 > ms) throw new Error(`no ${type} frame`);
    await new Promise(r => setTimeout(r, 10));
  }
}

describe('WebSurface (UniversalSnapshot wire protocol over ws)', () => {
  let tmp: string;
  let loom: Loom;
  let web: WebSurface;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-web-'));
    web = new WebSurface({ port: 0 });
    loom = createLoom({ drivers: [new EchoDriver()], defaultAgent: 'echo', sessionStore: new FsSessionStore(tmp), surfaces: [web] });
    await loom.start();
  });
  afterEach(async () => { await loom.stop(); fs.rmSync(tmp, { recursive: true, force: true }); });

  it('handshakes, streams snapshot patches, and accumulates the final text', async () => {
    const port = web.port!;
    expect(port).toBeGreaterThan(0);
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });

    let snap: UniversalSnapshot | null = null;
    let welcomed = false;
    let accepted = false;
    const frames: any[] = [];
    ws.on('message', (data) => {
      const m = JSON.parse(data.toString());
      frames.push(m);
      if (m.type === 'welcome') welcomed = true;
      if (m.type === 'accepted') accepted = true;
      if (m.type === 'session') snap = applySnapshotPatch(snap, m.patch);
    });

    ws.send(JSON.stringify({ type: 'hello', v: 1, client: { name: 'test' } }));
    ws.send(JSON.stringify({ type: 'subscribe', sessionKey: '*' }));
    ws.send(JSON.stringify({ type: 'prompt', prompt: 'hello web', agent: 'echo' }));

    const t0 = Date.now();
    while (!(snap && (snap as UniversalSnapshot).phase === 'done')) {
      if (Date.now() - t0 > 8000) throw new Error('timed out waiting for done');
      await new Promise(r => setTimeout(r, 10));
    }
    ws.close();

    expect(welcomed).toBe(true);
    expect(accepted).toBe(true);
    expect(snap!.text).toBe('Echo: hello web');
    expect(snap!.phase).toBe('done');
    // host advertised capabilities in welcome
    const welcome = frames.find(f => f.type === 'welcome');
    expect(welcome.host.capabilities).toContain('prompt');
    expect(welcome.v).toBe(1);
  });

  it('rejects unauthenticated control when a token is required', async () => {
    // separate loom with a token-gated web terminal
    const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-web2-'));
    const web2 = new WebSurface({ port: 0, token: 'secret' });
    const loom2 = createLoom({ drivers: [new EchoDriver()], defaultAgent: 'echo', sessionStore: new FsSessionStore(tmp2), surfaces: [web2] });
    await loom2.start();
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${web2.port}`);
      await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });
      const got: any[] = [];
      ws.on('message', (d) => got.push(JSON.parse(d.toString())));
      ws.send(JSON.stringify({ type: 'listSessions' })); // before hello -> auth error
      await new Promise(r => setTimeout(r, 100));
      expect(got.some(m => m.type === 'error' && m.code === 'auth')).toBe(true);
      ws.close();
    } finally {
      await loom2.stop();
      fs.rmSync(tmp2, { recursive: true, force: true });
    }
  });

  it('serves history + catalog over the wire (remote terminal needs zero driver knowledge)', async () => {
    const tmp3 = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-web3-'));
    const web3 = new WebSurface({ port: 0 });
    const catalog: Catalog = {
      async listModels({ agent }) { return [{ id: `${agent}-m1`, label: 'M1', providerName: 'acme', contextWindow: 1000 }]; },
      async listEffort() { return [{ id: 'high' }]; },
      async listTools() { return []; },
      async listSkills() { return []; },
    };
    const loom3 = createLoom({ drivers: [new EchoDriver()], defaultAgent: 'echo', sessionStore: new FsSessionStore(tmp3), surfaces: [web3], catalog });
    await loom3.start();
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${web3.port}`);
      await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });
      const frames: any[] = [];
      let snap: UniversalSnapshot | null = null;
      ws.on('message', (d) => { const m = JSON.parse(d.toString()); frames.push(m); if (m.type === 'session') snap = applySnapshotPatch(snap, m.patch); });
      ws.send(JSON.stringify({ type: 'hello', v: 1 }));
      ws.send(JSON.stringify({ type: 'subscribe', sessionKey: '*' }));
      ws.send(JSON.stringify({ type: 'prompt', prompt: 'remember me', agent: 'echo', clientRef: 'r1' }));

      const t0 = Date.now();
      while (!(snap && (snap as UniversalSnapshot).phase === 'done')) {
        if (Date.now() - t0 > 8000) throw new Error('timed out waiting for done');
        await new Promise(r => setTimeout(r, 10));
      }
      const sessionKey = frames.find(f => f.type === 'accepted').sessionKey;
      expect(frames.find(f => f.type === 'welcome').host.capabilities).toEqual(expect.arrayContaining(['history', 'catalog']));

      ws.send(JSON.stringify({ type: 'getHistory', sessionKey, ref: 'h1' }));
      const hist = await waitFrame(frames, 'history');
      expect(hist.ref).toBe('h1');
      expect(hist.turns.length).toBe(1);
      expect(hist.turns[0].text).toBe('Echo: remember me');

      ws.send(JSON.stringify({ type: 'getCatalog', agent: 'echo', ref: 'c1' }));
      const cat = await waitFrame(frames, 'catalog');
      expect(cat.ref).toBe('c1');
      expect(cat.agents.map((a: any) => a.id)).toContain('echo');
      expect(cat.agents.find((a: any) => a.id === 'echo').capabilities).toMatchObject({ steer: true, interact: true });
      expect(cat.models[0]).toMatchObject({ id: 'echo-m1', providerName: 'acme' });
      ws.close();
    } finally {
      await loom3.stop();
      fs.rmSync(tmp3, { recursive: true, force: true });
    }
  });
});
