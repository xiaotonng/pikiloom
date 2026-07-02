import { Hono } from 'hono';
import { allDriverIds } from '../../agent/index.js';
import {
  accountAgentSupported, getAccount, addAccount, updateAccount, removeAccount,
  getActiveAccountId, setActiveAccount, probeAccountUsage, getAccountsUsageSnapshot,
  MAX_ACCOUNTS_PER_AGENT,
  type AgentAccountRecord,
} from '../../agent/accounts.js';
import { invalidateAgentStatus } from './agents.js';

const app = new Hono();

function agentError(agent: string): { status: 400; msg: string } | null {
  if (!allDriverIds().includes(agent)) return { status: 400, msg: `Unknown agent: ${agent}` };
  if (!accountAgentSupported(agent)) return { status: 400, msg: `Agent ${agent} does not support multiple accounts` };
  return null;
}

// Never returns the token — only the display name, usage, and active flag.
async function publicAccount(agent: string, rec: AgentAccountRecord, activeId: string | null) {
  return {
    id: rec.id,
    label: rec.label,
    createdAt: rec.createdAt,
    lastUsedAt: rec.lastUsedAt ?? null,
    active: rec.id === activeId,
    usage: await probeAccountUsage(agent, rec.id),
  };
}

app.get('/api/agents/:agent/accounts', async (c) => {
  const agent = c.req.param('agent');
  if (!allDriverIds().includes(agent)) return c.json({ ok: false, error: `Unknown agent: ${agent}` }, 400);
  if (!accountAgentSupported(agent)) {
    return c.json({ ok: true, agent, supported: false, accounts: [], activeAccountId: null, nativeUsage: null, max: MAX_ACCOUNTS_PER_AGENT });
  }
  // `fresh=1` = the user is actively looking (popover open / panel refresh): re-probe past the
  // short fresh window. The min-interval debounce lives in the driver caches, so this is safe to
  // send on every hover. Account rows and the default-login quota come from the same pass.
  const fresh = c.req.query('fresh') === '1';
  const snap = await getAccountsUsageSnapshot(agent, { fresh });
  return c.json({
    ok: true, agent, supported: true,
    accounts: snap.accounts,
    activeAccountId: snap.activeAccountId,
    nativeUsage: snap.native,
    max: MAX_ACCOUNTS_PER_AGENT,
  });
});

app.post('/api/agents/:agent/accounts', async (c) => {
  const agent = c.req.param('agent');
  const err = agentError(agent);
  if (err) return c.json({ ok: false, error: err.msg }, err.status);
  let body: any = {};
  try { body = await c.req.json(); } catch { body = {}; }
  try {
    const rec = await addAccount(agent, String(body.label || ''), String(body.token || ''));
    return c.json({ ok: true, account: await publicAccount(agent, rec, getActiveAccountId(agent)) });
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message || String(e) }, 400);
  }
});

app.patch('/api/agents/:agent/accounts/:id', async (c) => {
  const agent = c.req.param('agent');
  const id = c.req.param('id');
  const err = agentError(agent);
  if (err) return c.json({ ok: false, error: err.msg }, err.status);
  if (!getAccount(agent, id)) return c.json({ ok: false, error: 'Account not found' }, 404);
  let body: any = {};
  try { body = await c.req.json(); } catch { body = {}; }
  try {
    const rec = await updateAccount(agent, id, {
      label: typeof body.label === 'string' ? body.label : undefined,
      token: typeof body.token === 'string' && body.token.trim() ? body.token : undefined,
    });
    return c.json({ ok: true, account: await publicAccount(agent, rec, getActiveAccountId(agent)) });
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message || String(e) }, 400);
  }
});

app.delete('/api/agents/:agent/accounts/:id', async (c) => {
  const agent = c.req.param('agent');
  const id = c.req.param('id');
  const err = agentError(agent);
  if (err) return c.json({ ok: false, error: err.msg }, err.status);
  if (!(await removeAccount(agent, id))) return c.json({ ok: false, error: 'Account not found' }, 404);
  return c.json({ ok: true });
});

app.post('/api/agents/:agent/active-account', async (c) => {
  const agent = c.req.param('agent');
  const err = agentError(agent);
  if (err) return c.json({ ok: false, error: err.msg }, err.status);
  let body: any = {};
  try { body = await c.req.json(); } catch { body = {}; }
  const accountId = body.accountId === null ? null : (typeof body.accountId === 'string' ? body.accountId : undefined);
  if (accountId === undefined) return c.json({ ok: false, error: 'accountId (string|null) is required' }, 400);
  try {
    setActiveAccount(agent, accountId);
    // The identity that drives usage just changed: drop the cached agent-status (its native /
    // default-login usage is now stale) and force-refresh the newly-active account's own usage,
    // so the header reflects the latest numbers immediately instead of the previous account's.
    if (accountId) await probeAccountUsage(agent, accountId, { force: true });
    await invalidateAgentStatus();
    return c.json({ ok: true, agent, activeAccountId: accountId });
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message || String(e) }, 400);
  }
});

export default app;
