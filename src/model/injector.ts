/**
 * Credential injector — turn an active Profile into the env vars and
 * additional argv that should be applied when spawning a specific agent.
 *
 * This is the single point where pikiloom's Profile abstraction is
 * translated into per-agent quirks. Adding a new agent (e.g. OpenCode)
 * = adding one entry to AGENT_INJECT_TABLE.
 */

import { resolveCredential } from '../core/secrets/index.js';
import { writeScopedLog } from '../core/logging.js';
import { getActiveProfile, getProvider } from './store.js';
import { peekProviderModelInfo, prefetchProviderModels } from './provider-models.js';
import { ensureResponsesBridge, upstreamToken } from './responses-bridge.js';
import type { ProviderConfig, ModelProfileConfig, ProviderKind } from './types.js';

export interface InjectedSpawnConfig {
  /** Env vars to merge into the child process environment. */
  env: Record<string, string>;
  /** Extra argv tokens to append to the agent CLI invocation (Hermes only). */
  argvAppend: string[];
  /**
   * Codex-only: TOML key=value pairs the driver should pass as `-c` overrides
   * to `codex app-server`. Used to configure `model_providers.<slug>.*` and
   * `model_provider` without touching the user's `~/.codex/config.toml`.
   */
  codexConfigOverrides?: string[];
  /** When set, override the agent's `model` opt (Claude/Codex/Gemini). */
  modelOverride?: string;
  /**
   * Real context window for the bound model — sourced from the provider's
   * cached `/models` listing (e.g. OpenRouter publishes `context_length`).
   * Drivers use this instead of the value the agent CLI reports for unknown
   * models (cc falls back to its Claude defaults; codex similar). `undefined`
   * means we don't know yet — fall back to whatever the CLI advertises.
   */
  contextWindow?: number;
  /**
   * Provider display name (e.g. "OpenRouter") — surfaced in IM footers and
   * the dashboard turn header so the user can tell at a glance that the turn
   * is being served by a BYOK provider rather than the agent CLI's native
   * auth path. Always set when an active Profile is bound.
   */
  providerName?: string;
  /** When set, files to write before spawn (path → content). */
  configFiles?: Record<string, string>;
  /** When set, override HOME / similar to redirect agent's data dir. */
  homeOverride?: string;
  /** Diagnostic message returned for logging / UI. */
  detail: string;
}

const EMPTY: InjectedSpawnConfig = { env: {}, argvAppend: [], detail: '' };

// ---------------------------------------------------------------------------
// Shared host-based provider identification
// ---------------------------------------------------------------------------

function providerHost(provider: ProviderConfig): string {
  try { return new URL(provider.baseURL).host.toLowerCase(); } catch { return ''; }
}

/**
 * Stable slug used to identify the provider in TOML-style configs (Codex
 * `model_providers.<slug>`, Hermes ACP `<slug>:<model>`). Host-aware so a
 * "DeepSeek personal" provider always resolves to `deepseek`, regardless of
 * its display name.
 */
function providerSlug(provider: ProviderConfig): string {
  if (provider.kind === 'anthropic') return 'anthropic';
  if (provider.kind === 'openai') return 'openai';
  if (provider.kind === 'google') return 'google';
  const host = providerHost(provider);
  if (host.includes('deepseek')) return 'deepseek';
  if (host.includes('moonshot') || host.includes('kimi')) return 'kimi';
  if (host.includes('minimax')) return 'minimax';
  if (host.includes('zhipuai') || host.includes('z.ai') || host.includes('bigmodel')) return 'zai';
  if (host.includes('x.ai')) return 'xai';
  if (host.includes('stepfun')) return 'stepfun';
  if (host.includes('dashscope') || host.includes('qwen')) return 'qwen';
  if (host.includes('volces') || host.includes('volcengine') || host.includes('doubao')) return 'doubao';
  if (host.includes('openrouter')) return 'openrouter';
  // Unknown host: derive a stable slug from the hostname's leading label. (The
  // old `return 'openrouter'` fallback mis-slugged every unrecognised provider —
  // including localhost Ollama — as openrouter.) This never collides with
  // codex's reserved built-in `openai`/`oss`/`ollama` ids, which are routed
  // before we ever reach providerSlug.
  const label = host.replace(/:\d+$/, '').replace(/^(www|api)\./, '').split('.')[0].replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return label || 'byok';
}

