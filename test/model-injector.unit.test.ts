import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addProvider, addProfile, setActiveProfile, resolveAgentInjection,
  type ProviderKind,
} from '../src/model/index.js';
import { sealInline } from '../src/core/secrets/index.js';
import { shutdownResponsesBridge } from '../src/model/responses-bridge.js';
import { shutdownAnthropicBridge } from '../src/model/anthropic-bridge.js';

describe('resolveAgentInjection — Claude BYOK ANTHROPIC_BASE_URL', () => {
  let tmpDir: string;
  let cache: Map<string, any>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikiloom-injector-'));
    process.env.PIKILOOM_CONFIG = path.join(tmpDir, 'setting.json');
    fs.writeFileSync(process.env.PIKILOOM_CONFIG, JSON.stringify({ models: {} }));
    cache = (globalThis as any)[Symbol.for('pikiloom.providerModelsCache')]
      || new Map();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  afterAll(() => { shutdownAnthropicBridge(); });

  async function bindClaude(kind: ProviderKind, baseURL: string, modelId: string) {
    const provider = await addProvider({
      kind, name: 'test', baseURL,
      credentialRef: { source: 'inline', sealed: sealInline('sk-test-key') },
    });
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

  it('routes 豆包/Ark (OpenAI-only, no native /v1/messages) through the Anthropic↔Chat bridge', async () => {
    const inj = await bindClaude('openai-compatible', 'https://ark.cn-beijing.volces.com/api/v3', 'doubao-seed-2-1-pro-260628');
    const m = inj.env.ANTHROPIC_BASE_URL.match(/^http:\/\/127\.0\.0\.1:\d+\/u\/([^/]+)$/);
    expect(m, `ANTHROPIC_BASE_URL should point at the bridge, got: ${inj.env.ANTHROPIC_BASE_URL}`).toBeTruthy();
    expect(Buffer.from(m![1], 'base64url').toString('utf8')).toBe('https://ark.cn-beijing.volces.com/api/v3');
    expect(inj.modelOverride).toBe('doubao-seed-2-1-pro-260628');
    expect(inj.env.ANTHROPIC_SMALL_FAST_MODEL).toBe('doubao-seed-2-1-pro-260628');
    expect(inj.env.ANTHROPIC_AUTH_TOKEN).toBe('sk-test-key');
    expect(inj.env.CLAUDE_CODE_ATTRIBUTION_HEADER).toBe('0');
  });

  it('suppresses the churning attribution header on third-party proxy routes', async () => {
    const ds = await bindClaude('openai-compatible', 'https://api.deepseek.com', 'deepseek-v4-flash');
    expect(ds.env.CLAUDE_CODE_ATTRIBUTION_HEADER).toBe('0');
    const or = await bindClaude('openai-compatible', 'https://openrouter.ai/api/v1', 'anthropic/claude-sonnet-4');
    expect(or.env.CLAUDE_CODE_ATTRIBUTION_HEADER).toBe('0');
  });

  it('leaves first-party Anthropic direct routes untouched (subscription or own-key)', async () => {
    const native = await bindClaude('anthropic', 'https://api.anthropic.com', 'claude-sonnet-4-5');
    expect(native.env.CLAUDE_CODE_ATTRIBUTION_HEADER).toBeUndefined();
    const withV1 = await bindClaude('anthropic', 'https://api.anthropic.com/v1', 'claude-sonnet-4-5');
    expect(withV1.env.CLAUDE_CODE_ATTRIBUTION_HEADER).toBeUndefined();
  });
});

describe('resolveAgentInjection — Codex routing (Responses-only)', () => {
  let tmpDir: string;
  let cache: Map<string, any>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikiloom-codex-'));
    process.env.PIKILOOM_CONFIG = path.join(tmpDir, 'setting.json');
    fs.writeFileSync(process.env.PIKILOOM_CONFIG, JSON.stringify({ models: {} }));
    cache = (globalThis as any)[Symbol.for('pikiloom.providerModelsCache')] || new Map();
  });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });
  afterAll(() => { shutdownResponsesBridge(); });

  async function bindCodex(kind: ProviderKind, name: string, baseURL: string, modelId: string) {
    const provider = await addProvider({
      kind, name, baseURL,
      credentialRef: { source: 'inline', sealed: sealInline('sk-test-key') },
    });
    cache.set(provider.id, {
      models: [modelId], modelInfos: [{ id: modelId, contextLength: 65536 }],
      fetchedAt: Date.now(), providerUpdatedAt: provider.updatedAt,
    });
    const profile = addProfile({ providerId: provider.id, modelId });
    setActiveProfile('codex', profile.id);
    return (await resolveAgentInjection('codex'))!;
  }
  const overrides = (inj: any) => (inj.codexConfigOverrides ?? []) as string[];

  it('routes a chat-only provider (DeepSeek) through the local bridge', async () => {
    const inj = await bindCodex('openai-compatible', 'DeepSeek', 'https://api.deepseek.com', 'deepseek-v4-flash');
    const ovr = overrides(inj);
    expect(ovr).toContain('model_provider="deepseek"');
    const baseLine = ovr.find(o => o.startsWith('model_providers.deepseek.base_url='));
    const m = baseLine?.match(/^model_providers\.deepseek\.base_url="(http:\/\/127\.0\.0\.1:\d+\/u\/([^"]+))"$/);
    expect(m, `base_url should point at the bridge, got: ${baseLine}`).toBeTruthy();
    expect(Buffer.from(m![2], 'base64url').toString('utf8')).toBe('https://api.deepseek.com');
    expect(inj.env.DEEPSEEK_API_KEY).toBe('sk-test-key');
    expect(ovr.some(o => o.includes('wire_api'))).toBe(false);
    expect(inj.modelOverride).toBe('deepseek-v4-flash');
  });

  it('points codex straight at a Responses-native provider (OpenRouter)', async () => {
    const inj = await bindCodex('openai-compatible', 'OpenRouter', 'https://openrouter.ai/api/v1', 'deepseek/deepseek-v4-flash');
    const ovr = overrides(inj);
    expect(ovr).toContain('model_provider="openrouter"');
    expect(ovr).toContain('model_providers.openrouter.base_url="https://openrouter.ai/api/v1"');
    expect(inj.env.OPENROUTER_API_KEY).toBe('sk-test-key');
    expect(ovr.some(o => o.includes('127.0.0.1'))).toBe(false);
    expect(ovr.some(o => o.includes('wire_api'))).toBe(false);
  });

  it('routes 豆包/Ark codex through the bridge (its native Responses rejects codex namespace/web_search tool types)', async () => {
    const inj = await bindCodex('openai-compatible', '豆包 (Volcengine Ark)', 'https://ark.cn-beijing.volces.com/api/v3', 'doubao-seed-2-1-pro-260628');
    const ovr = overrides(inj);
    expect(ovr).toContain('model_provider="doubao"');
    const baseLine = ovr.find(o => o.startsWith('model_providers.doubao.base_url='));
    const m = baseLine?.match(/^model_providers\.doubao\.base_url="(http:\/\/127\.0\.0\.1:\d+\/u\/([^"]+))"$/);
    expect(m, `base_url should point at the bridge, got: ${baseLine}`).toBeTruthy();
    expect(Buffer.from(m![2], 'base64url').toString('utf8')).toBe('https://ark.cn-beijing.volces.com/api/v3');
    expect(inj.env.ARK_API_KEY).toBe('sk-test-key');
    expect(ovr.some(o => o.includes('wire_api'))).toBe(false);
    expect(inj.modelOverride).toBe('doubao-seed-2-1-pro-260628');
  });

  it('selects codex built-in `ollama` provider for a localhost endpoint (no custom provider, no key)', async () => {
    const inj = await bindCodex('openai-compatible', 'Ollama', 'http://127.0.0.1:11434/v1', 'qwen3:4b');
    expect(overrides(inj)).toEqual(['model_provider="ollama"']);
    expect(inj.env).toEqual({});
    expect(inj.modelOverride).toBe('qwen3:4b');
  });

  it('selects codex built-in `lmstudio` provider for a localhost:1234 endpoint', async () => {
    const inj = await bindCodex('openai-compatible', 'LM Studio', 'http://localhost:1234/v1', 'qwen2.5-coder');
    expect(overrides(inj)).toEqual(['model_provider="lmstudio"']);
  });
});

