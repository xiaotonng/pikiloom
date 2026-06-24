import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from '../../api';
import { useStore } from '../../store';
import type { Locale } from '../../i18n';
import type {
  LocalBackendStatus,
  LocalBackendOs,
  LocalModelCatalogEntry,
  OllamaLibModel,
  OllamaLibSize,
} from '../../types';
import { BrandIcon } from '../../components/BrandIcon';
import { Badge, Button, Spinner, Modal, ModalHeader } from '../../components/ui';
import { ActionBar } from '../shared';

const RAM_HEADROOM_GB = 4;

interface Copy {
  sectionLabel: string;
  hostLabel: string;
  hostUnknown: string;
  refresh: string;
  refreshing: string;
  loadFailed: string;

  tileStatusDetected: string;
  tileStatusNotDetected: string;
  tileStatusUnsupported: string;
  tileBadgeReady: (n: number) => string;
  tileBlurbOllama: string;
  tileBlurbMlx: string;
  tileInstalledModels: (n: number) => string;

  modalTitle: (label: string) => string;
  modalDescription: (label: string) => string;
  stepStatus: string;
  stepModels: string;

  statusRunning: string;
  statusNotRunning: string;
  statusUnsupportedDesc: (label: string) => string;
  statusRecheck: string;
  statusRechecking: string;
  statusInstallHeader: string;
  statusInstallDocs: string;
  statusRunHint: string;
  statusHomepageCta: string;
  statusAutoAttachedHint: (label: string) => string;

  modelsInstalledHeader: (n: number) => string;
  modelsInstalledEmpty: string;
  modelsRecommendedHeader: string;
  modelsBackendOffline: string;
  fitOk: string;
  fitTight: string;
  fitNoGo: string;
  modelInstalledBadge: string;
  pullPrefix: string;
  copyCommand: string;
  copied: string;

  libHeader: string;
  libVia: string;
  libLoading: string;
  libErrorFallback: string;
  libStale: string;
  libSearchPlaceholder: (total: number) => string;
  libClearSearch: string;
  libFitLabel: string;
  libFilterRunnable: string;
  libFilterAll: string;
  libCapsLabel: string;
  libShowing: (n: number) => string;
  libEmpty: string;
  libClearFilters: string;
  libPullsSuffix: string;
  libUpdatedPrefix: string;
  libSizeHint: string;
  libRetry: string;

  closeBtn: string;
}

