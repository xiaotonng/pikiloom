// Multi-account store (app layer): local subscription accounts for an agent, switched by
// injecting a long-lived auth token at spawn. Each account = a user-named token (minted via
// `claude setup-token`), stored in the credential vault (not plaintext). The agent keeps
// using its normal single config home; only CLAUDE_CODE_OAUTH_TOKEN changes.
//
// claude only for now — codex has no token-based switch (see kernel accounts.ts).

import { randomUUID } from 'node:crypto';
import { loadUserConfig, saveUserConfig } from '../core/config/user-config.js';
import { persistSecret, forgetSecret, resolveCredential, isCredentialRef, type CredentialRef } from '../core/secrets/index.js';
import { loadKernel } from './kernel-bridge.js';
import { claudeUsageForToken } from './drivers/claude.js';
import type { UsageResult } from './types.js';
import { agentWarn } from './utils.js';

export interface AgentAccountRecord {
  id: string;
  label: string;
  credential: CredentialRef;
  createdAt: string;
  lastUsedAt?: string | null;
}

interface AccountsLayer {
  byAgent?: Record<string, AgentAccountRecord[]>;
  activeByAgent?: Record<string, string | null>;
}

// Agents whose local accounts are switched by a token (kept in sync with the kernel).
const ACCOUNT_AGENTS = new Set(['claude']);
export const MAX_ACCOUNTS_PER_AGENT = 5;
const TOKEN_RE = /^sk-ant-oat/;

export function accountAgentSupported(agent: string): boolean {
  return ACCOUNT_AGENTS.has(agent);
}

function getLayer(): AccountsLayer {
  return (loadUserConfig().accounts as AccountsLayer) || {};
}
function writeLayer(layer: AccountsLayer): void {
  saveUserConfig({ ...loadUserConfig(), accounts: layer });
}

// Only records that carry a resolvable credential are real accounts; this also drops stale
// records from the earlier config-directory implementation (which had no credential).
function validRecords(agent: string): AgentAccountRecord[] {
  return (getLayer().byAgent?.[agent] || []).filter(r => r && isCredentialRef((r as any).credential));
}

