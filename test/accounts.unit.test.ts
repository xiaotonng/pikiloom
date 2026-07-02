import { describe, it, expect, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolate HOME + config to a temp dir (read lazily per-call by the store).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pikiloom-acct-'));
process.env.HOME = TMP;
process.env.PIKILOOM_CONFIG = path.join(TMP, 'setting.json');

// Force inline-sealed credentials so the test never touches the OS keychain.
vi.mock('../src/core/secrets/index.js', async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    persistSecret: async (_account: string, plaintext: string) => ({ source: 'inline', sealed: actual.sealInline(plaintext) }),
    forgetSecret: async () => {},
  };
});

// Stub the driver-level usage reads so the snapshot tests never hit the network or the keychain.
const usageMocks = vi.hoisted(() => {
  const mkUsage = (tag: string) => ({
    ok: true, agent: 'claude', source: 'ratelimit-headers', capturedAt: '2026-07-02T00:00:00.000Z',
    status: 'allowed', windows: [{ label: '5h', usedPercent: 10, remainingPercent: 90, resetAt: null, resetAfterSeconds: null, status: 'allowed' }],
    error: null, tag,
  });
  return {
    mkUsage,
    claudeUsageForToken: vi.fn(async (token: string) => mkUsage(`token:${token}`)),
    claudeNativeUsage: vi.fn(async () => mkUsage('native')),
  };
});
vi.mock('../src/agent/drivers/claude.js', () => ({
  claudeUsageForToken: usageMocks.claudeUsageForToken,
  claudeNativeUsage: usageMocks.claudeNativeUsage,
}));

import * as kernel from '../packages/kernel/dist/index.js';
import * as accounts from '../src/agent/accounts.js';

afterAll(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* noop */ } });

describe('kernel account token capability', () => {
  it('maps supported agents to the token env var', () => {
    expect(kernel.accountTokenSupported('claude')).toBe(true);
    expect(kernel.accountTokenSupported('claude-tui')).toBe(true);
    expect(kernel.accountTokenSupported('codex')).toBe(false);
    expect(kernel.accountTokenEnvVar('claude')).toBe('CLAUDE_CODE_OAUTH_TOKEN');
    expect(kernel.accountTokenEnv('claude', 'sk-ant-oat01-x')).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-x' });
    expect(kernel.accountTokenEnv('codex', 'x')).toEqual({});
  });
});