function getCopy(locale: Locale): Copy {
  if (locale === 'zh-CN') {
    return {
      sectionLabel: '本地后端',
      hostLabel: '本机',
      hostUnknown: '检测中…',
      refresh: '刷新',
      refreshing: '刷新中…',
      loadFailed: '加载失败',

      tileStatusDetected: '已运行',
      tileStatusNotDetected: '未检测到',
      tileStatusUnsupported: '不支持当前系统',
      tileBadgeReady: n => `${n} 个模型已就绪`,
      tileBlurbOllama: '跨平台默认，CLI 友好，模型下载到本地后常驻',
      tileBlurbMlx: 'Apple Silicon 原生，性能压榨极限，按需启动',
      tileInstalledModels: n => `${n} 个模型`,

      modalTitle: label => `准备 ${label}`,
      modalDescription: label => `安装 ${label}、下载所需模型、核对运行状态——本地模型的全部配置都在这里完成。`,
      stepStatus: '后端状态',
      stepModels: '模型',

      statusRunning: '已运行',
      statusNotRunning: '未在本机检测到此后端',
      statusUnsupportedDesc: label => `${label} 不支持当前系统。`,
      statusRecheck: '重新检测',
      statusRechecking: '检测中…',
      statusInstallHeader: '安装命令',
      statusInstallDocs: '官方安装文档',
      statusRunHint: '启动服务（安装后）',
      statusHomepageCta: '官网',
      statusAutoAttachedHint: label => `本地 ${label} 已在运行；继续在下方下载并核对所需模型。`,

      modelsInstalledHeader: n => `已就绪（${n}）`,
      modelsInstalledEmpty: '后端在线，但尚未加载任何模型。在终端按下方命令准备一个。',
      modelsRecommendedHeader: '推荐模型 · 在终端执行以下命令准备',
      modelsBackendOffline: '启动后端后再返回此处准备模型。',
      fitOk: '推荐',
      fitTight: '勉强可跑',
      fitNoGo: '内存不足',
      modelInstalledBadge: '已就绪',
      pullPrefix: '终端执行',
      copyCommand: '复制',
      copied: '已复制',

      libHeader: '可下载模型',
      libVia: '来自 ollama.com 模型库',
      libLoading: '正在从 Ollama 模型库加载…',
      libErrorFallback: '无法连接 Ollama 模型库，已回退到内置推荐清单。',
      libStale: '展示的是缓存列表（最近一次刷新失败）。',
      libSearchPlaceholder: total => `在 ${total} 个模型中搜索，如 qwen、coder、vision…`,
      libClearSearch: '清除搜索',
      libFitLabel: '内存',
      libFilterRunnable: '本机可跑',
      libFilterAll: '全部',
      libCapsLabel: '能力',
      libShowing: n => `显示 ${n} 个模型`,
      libEmpty: '没有符合条件的模型。',
      libClearFilters: '清除筛选',
      libPullsSuffix: '次下载',
      libUpdatedPrefix: '更新于',
      libSizeHint: '点击尺寸复制 pull 命令',
      libRetry: '重试',

      closeBtn: '完成',
    };
  }
  return {
    sectionLabel: 'Local backends',
    hostLabel: 'This machine',
    hostUnknown: 'Detecting…',
    refresh: 'Refresh',
    refreshing: 'Refreshing…',
    loadFailed: 'Failed to load local backends',

    tileStatusDetected: 'Running',
    tileStatusNotDetected: 'Not detected',
    tileStatusUnsupported: 'Not supported on this OS',
    tileBadgeReady: n => `${n} models ready`,
    tileBlurbOllama: 'Cross-platform default, CLI-friendly, models persist on disk',
    tileBlurbMlx: 'Apple Silicon native, peak performance, on-demand launch',
    tileInstalledModels: n => `${n} models`,

    modalTitle: label => `Prepare ${label}`,
    modalDescription: label => `Install ${label}, download the models you want, and verify they're running — all the local-model configuration lives in this panel.`,
    stepStatus: 'Backend status',
    stepModels: 'Models',

    statusRunning: 'Running',
    statusNotRunning: 'Backend not detected on this machine',
    statusUnsupportedDesc: label => `${label} does not run on this OS.`,
    statusRecheck: 'Re-check',
    statusRechecking: 'Checking…',
    statusInstallHeader: 'Install commands',
    statusInstallDocs: 'Official install docs',
    statusRunHint: 'Start the server (after install)',
    statusHomepageCta: 'Homepage',
    statusAutoAttachedHint: label => `Local ${label} is running. Continue below to download and verify the models you need.`,

    modelsInstalledHeader: n => `Ready (${n})`,
    modelsInstalledEmpty: 'Backend is up but no model is loaded. Use the command below to prepare one.',
    modelsRecommendedHeader: 'Recommended models — run these in your terminal',
    modelsBackendOffline: 'Start the backend first, then come back to prepare models.',
    fitOk: 'Recommended',
    fitTight: 'Tight fit',
    fitNoGo: 'Not enough RAM',
    modelInstalledBadge: 'Ready',
    pullPrefix: 'Run in terminal',
    copyCommand: 'Copy',
    copied: 'Copied',

    libHeader: 'Downloadable models',
    libVia: 'from the ollama.com library',
    libLoading: 'Loading the Ollama model library…',
    libErrorFallback: 'Could not reach the Ollama library; showing the built-in picks instead.',
    libStale: 'Showing a cached list (the latest refresh failed).',
    libSearchPlaceholder: total => `Search ${total} models — e.g. qwen, coder, vision…`,
    libClearSearch: 'Clear search',
    libFitLabel: 'Memory',
    libFilterRunnable: 'Runs here',
    libFilterAll: 'All',
    libCapsLabel: 'Skills',
    libShowing: n => `${n} models`,
    libEmpty: 'No models match these filters.',
    libClearFilters: 'Clear filters',
    libPullsSuffix: 'pulls',
    libUpdatedPrefix: 'updated',
    libSizeHint: 'Click a size to copy its pull command',
    libRetry: 'Retry',

    closeBtn: 'Done',
  };
}

type Fit = 'ok' | 'tight' | 'no-go';

function fitFor(totalGb: number | null, minRamGb: number): Fit {
  if (totalGb === null) return 'tight';
  if (totalGb >= minRamGb + RAM_HEADROOM_GB) return 'ok';
  if (totalGb >= minRamGb) return 'tight';
  return 'no-go';
}

function pullCommandFor(backend: LocalBackendStatus, entry: LocalModelCatalogEntry): string | null {
  const id = backend.id === 'ollama' ? entry.ollamaTag : entry.mlxModel;
  if (!id) return null;
  return backend.pullCommandTemplate.replace('${model}', id);
}

function formatGb(bytes: number | undefined | null): string {
  if (!bytes || !Number.isFinite(bytes)) return '—';
  return `${(bytes / 1024 ** 3).toFixed(0)} GB`;
}

function formatModelSize(bytes: number | undefined): string {
  if (!bytes || !Number.isFinite(bytes)) return '';
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = bytes / 1024 ** 2;
  return `${mb.toFixed(0)} MB`;
}

function catalogFor(backend: LocalBackendStatus, catalog: LocalModelCatalogEntry[]): LocalModelCatalogEntry[] {
  return catalog.filter(e => backend.id === 'ollama' ? !!e.ollamaTag : !!e.mlxModel);
}

function entryInstalledOn(entry: LocalModelCatalogEntry, backend: LocalBackendStatus): string | null {
  const tag = backend.id === 'ollama' ? entry.ollamaTag : entry.mlxModel;
  if (!tag) return null;
  const base = tag.split(':')[0].toLowerCase();
  for (const m of backend.models) {
    if (m.id.toLowerCase().startsWith(base)) return m.id;
  }
  return null;
}

