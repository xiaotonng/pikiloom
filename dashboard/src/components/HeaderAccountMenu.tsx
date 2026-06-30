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
  const closeTimer = useRef<number | null>(null);

  const load = async () => { try { const r = await api.getAgentAccounts(agent); if (r.ok) setData(r); } catch { /* ignore */ } };
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [agent]);
  useEffect(() => () => { if (closeTimer.current) window.clearTimeout(closeTimer.current); }, []);

  const accounts = data?.accounts ?? [];
  const activeId = data?.activeAccountId ?? null;
  const active = accounts.find(a => a.id === activeId) || null;
  // Data-freshness stamp (restored from the old read-only usage tooltip). Every usage here is
  // fetched in the same pass, so the freshest capturedAt stands for the whole popover — one
  // line beats repeating an identical timestamp under each account.
  const capturedIso = [nativeUsage, ...accounts.map(a => a.usage)]
    .map(u => u?.capturedAt)
    .filter((iso): iso is string => !!iso)
    .reduce<string | null>((best, iso) => (best && best > iso ? best : iso), null);
  const capturedLabel = capturedIso ? formatCapturedAt(capturedIso) : null;
  // The ring + hover detail track whichever identity is actually in effect.
  const ringUsage = (active && active.usage?.ok) ? active.usage : nativeUsage;
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

  const openNow = () => { if (closeTimer.current) { window.clearTimeout(closeTimer.current); closeTimer.current = null; } setOpen(true); void load(); void refreshAgentStatus(); };
  const closeSoon = () => { if (closeTimer.current) window.clearTimeout(closeTimer.current); closeTimer.current = window.setTimeout(() => setOpen(false), 160); };

  const switchTo = async (id: string | null) => {
    setBusy(true);
    try {
      const r = await api.setActiveAgentAccount(agent, id);
      if (!r.ok) throw new Error(r.error || 'switch failed');
      await load();
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
            {busy && <span className="text-[10px] text-fg-5">{L('切换中…', 'Switching…')}</span>}
          </div>
          {accounts.map(a => row(a.id, a.label, a.id === activeId, a.usage, () => void switchTo(a.id), L('用量查询中…', 'Usage pending…')))}
          <div className="my-1 border-t border-edge/60" />
          {row('__default__', L('默认登录', 'Default login'), !activeId, nativeUsage, () => void switchTo(null), L('本机默认登录额度', 'Default-login quota'))}
          {capturedLabel && (
            <div className="px-1.5 pb-0.5 pt-1.5 text-right text-[10px] text-fg-5">{t('usage.asOf')} {capturedLabel}</div>
          )}
        </div>
      )}
    </div>
  );
}