describe('resolveAgentInjection — per-session profile override (dashboard does not mutate the global default)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikiloom-override-'));
    process.env.PIKILOOM_CONFIG = path.join(tmpDir, 'setting.json');
    fs.writeFileSync(process.env.PIKILOOM_CONFIG, JSON.stringify({ models: {} }));
  });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });
  afterAll(() => { shutdownAnthropicBridge(); });

  async function seedTwoProfiles() {
    const provider = await addProvider({
      kind: 'anthropic', name: 'anthropic', baseURL: 'https://api.anthropic.com',
      credentialRef: { source: 'inline', sealed: sealInline('sk-test-key') },
    });
    const active = addProfile({ providerId: provider.id, modelId: 'claude-active' });
    const other = addProfile({ providerId: provider.id, modelId: 'claude-other' });
    setActiveProfile('claude', active.id);
    return { active, other };
  }

  it('undefined override falls back to the global active profile (IM / default path)', async () => {
    const { active } = await seedTwoProfiles();
    const inj = await resolveAgentInjection('claude');
    expect(inj?.modelOverride).toBe(active.modelId);
  });

  it('a profileId override injects that profile without touching the global active one', async () => {
    const { active, other } = await seedTwoProfiles();
    const inj = await resolveAgentInjection('claude', other.id);
    expect(inj?.modelOverride).toBe(other.modelId);
    // the global default is unchanged — a fresh (undefined) resolution still sees the active profile
    expect((await resolveAgentInjection('claude'))?.modelOverride).toBe(active.modelId);
  });

  it('a null override means native — no injection even when a BYOK profile is active globally', async () => {
    await seedTwoProfiles();
    expect(await resolveAgentInjection('claude', null)).toBeNull();
  });
});