export interface LocalBackendsSnapshot {
  backends: LocalBackendStatus[];
  catalog: LocalModelCatalogEntry[];
  currentOs: LocalBackendOs | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<{ addedProviderIds: string[] }>;
}

export function useLocalBackends(): LocalBackendsSnapshot {
  const [backends, setBackends] = useState<LocalBackendStatus[]>([]);
  const [catalog, setCatalog] = useState<LocalModelCatalogEntry[]>([]);
  const [currentOs, setCurrentOs] = useState<LocalBackendOs | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<{ addedProviderIds: string[] }> => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.probeLocalModels();
      if (!res.ok) throw new Error(res.error || 'Failed to load local backends');
      setBackends(res.backends || []);
      setCatalog(res.catalog || []);
      setCurrentOs(res.currentOs ?? null);
      return { addedProviderIds: res.addedProviderIds ?? [] };
    } catch (e: any) {
      setError(e?.message || String(e));
      return { addedProviderIds: [] };
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  return { backends, catalog, currentOs, loading, error, refresh };
}

function BackendTile({
  backend,
  copy,
  onClick,
}: {
  backend: LocalBackendStatus;
  copy: Copy;
  locale: Locale;
  onClick: () => void;
}) {
  const unsupported = !backend.supportedOnThisOs;
  const blurb = backend.id === 'ollama' ? copy.tileBlurbOllama : copy.tileBlurbMlx;

  const badge = unsupported
    ? <Badge variant="muted">{copy.tileStatusUnsupported}</Badge>
    : backend.detected
      ? <Badge variant="ok">{copy.tileBadgeReady(backend.models.length)}</Badge>
      : null;

  const detail = backend.detected
    ? `${backend.version ? `v${backend.version} · ` : ''}${copy.tileInstalledModels(backend.models.length)}`
    : blurb;

  return (
    <button
      type="button"
      onClick={onClick}
      className="group relative flex h-[104px] flex-col rounded-lg border border-edge bg-panel-alt px-4 py-3.5 text-left transition-all duration-200 hover:-translate-y-0.5 hover:border-edge-strong hover:bg-panel hover:shadow-[0_4px_16px_rgba(15,23,42,0.06)]"
    >
      <div className="flex w-full items-start justify-between gap-2">
        <BrandIcon brand={backend.id} size={32} />
        {badge}
      </div>
      <div className="mt-auto min-w-0">
        <div className="truncate text-[14px] font-semibold tracking-tight text-fg group-hover:text-fg">{backend.label}</div>
        <div className="mt-1 truncate text-[11.5px] leading-relaxed text-fg-5" title={detail}>{detail}</div>
      </div>
    </button>
  );
}

