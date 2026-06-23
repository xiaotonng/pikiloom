import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../store';
import { createT } from '../i18n';
import { Modal, ModalHeader, Button, Input } from './ui';
import { cn } from '../utils';
import { getEndpoint, setEndpoint, clearEndpoint, encodeCode, decodeCode, type ConnMode } from '../endpoint';

interface PairInfo { token?: string; nodeId?: string; rendezvous?: string | null; publicHost?: string | null; registered?: boolean }

function ModuleHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[13px] font-semibold tracking-tight text-fg">{title}</div>
      <div className="mt-0.5 text-[12px] leading-relaxed text-fg-5">{subtitle}</div>
    </div>
  );
}

export function ClientConnectionPanel({ active = true }: { active?: boolean }) {
  const locale = useStore(s => s.locale);
  const toast = useStore(s => s.toast);
  const t = useMemo(() => createT(locale), [locale]);

  const ep = getEndpoint();
  const [mode, setMode] = useState<ConnMode>(ep ? ep.mode : 'local');
  const [host, setHost] = useState(ep?.host || '');
  const [token, setToken] = useState(ep?.token || '');
  const [code, setCode] = useState('');

  useEffect(() => {
    if (!active) return;
    const e = getEndpoint();
    setMode(e ? e.mode : 'local'); setHost(e?.host || ''); setToken(e?.token || ''); setCode('');
  }, [active]);

  const connect = () => {
    if (mode === 'local') { clearEndpoint(); }
    else if (mode === 'direct') {
      if (!host.trim()) { toast(t('conn.needHost'), false); return; }
      setEndpoint({ host: host.trim(), token: token.trim() || undefined });
    } else {
      const d = decodeCode(code.trim());
      if (!d) { toast(t('conn.badCode'), false); return; }
      setEndpoint(d);
    }
    window.location.reload();
  };

  const MODES: Array<{ key: ConnMode; label: string; hint: string }> = [
    { key: 'local', label: t('conn.local'), hint: t('conn.localHint') },
    { key: 'direct', label: t('conn.direct'), hint: t('conn.directHint') },
    { key: 'remote', label: t('conn.remote'), hint: t('conn.remoteHint') },
  ];

  return (
    <div className="space-y-3">
      <ModuleHeader title={t('conn.clientTitle')} subtitle={t('conn.clientSubtitle')} />

      <div className="grid grid-cols-3 gap-2">
        {MODES.map(m => (
          <button
            key={m.key}
            onClick={() => setMode(m.key)}
            className={cn(
              'rounded-lg border p-2.5 text-left transition-colors',
              mode === m.key ? 'border-[var(--brand)] bg-[var(--surface-2)]' : 'border-[var(--edge-default)] hover:border-[var(--edge-strong)]',
            )}
          >
            <div className="text-[13px] font-semibold text-fg">{m.label}</div>
            <div className="mt-0.5 text-[11px] leading-snug text-fg-5">{m.hint}</div>
          </button>
        ))}
      </div>

      <div className="space-y-2">
        {mode === 'direct' && (
          <>
            <Input tone="inset" value={host} onChange={e => setHost(e.target.value)} placeholder={t('conn.hostPh')} />
            <Input tone="inset" value={token} onChange={e => setToken(e.target.value)} placeholder={t('conn.tokenPh')} />
          </>
        )}
        {mode === 'remote' && (
          <Input tone="inset" value={code} onChange={e => setCode(e.target.value)} placeholder={t('conn.codePh')} />
        )}
        {mode === 'local' && (
          <div className="text-[12px] text-fg-4">{t('conn.localBody')}</div>
        )}
      </div>

      <div className="flex justify-end">
        <Button variant="primary" size="sm" onClick={connect}>{t('conn.connect')}</Button>
      </div>
    </div>
  );
}