/**
 * Canonical env-var name(s) carrying the credential for a provider. Returned
 * as a map so e.g. Google fans out to both `GOOGLE_API_KEY` and
 * `GEMINI_API_KEY` for SDKs that expect either.
 */
function providerCredentialEnv(provider: ProviderConfig, apiKey: string): Record<string, string> {
  if (provider.kind === 'anthropic') return { ANTHROPIC_API_KEY: apiKey };
  if (provider.kind === 'openai') return { OPENAI_API_KEY: apiKey };
  if (provider.kind === 'google') return { GOOGLE_API_KEY: apiKey, GEMINI_API_KEY: apiKey };
  const host = providerHost(provider);
  if (host.includes('openrouter')) return { OPENROUTER_API_KEY: apiKey };
  if (host.includes('deepseek')) return { DEEPSEEK_API_KEY: apiKey };
  if (host.includes('moonshot') || host.includes('kimi')) return { KIMI_API_KEY: apiKey, MOONSHOT_API_KEY: apiKey };
  if (host.includes('minimax')) return { MINIMAX_API_KEY: apiKey };
  if (host.includes('zhipuai') || host.includes('z.ai') || host.includes('bigmodel')) return { ZAI_API_KEY: apiKey, ZHIPU_API_KEY: apiKey };
  if (host.includes('x.ai')) return { XAI_API_KEY: apiKey };
  if (host.includes('stepfun')) return { STEPFUN_API_KEY: apiKey };
  if (host.includes('dashscope') || host.includes('qwen')) return { DASHSCOPE_API_KEY: apiKey, QWEN_API_KEY: apiKey };
  if (host.includes('volces') || host.includes('volcengine') || host.includes('doubao')) return { ARK_API_KEY: apiKey, DOUBAO_API_KEY: apiKey };
  return { OPENROUTER_API_KEY: apiKey };
}

/** Pick the single env var Codex's `model_providers.<slug>.env_key` should reference. */
function codexEnvKey(provider: ProviderConfig): string {
  const keys = Object.keys(providerCredentialEnv(provider, ''));
  return keys[0] || 'OPENROUTER_API_KEY';
}

/** Escape a string for embedding inside a TOML double-quoted string literal. */
function tomlEscape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * OpenAI-compatible providers that expose their Anthropic-protocol API under a
 * dedicated namespace on the SAME origin (not the OpenAI base we store). Keyed
 * by `providerSlug`; the value maps the origin → the Anthropic base URL.
 *
 *   slug       stored OpenAI baseURL                    Anthropic base
 *   ─────────  ───────────────────────────────────      ───────────────────────────────
 *   deepseek   https://api.deepseek.com                 https://api.deepseek.com/anthropic
 *   kimi       https://api.moonshot.cn/v1               https://api.moonshot.cn/anthropic
 *   zai        https://open.bigmodel.cn/api/paas/v4     https://open.bigmodel.cn/api/anthropic
 *
 * The SDK appends `/v1/messages`, so e.g. DeepSeek lands on
 * `…/anthropic/v1/messages` — the endpoint DeepSeek actually serves the
 * Anthropic protocol on (cf. src/agent/drivers/claude.ts).
 */
const ANTHROPIC_ENDPOINT_BY_SLUG: Record<string, (origin: string) => string> = {
  deepseek: origin => `${origin}/anthropic`,
  kimi: origin => `${origin}/anthropic`,
  zai: origin => `${origin}/api/anthropic`,
};

