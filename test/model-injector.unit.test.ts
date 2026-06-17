import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addProvider, addProfile, setActiveProfile, resolveAgentInjection,
  type ProviderKind,
} from '../src/model/index.js';
import { sealInline } from '../src/core/secrets/index.js';

// resolveAgentInjection is the single point where a bound Profile becomes the
// env / model overrides a spawned agent receives. The Claude BYOK path is the
// subtle one: Claude Code speaks the Anthropic Messages API and appends
// `/v1/messages` to ANTHROPIC_BASE_URL, so the base has to be the provider's
// *Anthropic-protocol* root — which for DeepSeek/Kimi/Zhipu is a dedicated
// namespace, NOT the OpenAI base we store for validation.

describe('resolveAgentInjection — Claude BYOK ANTHROPIC_BASE_URL', () => {
  let tmpDir: string;
  let cache: Map<string, any>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikiloom-injector-'));
    process.env.PIKILOOM_CONFIG = path.join(tmpDir, 'setting.json');
    fs.writeFileSync(process.env.PIKILOOM_CONFIG, JSON.stringify({ models: {} }));
    // The provider-models cache is pinned to globalThis; pre-seed it per
    // provider below so resolveAgentInjection's sync peek hits and never kicks
    // off a real network /models fetch during the test.
    cache = (globalThis as any)[Symbol.for('pikiloom.providerModelsCache')]
      || new Map();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function bindClaude(kind: ProviderKind, baseURL: string, modelId: string) {
    const provider = await addProvider({
      kind, name: 'test', baseURL,
      credentialRef: { source: 'inline', sealed: sealInline('sk-test-key') },
    });
    // Seed the model cache so the injection runs offline.
    cache.set(provider.id, {
      models: [modelId],
      modelInfos: [{ id: modelId, contextLength: 131072 }],
      fetchedAt: Date.now(),
      providerUpdatedAt: provider.updatedAt,
    });
    const profile = addProfile({ providerId: provider.id, modelId });
    setActiveProfile('claude', profile.id);
    const injection = await resolveAgentInjection('claude');
    return injection!;
  }

  it('routes DeepSeek to its /anthropic endpoint (the reported flash case)', async () => {
    const inj = await bindClaude('openai-compatible', 'https://api.deepseek.com', 'deepseek-v4-flash');
    expect(inj.env.ANTHROPIC_BASE_URL).toBe('https://api.deepseek.com/anthropic');
    expect(inj.env.ANTHROPIC_API_KEY).toBe('sk-test-key');
    expect(inj.env.ANTHROPIC_AUTH_TOKEN).toBe('sk-test-key');
    // The exact model id the user picked must reach Claude verbatim.
    expect(inj.modelOverride).toBe('deepseek-v4-flash');
    expect(inj.contextWindow).toBe(131072);
  });

  it('is idempotent when the user already pasted the /anthropic URL', async () => {
    const inj = await bindClaude('openai-compatible', 'https://api.deepseek.com/anthropic', 'deepseek-v4-pro');
    expect(inj.env.ANTHROPIC_BASE_URL).toBe('https://api.deepseek.com/anthropic');
  });

  it('drops a trailing /v1 before mapping DeepSeek to /anthropic', async () => {
    const inj = await bindClaude('openai-compatible', 'https://api.deepseek.com/v1', 'deepseek-v4-flash');
    expect(inj.env.ANTHROPIC_BASE_URL).toBe('https://api.deepseek.com/anthropic');
  });

  it('maps Kimi (Moonshot) to /anthropic', async () => {
    const inj = await bindClaude('openai-compatible', 'https://api.moonshot.cn/v1', 'kimi-k2');
    expect(inj.env.ANTHROPIC_BASE_URL).toBe('https://api.moonshot.cn/anthropic');
  });

  it('maps Zhipu/GLM to /api/anthropic', async () => {
    const inj = await bindClaude('openai-compatible', 'https://open.bigmodel.cn/api/paas/v4', 'glm-4.6');
    expect(inj.env.ANTHROPIC_BASE_URL).toBe('https://open.bigmodel.cn/api/anthropic');
  });

  it('leaves Anthropic-native untouched (minus a trailing /v1)', async () => {
    const inj = await bindClaude('anthropic', 'https://api.anthropic.com', 'claude-sonnet-4-5');
    expect(inj.env.ANTHROPIC_BASE_URL).toBe('https://api.anthropic.com');
  });

  it('keeps the historical strip-/v1 default for unmapped providers (OpenRouter)', async () => {
    const inj = await bindClaude('openai-compatible', 'https://openrouter.ai/api/v1', 'anthropic/claude-sonnet-4');
    expect(inj.env.ANTHROPIC_BASE_URL).toBe('https://openrouter.ai/api');
  });
});