function StepHeader({ index, label, done }: { index: number; label: string; done?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <span
        className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[10px] font-semibold ${
          done
            ? 'border-transparent bg-[var(--th-badge-accent-bg)] text-[var(--th-badge-accent-text)]'
            : 'border-edge bg-panel-alt text-fg-4'
        }`}
      >
        {done ? '✓' : index}
      </span>
      <span className="text-[12px] font-semibold uppercase tracking-[0.16em] text-fg-3">{label}</span>
    </div>
  );
}

function InstalledModelChip({ name, sizeBytes }: { name: string; sizeBytes?: number }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-edge bg-panel-alt px-2 py-0.5 text-[11px] text-fg-3">
      <span className="truncate font-mono">{name}</span>
      {sizeBytes ? <span className="shrink-0 text-fg-5">{formatModelSize(sizeBytes)}</span> : null}
    </span>
  );
}

function CommandRow({
  label,
  cmd,
  copy,
  onCopy,
}: {
  label?: string;
  cmd: string;
  copy: Copy;
  onCopy: (cmd: string) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <code
        className="flex-1 truncate rounded-md border border-edge bg-panel px-2.5 py-1.5 font-mono text-[12px] text-fg-3"
        title={cmd}
      >
        {label && <span className="mr-2 text-fg-5">{label}</span>}
        {cmd}
      </code>
      <button
        type="button"
        onClick={() => onCopy(cmd)}
        className="shrink-0 rounded-md border border-edge bg-panel-alt px-2 py-1 text-[11px] text-fg-3 transition hover:border-edge-strong hover:bg-panel"
      >
        {copy.copyCommand}
      </button>
    </div>
  );
}

function CatalogRow({
  entry,
  backend,
  totalRamGb,
  copy,
  locale,
  onCopy,
}: {
  entry: LocalModelCatalogEntry;
  backend: LocalBackendStatus;
  totalRamGb: number | null;
  copy: Copy;
  locale: Locale;
  onCopy: (cmd: string) => void;
}) {
  const fit = fitFor(totalRamGb, entry.minRamGb);
  const blurb = locale === 'zh-CN' ? entry.descriptionZh : entry.description;
  const installedId = entryInstalledOn(entry, backend);
  const cmd = pullCommandFor(backend, entry);

  return (
    <div className="rounded-md border border-edge bg-panel-alt px-3 py-2.5">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <div className="text-[13px] font-semibold text-fg">{entry.name}</div>
          <span className="text-[11px] text-fg-5">{entry.publisher}</span>
          {fit === 'ok' && <Badge variant="ok">{copy.fitOk}</Badge>}
          {fit === 'tight' && <Badge variant="warn">{copy.fitTight}</Badge>}
          {fit === 'no-go' && <Badge variant="err">{copy.fitNoGo}</Badge>}
          {installedId && <Badge variant="accent">{copy.modelInstalledBadge}</Badge>}
        </div>
        <div className="text-[12px] leading-relaxed text-fg-4">{blurb}</div>
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-fg-5">
          <span>{entry.paramsB}B params</span>
          <span>{entry.sizeGb} GB on disk</span>
          <span>≥ {entry.minRamGb} GB RAM</span>
          {entry.homepage && (
            <a
              href={entry.homepage}
              target="_blank"
              rel="noreferrer"
              className="text-accent underline-offset-2 hover:underline"
            >
              {locale === 'zh-CN' ? '模型主页' : 'Model card'}
            </a>
          )}
        </div>
        {!installedId && fit !== 'no-go' && cmd && (
          <CommandRow label={copy.pullPrefix} cmd={cmd} copy={copy} onCopy={onCopy} />
        )}
      </div>
    </div>
  );
}

const CAP_LABEL_ZH: Record<string, string> = {
  tools: '工具', thinking: '思考', vision: '视觉', embedding: '嵌入', audio: '音频', insert: '填充',
};
function capLabel(cap: string, locale: Locale): string {
  return locale === 'zh-CN' ? (CAP_LABEL_ZH[cap] ?? cap) : cap;
}

const FIT_RANK: Record<Fit, number> = { ok: 0, tight: 1, 'no-go': 2 };

function modelBestFit(model: OllamaLibModel, totalRamGb: number | null): Fit {
  if (!model.sizes.length) return 'ok';
  let best: Fit = 'no-go';
  for (const s of model.sizes) {
    const f = fitFor(totalRamGb, s.minRamGb);
    if (FIT_RANK[f] < FIT_RANK[best]) best = f;
  }
  return best;
}

function installedTagsFor(name: string, backend: LocalBackendStatus): Set<string> {
  const set = new Set<string>();
  const lower = name.toLowerCase();
  const prefix = `${lower}:`;
  for (const m of backend.models) {
    const id = m.id.toLowerCase();
    if (id === lower) set.add('latest');
    else if (id.startsWith(prefix)) set.add(id.slice(prefix.length));
  }
  return set;
}

let libraryModuleCache: { models: OllamaLibModel[]; fetchedAt: number } | null = null;

function useOllamaLibrary(enabled: boolean) {
  const [models, setModels] = useState<OllamaLibModel[] | null>(libraryModuleCache?.models ?? null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const startedRef = useRef(false);

  const load = useCallback(async (refresh: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.fetchOllamaLibrary(refresh);
      if (!res.ok || !res.models) throw new Error(res.error || 'Failed to load the Ollama library');
      libraryModuleCache = { models: res.models, fetchedAt: res.fetchedAt ?? Date.now() };
      setModels(res.models);
      setStale(!!res.stale);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    if (libraryModuleCache) { setModels(libraryModuleCache.models); return; }
    if (startedRef.current) return;
    startedRef.current = true;
    void load(false);
  }, [enabled, load]);

  const reload = useCallback(() => { startedRef.current = true; void load(true); }, [load]);
  return { models, loading, error, stale, reload };
}

function OllamaSizeChip({
  size,
  installed,
  cmd,
  fit,
  copy,
  onCopy,
}: {
  size: OllamaLibSize;
  installed: boolean;
  cmd: string;
  fit: Fit;
  copy: Copy;
  onCopy: (cmd: string) => void;
}) {
  const tip = [
    cmd,
    size.diskGb > 0 ? `~${size.diskGb} GB` : '',
    size.minRamGb > 0 ? `≥ ${size.minRamGb} GB RAM` : '',
  ].filter(Boolean).join(' · ');
  const tone = installed
    ? 'border-[var(--th-badge-accent-bg)] bg-[var(--th-badge-accent-bg)] text-[var(--th-badge-accent-text)]'
    : fit === 'ok'
      ? 'border-emerald-600/40 bg-emerald-600/5 text-emerald-700 hover:border-emerald-600/70 dark:text-emerald-300'
      : fit === 'tight'
        ? 'border-amber-600/40 bg-amber-600/5 text-amber-700 hover:border-amber-600/70 dark:text-amber-300'
        : 'border-edge bg-panel text-fg-5 hover:border-edge-strong';
  return (
    <button
      type="button"
      title={tip}
      onClick={() => onCopy(cmd)}
      className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-[11px] transition ${tone}`}
    >
      {installed && <span aria-hidden="true">✓</span>}
      {size.tag}
    </button>
  );
}