/**
 * Anthropic-protocol baseURL for Claude BYOK. Claude Code speaks the Anthropic
 * Messages API and appends `/v1/messages` to `ANTHROPIC_BASE_URL` itself, so
 * the base must point at the provider's *Anthropic-compatible* root.
 *
 * The base must NOT carry a trailing `/v1` (otherwise requests land on
 * `/v1/v1/messages` and 404). The canonical stored form is the OpenAI base
 * (so `validateProvider`'s GET /models and the Codex/Hermes injectors keep
 * working); we translate it here:
 *   - Anthropic-native (and Anthropic-shaped third parties): strip a trailing
 *     `/v1` and pass through verbatim.
 *   - Known OpenAI-compatible providers whose Anthropic API lives under a
 *     separate path (DeepSeek `/anthropic`, Kimi `/anthropic`, Zhipu
 *     `/api/anthropic`): rebuild from the origin via `ANTHROPIC_ENDPOINT_BY_SLUG`.
 *     Rebuilding from the origin (not the stored path) is idempotent — a user
 *     who already pasted the `/anthropic` URL doesn't get `/anthropic/anthropic`.
 *   - Anything else: best-effort, strip a trailing `/v1` (historical default).
 */
function claudeAnthropicBaseURL(provider: ProviderConfig): string {
  const raw = provider.baseURL.replace(/\/+$/, '');
  if (provider.kind === 'anthropic') return raw.replace(/\/v1$/, '');
  const mapper = ANTHROPIC_ENDPOINT_BY_SLUG[providerSlug(provider)];
  if (mapper) {
    let origin: string;
    try { origin = new URL(raw).origin; } catch { return raw.replace(/\/v1$/, ''); }
    return mapper(origin);
  }
  return raw.replace(/\/v1$/, '');
}

/**
 * First-party Anthropic = the official API host (`api.anthropic.com` / any
 * `*.anthropic.com`). A Claude route counts as "direct" when it lands here —
 * both the subscription path and an own-key BYOK profile pointed at
 * api.anthropic.com. Everything else (OpenRouter, DeepSeek, domestic series, a
 * self-hosted relay, localhost) is a third-party proxy. Unparseable → treat as
 * proxy (safe default: suppressing attribution is harmless, churning isn't).
 */
function isFirstPartyAnthropic(baseURL: string): boolean {
  let host: string;
  try { host = new URL(baseURL).hostname.toLowerCase(); } catch { return false; }
  return host === 'anthropic.com' || host.endsWith('.anthropic.com');
}

// ---------------------------------------------------------------------------
// Per-agent translation rules
// ---------------------------------------------------------------------------

type AgentInjector = (
  provider: ProviderConfig,
  profile: ModelProfileConfig,
  apiKey: string,
) => InjectedSpawnConfig | Promise<InjectedSpawnConfig>;

/**
 * Claude Code respects `ANTHROPIC_BASE_URL` + `ANTHROPIC_API_KEY` (or
 * `ANTHROPIC_AUTH_TOKEN`) as a BYOK route. The CLI itself is unchanged.
 * The model is overridden via opts.claudeModel (handled in stream.ts).
 *
 * For OpenAI-compatible providers (OpenRouter, DeepSeek native, …), the
 * baseURL must point to an Anthropic-protocol-compatible endpoint
 * (`/v1/messages`-shaped). `claudeAnthropicBaseURL` translates the stored
 * OpenAI base into the right Anthropic root per provider (e.g. DeepSeek's
 * `https://api.deepseek.com` → `https://api.deepseek.com/anthropic`).
 */
const claudeInjector: AgentInjector = (provider, profile, apiKey) => {
  if (provider.kind !== 'anthropic' && provider.kind !== 'openai-compatible') {
    return {
      ...EMPTY,
      detail: `Claude BYOK requires Anthropic or OpenAI-compatible (Anthropic-API-shaped) provider; got ${provider.kind}.`,
    };
  }
  const baseURL = claudeAnthropicBaseURL(provider);
  const env: Record<string, string> = {
    ANTHROPIC_BASE_URL: baseURL,
    ANTHROPIC_API_KEY: apiKey,
    ANTHROPIC_AUTH_TOKEN: apiKey,
  };
  // Claude Code >= 2.1.36 stamps a per-request `x-anthropic-billing-header`
  // (cc_version / cc_entrypoint / cch=… — the cch token churns every turn).
  // Third-party proxies (OpenRouter, DeepSeek /anthropic, domestic series, any
  // OpenAI-compat or self-hosted Anthropic-shaped front) often key their
  // prefix/KV cache on request headers, so the churn forces a full prompt
  // reprocess every turn — slow and expensive. `0` makes claude omit the header
  // (env-bool: 0/false/no/off). Only on proxy routes: first-party Anthropic
  // (api.anthropic.com — subscription OR own-key direct) is left exactly as
  // shipped; its cache is content/breakpoint based, so attribution is irrelevant
  // there and we don't touch it.
  if (!isFirstPartyAnthropic(baseURL)) {
    env.CLAUDE_CODE_ATTRIBUTION_HEADER = '0';
  }
  return {
    env,
    argvAppend: [],
    modelOverride: profile.modelId,
    detail: `Claude BYOK → ${provider.name} / ${profile.modelId}`,
  };
};