export function listAccounts(agent: string): AgentAccountRecord[] {
  return validRecords(agent).slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
export function getAccount(agent: string, id: string): AgentAccountRecord | null {
  return validRecords(agent).find(a => a.id === id) || null;
}

export async function addAccount(agent: string, label: string, token: string): Promise<AgentAccountRecord> {
  if (!accountAgentSupported(agent)) throw new Error(`Agent ${agent} does not support multiple accounts`);
  const name = (label || '').trim();
  if (!name) throw new Error('Account name is required');
  const t = (token || '').trim();
  if (!TOKEN_RE.test(t)) throw new Error('Expected a token starting with "sk-ant-oat" (the output of `claude setup-token`)');
  const existing = listAccounts(agent);
  if (existing.length >= MAX_ACCOUNTS_PER_AGENT) throw new Error(`At most ${MAX_ACCOUNTS_PER_AGENT} accounts per agent`);

  const id = randomUUID().slice(0, 8);
  const credential = await persistSecret(`account/${agent}/${id}`, t);
  const rec: AgentAccountRecord = { id, label: name, credential, createdAt: new Date().toISOString(), lastUsedAt: null };

  const layer = getLayer();
  const byAgent = { ...(layer.byAgent || {}) };
  byAgent[agent] = [...existing, rec];
  writeLayer({ ...layer, byAgent });
  return rec;
}

export async function updateAccount(
  agent: string,
  id: string,
  patch: { label?: string; token?: string; lastUsedAt?: string | null },
): Promise<AgentAccountRecord> {
  const list = listAccounts(agent);
  const idx = list.findIndex(a => a.id === id);
  if (idx < 0) throw new Error(`Account not found: ${id}`);
  const cur = list[idx];

  let credential = cur.credential;
  if (patch.token !== undefined) {
    const t = patch.token.trim();
    if (!TOKEN_RE.test(t)) throw new Error('Expected a token starting with "sk-ant-oat"');
    credential = await persistSecret(`account/${agent}/${id}`, t);
  }
  const next: AgentAccountRecord = {
    ...cur,
    credential,
    ...('label' in patch && patch.label !== undefined ? { label: patch.label.trim() || cur.label } : {}),
    ...('lastUsedAt' in patch ? { lastUsedAt: patch.lastUsedAt ?? null } : {}),
  };
  list[idx] = next;
  const layer = getLayer();
  writeLayer({ ...layer, byAgent: { ...(layer.byAgent || {}), [agent]: list } });
  return next;
}

export async function removeAccount(agent: string, id: string): Promise<boolean> {
  const rec = getAccount(agent, id);
  if (!rec) return false;
  const layer = getLayer();
  const byAgent = { ...(layer.byAgent || {}) };
  byAgent[agent] = listAccounts(agent).filter(a => a.id !== id);
  const activeByAgent = { ...(layer.activeByAgent || {}) };
  if (activeByAgent[agent] === id) activeByAgent[agent] = null;
  writeLayer({ ...layer, byAgent, activeByAgent });
  try { await forgetSecret(rec.credential); } catch { /* best-effort */ }
  return true;
}

export function getActiveAccountId(agent: string): string | null {
  const id = getLayer().activeByAgent?.[agent] || null;
  if (id && !getAccount(agent, id)) return null;
  return id;
}
export function setActiveAccount(agent: string, id: string | null): void {
  if (id && !getAccount(agent, id)) throw new Error(`Account not found: ${id}`);
  const layer = getLayer();
  writeLayer({ ...layer, activeByAgent: { ...(layer.activeByAgent || {}), [agent]: id } });
}

/**
 * Resolve the env to inject for a turn. Tri-state override (mirrors profileId):
 *   undefined -> use the agent's globally-active account
 *   null      -> no account (default login)
 *   <id>      -> that specific account
 */
export async function resolveAccountEnv(
  agent: string,
  accountIdOverride?: string | null,
): Promise<{ env: Record<string, string>; accountId: string } | null> {
  if (!accountAgentSupported(agent)) return null;
  const id = accountIdOverride === undefined ? getActiveAccountId(agent) : accountIdOverride;
  if (!id) return null;
  const rec = getAccount(agent, id);
  if (!rec) return null;
  let token = '';
  try { token = await resolveCredential(rec.credential); } catch (e: any) {
    agentWarn(`[account] could not resolve token for ${agent}/${id}: ${e?.message || e}`);
    return null;
  }
  if (!token) return null;
  const kernel = await loadKernel();
  const env = kernel.accountTokenEnv(agent, token) as Record<string, string>;
  return { env, accountId: id };
}

// Last-known per-account usage, kept so synchronous surfaces (the IM `/agents` view builder)
// can render usage without awaiting a probe. Filled whenever `probeAccountUsage` resolves.
const accountUsageById = new Map<string, UsageResult | null>();
const usageKey = (agent: string, id: string) => `${agent}/${id}`;

/** Best-effort per-account usage: read the account's quota from its token (see claudeUsageForToken). */
export async function probeAccountUsage(agent: string, id: string, opts?: { force?: boolean }): Promise<UsageResult | null> {
  if (agent !== 'claude') return null;
  const rec = getAccount(agent, id);
  if (!rec) return null;
  try {
    const token = await resolveCredential(rec.credential);
    const usage = token ? await claudeUsageForToken(token, opts) : null;
    accountUsageById.set(usageKey(agent, id), usage);
    return usage;
  } catch { return null; }
}

/** Synchronous read of the last-probed usage for an account (no network), or null. */
export function getCachedAccountUsage(agent: string, id: string): UsageResult | null {
  return accountUsageById.get(usageKey(agent, id)) ?? null;
}

/** Fire-and-forget refresh of every account's usage (cached + de-duped under the hood). */
export function warmAccountUsages(agent: string): void {
  if (!accountAgentSupported(agent)) return;
  for (const rec of listAccounts(agent)) void probeAccountUsage(agent, rec.id);
}

/** Compact "5h 100% · 7d 19%" summary from the cached usage, or null. */
export function accountUsageSummary(agent: string, id: string): string | null {
  const usage = getCachedAccountUsage(agent, id);
  if (!usage?.ok || !usage.windows.length) return null;
  const parts = usage.windows
    .filter(w => w.usedPercent != null)
    .map(w => `${w.label} ${Math.round(w.usedPercent as number)}%`);
  return parts.length ? parts.join(' · ') : null;
}
