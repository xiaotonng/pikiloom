import { useEffect, useRef, useState } from 'react';
import { api, type AgentAccountsResponse } from '../api';
import type { UsageResult } from '../types';
import { useStore } from '../store';
import { getAgentMeta } from '../utils';
import { formatCapturedAt, usageGauge, usageWindowTone, type UsageGauge } from '../usage';
import { BrandIcon } from './BrandIcon';
import { Tooltip } from './ui';
import { UsageRing } from './UsageRing';
import { UsageBars } from './UsageBars';
import { UsageTooltipContent } from './UsageTooltip';

// Top-bar usage + account control for an account-capable agent (claude). With NO local accounts
// it is identical to the read-only usage ring every other agent uses (hover → detail). Once
// accounts exist, hovering opens an INTERACTIVE popover (same width/style as that tooltip) that
// lists every account with its usage and lets you switch — no click needed to open.
export function HeaderAccountMenu({ agent, nativeGauge, nativeUsage, t }: {
  agent: string;
  nativeGauge: UsageGauge | null;
  nativeUsage: UsageResult | null;
  t: (key: string) => string;
}) {
  const locale = useStore(s => s.locale);
  const toast = useStore(s => s.toast);
  const refreshAgentStatus = useStore(s => s.refreshAgentStatus);
  const L = (zh: string, en: string) => (locale === 'en' ? en : zh);

  const [open, setOpen] = useState(false);
  const [data, setData] = useState<AgentAccountsResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const closeTimer = useRef<number | null>(null);

  // `fresh` = the user is actively looking (popover open / just switched): the backend re-probes
  // past its short fresh window. Debounce lives server-side, so firing on every hover is safe.
  const load = async (fresh = false) => { try { const r = await api.getAgentAccounts(agent, { fresh }); if (r.ok) setData(r); } catch { /* ignore */ } };
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [agent]);
  useEffect(() => () => { if (closeTimer.current) window.clearTimeout(closeTimer.current); }, []);

  // Explicit refresh (the ↻ button): `force` bypasses the backend failure backoff, so rows a
  // rate-limited probe pinned at last-good get a real retry. Click-only — hover keeps `fresh`.
  const forceRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const r = await api.getAgentAccounts(agent, { force: true });
      if (r.ok) setData(r);
      void refreshAgentStatus();
    } catch { /* ignore */ } finally { setRefreshing(false); }
  };

  const accounts = data?.accounts ?? [];
  const activeId = data?.activeAccountId ?? null;
  const active = accounts.find(a => a.id === activeId) || null;
  // Default-login quota from the same unified pass as the account rows; the agent-status prop is
  // only the pre-load / non-account fallback.
  const defaultLoginUsage = data?.nativeUsage ?? nativeUsage;
  // Data-freshness stamp: all rows come from one pass now, so one line stands for the popover.
  // Use the OLDEST capturedAt — if any row lagged (probe failure serving last-good), the stamp
  // must own up to it instead of advertising the freshest row's time.
  const capturedIso = [defaultLoginUsage, ...accounts.map(a => a.usage)]
    .map(u => u?.capturedAt)
    .filter((iso): iso is string => !!iso)
    .reduce<string | null>((oldest, iso) => (oldest && oldest < iso ? oldest : iso), null);
  const capturedLabel = capturedIso ? formatCapturedAt(capturedIso) : null;
  // The ring + hover detail track whichever identity is actually in effect.
  const ringUsage = (active && active.usage?.ok) ? active.usage : defaultLoginUsage;
  const ringGauge = usageGauge(ringUsage) || nativeGauge;
  const meta = getAgentMeta(agent);
  const ring = ringGauge && (
    <UsageRing
      percent={ringGauge.primary.usedPercent ?? 0}
      tone={usageWindowTone(ringGauge.primary)}
      trackTone={ringGauge.secondaryTone ?? undefined}
      alert={ringGauge.secondaryAlert}
      size={13}
    />
  );

  // No accounts configured → identical to the original read-only usage ring (hover for detail).
  if (accounts.length === 0) {
    if (!ringGauge) return null;
    return (
      <Tooltip
        content={<UsageTooltipContent usage={ringUsage} t={t} title={`${meta.label} · ${t('usage.accountQuota')}`} />}
        onShow={() => void refreshAgentStatus()}
        className="cursor-default items-center gap-1"
      >
        <BrandIcon brand={agent} size={12} />
        {ring}
      </Tooltip>
    );
  }

  const openNow = () => { if (closeTimer.current) { window.clearTimeout(closeTimer.current); closeTimer.current = null; } setOpen(true); void load(true); void refreshAgentStatus(); };
  const closeSoon = () => { if (closeTimer.current) window.clearTimeout(closeTimer.current); closeTimer.current = window.setTimeout(() => setOpen(false), 160); };

  const switchTo = async (id: string | null) => {
    setBusy(true);
    try {
      const r = await api.setActiveAgentAccount(agent, id);
      if (!r.ok) throw new Error(r.error || 'switch failed');
      await load(true);
      await refreshAgentStatus();
      toast(id ? L('已切换账号', 'Account switched') : L('已用默认登录', 'Using default login'));
    } catch (e: any) {
      toast(String(e?.message || e), false);
    } finally {
      setBusy(false);
    }
  };

  const row = (key: string, label: string, isActive: boolean, usage: UsageResult | null, onClick: () => void, emptyText: string) => (
    <button
      key={key}
      type="button"
      disabled={busy || isActive}
      onClick={onClick}
      className={`group flex w-full flex-col gap-1 rounded-md px-1.5 py-1.5 text-left transition-colors ${isActive ? 'bg-[var(--th-accent)]/10' : 'hover:bg-white/5'}`}
    >
      <span className="flex items-center gap-1.5">
        <span className={`flex-1 truncate text-[12px] font-medium ${isActive ? 'text-[var(--th-accent)]' : 'text-fg-2'}`}>{label}</span>
        {isActive ? (
          <span className="shrink-0 text-[11px] font-semibold text-[var(--th-accent)]">✓ {L('当前', 'Active')}</span>
        ) : (
          <span className="shrink-0 text-[11px] font-medium text-[var(--th-accent)] opacity-0 transition-opacity duration-150 group-hover:opacity-100">{L('切换', 'Switch')} →</span>
        )}
      </span>
      <UsageBars usage={usage} emptyText={emptyText} />
    </button>
  );

  return (
    <div className="relative" onMouseEnter={openNow} onMouseLeave={closeSoon}>
      <div
        className="flex cursor-default items-center gap-1 rounded-md px-1 py-0.5"
        title={`${meta.label} · ${L('悬停查看并切换账号', 'hover to view & switch accounts')}`}
      >
        <BrandIcon brand={agent} size={12} />
        {ring}
        {active && <span className="max-w-[84px] truncate text-[10px] text-fg-4">{active.label}</span>}
      </div>

      {open && (
        <div className="absolute right-0 top-full z-[240] mt-1 w-[248px] animate-in rounded-lg border border-edge/40 bg-[var(--th-dropdown)] p-1.5 text-fg-3 shadow-lg backdrop-blur-xl">
          <div className="flex items-center justify-between px-1.5 pb-1 pt-0.5">
            <span className="text-[10px] uppercase tracking-wide text-fg-5">{meta.label} · {L('账号', 'Accounts')}</span>
            <span className="flex items-center gap-1">
              {busy && <span className="text-[10px] text-fg-5">{L('切换中…', 'Switching…')}</span>}
              <button
                type="button"
                disabled={refreshing}
                onClick={() => void forceRefresh()}
                title={t('usage.refresh')}
                className={`rounded p-0.5 text-fg-5 transition-colors hover:bg-white/5 hover:text-fg-3 ${refreshing ? 'pointer-events-none opacity-70' : ''}`}
              >
                <svg
                  width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                  className={refreshing ? 'animate-spin' : ''}
                  style={refreshing ? { animationDuration: '1s' } : undefined}
                >
                  <polyline points="23 4 23 10 17 10" />
                  <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                </svg>
              </button>
            </span>
          </div>
          {accounts.map(a => row(a.id, a.label, a.id === activeId, a.usage, () => void switchTo(a.id), L('用量查询中…', 'Usage pending…')))}
          <div className="my-1 border-t border-edge/60" />
          {row('__default__', L('默认登录', 'Default login'), !activeId, defaultLoginUsage, () => void switchTo(null), L('本机默认登录额度', 'Default-login quota'))}
          {capturedLabel && (
            <div className="px-1.5 pb-0.5 pt-1.5 text-right text-[10px] text-fg-5">{t('usage.asOf')} {capturedLabel}</div>
          )}
        </div>
      )}
    </div>
  );
}
