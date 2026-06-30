import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadKernel } from '../agent/kernel-bridge.js';
import { loadUserConfig, applyUserConfig } from '../core/config/user-config.js';
import { resolveAgentInjection } from '../model/injector.js';

// ── The "new version": pikiloom's backend booted ON @pikiloom/kernel ────────────
//
// Gated by LOOM_KERNEL_APP=1 (non-PIKILOOM_ prefix so it survives dev.sh's env scrub).
//   LOOM_KERNEL_APP=1 npm run dev   -> this kernel runtime on the dashboard port
//   npm run dev                      -> the legacy app (old version), untouched
//
// One createLoom() drives every agent through the kernel's Driver registry and exposes it
// over a WebSurface carrying both lanes on one ws host: Lane S (web/structured snapshot) and
// Lane R (raw PTY / terminal). The whole C1-C5 SDK surface (history, catalog, HITL, per-session
// queue, wire) is live here.

const DEMO_MODELS: Record<string, any[]> = {
  claude: [{ id: 'claude-opus-4-8', label: 'Opus 4.8', providerName: 'anthropic', contextWindow: 200000 }],
  codex: [{ id: 'gpt-5.5-codex', label: 'GPT-5.5 Codex', providerName: 'openai', contextWindow: 400000 }],
  gemini: [{ id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', providerName: 'google', contextWindow: 1000000 }],
  opencode: [{ id: 'claude-sonnet-4-6', label: 'OpenCode · Sonnet 4.6 (ACP)', providerName: 'opencode', contextWindow: 200000 }],
  echo: [{ id: 'echo-1', label: 'Echo (hermetic)', providerName: 'local', contextWindow: 8192 }],
};

export async function runKernelApp(argv: string[]): Promise<void> {
  const i = argv.indexOf('--dashboard-port');
  const port = (i >= 0 && parseInt(argv[i + 1], 10)) || 3940;
  const k = await loadKernel();
  const { createLoom, ClaudeDriver, CodexDriver, GeminiDriver, HermesDriver, AcpDriver, EchoDriver, WebSurface } = k;

  // Load providers/profiles so the active BYOK/豆包 bindings are visible to the resolver.
  try { applyUserConfig(loadUserConfig(), undefined, { overwrite: true, clearMissing: true }); }
  catch (e: any) { console.log(`[kernel-app] config load: ${e?.message || e}`); }

  // REAL ModelResolver: delegate to pikiloom's resolveAgentInjection (BYOK / 豆包 / native).
  // null => native CLI login; else map the InjectedSpawnConfig onto the kernel's ModelInjection.
  const modelResolver = {
    async resolve(agent: string, opts: { model?: string | null; profileId?: string | null }) {
      let inj: any = null;
      try { inj = await resolveAgentInjection(agent, opts.profileId ?? undefined); }
      catch (e: any) { console.log(`[kernel-app] inject ${agent} failed: ${e?.message || e}`); return null; }
      if (!inj) return null;                                   // no active profile → native login
      const env = { ...(inj.env || {}) };
      if (inj.homeOverride) env.HOME = inj.homeOverride;
      if (inj.configFiles && Object.keys(inj.configFiles).length) console.log(`[kernel-app] note: ${agent} injection has configFiles (not yet threaded through kernel)`);
      return {
        model: inj.modelOverride ?? opts.model ?? null,
        env,
        extraArgs: inj.argvAppend?.length ? inj.argvAppend : undefined,
        configOverrides: inj.codexConfigOverrides?.length ? inj.codexConfigOverrides : undefined,
        providerName: inj.providerName ?? null,
        contextWindow: inj.contextWindow ?? null,
      };
    },
  };

  // Discovery (C2). A full cutover wires pikiloom's runtime-config / catalog / mcp SSOT
  // through this port; here a representative catalog proves discovery end to end.
  const catalog = {
    async listModels({ agent }: { agent: string }) { return DEMO_MODELS[agent] || []; },
    async listEffort() { return [{ id: 'low' }, { id: 'medium' }, { id: 'high' }]; },
    async listTools() { return []; },
    async listSkills() { return []; },
  };

  const here = path.dirname(fileURLToPath(import.meta.url));
  let html = '<!doctype html><meta charset=utf-8><title>pikiloom · kernel</title>'
    + '<body style="font:14px system-ui;padding:2rem;max-width:42rem">'
    + '<h1>pikiloom — kernel runtime (new version)</h1>'
    + '<p>The WebSurface ws host is live on this port. Connect any pikichannel/ws client and speak the UniversalSnapshot wire protocol (hello → subscribe → prompt; getHistory / getCatalog).</p>';
  for (const c of [
    path.resolve(here, '../../packages/kernel/examples/console.html'),
    path.resolve(process.cwd(), 'packages/kernel/examples/console.html'),
  ]) { try { html = fs.readFileSync(c, 'utf8'); break; } catch { /* fallback inline */ } }

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/' || req.url?.startsWith('/?'))) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
      res.end(html);
      return;
    }
    res.writeHead(404); res.end('not found');
  });

  // WebSurface serves BOTH lanes: Lane S (Web/structured snapshot) and Lane R (Surface/
  // raw PTY, via the TuiHost the kernel hands it at start). One ws host, two lanes.
  const web = new WebSurface({ server, name: 'pikiloom-kernel' });
  const surfaces: any[] = [web];

  const loom = createLoom({
    appNamespace: 'pikiloom-kernel',
    // OpenCode (and any other ACP CLI) plugs in via the generic AcpDriver — same registry as the natives.
    drivers: [new EchoDriver(), new ClaudeDriver(), new CodexDriver(), new GeminiDriver(), new HermesDriver(), new AcpDriver({ id: 'opencode', command: 'opencode', args: ['acp'] })],
    defaultAgent: 'claude',
    surfaces,
    catalog,
    modelResolver,
    log: (m: string) => console.log(`[kernel-app] ${m}`),
  });

  await loom.start();
  await new Promise<void>((resolve) => server.listen(port, () => resolve()));
  const st = loom.status();
  console.log(`[kernel-app] NEW VERSION up — http+ws http://localhost:${port}  agents=${st.agents.join(',')}  surfaces=${st.surfaces.join(',')}`);
  // The http+ws server keeps the process alive.
}
