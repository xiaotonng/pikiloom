import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  recoverProfileIdForModel, humanizeCodexError,
  type Agent,
} from '../src/agent/index.js';
import {
  addProvider, addProfile, setActiveProfile,
  type ProviderKind,
} from '../src/model/index.js';
import { sealInline } from '../src/core/secrets/index.js';

describe('humanizeCodexError — ChatGPT-account rejects third-party models', () => {
  it('translates the raw upstream JSON into an actionable instruction', () => {
    const raw = `{"detail":"The 'deepseek-v4-pro' model is not supported when using Codex with a ChatGPT account."}`;
    const out = humanizeCodexError(raw);
    expect(out).not.toBe(raw);
    expect(out).toContain('deepseek-v4-pro');
    expect(out).toContain('ChatGPT');
    expect(out).toContain('智能体配置');
    expect(out).not.toContain('"detail"');
  });

  it('captures the rejected model id regardless of wrapping', () => {
    const out = humanizeCodexError("The 'kimi-k2' model is not supported when using Codex with a ChatGPT account.");
    expect(out).toContain('kimi-k2');
  });

  it('passes unrelated errors through untouched', () => {
    expect(humanizeCodexError('turn/start failed')).toBe('turn/start failed');
  });

  it('returns null for empty input (so the `||` error chain keeps falling through)', () => {
    expect(humanizeCodexError(null)).toBeNull();
    expect(humanizeCodexError(undefined)).toBeNull();
    expect(humanizeCodexError('')).toBeNull();
  });
});

describe('recoverProfileIdForModel — recover a lost provider binding by model id', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikiloom-recover-'));
    process.env.PIKILOOM_CONFIG = path.join(tmpDir, 'setting.json');
    fs.writeFileSync(process.env.PIKILOOM_CONFIG, JSON.stringify({ models: {} }));
  });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  async function addCodexProfile(modelId: string, baseURL = 'https://api.deepseek.com', kind: ProviderKind = 'openai-compatible') {
    const provider = await addProvider({
      kind, name: 'test', baseURL,
      credentialRef: { source: 'inline', sealed: sealInline('sk-test-key') },
    });
    return addProfile({ providerId: provider.id, modelId });
  }

  it('recovers the unique profile that declares the requested model (the screenshot case)', async () => {
    const profile = await addCodexProfile('deepseek-v4-pro');
    expect(recoverProfileIdForModel('codex', 'deepseek-v4-pro')).toBe(profile.id);
  });

  it('recovers even when the profile is not the globally-bound active one', async () => {
    const bound = await addCodexProfile('deepseek-v4-flash');
    setActiveProfile('codex', bound.id);
    const orphan = await addCodexProfile('deepseek-v4-pro');
    // session asks for deepseek-v4-pro but the active binding is deepseek-v4-flash
    expect(recoverProfileIdForModel('codex', 'deepseek-v4-pro')).toBe(orphan.id);
  });

  it('returns null for a native model that no profile backs (leave native spawn alone)', async () => {
    await addCodexProfile('deepseek-v4-pro');
    expect(recoverProfileIdForModel('codex', 'gpt-5.5')).toBeNull();
  });

  it('refuses to guess when the model id is ambiguous across multiple profiles', async () => {
    await addCodexProfile('deepseek-v4-pro', 'https://api.deepseek.com');
    await addCodexProfile('deepseek-v4-pro', 'https://openrouter.ai/api/v1');
    expect(recoverProfileIdForModel('codex', 'deepseek-v4-pro')).toBeNull();
  });

  it('does not cross agent provider-kind boundaries (Gemini only accepts google)', async () => {
    await addCodexProfile('deepseek-v4-pro'); // openai-compatible — not a google kind
    expect(recoverProfileIdForModel('gemini' as Agent, 'deepseek-v4-pro')).toBeNull();
  });

  it('returns null for an empty/whitespace model id', () => {
    expect(recoverProfileIdForModel('codex', '')).toBeNull();
    expect(recoverProfileIdForModel('codex', '   ')).toBeNull();
  });
});