function providerHostname(provider: ProviderConfig): string {
  try { return new URL(provider.baseURL).hostname.toLowerCase(); } catch { return ''; }
}

/** True for localhost endpoints (Ollama / LM Studio / llama.cpp). */
function isLocalProvider(provider: ProviderConfig): boolean {
  const h = providerHostname(provider);
  return h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0' || h === '::1';
}

/** Providers that natively implement the OpenAI Responses API (codex talks to them directly). */
function isResponsesNativeProvider(provider: ProviderConfig): boolean {
  return providerHost(provider).includes('openrouter');
}

/** codex's built-in local provider id for a localhost endpoint. */
function codexLocalProvider(provider: ProviderConfig): 'ollama' | 'lmstudio' {
  let port = '';
  try { port = new URL(provider.baseURL).port; } catch { /* ignore */ }
  if (port === '1234' || /lm\s*studio/i.test(provider.name)) return 'lmstudio';
  return 'ollama';
}

/** Ollama keeps a prewarmed model resident for this long (its `keep_alive`). */
const PREWARM_KEEP_ALIVE = '30m';

/**
 * Warm a localhost model backend so the user's first real turn doesn't pay the
 * model cold-load (weights → memory). Fire-and-forget: never blocks the caller,
 * never throws.
 *
 *  - Ollama has a native load endpoint — `POST /api/generate {model, keep_alive}`
 *    with no prompt loads the weights and returns immediately; `keep_alive`
 *    keeps them resident across the seed + real turns of a session.
 *  - LM Studio JIT-loads on first request, so we nudge it with a 1-token
 *    completion against its OpenAI-compatible endpoint.
 *
 * Called when a local Profile is bound (warm while the user reads / types) and
 * again at spawn (re-assert keep_alive). Measured: a cold gemma3:4b spent ~12s
 * before its first token; prewarmed, generation starts in ~2s.
 */
