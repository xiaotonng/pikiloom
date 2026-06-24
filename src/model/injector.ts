import { resolveCredential } from '../core/secrets/index.js';
import { writeScopedLog } from '../core/logging.js';
import { getActiveProfile, getProvider } from './store.js';
import { peekProviderModelInfo, prefetchProviderModels } from './provider-models.js';
import { ensureResponsesBridge, upstreamToken } from './responses-bridge.js';
import { ensureAnthropicBridge } from './anthropic-bridge.js';
import type { ProviderConfig, ModelProfileConfig, ProviderKind } from './types.js';

export interface InjectedSpawnConfig {
  env: Record<string, string>;
  argvAppend: string[];
  codexConfigOverrides?: string[];
  modelOverride?: string;
  contextWindow?: number;
  providerName?: string;
  configFiles?: Record<string, string>;
  homeOverride?: string;
  detail: string;
}

const EMPTY: InjectedSpawnConfig = { env: {}, argvAppend: [], detail: '' };

function providerHost(provider: ProviderConfig): string {
  try { return new URL(provider.baseURL).host.toLowerCase(); } catch { return ''; }
}

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
  const label = host.replace(/:\d+$/, '').replace(/^(www|api)\./, '').split('.')[0].replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return label || 'byok';
}

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

function codexEnvKey(provider: ProviderConfig): string {
  const keys = Object.keys(providerCredentialEnv(provider, ''));
  return keys[0] || 'OPENROUTER_API_KEY';
}

function tomlEscape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

const ANTHROPIC_ENDPOINT_BY_SLUG: Record<string, (origin: string) => string> = {
  deepseek: origin => `${origin}/anthropic`,
  kimi: origin => `${origin}/anthropic`,
  zai: origin => `${origin}/api/anthropic`,
};

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

function isFirstPartyAnthropic(baseURL: string): boolean {
  let host: string;
  try { host = new URL(baseURL).hostname.toLowerCase(); } catch { return false; }
  return host === 'anthropic.com' || host.endsWith('.anthropic.com');
}

function claudeUsesNativeAnthropic(provider: ProviderConfig): boolean {
  if (provider.kind === 'anthropic') return true;
  const slug = providerSlug(provider);
  if (slug in ANTHROPIC_ENDPOINT_BY_SLUG) return true;
  if (slug === 'openrouter') return true;
  return false;
}

type AgentInjector = (
  provider: ProviderConfig,
  profile: ModelProfileConfig,
  apiKey: string,
) => InjectedSpawnConfig | Promise<InjectedSpawnConfig>;

const claudeInjector: AgentInjector = async (provider, profile, apiKey) => {
  if (provider.kind !== 'anthropic' && provider.kind !== 'openai-compatible') {
    return {
      ...EMPTY,
      detail: `Claude BYOK requires Anthropic or OpenAI-compatible provider; got ${provider.kind}.`,
    };
  }
  if (!claudeUsesNativeAnthropic(provider)) {
    const port = await ensureAnthropicBridge();
    const base = `http://127.0.0.1:${port}/u/${upstreamToken(provider.baseURL)}`;
    return {
      env: {
        ANTHROPIC_BASE_URL: base,
        ANTHROPIC_API_KEY: apiKey,
        ANTHROPIC_AUTH_TOKEN: apiKey,
        ANTHROPIC_SMALL_FAST_MODEL: profile.modelId,
        CLAUDE_CODE_ATTRIBUTION_HEADER: '0',
      },
      argvAppend: [],
      modelOverride: profile.modelId,
      detail: `Claude BYOK → ${provider.name} / ${profile.modelId} via Anthropic↔Chat bridge`,
    };
  }
  const baseURL = claudeAnthropicBaseURL(provider);
  const env: Record<string, string> = {
    ANTHROPIC_BASE_URL: baseURL,
    ANTHROPIC_API_KEY: apiKey,
    ANTHROPIC_AUTH_TOKEN: apiKey,
  };
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

function isLocalProvider(provider: ProviderConfig): boolean {
  const h = providerHostname(provider);
  return h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0' || h === '::1';
}

function isResponsesNativeProvider(provider: ProviderConfig): boolean {
  const host = providerHost(provider);
  if (host.includes('openrouter')) return true;
  if (host.includes('volces') || host.includes('volcengine') || host.includes('doubao')) return true;
  return false;
}

function codexLocalProvider(provider: ProviderConfig): 'ollama' | 'lmstudio' {
  let port = '';
  try { port = new URL(provider.baseURL).port; } catch {  }
  if (port === '1234' || /lm\s*studio/i.test(provider.name)) return 'lmstudio';
  return 'ollama';
}

const PREWARM_KEEP_ALIVE = '30m';

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

function codexRoute(provider: ProviderConfig): CodexRoute {
  if (provider.kind === 'openai') return 'openai-native';
  if (isLocalProvider(provider)) return 'local-oss';
  if (isResponsesNativeProvider(provider)) return 'responses-native';
  return 'bridge';
}

const codexInjector: AgentInjector = async (provider, profile, apiKey) => {
  if (provider.kind !== 'openai' && provider.kind !== 'openai-compatible') {
    return {
      ...EMPTY,
      detail: `Codex BYOK requires an OpenAI-compatible provider; got ${provider.kind}.`,
    };
  }
  const model = profile.modelId;
  const route = codexRoute(provider);

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

const hermesInjector: AgentInjector = (provider, profile, apiKey) => {
  const env = providerCredentialEnv(provider, apiKey);
  const slug = providerSlug(provider);
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

export async function resolveAgentInjection(agentId: string): Promise<InjectedSpawnConfig | null> {
  const profile = getActiveProfile(agentId);
  if (!profile) return null;
  const provider = getProvider(profile.providerId);
  if (!provider) return null;
  const injector = AGENT_INJECT_TABLE[agentId];
  if (!injector) return null;

  let apiKey = '';
  try {
    apiKey = await resolveCredential(provider.credential);
  } catch (e: any) {
    if (!isLocalProvider(provider)) {
      throw new Error(`Failed to resolve credential for ${provider.name}: ${e?.message || e}`);
    }
  }

  const result = await injector(provider, profile, apiKey);
  result.providerName = provider.name;
  const cached = peekProviderModelInfo(provider.id, profile.modelId);
  if (cached?.contextLength && cached.contextLength > 0) {
    result.contextWindow = cached.contextLength;
  } else {
    prefetchProviderModels(provider.id);
  }
  return result;
}

export function isAgentBoundToProfile(agentId: string): boolean {
  return getActiveProfile(agentId) !== null;
}
