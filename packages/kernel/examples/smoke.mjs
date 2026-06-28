// Smoke test against the COMPILED package (dist), not the TS source — proves the
// published artifact boots: createLoom -> WebSurface -> ws client -> prompt -> done.
// Run: node packages/kernel/examples/smoke.mjs   (after `npm run build` in packages/kernel)
import { createLoom, EchoDriver, WebSurface, applySnapshotPatch } from '../dist/index.js';
import { WebSocket } from 'ws';

const web = new WebSurface({ port: 0 });
const loom = createLoom({ appNamespace: 'loom-smoke', drivers: [new EchoDriver()], defaultAgent: 'echo', surfaces: [web] });
await loom.start();

const ws = new WebSocket(`ws://127.0.0.1:${web.port}`);
await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });

let snap = null;
ws.on('message', (d) => {
  const m = JSON.parse(d.toString());
  if (m.type === 'session') snap = applySnapshotPatch(snap, m.patch);
});
ws.send(JSON.stringify({ type: 'hello', v: 1 }));
ws.send(JSON.stringify({ type: 'subscribe', sessionKey: '*' }));
ws.send(JSON.stringify({ type: 'prompt', prompt: 'compiled package works', agent: 'echo' }));

const t0 = Date.now();
while (!(snap && snap.phase === 'done')) {
  if (Date.now() - t0 > 8000) { console.error('SMOKE FAIL: timeout'); process.exit(1); }
  await new Promise(r => setTimeout(r, 10));
}
ws.close();
await loom.stop();

if (snap.text === 'Echo: compiled package works') {
  console.log('SMOKE OK:', JSON.stringify({ phase: snap.phase, text: snap.text, tool: snap.toolCalls?.[0]?.status }));
  process.exit(0);
}
console.error('SMOKE FAIL: unexpected text', snap.text);
process.exit(1);