function OllamaLibRow({
  model,
  backend,
  totalRamGb,
  copy,
  locale,
  onCopy,
}: {
  model: OllamaLibModel;
  backend: LocalBackendStatus;
  totalRamGb: number | null;
  copy: Copy;
  locale: Locale;
  onCopy: (cmd: string) => void;
}) {
  const installedTags = useMemo(() => installedTagsFor(model.name, backend), [model.name, backend]);
  const anyInstalled = installedTags.size > 0;
  const cmdFor = (tag: string) => backend.pullCommandTemplate.replace('${model}', `${model.name}:${tag}`);

  return (
    <div className="rounded-md border border-edge bg-panel-alt px-3 py-2.5">
      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <a
            href={model.url}
            target="_blank"
            rel="noreferrer"
            className="text-[13px] font-semibold text-fg underline-offset-2 hover:underline"
          >
            {model.name}
          </a>
          {anyInstalled && <Badge variant="accent">{copy.modelInstalledBadge}</Badge>}
          {model.capabilities.map(cap => (
            <span
              key={cap}
              className="rounded bg-indigo-500/10 px-1.5 py-0.5 text-[10px] font-medium text-indigo-600 dark:text-indigo-300"
            >
              {capLabel(cap, locale)}
            </span>
          ))}
          <span className="ml-auto shrink-0 text-[10.5px] text-fg-5">
            {model.pulls && <span>{model.pulls} {copy.libPullsSuffix}</span>}
            {model.pulls && model.updated && <span className="mx-1 text-fg-6">·</span>}
            {model.updated && <span>{copy.libUpdatedPrefix} {model.updated}</span>}
          </span>
        </div>
        {model.description && (
          <div className="line-clamp-2 text-[11.5px] leading-relaxed text-fg-4">{model.description}</div>
        )}
        {model.sizes.length > 0 && (
          <div className="flex flex-wrap items-center gap-1 pt-0.5">
            {model.sizes.map(size => (
              <OllamaSizeChip
                key={size.tag}
                size={size}
                installed={installedTags.has(size.tag.toLowerCase())}
                cmd={cmdFor(size.tag)}
                fit={fitFor(totalRamGb, size.minRamGb)}
                copy={copy}
                onCopy={onCopy}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function StaticCatalogList({
  entries,
  backend,
  totalRamGb,
  copy,
  locale,
  onCopy,
}: {
  entries: LocalModelCatalogEntry[];
  backend: LocalBackendStatus;
  totalRamGb: number | null;
  copy: Copy;
  locale: Locale;
  onCopy: (cmd: string) => void;
}) {
  if (!entries.length) return null;
  return (
    <div className="space-y-2">
      <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-fg-5">
        {copy.modelsRecommendedHeader}
      </div>
      <div className="space-y-1.5">
        {entries.map(entry => (
          <CatalogRow
            key={entry.id}
            entry={entry}
            backend={backend}
            totalRamGb={totalRamGb}
            copy={copy}
            locale={locale}
            onCopy={onCopy}
          />
        ))}
      </div>
    </div>
  );
}

function OllamaLibrarySection({
  enabled,
  backend,
  totalRamGb,
  copy,
  locale,
  onCopy,
  fallback,
}: {
  enabled: boolean;
  backend: LocalBackendStatus;
  totalRamGb: number | null;
  copy: Copy;
  locale: Locale;
  onCopy: (cmd: string) => void;
  fallback: ReactNode;
}) {
  const { models, loading, error, stale, reload } = useOllamaLibrary(enabled);
  const [query, setQuery] = useState('');
  const [onlyRunnable, setOnlyRunnable] = useState(true);
  const [selectedCaps, setSelectedCaps] = useState<string[]>([]);

  const all = models ?? [];
  const runnable = useMemo(
    () => all.filter(m => modelBestFit(m, totalRamGb) !== 'no-go'),
    [all, totalRamGb],
  );
  const base = onlyRunnable ? runnable : all;

  const capFacets = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const m of base) for (const cap of new Set(m.capabilities)) counts[cap] = (counts[cap] ?? 0) + 1;
    const ORDER = ['tools', 'vision', 'thinking', 'embedding', 'audio', 'insert'];
    return Object.keys(counts).sort((a, b) => {
      const ia = ORDER.indexOf(a); const ib = ORDER.indexOf(b);
      if (ia !== ib) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
      return counts[b] - counts[a];
    }).map(cap => ({ cap, count: counts[cap] }));
  }, [base]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return base.filter(m => {
      if (selectedCaps.length && !selectedCaps.every(c => m.capabilities.includes(c))) return false;
      if (!q) return true;
      return m.name.toLowerCase().includes(q) || m.description.toLowerCase().includes(q);
    });
  }, [base, selectedCaps, query]);

  const toggleCap = (cap: string) =>
    setSelectedCaps(prev => (prev.includes(cap) ? prev.filter(c => c !== cap) : [...prev, cap]));
  const filtersActive = query.trim().length > 0 || selectedCaps.length > 0;
  const clearFilters = () => { setQuery(''); setSelectedCaps([]); };

  if (loading && !models) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-edge bg-panel-alt px-3.5 py-3 text-[12px] text-fg-5">
        <Spinner className="h-3.5 w-3.5" /> {copy.libLoading}
      </div>
    );
  }

  if (error && !models) {
    return (
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2 rounded-md border border-amber-600/30 bg-amber-600/5 px-3 py-2 text-[11.5px] text-amber-700 dark:text-amber-300">
          <span>{copy.libErrorFallback}</span>
          <Button variant="outline" size="sm" onClick={reload}>{copy.libRetry}</Button>
        </div>
        {fallback}
      </div>
    );
  }

  const segBtn = (active: boolean) =>
    `px-2.5 py-1 text-[11.5px] font-medium transition ${active ? 'bg-[var(--th-badge-accent-bg)] text-[var(--th-badge-accent-text)]' : 'bg-panel-alt text-fg-4 hover:bg-panel hover:text-fg-3'}`;

  return (
    <div className="space-y-2.5">
      <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-fg-5">
        {copy.libHeader}
        <span className="ml-2 normal-case tracking-normal text-fg-6">· {copy.libVia}</span>
      </div>

      {/* Search — prominent, total baked into the placeholder */}
      <div className="relative">
        <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-5" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
            <circle cx="11" cy="11" r="7" /><path d="m20 20-3.2-3.2" />
          </svg>
        </span>
        <input
          type="search"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder={copy.libSearchPlaceholder(all.length)}
          className="w-full rounded-md border border-edge bg-panel py-2 pl-8 pr-8 text-[12.5px] text-fg-2 outline-none transition placeholder:text-fg-6 focus:border-edge-strong"
        />
        {query && (
          <button
            type="button"
            onClick={() => setQuery('')}
            title={copy.libClearSearch}
            aria-label={copy.libClearSearch}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-fg-5 transition hover:bg-panel-alt hover:text-fg-3"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        )}
      </div>

      {/* Filters — memory fit + capability facets, each carrying its own count */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-fg-6">{copy.libFitLabel}</span>
          <div className="flex overflow-hidden rounded-md border border-edge">
            <button type="button" onClick={() => setOnlyRunnable(true)} className={segBtn(onlyRunnable)}>
              {copy.libFilterRunnable} <span className="tabular-nums opacity-70">{runnable.length}</span>
            </button>
            <button type="button" onClick={() => setOnlyRunnable(false)} className={`border-l border-edge ${segBtn(!onlyRunnable)}`}>
              {copy.libFilterAll} <span className="tabular-nums opacity-70">{all.length}</span>
            </button>
          </div>
        </div>

        {capFacets.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-fg-6">{copy.libCapsLabel}</span>
            {capFacets.map(({ cap, count }) => {
              const active = selectedCaps.includes(cap);
              return (
                <button
                  key={cap}
                  type="button"
                  onClick={() => toggleCap(cap)}
                  className={`rounded-md border px-2 py-0.5 text-[11px] transition ${
                    active
                      ? 'border-[var(--th-badge-accent-bg)] bg-[var(--th-badge-accent-bg)] text-[var(--th-badge-accent-text)]'
                      : 'border-edge bg-panel-alt text-fg-4 hover:border-edge-strong hover:text-fg-3'
                  }`}
                >
                  {capLabel(cap, locale)} <span className="tabular-nums opacity-70">{count}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {stale && (
        <div className="rounded-md border border-amber-600/30 bg-amber-600/5 px-2.5 py-1 text-[10.5px] text-amber-700 dark:text-amber-300">
          {copy.libStale}
        </div>
      )}

      {/* Live result count — the headline metric — + the chip hint */}
      <div className="flex items-center justify-between gap-2 border-t border-edge pt-2 text-[11px]">
        <span className="font-medium text-fg-3">{copy.libShowing(filtered.length)}</span>
        <span className="text-[10px] text-fg-6">{copy.libSizeHint}</span>
      </div>

      {filtered.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-md border border-edge bg-panel-alt px-3.5 py-6 text-[12px] text-fg-5">
          <span>{copy.libEmpty}</span>
          {filtersActive && (
            <Button variant="outline" size="sm" onClick={clearFilters}>{copy.libClearFilters}</Button>
          )}
        </div>
      ) : (
        <div className="min-h-[240px] max-h-[52vh] space-y-1.5 overflow-y-auto pr-1">
          {filtered.map(m => (
            <OllamaLibRow
              key={m.name}
              model={m}
              backend={backend}
              totalRamGb={totalRamGb}
              copy={copy}
              locale={locale}
              onCopy={onCopy}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function LocalBackendModal({
  open,
  backend,
  catalog,
  totalRamGb,
  currentOs,
  copy,
  locale,
  onClose,
  onRefresh,
  onCopy,
}: {
  open: boolean;
  backend: LocalBackendStatus | null;
  catalog: LocalModelCatalogEntry[];
  totalRamGb: number | null;
  currentOs: LocalBackendOs | null;
  copy: Copy;
  locale: Locale;
  onClose: () => void;
  onRefresh: () => Promise<{ addedProviderIds: string[] }>;
  onCopy: (cmd: string) => void;
}) {
  const [rechecking, setRechecking] = useState(false);
  useEffect(() => { setRechecking(false); }, [backend?.detected, backend?.id]);

  const backendCatalog = useMemo(
    () => !backend ? [] : catalogFor(backend, catalog).sort((a, b) => {
      const fa = fitFor(totalRamGb, a.minRamGb);
      const fb = fitFor(totalRamGb, b.minRamGb);
      const score = (f: Fit) => (f === 'ok' ? 0 : f === 'tight' ? 1 : 2);
      const installedA = entryInstalledOn(a, backend) ? 0 : 1;
      const installedB = entryInstalledOn(b, backend) ? 0 : 1;
      if (installedA !== installedB) return installedA - installedB;
      return score(fa) - score(fb);
    }),
    [backend, catalog, totalRamGb],
  );

  if (!backend) return null;
  const unsupported = !backend.supportedOnThisOs;
  const installCommands = currentOs ? (backend.install[currentOs] || []) : [];

  const handleRecheck = async () => {
    setRechecking(true);
    try { await onRefresh(); } finally { setRechecking(false); }
  };

  return (
    <Modal open={open} onClose={onClose} wide>
      <ModalHeader
        title={copy.modalTitle(backend.label)}
        description={copy.modalDescription(backend.label)}
        onClose={onClose}
      />
      <div className="space-y-5">
        <section className="space-y-2">
          <StepHeader index={1} label={copy.stepStatus} done={backend.detected} />
          <div className="space-y-2 rounded-md border border-edge bg-panel-alt px-3.5 py-3">
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-edge bg-panel">
                <BrandIcon brand={backend.id} size={20} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[13px] font-semibold text-fg">{backend.label}</span>
                  {unsupported
                    ? <Badge variant="muted">{copy.tileStatusUnsupported}</Badge>
                    : backend.detected
                      ? <Badge variant="ok">{copy.statusRunning}</Badge>
                      : <Badge variant="muted">{copy.tileStatusNotDetected}</Badge>}
                </div>
                <div className="mt-1 text-[11px] leading-relaxed text-fg-5">
                  {unsupported ? (
                    <>{copy.statusUnsupportedDesc(backend.label)}</>
                  ) : backend.detected ? (
                    <>
                      {backend.version && <>v{backend.version} · </>}
                      <span className="font-mono">{backend.baseURL}</span>
                    </>
                  ) : (
                    <>{copy.statusNotRunning}</>
                  )}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <a
                  href={backend.homepage}
                  target="_blank"
                  rel="noreferrer"
                  className="text-[12px] text-accent underline-offset-2 hover:underline"
                >
                  {copy.statusHomepageCta}
                </a>
                {!unsupported && (
                  <Button variant="outline" size="sm" disabled={rechecking} onClick={() => void handleRecheck()}>
                    {rechecking
                      ? <><Spinner className="h-3 w-3" /> {copy.statusRechecking}</>
                      : <><span aria-hidden="true">↻</span> {copy.statusRecheck}</>}
                  </Button>
                )}
              </div>
            </div>

            {!unsupported && backend.detected && backend.existingProviderId && (
              <div className="rounded-md border border-emerald-700/20 bg-emerald-700/5 px-2.5 py-1.5 text-[11px] leading-relaxed text-emerald-700 dark:text-emerald-300">
                {copy.statusAutoAttachedHint(backend.label)}
              </div>
            )}

            {!unsupported && !backend.detected && (
              <div className="space-y-2 pt-1">
                {installCommands.length > 0 && (
                  <div className="space-y-1.5">
                    <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-fg-5">
                      {copy.statusInstallHeader}
                    </div>
                    {installCommands.map((c, i) => (
                      <CommandRow key={i} label={c.label} cmd={c.cmd} copy={copy} onCopy={onCopy} />
                    ))}
                    {backend.install.docs && (
                      <a
                        href={backend.install.docs}
                        target="_blank"
                        rel="noreferrer"
                        className="text-[11px] text-accent underline-offset-2 hover:underline"
                      >
                        {copy.statusInstallDocs} →
                      </a>
                    )}
                  </div>
                )}
                <div className="space-y-1.5">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-fg-5">
                    {copy.statusRunHint}
                  </div>
                  <CommandRow
                    label={backend.runHint.label}
                    cmd={backend.runHint.cmd}
                    copy={copy}
                    onCopy={onCopy}
                  />
                </div>
              </div>
            )}
          </div>
        </section>

        <section className="space-y-2">
          <StepHeader index={2} label={copy.stepModels} done={backend.detected && backend.models.length > 0} />

          {!backend.detected ? (
            <div className="rounded-md border border-edge bg-panel-alt px-3.5 py-3 text-[12px] text-fg-5">
              {copy.modelsBackendOffline}
            </div>
          ) : (
            <div className="space-y-3">
              <div className="rounded-md border border-edge bg-panel-alt px-3.5 py-3">
                <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-fg-5">
                  {copy.modelsInstalledHeader(backend.models.length)}
                </div>
                {backend.models.length === 0 ? (
                  <div className="text-[12px] text-fg-5">{copy.modelsInstalledEmpty}</div>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {backend.models.map(m => (
                      <InstalledModelChip key={m.id} name={m.id} sizeBytes={m.sizeBytes} />
                    ))}
                  </div>
                )}
              </div>

              {backend.id === 'ollama' ? (
                <OllamaLibrarySection
                  enabled={open && backend.detected}
                  backend={backend}
                  totalRamGb={totalRamGb}
                  copy={copy}
                  locale={locale}
                  onCopy={onCopy}
                  fallback={
                    <StaticCatalogList
                      entries={backendCatalog}
                      backend={backend}
                      totalRamGb={totalRamGb}
                      copy={copy}
                      locale={locale}
                      onCopy={onCopy}
                    />
                  }
                />
              ) : (
                <StaticCatalogList
                  entries={backendCatalog}
                  backend={backend}
                  totalRamGb={totalRamGb}
                  copy={copy}
                  locale={locale}
                  onCopy={onCopy}
                />
              )}
            </div>
          )}
        </section>
      </div>

      <div className="mt-6 border-t border-edge pt-4">
        <ActionBar primary={{ label: copy.closeBtn, onClick: onClose }} />
      </div>
    </Modal>
  );
}

export function LocalModelsSection({
  snapshot,
  onConnected,
}: {
  snapshot?: LocalBackendsSnapshot;
  onConnected?: () => void | Promise<void>;
}) {
  const locale = useStore(s => s.locale);
  const host = useStore(s => s.host);
  const toast = useStore(s => s.toast);
  const copy = useMemo(() => getCopy(locale), [locale]);

  const local = useLocalBackends();
  const eff = snapshot ?? local;
  const { backends, catalog, currentOs, loading, error, refresh } = eff;

  const [openId, setOpenId] = useState<LocalBackendStatus['id'] | null>(null);
  const openBackend = useMemo(
    () => backends.find(b => b.id === openId) ?? null,
    [backends, openId],
  );

  const lastAttachKeyRef = useRef<string>('');
  useEffect(() => {
    const ids = backends.map(b => b.existingProviderId || '').join(',');
    if (ids === lastAttachKeyRef.current) return;
    lastAttachKeyRef.current = ids;
    if (onConnected && backends.some(b => b.existingProviderId)) {
      void onConnected();
    }
  }, [backends, onConnected]);

  const handleRefresh = useCallback(async () => {
    const r = await refresh();
    if (onConnected && r.addedProviderIds.length > 0) await onConnected();
    return r;
  }, [refresh, onConnected]);

  const handleCopy = useCallback((cmd: string) => {
    void navigator.clipboard?.writeText(cmd);
    toast(copy.copied);
  }, [copy.copied, toast]);

  const totalRamGb = host?.totalMem ? host.totalMem / 1024 ** 3 : null;
  const hostSummary = host
    ? `${host.cpuModel || host.arch} · ${formatGb(host.totalMem)} RAM`
    : copy.hostUnknown;

  const tiles: LocalBackendStatus[] = backends.length > 0
    ? backends
    : [
        {
          id: 'ollama', label: 'Ollama', detected: false,
          baseURL: 'http://127.0.0.1:11434', openAIBaseURL: 'http://127.0.0.1:11434/v1',
          models: [], existingProviderId: null,
          homepage: 'https://ollama.com/',
          install: {}, runHint: { cmd: 'ollama serve' }, pullCommandTemplate: 'ollama pull ${model}',
          supportedOnThisOs: true,
        },
        {
          id: 'mlx', label: 'mlx-lm', detected: false,
          baseURL: 'http://127.0.0.1:8080', openAIBaseURL: 'http://127.0.0.1:8080/v1',
          models: [], existingProviderId: null,
          homepage: 'https://github.com/ml-explore/mlx-lm',
          install: {}, runHint: { cmd: 'mlx_lm.server --port 8080' }, pullCommandTemplate: 'mlx_lm.server --model ${model} --port 8080',
          supportedOnThisOs: true,
        },
      ];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-[12px] text-fg-5">
          <span className="font-semibold uppercase tracking-[0.14em] text-fg-5">{copy.hostLabel}</span>
          <span className="mx-2 text-fg-6">·</span>
          <span className="text-fg-3">{hostSummary}</span>
        </div>
        <Button variant="ghost" size="sm" onClick={() => void handleRefresh()} disabled={loading}>
          {loading
            ? <><Spinner className="h-3 w-3" /> {copy.refreshing}</>
            : <><span aria-hidden="true">↻</span> {copy.refresh}</>}
        </Button>
      </div>

      <div className="space-y-1.5 pt-1">
        <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-fg-5">{copy.sectionLabel}</div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {tiles.map(b => (
            <BackendTile
              key={b.id}
              backend={b}
              copy={copy}
              locale={locale}
              onClick={() => setOpenId(b.id)}
            />
          ))}
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-rose-700/40 bg-rose-900/20 px-3 py-2 text-xs text-rose-200">
          {error}
        </div>
      )}

      <LocalBackendModal
        open={openId !== null}
        backend={openBackend}
        catalog={catalog}
        totalRamGb={totalRamGb}
        currentOs={currentOs}
        copy={copy}
        locale={locale}
        onClose={() => setOpenId(null)}
        onRefresh={handleRefresh}
        onCopy={handleCopy}
      />
    </div>
  );
}

export default LocalModelsSection;
