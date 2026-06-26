import { create } from 'zustand';
import { api } from './api';
import { hasPendingChannelValidation } from './channel-status';
import type { AgentStatusResponse, AppState, HostInfo, SessionInfo } from './types';
import type { Locale } from './i18n';

export interface Toast {
  id: number;
  message: string;
  ok: boolean;
}

export type Theme = 'dark' | 'light';

export interface ModelLayer {
  providers: Array<{ id: string; name: string; kind: string; baseURL: string }>;
  profiles: Array<{ id: string; name: string; providerId: string; modelId: string; effort?: string | null }>;
  activeProfiles: Record<string, string | null>;
}

// Global model config (providers/profiles/agent bindings) is identical across every session
// panel, so it lives here once instead of being re-fetched by each InputComposer on mount.
let _modelLayerInFlight: Promise<ModelLayer | null> | null = null;

const CACHE_KEY = 'pikiloom-store-cache';

interface CachedSlices {
  state: AppState | null;
  host: HostInfo | null;
  agentStatus: AgentStatusResponse | null;
}

function readCache(): CachedSlices {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (raw) return JSON.parse(raw) as CachedSlices;
  } catch {}
  return { state: null, host: null, agentStatus: null };
}

function writeCache(slices: Partial<CachedSlices>) {
  try {
    const prev = readCache();
    sessionStorage.setItem(CACHE_KEY, JSON.stringify({ ...prev, ...slices }));
  } catch {}
}

let _toastId = 0;

function getInitialTheme(): Theme {
  try {
    const stored = localStorage.getItem('pikiloom-theme');
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {}
  return 'dark';
}

function getInitialLocale(): Locale {
  try {
    const stored = localStorage.getItem('pikiloom-locale');
    if (stored === 'en' || stored === 'zh-CN') return stored;
  } catch {}
  return 'zh-CN';
}

interface StoreState {
  state: AppState | null;
  host: HostInfo | null;
  agentStatus: AgentStatusResponse | null;
  modelLayer: ModelLayer | null;
  toasts: Toast[];
  allSessions: Record<string, { sessions: SessionInfo[] }>;
  theme: Theme;
  locale: Locale;

  toast: (msg: string, ok?: boolean) => void;
  setTheme: (t: Theme) => void;
  setLocale: (l: Locale) => void;
  reload: () => Promise<AppState | null>;
  refreshAgentStatus: () => Promise<AgentStatusResponse | null>;
  setAgentStatus: (status: AgentStatusResponse) => void;
  ensureModelLayer: () => Promise<ModelLayer | null>;
  refreshModelLayer: () => Promise<ModelLayer | null>;
  setModelLayer: (layer: ModelLayer) => void;
  reloadUntil: (
    predicate: (state: AppState) => boolean,
    opts?: { attempts?: number; intervalMs?: number },
  ) => Promise<AppState | null>;
  loadSessions: () => Promise<void>;
}

const initialTheme = getInitialTheme();
document.documentElement.dataset.theme = initialTheme;

const _cached = readCache();

export const useStore = create<StoreState>()((set, get) => ({
  state: _cached.state,
  host: _cached.host,
  agentStatus: _cached.agentStatus,
  modelLayer: null,
  toasts: [],
  allSessions: {},
  theme: initialTheme,
  locale: getInitialLocale(),

  toast: (message, ok = true) => {
    const id = ++_toastId;
    set((prev) => ({ toasts: [...prev.toasts, { id, message, ok }] }));
    setTimeout(() => {
      set((prev) => ({ toasts: prev.toasts.filter((t) => t.id !== id) }));
    }, 3000);
  },

  setTheme: (t) => {
    document.documentElement.dataset.theme = t;
    try { localStorage.setItem('pikiloom-theme', t); } catch {}
    set({ theme: t });
  },

  setLocale: (l) => {
    try { localStorage.setItem('pikiloom-locale', l); } catch {}
    set({ locale: l });
  },

  reload: async () => {
    try {
      const [d, h, agents] = await Promise.all([
        api.getState(),
        api.getHost().catch(() => null),
        api.getAgentStatus().catch(() => null),
      ]);
      set({ state: d, ...(h ? { host: h } : {}), ...(agents ? { agentStatus: agents } : {}) });
      writeCache({ state: d, ...(h ? { host: h } : {}), ...(agents ? { agentStatus: agents } : {}) });
      return d;
    } catch (e) {
      console.error('loadState:', e);
      return null;
    }
  },

  refreshAgentStatus: async () => {
    try {
      const agents = await api.getAgentStatus();
      set({ agentStatus: agents });
      writeCache({ agentStatus: agents });
      return agents;
    } catch { return null; }
  },

  setAgentStatus: (status) => {
    set({ agentStatus: status });
    writeCache({ agentStatus: status });
  },

  setModelLayer: (layer) => set({ modelLayer: layer }),

  refreshModelLayer: async () => {
    if (_modelLayerInFlight) return _modelLayerInFlight;
    _modelLayerInFlight = (async () => {
      try {
        const [pRes, profRes, bRes] = await Promise.all([
          api.getModelProviders().catch(() => null),
          api.getModelProfiles().catch(() => null),
          api.getModelAgentBindings().catch(() => null),
        ]);
        const prev = get().modelLayer;
        const layer: ModelLayer = {
          providers: pRes?.ok ? (pRes.providers || []) : (prev?.providers || []),
          profiles: profRes?.ok ? (profRes.profiles || []) : (prev?.profiles || []),
          activeProfiles: bRes?.ok
            ? Object.fromEntries((bRes.bindings || []).map(b => [b.agent, b.activeProfileId]))
            : (prev?.activeProfiles || {}),
        };
        set({ modelLayer: layer });
        return layer;
      } catch {
        return get().modelLayer;
      } finally {
        _modelLayerInFlight = null;
      }
    })();
    return _modelLayerInFlight;
  },

  ensureModelLayer: async () => {
    const cur = get().modelLayer;
    if (cur) return cur;
    return get().refreshModelLayer();
  },

  reloadUntil: async (predicate, opts) => {
    const attempts = opts?.attempts ?? 8;
    const intervalMs = opts?.intervalMs ?? 250;
    let latest: AppState | null = null;
    for (let i = 0; i < attempts; i++) {
      latest = await get().reload();
      if (latest && predicate(latest)) return latest;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, intervalMs));
    }
    return latest;
  },

  loadSessions: async () => {
    try {
      const [s, h, ses] = await Promise.all([
        api.getState(),
        api.getHost(),
        api.getSessions(),
      ]);
      set({
        state: s,
        host: h,
        allSessions: ses as Record<string, { sessions: SessionInfo[] }>,
      });
      writeCache({ state: s, host: h });
    } catch (e) {
      console.error('loadSessions:', e);
    }
  },
}));

void useStore.getState().reload();

let _channelPollTimer: ReturnType<typeof setTimeout> | null = null;

useStore.subscribe((cur, prev) => {
  if (cur.state === prev.state) return;

  if (_channelPollTimer) { clearTimeout(_channelPollTimer); _channelPollTimer = null; }

  if (!hasPendingChannelValidation(cur.state?.setupState?.channels || null)) return;

  _channelPollTimer = setTimeout(() => {
    _channelPollTimer = null;
    void useStore.getState().reload();
  }, 1500);
});
