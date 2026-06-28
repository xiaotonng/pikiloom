// The "5-line pikiloom": stand up a multi-agent backend reachable over CLI + Web.
// Run: npx tsx packages/kernel/examples/demo.ts   (type a line; or connect a ws client to the printed port)
import { createLoom, ClaudeDriver, EchoDriver, WebSurface, CliSurface } from '../src/index.js';

const useReal = process.env.DEMO_REAL === '1';

const web = new WebSurface({ port: Number(process.env.PORT) || 0 });
const loom = createLoom({
  appNamespace: 'loom-demo',
  drivers: [useReal ? new ClaudeDriver() : new EchoDriver()],
  defaultAgent: useReal ? 'claude' : 'echo',
  surfaces: [web, new CliSurface({ agent: useReal ? 'claude' : 'echo' })],
});

await loom.start();
console.log(`\n[demo] web terminal listening on ws://127.0.0.1:${web.port}`);
console.log(`[demo] agents: ${loom.status().agents.join(', ')} — type a prompt and press enter:\n`);
