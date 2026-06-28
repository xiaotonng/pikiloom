import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { StreamOpts, StreamResult, StreamPreviewMeta, StreamToolCall } from './types.js';
import { agentLog, agentWarn } from './utils.js';
import { normalizeClaudeSessionEntrypoint } from './drivers/claude.js';
import { humanizeCodexError } from './drivers/codex.js';

// ── The cutover seam: route an agent turn through @pikiloom/kernel ──────────────
//
// DEFAULT: ON — claude/codex/gemini/hermes turns run on the kernel drivers (via runTurn).
// Escape hatches to the legacy driver path:
//   LOOM_KERNEL_PIPELINE=0             (env; force legacy at startup; survives dev.sh scrub)
//   ~/.pikiloom/dev/kernel-legacy.on   (file; hot-toggle legacy without restart)
//   LOOM_KERNEL_PIPELINE=1             (env; force kernel, overriding the file)
// Tests always run legacy (the unit suite asserts legacy driver behavior). The bridge
// re-applies app-level parity the pure kernel must not own (claude jsonl entrypoint, codex humanize).

const KERNEL_AGENTS = new Set(['claude', 'codex', 'gemini', 'hermes']);

export function shouldUseKernelPipeline(agent: string): boolean {
  if (!KERNEL_AGENTS.has(agent)) return false;
  if (process.env.VITEST || process.env.NODE_ENV === 'test') return false;   // tests assert legacy
  if (process.env.LOOM_KERNEL_PIPELINE === '0') return false;                 // explicit legacy
  if (process.env.LOOM_KERNEL_PIPELINE === '1') return true;                  // explicit kernel
  try { if (fs.existsSync(path.join(os.homedir(), '.pikiloom', 'dev', 'kernel-legacy.on'))) return false; } catch { /* ignore */ }
  return true;                                                                // default: kernel
}

// Build the kernel driver instance + the per-agent AgentTurnInput from pikiloom StreamOpts.
function buildKernelDriver(kernel: any, opts: StreamOpts): { driver: any; input: any } {
  const common = {
    prompt: opts.prompt,
    workdir: opts.workdir,
    sessionId: opts.sessionId ?? null,
    attachments: opts.attachments,
    effort: opts.thinkingEffort,
    env: opts.extraEnv,
    mcpConfigPath: opts.mcpConfigPath ?? null,
  };
  switch (opts.agent) {
    case 'codex': {
      // codexExtraArgs is a flattened ['-c','k=v','-c','k=v',...]; extract the k=v values
      // so the kernel keeps BYOK provider routing.
      const ce = opts.codexExtraArgs || [];
      const configOverrides: string[] = [];
      for (let i = 0; i < ce.length; i++) if (ce[i] === '-c' && ce[i + 1]) configOverrides.push(ce[++i]);
      return { driver: new kernel.CodexDriver(), input: { ...common, model: opts.codexModel ?? opts.model ?? null, systemPrompt: opts.codexDeveloperInstructions, configOverrides, fullAccess: opts.codexFullAccess } };
    }
    case 'gemini':
      return { driver: new kernel.GeminiDriver(), input: { ...common, model: opts.geminiModel ?? opts.model ?? null, systemPrompt: opts.geminiSystemInstruction, extraArgs: opts.geminiExtraArgs } };
    case 'hermes':
      return { driver: new kernel.HermesDriver(), input: { ...common, model: opts.hermesModel ?? opts.model ?? null } };
    case 'claude':
    default:
      return {
        driver: new kernel.ClaudeDriver(),
        input: { ...common, model: opts.claudeModel ?? opts.model ?? null, systemPrompt: opts.claudeAppendSystemPrompt, permissionMode: opts.claudePermissionMode ?? null, extraArgs: opts.claudeExtraArgs, steerable: !!opts.onSteerReady },
      };
  }
}

let _kernel: any = null;
export async function loadKernel(): Promise<any> {
  if (_kernel) return _kernel;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, '../../packages/kernel/dist/index.js'),      // src/agent (dev) & dist/agent (prod) -> <repo>/packages/kernel
    path.resolve(process.cwd(), 'packages/kernel/dist/index.js'),
  ];
  // Prefer an installed package if present, else the in-repo built dist.
  // (specifier kept in a variable so tsc treats it as a dynamic any, not a static resolve)
  const pkgName = '@pikiloom/kernel';
  try { _kernel = await import(pkgName); return _kernel; } catch { /* not installed */ }
  for (const c of candidates) {
    if (fs.existsSync(c)) { _kernel = await import(pathToFileURL(c).href); return _kernel; }
  }
  throw new Error(`@pikiloom/kernel not found (build it: npm run build in packages/kernel). Looked in: ${candidates.join(', ')}`);
}

