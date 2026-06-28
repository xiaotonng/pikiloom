// A complete kernel-backed web app on ONE port: http serves the console UI, and the
// SAME server is the WebSurface ws host. Drives a real `claude` turn by default.
// This is "a pikiloom-like project, built on @pikiloom/kernel" — proving the kernel
// is a usable core, not just a library.
//
//   node packages/kernel/examples/server.mjs            # real claude on :3941
//   CONSOLE_REAL=0 PORT=3942 node .../server.mjs         # hermetic echo driver
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLoom, ClaudeDriver, EchoDriver, WebSurface } from '../dist/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(__dirname, 'console.html'), 'utf8');
const port = Number(process.env.PORT) || 3941;
const useReal = process.env.CONSOLE_REAL !== '0';

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url?.startsWith('/?'))) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
    res.end(html);
    return;
  }
  res.writeHead(404); res.end('not found');
});

const web = new WebSurface({ server, name: 'pikiloom-kernel' });
const loom = createLoom({
  appNamespace: 'loom-console',
  drivers: [useReal ? new ClaudeDriver() : new EchoDriver()],
  defaultAgent: useReal ? 'claude' : 'echo',
  surfaces: [web],
  log: (m) => console.log(m),
});

await loom.start();
server.listen(port, () => {
  console.log(`[kernel-console] http + ws on http://localhost:${port}  (agent=${loom.status().agents.join(',')}, real=${useReal})`);
});