export function prewarmLocalModel(provider: ProviderConfig, modelId: string): void {
  if (!modelId || !isLocalProvider(provider)) return;
  let origin: string;
  try { origin = new URL(provider.baseURL).origin; } catch { return; }
  const swallow = () => {};
  if (codexLocalProvider(provider) === 'lmstudio') {
    void fetch(`${origin}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: modelId, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
    }).then(swallow, swallow);
    return;
  }
  void fetch(`${origin}/api/generate`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: modelId, keep_alive: PREWARM_KEEP_ALIVE }),
  }).then(
    r => { writeScopedLog('model-prewarm', `ollama load ${modelId} → ${r.status}`); },
    e => { writeScopedLog('model-prewarm', `ollama load ${modelId} failed: ${e?.message || e}`, { level: 'warn', stream: 'stderr' }); },
  );
}

type CodexRoute = 'openai-native' | 'responses-native' | 'local-oss' | 'bridge';

/**
 * Decide how codex should reach a provider. Codex 0.140+ speaks ONLY the
 * Responses API, so the route depends on what the provider implements:
 *   openai-native   genuine OpenAI            → built-in `openai` provider
 *   local-oss       localhost Ollama/LMStudio → built-in `ollama`/`lmstudio` (responses)
 *   responses-native OpenRouter, …            → custom provider, responses direct
 *   bridge          chat-only (DeepSeek, Kimi, MiniMax, 豆包, Qwen, Zhipu, …)
 *                                             → local Responses↔Chat bridge
 */
function codexRoute(provider: ProviderConfig): CodexRoute {
  if (provider.kind === 'openai') return 'openai-native';
  if (isLocalProvider(provider)) return 'local-oss';
  if (isResponsesNativeProvider(provider)) return 'responses-native';
  return 'bridge';
}

/**
 * Codex CLI honours `model_providers.<slug>` definitions in `config.toml` and
 * binds the active one via `model_provider="<slug>"`. The credential lives in
 * the env var named by `env_key`, picked host-aware (e.g. `DEEPSEEK_API_KEY`).
 *
 * Codex 0.140+ dropped Chat Completions (`wire_api = "chat"` is rejected at
 * config load) — it speaks ONLY the Responses API. So this injector routes per
 * `codexRoute()`: responses-capable providers (OpenAI, OpenRouter, local
 * Ollama/LM Studio) are reached directly with the default `responses` wire;
 * chat-only providers (DeepSeek and the domestic series) are routed through the
 * in-process Responses↔Chat bridge, which codex sees as just another
 * responses-speaking provider on localhost.
 */
const codexInjector: AgentInjector = async (provider, profile, apiKey) => {
  if (provider.kind !== 'openai' && provider.kind !== 'openai-compatible') {
    return {
      ...EMPTY,
      detail: `Codex BYOK requires an OpenAI-compatible provider; got ${provider.kind}.`,
    };
  }
  const model = profile.modelId;
  const route = codexRoute(provider);

  // Local Ollama / LM Studio: codex's built-in provider already speaks the
  // Responses API to the local server. Just select it — no custom provider, no
  // API key. (Defining `model_providers.<built-in>` is rejected: "Built-in
  // providers cannot be overridden.")
  if (route === 'local-oss') {
    const local = codexLocalProvider(provider);
    prewarmLocalModel(provider, model);
    return {
      env: {}, argvAppend: [],
      codexConfigOverrides: [`model_provider="${local}"`],
      modelOverride: model,
      detail: `Codex local → ${provider.name} / ${model} (built-in ${local}, responses)`,
    };
  }

  // Genuine OpenAI: use the built-in `openai` provider; inject the key (+ base).
  if (route === 'openai-native') {
    const env: Record<string, string> = { OPENAI_API_KEY: apiKey };
    if (provider.baseURL) env.OPENAI_BASE_URL = provider.baseURL;
    return {
      env, argvAppend: [],
      codexConfigOverrides: ['model_provider="openai"'],
      modelOverride: model,
      detail: `Codex BYOK → OpenAI / ${model}`,
    };
  }

  const slug = providerSlug(provider);
  const envKey = codexEnvKey(provider);

  // Chat-only providers: route through the local Responses↔Chat bridge. Codex
  // forwards `Authorization: Bearer <key>` (from env_key) to the bridge, which
  // relays it to the upstream chat endpoint — the bridge never stores secrets.
  if (route === 'bridge') {
    const port = await ensureResponsesBridge();
    const base = `http://127.0.0.1:${port}/u/${upstreamToken(provider.baseURL)}`;
    return {
      env: { [envKey]: apiKey },
      argvAppend: [],
      codexConfigOverrides: [
        `model_providers.${slug}.name="${tomlEscape(provider.name)}"`,
        `model_providers.${slug}.base_url="${tomlEscape(base)}"`,
        `model_providers.${slug}.env_key="${envKey}"`,
        `model_provider="${slug}"`,
      ],
      modelOverride: model,
      detail: `Codex BYOK → ${provider.name} / ${model} via Responses↔Chat bridge (provider=${slug})`,
    };
  }

  // responses-native (OpenRouter, …): point codex straight at the provider's
  // Responses endpoint (wire_api omitted ⇒ codex default `responses`).
  return {
    env: { [envKey]: apiKey },
    argvAppend: [],
    codexConfigOverrides: [
      `model_providers.${slug}.name="${tomlEscape(provider.name)}"`,
      `model_providers.${slug}.base_url="${tomlEscape(provider.baseURL)}"`,
      `model_providers.${slug}.env_key="${envKey}"`,
      `model_provider="${slug}"`,
    ],
    modelOverride: model,
    detail: `Codex BYOK → ${provider.name} / ${model} (provider=${slug}, native responses)`,
  };
};

/** Gemini CLI accepts `GEMINI_API_KEY` but does not allow custom baseURL. */
const geminiInjector: AgentInjector = (provider, profile, apiKey) => {
  if (provider.kind !== 'google') {
    return {
      ...EMPTY,
      detail: `Gemini BYOK only supports Google AI Studio keys; got ${provider.kind}.`,
    };
  }
  return {
    env: { GEMINI_API_KEY: apiKey },
    argvAppend: [],
    modelOverride: profile.modelId,
    detail: `Gemini BYOK → ${provider.name} / ${profile.modelId}`,
  };
};

/**
 * Hermes injector. Two channels:
 *   1. Env vars carry the credential — `hermes acp` honours `OPENROUTER_API_KEY`,
 *      `ANTHROPIC_API_KEY`, etc. just like the top-level `hermes` CLI.
 *   2. The model is bound *per-session* by the driver via the ACP
 *      `session/set_model` request — `hermes acp` does NOT accept `-m` /
 *      `--provider` (only `--accept-hooks`); appending `-m` here used to make
 *      every BYOK-bound spawn die with `unrecognized arguments`.
 *
 * The model is handed to the driver via `modelOverride` (an ACP-style
 * `<provider>:<model>` string). The driver passes it to `session/set_model`
 * after `session/new` returns; if the user has no Profile bound, no
 * `set_model` call is made and Hermes uses its `~/.hermes/config.yaml`
 * default.
 */
const hermesInjector: AgentInjector = (provider, profile, apiKey) => {
  const env = providerCredentialEnv(provider, apiKey);
  const slug = providerSlug(provider);
  // Only strip a leading `<slug>/` or `<slug>:` if the user accidentally
  // stored a redundant provider prefix. Do NOT strip the *first segment* of
  // a slash-separated model id wholesale — for OpenRouter the canonical
  // model id is `vendor/model` (e.g. `deepseek/deepseek-v4-flash`), and
  // dropping the `vendor/` part yields a non-existent model.
  let bareModel = profile.modelId;
  if (bareModel.startsWith(`${slug}/`) || bareModel.startsWith(`${slug}:`)) {
    bareModel = bareModel.slice(slug.length + 1);
  }
  return {
    env,
    argvAppend: [],
    modelOverride: `${slug}:${bareModel}`,
    detail: `Hermes → ${provider.name} / ${profile.modelId}`,
  };
};

const AGENT_INJECT_TABLE: Record<string, AgentInjector | undefined> = {
  claude: claudeInjector,
  codex: codexInjector,
  gemini: geminiInjector,
  hermes: hermesInjector,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve the active Profile for an agent and return the spawn config to
 * inject. Returns `null` when no Profile is bound (caller should fall back
 * to the agent's native auth / default model).
 */
export async function resolveAgentInjection(agentId: string): Promise<InjectedSpawnConfig | null> {
  const profile = getActiveProfile(agentId);
  if (!profile) return null;
  const provider = getProvider(profile.providerId);
  if (!provider) return null;
  const injector = AGENT_INJECT_TABLE[agentId];
  if (!injector) return null;

  // Local providers (Ollama / LM Studio / llama.cpp) need no credential — codex
  // reaches them via its built-in localhost provider with no auth. Don't let a
  // missing/placeholder key block an otherwise-valid local binding.
  let apiKey = '';
  try {
    apiKey = await resolveCredential(provider.credential);
  } catch (e: any) {
    if (!isLocalProvider(provider)) {
      throw new Error(`Failed to resolve credential for ${provider.name}: ${e?.message || e}`);
    }
  }

  const result = await injector(provider, profile, apiKey);
  // Attach the provider display name so renders can surface "via <provider>"
  // — this is what tells the user the turn is going through a BYOK route.
  result.providerName = provider.name;
  // Attach the real context window from the provider's cached /models listing.
  // Sync peek — no network blocking; on miss we kick off a fetch so the *next*
  // session has it, and this turn falls back to the CLI's advertised value.
  const cached = peekProviderModelInfo(provider.id, profile.modelId);
  if (cached?.contextLength && cached.contextLength > 0) {
    result.contextWindow = cached.contextLength;
  } else {
    prefetchProviderModels(provider.id);
  }
  return result;
}

/** Returns `true` if the given agent is bound to a Profile. */
export function isAgentBoundToProfile(agentId: string): boolean {
  return getActiveProfile(agentId) !== null;
}
