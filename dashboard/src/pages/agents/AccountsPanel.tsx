import { useCallback, useEffect, useState } from 'react';
import { api, type AgentAccountInfo } from '../../api';
import { Button, Input, Label, Spinner } from '../../components/ui';
import { UsageBars } from '../../components/UsageBars';
import { useStore } from '../../store';

// Per-agent local subscription accounts. Each account is a named `claude setup-token` token;
// switching the active account injects it as CLAUDE_CODE_OAUTH_TOKEN for new turns (the agent
// keeps using its normal config home). Shown as a click-to-switch card grid on the claude
// agent config page.
type FormState = { mode: 'add' | 'token'; id?: string; label: string; token: string; saving: boolean };
type L = (zh: string, en: string) => string;

export function AccountsPanel({ agentId }: { agentId: string }) {
  const locale = useStore(s => s.locale);
  const toast = useStore(s => s.toast);
  const agentStatus = useStore(s => s.agentStatus);
  const L: L = (zh, en) => (locale === 'en' ? en : zh);
  // The default-login card shows the machine's native (non-token) usage, sourced from the same
  // agent-status feed the header/agent list use.
  const nativeUsage = agentStatus?.agents?.find(a => a.agent === agentId)?.usage ?? null;

  const [accounts, setAccounts] = useState<AgentAccountInfo[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [max, setMax] = useState(5);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; label: string } | null>(null);
  const [form, setForm] = useState<FormState | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await api.getAgentAccounts(agentId);
      if (r.ok) { setAccounts(r.accounts); setActiveId(r.activeAccountId); setMax(r.max); }
    } catch (e: any) {
      toast(String(e?.message || e), false);
    } finally {
      setLoading(false);
    }
  }, [agentId, toast]);

  useEffect(() => { void refresh(); }, [refresh]);

  const submitForm = useCallback(async () => {
    if (!form) return;
    setForm(f => (f ? { ...f, saving: true } : f));
    try {
      if (form.mode === 'add') {
        const r = await api.addAgentAccount(agentId, form.label, form.token);
        if (!r.ok) throw new Error(r.error || 'add failed');
        toast(L('账号已添加', 'Account added'));
      } else {
        const r = await api.updateAgentAccount(agentId, form.id!, { token: form.token });
        if (!r.ok) throw new Error(r.error || 'update failed');
        toast(L('Token 已更新', 'Token updated'));
      }
      setForm(null);
      await refresh();
    } catch (e: any) {
      toast(String(e?.message || e), false);
      setForm(f => (f ? { ...f, saving: false } : f));
    }
  }, [agentId, form, refresh, toast]);

  const setActive = useCallback(async (id: string | null) => {
    setBusy(id || '__clear__');
    try {
      const r = await api.setActiveAgentAccount(agentId, id);
      if (!r.ok) throw new Error(r.error || 'switch failed');
      setActiveId(id);
      toast(id ? L('已设为当前账号', 'Set as active account') : L('已清除当前账号', 'Cleared active account'));
    } catch (e: any) {
      toast(String(e?.message || e), false);
    } finally {
      setBusy(null);
    }
  }, [agentId, toast]);

  const saveRename = useCallback(async () => {
    if (!editing) return;
    setBusy(editing.id);
    try {
      const r = await api.updateAgentAccount(agentId, editing.id, { label: editing.label });
      if (!r.ok) throw new Error(r.error || 'rename failed');
      setEditing(null);
      await refresh();
    } catch (e: any) {
      toast(String(e?.message || e), false);
    } finally {
      setBusy(null);
    }
  }, [agentId, editing, refresh, toast]);

  const remove = useCallback(async (id: string) => {
    if (!window.confirm(L('删除该账号？其保存的 token 会被一并移除。', 'Delete this account? Its stored token will be removed too.'))) return;
    setBusy(id);
    try {
      const r = await api.removeAgentAccount(agentId, id);
      if (!r.ok) throw new Error(r.error || 'remove failed');
      await refresh();
    } catch (e: any) {
      toast(String(e?.message || e), false);
    } finally {
      setBusy(null);
    }
  }, [agentId, refresh, toast]);

  const tokenHint = (
    <div className="text-[11px] leading-relaxed text-fg-4">
      {L('在你的终端运行下面的命令（需 Claude 订阅，会打开浏览器授权），把打印出来的 token 粘到下方：',
         'Run this in your terminal (needs a Claude subscription; opens a browser), then paste the printed token below:')}
      <code className="mt-1 block w-fit select-all rounded bg-black/40 px-2 py-1 font-mono text-[11px] text-fg-3">claude setup-token</code>
    </div>
  );

  // One consistent switch control for every card: active → a selected accent chip, inactive →
  // a "use this" button. Same size/shape/position so the cards read as a uniform radio group.
  const switchControl = (active: boolean, label: string, onSwitch: () => void, pending: boolean) =>
    active ? (
      <div className="flex h-8 w-full items-center justify-center gap-1.5 rounded-md border border-[var(--th-accent)]/70 bg-[var(--th-accent)]/15 text-[12px] font-medium text-[var(--th-accent)]">
        ✓ {L('当前账号', 'Active')}
      </div>
    ) : (
      <Button variant="secondary" size="sm" className="h-8 w-full" onClick={onSwitch} disabled={pending}>
        {pending && <Spinner className="h-3 w-3" />}{label}
      </Button>
    );

  return (
    <div className="rounded-lg border border-edge bg-panel-alt/50 p-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="text-[12px] font-medium text-fg-2">{L('本地账号', 'Local accounts')}</div>
          <div className="mt-0.5 text-[11px] leading-relaxed text-fg-5">
            {L('点账号上的「切换到此账号」设为当前账号；新会话/轮次以该账号运行（仅在未绑定 BYOK 模型时生效）。',
               'Use an account’s “Use this account” button to make it active; new sessions/turns run under it (applies when no BYOK profile is bound).')}
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setForm({ mode: 'add', label: '', token: '', saving: false })}
          disabled={!!form || accounts.length >= max}
        >
          {L('添加账号', 'Add account')}
        </Button>
      </div>

      {form?.mode === 'add' && (
        <div className="mt-3 space-y-2 rounded-md border border-edge bg-panel p-3">
          {tokenHint}
          <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
            <div>
              <Label className="!mb-1 text-[11px]">{L('名称', 'Name')}</Label>
              <Input value={form.label} onChange={e => setForm(f => (f ? { ...f, label: e.target.value } : f))} placeholder={L('如：工作号', 'e.g. Work')} className="h-7 text-[12px]" />
            </div>
            <div>
              <Label className="!mb-1 text-[11px]">Token</Label>
              <Input value={form.token} onChange={e => setForm(f => (f ? { ...f, token: e.target.value } : f))} placeholder="sk-ant-oat01-…" className="h-7 font-mono text-[12px]" />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="primary" size="sm" onClick={() => void submitForm()} disabled={form.saving || !form.label.trim() || !form.token.trim()}>
              {form.saving && <Spinner className="h-3 w-3" />}{L('保存', 'Save')}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setForm(null)}>{L('取消', 'Cancel')}</Button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="mt-3 flex items-center gap-2 text-[12px] text-fg-5"><Spinner className="h-3 w-3" />{L('加载中…', 'Loading…')}</div>
      ) : accounts.length === 0 && form?.mode !== 'add' ? (
        <div className="mt-3 rounded-md border border-dashed border-edge px-3 py-3 text-center text-[12px] text-fg-5">
          {L('还没有账号。点击「添加账号」，命名并粘贴 setup-token。', 'No accounts yet. Click "Add account", name it, and paste a setup-token.')}
        </div>
      ) : (
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {accounts.map(acc => {
            const isActive = acc.id === activeId;
            const rowBusy = busy === acc.id;
            const isEditing = editing?.id === acc.id;
            const tokenFormOpen = form?.mode === 'token' && form.id === acc.id;
            return (
              <div
                key={acc.id}
                className="flex flex-col gap-2 rounded-lg border border-edge bg-panel p-3"
              >
                {isEditing ? (
                  <Input
                    value={editing!.label}
                    onChange={e => setEditing({ id: acc.id, label: e.target.value })}
                    onKeyDown={e => { if (e.key === 'Enter') void saveRename(); if (e.key === 'Escape') setEditing(null); }}
                    autoFocus
                    className="h-7 text-[12px]"
                  />
                ) : (
                  <span className="truncate text-[13px] font-medium text-fg-2" title={acc.label}>{acc.label}</span>
                )}

                <UsageBars usage={acc.usage} emptyText={L('用量查询中，稍后自动刷新', 'Usage pending — refreshes shortly')} />

                {tokenFormOpen && (
                  <div className="space-y-2 rounded-md border border-edge bg-black/20 p-2">
                    {tokenHint}
                    <Input value={form!.token} onChange={e => setForm(f => (f ? { ...f, token: e.target.value } : f))} placeholder="sk-ant-oat01-…" className="h-7 font-mono text-[12px]" />
                    <div className="flex items-center gap-2">
                      <Button variant="primary" size="sm" onClick={() => void submitForm()} disabled={form!.saving || !form!.token.trim()}>{form!.saving && <Spinner className="h-3 w-3" />}{L('更新 token', 'Update')}</Button>
                      <Button variant="ghost" size="sm" onClick={() => setForm(null)}>{L('取消', 'Cancel')}</Button>
                    </div>
                  </div>
                )}

                {isEditing ? (
                  <div className="mt-auto flex items-center gap-1.5">
                    <Button variant="primary" size="sm" className="h-8 flex-1" onClick={() => void saveRename()} disabled={rowBusy}>{rowBusy && <Spinner className="h-3 w-3" />}{L('保存', 'Save')}</Button>
                    <Button variant="ghost" size="sm" className="h-8" onClick={() => setEditing(null)}>{L('取消', 'Cancel')}</Button>
                  </div>
                ) : (
                  <div className="mt-auto flex flex-col gap-1.5">
                    <div className="flex items-center justify-between text-[11px] text-fg-5">
                      <button type="button" className="hover:text-fg-3" onClick={() => setEditing({ id: acc.id, label: acc.label })}>{L('重命名', 'Rename')}</button>
                      <button type="button" className="hover:text-fg-3" onClick={() => setForm({ mode: 'token', id: acc.id, label: acc.label, token: '', saving: false })} disabled={!!form}>{L('换 token', 'Replace token')}</button>
                      <button type="button" className="hover:text-[var(--th-badge-err-text)]" onClick={() => void remove(acc.id)} disabled={rowBusy}>{L('删除', 'Delete')}</button>
                    </div>
                    {switchControl(isActive, L('切换到此账号', 'Use this account'), () => void setActive(acc.id), rowBusy)}
                  </div>
                )}
              </div>
            );
          })}

          {accounts.length > 0 && (
            <div className="flex flex-col gap-2 rounded-lg border border-dashed border-edge bg-panel p-3">
              <span className="truncate text-[13px] font-medium text-fg-3">{L('默认登录', 'Default login')}</span>
              <UsageBars usage={nativeUsage} emptyText={L('本机默认登录额度', 'Default-login quota')} />
              <div className="mt-auto">
                {switchControl(!activeId, L('切换到默认登录', 'Use default login'), () => void setActive(null), busy === '__clear__')}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