describe('app token-account store', () => {
  it('requires a name + valid token, claude-only', async () => {
    await expect(accounts.addAccount('claude', '', 'sk-ant-oat01-x')).rejects.toThrow();   // no name
    await expect(accounts.addAccount('claude', 'X', 'bad')).rejects.toThrow();             // bad token
    await expect(accounts.addAccount('codex', 'X', 'sk-ant-oat01-x')).rejects.toThrow();   // codex unsupported
    expect(accounts.accountAgentSupported('claude')).toBe(true);
    expect(accounts.accountAgentSupported('codex')).toBe(false);
    expect(accounts.listAccounts('claude')).toHaveLength(0);
  });

  it('add / list / active / resolve(token env) / rename / replace-token / remove', async () => {
    const a = await accounts.addAccount('claude', '工作号', 'sk-ant-oat01-AAA');
    const b = await accounts.addAccount('claude', '个人号', 'sk-ant-oat01-BBB');
    expect(accounts.listAccounts('claude').map(r => r.label)).toEqual(['工作号', '个人号']);

    // resolution falls through to the globally-active account
    expect(await accounts.resolveAccountEnv('claude')).toBeNull();
    accounts.setActiveAccount('claude', a.id);
    const resolved = await accounts.resolveAccountEnv('claude');
    expect(resolved?.accountId).toBe(a.id);
    expect(resolved?.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-AAA' });

    // tri-state override: null -> none, id -> that account's token
    expect(await accounts.resolveAccountEnv('claude', null)).toBeNull();
    expect((await accounts.resolveAccountEnv('claude', b.id))?.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-BBB');

    await accounts.updateAccount('claude', a.id, { label: '工作号-2' });
    expect(accounts.getAccount('claude', a.id)?.label).toBe('工作号-2');

    await accounts.updateAccount('claude', a.id, { token: 'sk-ant-oat01-CCC' });
    expect((await accounts.resolveAccountEnv('claude', a.id))?.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-CCC');

    expect(await accounts.removeAccount('claude', a.id)).toBe(true);
    expect(accounts.listAccounts('claude').map(r => r.id)).toEqual([b.id]);
  });

  it('clears active on removal and ignores stale credential-less records', async () => {
    const c = await accounts.addAccount('claude', 'temp', 'sk-ant-oat01-DDD');
    accounts.setActiveAccount('claude', c.id);
    expect(accounts.getActiveAccountId('claude')).toBe(c.id);
    await accounts.removeAccount('claude', c.id);
    expect(accounts.getActiveAccountId('claude')).toBeNull();

    // a record from the old config-dir implementation (no credential) is not a real account
    const cfgPath = process.env.PIKILOOM_CONFIG!;
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    cfg.accounts = cfg.accounts || {};
    cfg.accounts.byAgent = cfg.accounts.byAgent || {};
    cfg.accounts.byAgent.claude = [...(cfg.accounts.byAgent.claude || []), { id: 'legacy', label: 'old', createdAt: '2026-01-01T00:00:00Z' }];
    fs.writeFileSync(cfgPath, JSON.stringify(cfg));
    expect(accounts.listAccounts('claude').some(r => r.id === 'legacy')).toBe(false);
  });
});

describe('getAccountsUsageSnapshot — unified usage channel', () => {
  it('returns account rows + native usage from one pass, forwarding the fresh flag', async () => {
    const a = await accounts.addAccount('claude', 'snap-a', 'sk-ant-oat01-SNAPA');
    accounts.setActiveAccount('claude', a.id);
    usageMocks.claudeUsageForToken.mockClear();
    usageMocks.claudeNativeUsage.mockClear();

    const snap = await accounts.getAccountsUsageSnapshot('claude', { fresh: true });
    expect(snap.supported).toBe(true);
    expect(snap.activeAccountId).toBe(a.id);
    const row = snap.accounts.find(r => r.id === a.id);
    expect(row?.active).toBe(true);
    expect(row?.label).toBe('snap-a');
    expect((row?.usage as any)?.tag).toBe('token:sk-ant-oat01-SNAPA');
    expect((snap.native as any)?.tag).toBe('native');
    expect(usageMocks.claudeNativeUsage).toHaveBeenCalledWith({ fresh: true, force: false });
    expect(usageMocks.claudeUsageForToken).toHaveBeenCalledWith('sk-ant-oat01-SNAPA', { fresh: true, force: false });

    await accounts.removeAccount('claude', a.id);
  });

  it('forwards the force flag (explicit refresh) to both the native and token probes', async () => {
    const c = await accounts.addAccount('claude', 'snap-c', 'sk-ant-oat01-SNAPC');
    usageMocks.claudeUsageForToken.mockClear();
    usageMocks.claudeNativeUsage.mockClear();

    await accounts.getAccountsUsageSnapshot('claude', { fresh: true, force: true });
    expect(usageMocks.claudeNativeUsage).toHaveBeenCalledWith({ fresh: true, force: true });
    expect(usageMocks.claudeUsageForToken).toHaveBeenCalledWith('sk-ant-oat01-SNAPC', { fresh: true, force: true });

    await accounts.removeAccount('claude', c.id);
  });

  it('probe failures fall back to the last cached value instead of dropping the row', async () => {
    const b = await accounts.addAccount('claude', 'snap-b', 'sk-ant-oat01-SNAPB');
    await accounts.probeAccountUsage('claude', b.id);          // seeds the cached value
    usageMocks.claudeUsageForToken.mockRejectedValueOnce(new Error('network down'));

    const snap = await accounts.getAccountsUsageSnapshot('claude', { fresh: true });
    const row = snap.accounts.find(r => r.id === b.id);
    expect((row?.usage as any)?.tag).toBe('token:sk-ant-oat01-SNAPB');

    await accounts.removeAccount('claude', b.id);
  });

  it('reports unsupported agents without probing', async () => {
    usageMocks.claudeNativeUsage.mockClear();
    const snap = await accounts.getAccountsUsageSnapshot('codex');
    expect(snap).toEqual({ supported: false, activeAccountId: null, accounts: [], native: null });
    expect(usageMocks.claudeNativeUsage).not.toHaveBeenCalled();
  });
});