// A kernel 'artifact' (e.g. a generated image as a data URL) -> write to a temp file and
// deliver through pikiloom's normal file-delivery seam (same path as im_send_file).
async function deliverKernelArtifact(artifact: any, opts: StreamOpts): Promise<void> {
  try {
    const send = (opts as any).mcpSendFile;
    if (typeof send !== 'function' || !artifact?.url) return;
    const m = String(artifact.url).match(/^data:([^;]+);base64,(.*)$/s);
    if (!m) return;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-art-'));
    const file = path.join(dir, artifact.fileName || 'artifact.bin');
    fs.writeFileSync(file, Buffer.from(m[2], 'base64'));
    await send(file, { kind: artifact.kind || 'document', caption: artifact.caption });
  } catch { /* best-effort delivery */ }
}

export async function kernelStream(opts: StreamOpts): Promise<StreamResult> {
  const start = Date.now();
  const kernel = await loadKernel();
  const { driver, input } = buildKernelDriver(kernel, opts);
  agentLog(`[kernel-bridge] routing ${opts.agent} turn via @pikiloom/kernel ${driver?.constructor?.name || 'Driver'}`);

  let delivered = 0;                 // artifacts already sent out-of-band
  let seenSid: string | null = null;

  // SessionRunner (via runTurn) owns the event accumulation; the bridge only translates
  // the kernel's UniversalSnapshot onto pikiloom's preview (onText) and delivers any new
  // artifacts through the normal file seam. This is the "product bridge" pattern: map your
  // request -> AgentTurnInput, map snapshot -> your UI, map result -> your result shape.
  const onSnapshot = (s: any) => {
    const arts = s.artifacts || [];
    for (; delivered < arts.length; delivered++) void deliverKernelArtifact(arts[delivered], opts);
    if (s.sessionId && s.sessionId !== seenSid) { seenSid = s.sessionId; try { opts.onSessionId?.(s.sessionId); } catch { /* ignore */ } }
    const m: StreamPreviewMeta = {
      inputTokens: s.usage?.inputTokens ?? null,
      outputTokens: s.usage?.outputTokens ?? null,
      cachedInputTokens: s.usage?.cachedInputTokens ?? null,
      contextUsedTokens: s.usage?.contextUsedTokens ?? null,
      contextPercent: s.usage?.contextPercent ?? null,
      toolCalls: s.toolCalls?.length ? (s.toolCalls as StreamToolCall[]) : undefined,
      subAgents: s.subAgents?.length ? s.subAgents : undefined,
      providerName: opts.byokProviderName ?? null,
    };
    try { opts.onText(s.text || '', s.reasoning || '', s.activity || '', m, s.plan ?? null); } catch { /* isolate */ }
  };

  let result: any; let snapshot: any = {};
  try {
    ({ result, snapshot } = await kernel.runTurn(driver, input, {
      onSnapshot,
      onSteer: (fn: any) => { try { opts.onSteerReady?.(fn); } catch { /* ignore */ } },
      signal: opts.abortSignal,
    }));
  } catch (err: any) {
    agentWarn(`[kernel-bridge] kernel run failed: ${err?.message || err}`);
    result = { ok: false, text: '', error: err?.message || String(err), stopReason: 'error', sessionId: opts.sessionId ?? null };
  }

  const finalSessionId = result.sessionId || snapshot.sessionId || opts.sessionId || null;
  if (finalSessionId && finalSessionId !== seenSid) { try { opts.onSessionId?.(finalSessionId); } catch { /* ignore */ } }

  // App-level parity the pure kernel must not own (mirrors legacy *.doStream):
  //  - claude: rewrite the native jsonl entrypoint sdk-cli->cli (VSCode session visibility).
  //  - codex: translate raw provider error JSON (ChatGPT-account / third-party) to prose.
  if (opts.agent === 'claude') { try { normalizeClaudeSessionEntrypoint(opts.workdir, finalSessionId); } catch { /* best-effort */ } }
  const finalError = (opts.agent === 'codex' && result.error)
    ? (humanizeCodexError(result.error) ?? result.error)
    : (result.error ?? null);

  const u = result.usage || snapshot.usage || {};
  return {
    ok: !!result.ok,
    message: (result.text || snapshot.text || '').trim() || (finalError ?? '(no output)'),
    thinking: (result.reasoning || snapshot.reasoning || '').trim() || null,
    plan: snapshot.plan ?? null,
    sessionId: finalSessionId,
    workspacePath: null,
    model: input.model ?? null,
    thinkingEffort: opts.thinkingEffort,
    elapsedS: (Date.now() - start) / 1000,
    inputTokens: u.inputTokens ?? null,
    outputTokens: u.outputTokens ?? null,
    cachedInputTokens: u.cachedInputTokens ?? null,
    cacheCreationInputTokens: null,
    contextWindow: null,
    contextUsedTokens: u.contextUsedTokens ?? null,
    contextPercent: null,
    codexCumulative: null,
    error: finalError,
    stopReason: result.stopReason ?? null,
    incomplete: !result.ok,
    activity: snapshot.activity || null,
  };
}