export function ServerConfigPanel({ active = true }: { active?: boolean }) {
  const locale = useStore(s => s.locale);
  const toast = useStore(s => s.toast);
  const t = useMemo(() => createT(locale), [locale]);

  const [pair, setPair] = useState<PairInfo | null>(null);
  const [rdvUrl, setRdvUrl] = useState('');
  const [publicHost, setPublicHost] = useState('');
  const [savingRemote, setSavingRemote] = useState(false);

  useEffect(() => {
    if (!active) return;
    fetch('/pikichannel/pair').then(r => (r.ok ? r.json() : null)).then((j) => {
      if (j?.ok) { setPair(j); setRdvUrl(j.rendezvous || ''); setPublicHost(j.publicHost || ''); }
    }).catch(() => {  });
  }, [active]);

  const shareCode = pair
    ? encodeCode(
        publicHost.trim()
          ? { host: publicHost.trim(), token: pair.token }
          : (pair.registered && pair.rendezvous && pair.nodeId)
            ? { rendezvous: pair.rendezvous, nodeId: pair.nodeId, token: pair.token }
            : { token: pair.token })
    : '';

  const savePublicHost = async () => {
    setSavingRemote(true);
    try {
      const r = await fetch('/pikichannel/remote', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ publicHost: publicHost.trim() }),
      }).then(res => res.json());
      if (r.ok) setPair(p => ({ ...(p || {}), publicHost: r.publicHost || '' }));
    } catch {  }
    finally { setSavingRemote(false); }
  };

  const copy = async (text: string) => {
    if (!text) return;
    try { await navigator.clipboard.writeText(text); toast(t('conn.copied')); } catch { toast(t('conn.copyFail'), false); }
  };

  const toggleRemote = async (enabled: boolean) => {
    if (enabled && !rdvUrl.trim()) { toast(t('conn.needRdv'), false); return; }
    setSavingRemote(true);
    try {
      const r = await fetch('/pikichannel/remote', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled, rendezvous: rdvUrl.trim() }),
      }).then(res => res.json());
      if (r.ok) { setPair(p => ({ ...(p || {}), registered: !!r.registered, rendezvous: r.rendezvous || '' })); toast(enabled ? t('conn.remoteOn') : t('conn.remoteOff')); }
      else toast(r.error || t('conn.remoteFail'), false);
    } catch { toast(t('conn.remoteFail'), false); }
    finally { setSavingRemote(false); }
  };

  return (
    <div className="space-y-3">
      <ModuleHeader title={t('conn.serverTitle')} subtitle={t('conn.serverSubtitle')} />

      {pair ? (
        <div className="space-y-3">
          <div className="space-y-1">
            <Input tone="inset" value={publicHost} onChange={e => setPublicHost(e.target.value)} onBlur={savePublicHost} placeholder={t('conn.publicHostPh')} disabled={savingRemote} />
            <div className="text-[11px] text-fg-5">{t('conn.publicHostHint')}</div>
          </div>
          <label className="flex items-center gap-2 text-[13px] text-fg-2">
            <input
              type="checkbox"
              checked={!!pair.registered}
              disabled={savingRemote}
              onChange={e => toggleRemote(e.target.checked)}
            />
            {t('conn.enableRemote')}
          </label>
          <Input tone="inset" value={rdvUrl} onChange={e => setRdvUrl(e.target.value)} placeholder={t('conn.rdvPh')} disabled={savingRemote} />
          <div className="flex items-center gap-2">
            <Input tone="inset" readOnly value={shareCode} className="font-mono text-[11px]" />
            <Button variant="outline" size="sm" onClick={() => copy(shareCode)}>{t('conn.copyCode')}</Button>
          </div>
          {shareCode && (
            <div className="flex items-center gap-3 pt-0.5">
              <img src={`/pikichannel/qr?data=${encodeURIComponent(shareCode)}`} alt="QR" width={116} height={116} className="shrink-0 rounded-md bg-white p-2" />
              <div className="text-[11px] leading-relaxed text-fg-5">{t('conn.scan')}</div>
            </div>
          )}
          <div className="text-[11px] text-fg-5">{t('conn.shareFoot')}</div>
        </div>
      ) : (
        <div className="text-[12px] text-fg-5">{t('conn.shareUnavailable')}</div>
      )}
    </div>
  );
}

export function ConnectionModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const locale = useStore(s => s.locale);
  const t = useMemo(() => createT(locale), [locale]);
  return (
    <Modal open={open} onClose={onClose} size="md">
      <ModalHeader title={t('conn.title')} description={t('conn.subtitle')} onClose={onClose} />
      <ClientConnectionPanel active={open} />
      <div className="mt-6 border-t border-edge pt-4">
        <ServerConfigPanel active={open} />
      </div>
    </Modal>
  );
}
