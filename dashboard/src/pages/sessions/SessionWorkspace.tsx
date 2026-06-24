import { Suspense, lazy, startTransition, useDeferredValue, useState, useEffect, useCallback, useRef, memo, useMemo } from 'react';
import { useStore } from '../../store';
import { createT } from '../../i18n';
import { api } from '../../api';
import { loadWorkspaceSessions, prefetchSessionMessages } from '../../session-preload';
import { useDashboardEvent, useDashboardReconnect } from '../../ws';
import {
  applyLiveSessionState,
  cn,
  fmtTime,
  fmtRelative,
  getAgentMeta,
  isPendingSessionId,
  normalizeLiveSessionState,
  resolveCanonicalSessionId,
  shortenModel,
  sessionDisplayState,
  sessionListContextText,
  sessionListDisplayText,
  type LiveSessionState,
} from '../../utils';
import { Dot, Spinner, Modal, ModalHeader, Button, IconPicker, Tooltip } from '../../components/ui';
import { BrandIcon } from '../../components/BrandIcon';
import { DirBrowser } from '../../components/DirBrowser';
import type { SessionInfo, WorkspaceEntry, DirEntry, OpenTarget, GitStatus } from '../../types';
import { InputComposer } from './InputComposer';
import { UserBubble } from './TurnView';
import { ThinkingDots } from './LivePreview';
import { WorkspaceExtensionsModal } from '../extensions/WorkspaceExtensionsModal';

let sessionPanelModulePromise: Promise<typeof import('./SessionPanel')> | null = import('./SessionPanel');

function preloadSessionPanel() {
  sessionPanelModulePromise ??= import('./SessionPanel');
  return sessionPanelModulePromise;
}

const SessionPanel = lazy(async () => ({ default: (await preloadSessionPanel()).SessionPanel }));

const PAGE_SIZE = 5;
const AUTO_PREFETCH_DELAY_MS = 240;
const HOVER_PREFETCH_DELAY_MS = 120;
const SESSION_PREFETCH_TURNS = 12;
const LIVE_SESSION_STATE_MAX_AGE_MS = 15 * 60 * 1000;
const sKey = (agent: string, id: string) => `${agent}:${id}`;

type SessionWithDepth = SessionInfo & { __forkDepth: number };

function groupForkDescendants(sessions: SessionInfo[]): SessionWithDepth[] {
  const byKey = new Map<string, SessionInfo>();
  for (const s of sessions) byKey.set(sKey(s.agent || '', s.sessionId), s);

  const childMap = new Map<string, SessionInfo[]>();
  const isForkChild = new Set<string>();
  for (const s of sessions) {
    const from = s.migratedFrom;
    if (!from || from.kind !== 'fork' || !from.sessionId) continue;
    const parentKey = sKey(from.agent || s.agent || '', from.sessionId);
    if (!byKey.has(parentKey)) continue;
    isForkChild.add(sKey(s.agent || '', s.sessionId));
    if (!childMap.has(parentKey)) childMap.set(parentKey, []);
    childMap.get(parentKey)!.push(s);
  }

  const out: SessionWithDepth[] = [];
  const seen = new Set<string>();
  const visit = (s: SessionInfo, depth: number) => {
    const key = sKey(s.agent || '', s.sessionId);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(Object.assign({}, s, { __forkDepth: depth }));
    const kids = childMap.get(key);
    if (!kids) return;
    for (const k of kids) visit(k, depth + 1);
  };
  for (const s of sessions) {
    const key = sKey(s.agent || '', s.sessionId);
    if (isForkChild.has(key)) continue;
    visit(s, 0);
  }
  for (const s of sessions) {
    visit(s, 0);
  }
  return out;
}

let _slotKeySeq = 0;
function nextMountKey() { return `mk-${Date.now().toString(36)}-${(++_slotKeySeq).toString(36)}`; }

function layoutGet(key: string): string | null {
  try {
    const v = localStorage.getItem(key);
    if (v != null) return v;
    const legacy = sessionStorage.getItem(key);
    if (legacy != null) {
      try { localStorage.setItem(key, legacy); sessionStorage.removeItem(key); } catch {}
      return legacy;
    }
  } catch {}
  return null;
}
function layoutSet(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch {}
}

type LayoutMode = 1 | 2 | 3 | 6;
const LAYOUT_LADDER: readonly LayoutMode[] = [1, 2, 3, 6];
const MAX_LAYOUT: LayoutMode = 6;

function fitLayout(count: number): LayoutMode {
  for (const m of LAYOUT_LADDER) if (m >= count) return m;
  return MAX_LAYOUT;
}

function defaultLayoutMode(): LayoutMode {
  const w = typeof window !== 'undefined' ? window.innerWidth : 1280;
  return w >= 1920 ? 3 : w >= 1280 ? 2 : 1;
}

function layoutForCount(count: number, floor: LayoutMode): LayoutMode {
  const fit = fitLayout(count);
  return fit > floor ? fit : floor;
}

type FilterMode = 'all' | 'running' | 'review';

function isOpenTarget(value: string | null | undefined): value is OpenTarget {
  return value === 'vscode'
    || value === 'cursor'
    || value === 'windsurf'
    || value === 'finder'
    || value === 'default';
}

function inferOpenTarget(hostApp: string | null, platform: string | null): OpenTarget {
  const normalized = String(hostApp || '').toLowerCase();
  if (normalized.includes('cursor')) return 'cursor';
  if (normalized.includes('windsurf')) return 'windsurf';
  if (normalized.includes('code')) return 'vscode';
  return platform === 'darwin' ? 'vscode' : 'default';
}

function targetLabelKey(target: OpenTarget) {
  switch (target) {
    case 'cursor': return 'hub.openTargetCursor';
    case 'windsurf': return 'hub.openTargetWindsurf';
    case 'finder': return 'hub.openTargetFinder';
    case 'default': return 'hub.openTargetDefault';
    case 'vscode':
    default:
      return 'hub.openTargetVsCode';
  }
}

export const SessionWorkspace = memo(function SessionWorkspace({
  active = true,
}: {
  active?: boolean;
}) {
  const locale = useStore(s => s.locale);
  const runtimeWorkdir = useStore(s => s.state?.runtimeWorkdir ?? null);
  const t = useMemo(() => createT(locale), [locale]);

  const [workspaces, setWorkspaces] = useState<WorkspaceEntry[]>([]);
  const [sessionsMap, setSessionsMap] = useState<Record<string, SessionInfo[]>>({});
  const [loadingMap, setLoadingMap] = useState<Record<string, boolean>>({});
  const [sidebarLoading, setSidebarLoading] = useState(true);
  type SessionSlot = { agent: string; sessionId: string; workdir: string; mountKey: string; pendingPrompt?: string | null; pendingImageUrls?: string[] };

  const [layoutMode, setLayoutModeRaw] = useState<LayoutMode>(() => {
    const v = layoutGet('pikiloom-layout-mode');
    if (v === '1' || v === '2' || v === '3' || v === '6') return Number(v) as LayoutMode;
    return defaultLayoutMode();
  });
  const [floorMode, setFloorModeRaw] = useState<LayoutMode>(() => {
    const v = layoutGet('pikiloom-layout-floor');
    if (v === '1' || v === '2' || v === '3' || v === '6') return Number(v) as LayoutMode;
    return defaultLayoutMode();
  });
  const [openSessions, setOpenSessionsRaw] = useState<SessionSlot[]>(() => {
    try {
      const v = layoutGet('pikiloom-open-sessions');
      if (v) {
        const parsed = JSON.parse(v);
        if (Array.isArray(parsed)) return parsed.map((s: any) => ({ ...s, mountKey: s.mountKey || nextMountKey() }));
      }
    } catch {}
    return [];
  });
  const [activeSlotIndex, setActiveSlotIndexRaw] = useState(() => {
    const v = layoutGet('pikiloom-active-slot');
    if (v != null) { const n = Number(v); if (Number.isFinite(n) && n >= 0) return n; }
    return 0;
  });

  const setLayoutMode = useCallback((mode: LayoutMode) => {
    setLayoutModeRaw(mode);
    layoutSet('pikiloom-layout-mode', String(mode));
  }, []);
  const setFloorMode = useCallback((mode: LayoutMode) => {
    setFloorModeRaw(mode);
    layoutSet('pikiloom-layout-floor', String(mode));
  }, []);
  const setOpenSessions = useCallback((updater: SessionSlot[] | ((prev: SessionSlot[]) => SessionSlot[])) => {
    setOpenSessionsRaw(prev => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      const persistable = next.map(({ pendingPrompt: _p, pendingImageUrls: _i, ...rest }) => rest);
      layoutSet('pikiloom-open-sessions', JSON.stringify(persistable));
      return next;
    });
  }, []);
  const setActiveSlotIndex = useCallback((updater: number | ((prev: number) => number)) => {
    setActiveSlotIndexRaw(prev => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      layoutSet('pikiloom-active-slot', String(next));
      return next;
    });
  }, []);
  const handleSelectLayoutMode = useCallback((mode: LayoutMode) => {
    setLayoutMode(mode);
    setFloorMode(mode);
  }, [setLayoutMode, setFloorMode]);

  useEffect(() => {
    setOpenSessions(prev => prev.length > layoutMode ? prev.slice(0, layoutMode) : prev);
    setActiveSlotIndex(prev => prev >= layoutMode ? layoutMode - 1 : prev);
  }, [layoutMode]);

  const [fileTreeOpen, setFileTreeOpen] = useState(false);

  const layoutModeRef = useRef(layoutMode);
  layoutModeRef.current = layoutMode;
  const floorModeRef = useRef(floorMode);
  floorModeRef.current = floorMode;
  const activeSlotRef = useRef(activeSlotIndex);
  activeSlotRef.current = activeSlotIndex;
  const openSessionsRef = useRef(openSessions);
  openSessionsRef.current = openSessions;
  const newSessionSlotRef = useRef(-1);

  const selectedSession = openSessions[activeSlotIndex] ?? null;
  const setSelectedSession = useCallback((next: SessionSlot | null) => {
    if (!next) {
      setOpenSessions([]);
      setActiveSlotIndex(0);
      return;
    }
    const withKey = next.mountKey ? next : { ...next, mountKey: nextMountKey() };
    setOpenSessions(prev => {
      const existingIdx = prev.findIndex(s => s.agent === withKey.agent && s.sessionId === withKey.sessionId);
      if (existingIdx >= 0) {
        setActiveSlotIndex(existingIdx);
        return prev;
      }
      if (prev.length < layoutModeRef.current) {
        const newList = [...prev, withKey];
        setActiveSlotIndex(newList.length - 1);
        return newList;
      }
      if (layoutModeRef.current < MAX_LAYOUT) {
        const newList = [...prev, withKey];
        setLayoutMode(layoutForCount(newList.length, floorModeRef.current));
        setActiveSlotIndex(newList.length - 1);
        return newList;
      }
      const newList = [...prev];
      newList[activeSlotRef.current] = withKey;
      return newList;
    });
  }, [setOpenSessions, setActiveSlotIndex, setLayoutMode]);

  const [showAddDialog, setShowAddDialog] = useState(false);
  const [showNewSession, setShowNewSession] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<FilterMode>('all');
  const [liveSessionStates, setLiveSessionStates] = useState<Record<string, LiveSessionState>>({});
  const [promotionsByWs, setPromotionsByWs] = useState<Record<string, Record<string, string>>>({});
  const deferredSearch = useDeferredValue(search);
  const initializedRef = useRef(false);
  const inflightLoadsRef = useRef<Record<string, boolean>>({});
  const sessionsMapRef = useRef(sessionsMap);
  sessionsMapRef.current = sessionsMap;
  const liveSessionStatesRef = useRef(liveSessionStates);
  liveSessionStatesRef.current = liveSessionStates;
  const autoPrefetchedSessionsRef = useRef<Set<string>>(new Set());
  const hoverPrefetchTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  useEffect(() => () => {
    for (const timer of Object.values(hoverPrefetchTimersRef.current)) {
      clearTimeout(timer);
    }
  }, []);

  useEffect(() => {
    setOpenSessions(prev => {
      let changed = false;
      const next = prev.map(slot => {
        const promos = promotionsByWs[slot.workdir];
        if (!promos) return slot;
        const canonical = resolveCanonicalSessionId(promos, slot.agent, slot.sessionId);
        if (canonical === slot.sessionId) return slot;
        changed = true;
        return { ...slot, sessionId: canonical };
      });
      return changed ? next : prev;
    });
  }, [promotionsByWs, setOpenSessions]);

  const loadWorkspaces = useCallback(async () => {
    try {
      const res = await api.getWorkspaces();
      const list = res.ok ? res.workspaces : [];
      if (list.length) {
        setWorkspaces(prev => (
          prev.length === list.length
          && prev.every((p, i) => p.path === list[i].path && p.name === list[i].name)
            ? prev
            : list
        ));
      }
      initializedRef.current = true;
    } catch {
      initializedRef.current = true;
    } finally {
      setSidebarLoading(false);
    }
  }, []);

  useEffect(() => { loadWorkspaces(); }, [loadWorkspaces]);

  const loadSessionsForWorkspace = useCallback(async (
    wsPath: string,
    opts: { background?: boolean; force?: boolean } = {},
  ) => {
    if (inflightLoadsRef.current[wsPath]) return;
    inflightLoadsRef.current[wsPath] = true;
    if (!opts.background) {
      setLoadingMap(prev => ({ ...prev, [wsPath]: true }));
    }
    try {
      const res = await loadWorkspaceSessions(wsPath, { force: opts.force });
      startTransition(() => {
        setPromotionsByWs(prev => {
          const next = res.promotions || {};
          const cur = prev[wsPath];
          if (cur && Object.keys(cur).length === Object.keys(next).length
              && Object.entries(next).every(([k, v]) => cur[k] === v)) return prev;
          return { ...prev, [wsPath]: next };
        });
        setSessionsMap(prev => {
          const incoming = res.sessions || [];
          const existing = prev[wsPath] || [];
          const incomingIds = new Set(incoming.map(s => sKey(s.agent || '', s.sessionId)));
          const stubs = existing.filter(s => {
            if (s.runState !== 'running') return false;
            const key = sKey(s.agent || '', s.sessionId);
            if (incomingIds.has(key)) return false;
            const live = liveSessionStatesRef.current[key];
            return !(live?.resolvedKey && live.resolvedKey !== key);
          });
          return { ...prev, [wsPath]: stubs.length ? [...stubs, ...incoming] : incoming };
        });
      });
    } catch {
      if (!opts.background) {
        startTransition(() => {
          setSessionsMap(prev => ({ ...prev, [wsPath]: [] }));
        });
      }
    } finally {
      inflightLoadsRef.current[wsPath] = false;
      if (!opts.background) {
        setLoadingMap(prev => ({ ...prev, [wsPath]: false }));
      }
    }
  }, []);

  const runtimeWorkdirRef = useRef(runtimeWorkdir);
  useEffect(() => {
    if (runtimeWorkdir === runtimeWorkdirRef.current) return;
    runtimeWorkdirRef.current = runtimeWorkdir;
    if (!runtimeWorkdir || !initializedRef.current) return;
    loadWorkspaces().then(() => {
      void loadSessionsForWorkspace(runtimeWorkdir, { force: true });
    });
  }, [runtimeWorkdir, loadWorkspaces, loadSessionsForWorkspace]);

  const warmSession = useCallback((session: SessionInfo, workdir: string) => {
    const agent = session.agent || '';
    if (!agent || !session.sessionId) return;
    void preloadSessionPanel();
    prefetchSessionMessages({
      workdir,
      agent,
      sessionId: session.sessionId,
      rich: true,
      turnOffset: 0,
      turnLimit: SESSION_PREFETCH_TURNS,
    });
  }, []);

  const scheduleSessionWarmup = useCallback((session: SessionInfo, workdir: string, delayMs = HOVER_PREFETCH_DELAY_MS) => {
    const key = `${workdir}:${sKey(session.agent || '', session.sessionId)}`;
    const existing = hoverPrefetchTimersRef.current[key];
    if (existing) clearTimeout(existing);
    hoverPrefetchTimersRef.current[key] = setTimeout(() => {
      delete hoverPrefetchTimersRef.current[key];
      warmSession(session, workdir);
    }, delayMs);
  }, [warmSession]);

  const cancelScheduledWarmup = useCallback((session: SessionInfo, workdir: string) => {
    const key = `${workdir}:${sKey(session.agent || '', session.sessionId)}`;
    const existing = hoverPrefetchTimersRef.current[key];
    if (!existing) return;
    clearTimeout(existing);
    delete hoverPrefetchTimersRef.current[key];
  }, []);

  useEffect(() => {
    if (active) void preloadSessionPanel();
  }, [active]);

  useEffect(() => {
    if (!active) return;
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    workspaces.forEach((ws, index) => {
      if (sessionsMap[ws.path] || loadingMap[ws.path]) return;
      const timer = setTimeout(() => {
        void loadSessionsForWorkspace(ws.path);
      }, index * 90);
      timers.push(timer);
    });
    return () => {
      for (const timer of timers) clearTimeout(timer);
    };
  }, [active, loadSessionsForWorkspace, loadingMap, sessionsMap, workspaces]);

  const sessionsChangedTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useDashboardEvent(
    active && initializedRef.current && workspaces.length > 0 ? 'sessions-changed' : null,
    useCallback((event) => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      const eventKey = event.key;
      const targets = eventKey
        ? workspaces.filter(ws => (sessionsMapRef.current[ws.path] || []).some(s => sKey(s.agent || '', s.sessionId) === eventKey))
        : workspaces;
      const toRefresh = targets.length ? targets : workspaces;
      const timers = sessionsChangedTimers.current;
      for (const ws of toRefresh) {
        if (timers.has(ws.path)) clearTimeout(timers.get(ws.path)!);
        timers.set(ws.path, setTimeout(() => {
          timers.delete(ws.path);
          void loadSessionsForWorkspace(ws.path, { background: true, force: true });
        }, 300));
      }
    }, [workspaces, loadSessionsForWorkspace]),
  );

  const hydrateSession = useCallback((session: SessionInfo): SessionInfo => {
    const agent = session.agent || '';
    if (!agent || !session.sessionId) return session;
    return applyLiveSessionState(session, liveSessionStates[sKey(agent, session.sessionId)] || null);
  }, [liveSessionStates]);

  useDashboardEvent(
    'stream-update',
    useCallback((event) => {
      const key = event.key;
      if (!key) return;
      const live = normalizeLiveSessionState(key, event.snapshot ?? null);
      setLiveSessionStates(prev => {
        if (!live) {
          const cur = prev[key];
          if (!cur || cur.phase === 'done') return prev;
          return { ...prev, [key]: { ...cur, phase: 'done', updatedAt: Date.now() } };
        }

        const renderEqual = (a?: LiveSessionState, b?: LiveSessionState) =>
          !!a && !!b
          && a.phase === b.phase
          && a.resolvedKey === b.resolvedKey
          && a.sessionId === b.sessionId
          && a.incomplete === b.incomplete
          && a.error === b.error;
        const primaryUnchanged = renderEqual(prev[key], live);
        const resolvedUnchanged = live.resolvedKey === key
          || renderEqual(prev[live.resolvedKey], { ...live, key: live.resolvedKey });
        if (primaryUnchanged && resolvedUnchanged) return prev;

        const cutoff = Date.now() - LIVE_SESSION_STATE_MAX_AGE_MS;
        const next: Record<string, LiveSessionState> = {};
        for (const [entryKey, entry] of Object.entries(prev)) {
          if (entry.phase === 'done' && entry.updatedAt < cutoff) continue;
          next[entryKey] = entry;
        }
        next[key] = live;
        if (live.resolvedKey !== key) {
          next[live.resolvedKey] = { ...live, key: live.resolvedKey };
        }
        return next;
      });
    }, []),
  );

  useDashboardReconnect(useCallback(() => {
    if (!active || !initializedRef.current || workspaces.length === 0) return;
    for (const ws of workspaces) {
      void loadSessionsForWorkspace(ws.path, { background: true, force: true });
    }
  }, [active, workspaces, loadSessionsForWorkspace]));

  useEffect(() => {
    if (!active || !initializedRef.current || workspaces.length === 0) return;

    const refreshVisibleWorkspaces = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      for (const ws of workspaces) {
        void loadSessionsForWorkspace(ws.path, { background: true, force: true });
      }
    };

    refreshVisibleWorkspaces();

    if (typeof document === 'undefined' || typeof window === 'undefined') return;

    const handleVisible = () => {
      if (document.visibilityState !== 'visible') return;
      refreshVisibleWorkspaces();
    };

    document.addEventListener('visibilitychange', handleVisible);
    window.addEventListener('focus', handleVisible);
    return () => {
      document.removeEventListener('visibilitychange', handleVisible);
      window.removeEventListener('focus', handleVisible);
    };
  }, [active, loadSessionsForWorkspace, workspaces]);

  useEffect(() => {
    if (!active) return;
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    workspaces.forEach((ws, index) => {
      const candidate = (sessionsMap[ws.path] || [])[0];
      if (!candidate) return;
      const key = `${ws.path}:${sKey(candidate.agent || '', candidate.sessionId)}`;
      if (autoPrefetchedSessionsRef.current.has(key)) return;
      const timer = setTimeout(() => {
        autoPrefetchedSessionsRef.current.add(key);
        warmSession(candidate, ws.path);
      }, AUTO_PREFETCH_DELAY_MS + index * 120);
      timers.push(timer);
    });
    return () => {
      for (const timer of timers) clearTimeout(timer);
    };
  }, [active, sessionsMap, warmSession, workspaces]);

  const handleAddWorkspace = useCallback(async (wsPath: string) => {
    try {
      const res = await api.addWorkspace(wsPath);
      if (res.ok) { setShowAddDialog(false); await loadWorkspaces(); loadSessionsForWorkspace(wsPath); }
    } catch {}
  }, [loadWorkspaces, loadSessionsForWorkspace]);

  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const [extensionsWorkdir, setExtensionsWorkdir] = useState<string | null>(null);

  const handleRemoveWorkspace = useCallback((wsPath: string) => {
    setConfirmRemove(wsPath);
  }, []);

  const executeRemoveWorkspace = useCallback(async () => {
    const wsPath = confirmRemove;
    if (!wsPath) return;
    setRemoving(true);
    try {
      await api.removeWorkspace(wsPath);
      setWorkspaces(prev => prev.filter(w => w.path !== wsPath));
      setSessionsMap(prev => { const n = { ...prev }; delete n[wsPath]; return n; });
      setOpenSessions(prev => {
        const next = prev.filter(s => s.workdir !== wsPath);
        if (next.length !== prev.length) setLayoutMode(layoutForCount(next.length, floorModeRef.current));
        return next;
      });
      setActiveSlotIndex(0);
      setConfirmRemove(null);
    } catch {}
    finally { setRemoving(false); }
  }, [confirmRemove]);

  const handleRefreshWorkspace = useCallback((wsPath: string) => {
    void loadSessionsForWorkspace(wsPath, { force: true });
  }, [loadSessionsForWorkspace]);

  type DeleteSessionTarget = {
    workdir: string;
    agent: string;
    sessionId: string;
    title: string;
  };
  const [confirmDeleteSession, setConfirmDeleteSession] = useState<DeleteSessionTarget | null>(null);
  const [deleteSessionPurgeNative, setDeleteSessionPurgeNative] = useState(false);
  const [deletingSession, setDeletingSession] = useState(false);
  const toastSession = useStore(s => s.toast);

  const [sessionMenu, setSessionMenu] = useState<{
    anchor: { right: number; bottom: number };
    target: DeleteSessionTarget;
  } | null>(null);

  const handleSessionMenuOpen = useCallback((anchor: DOMRect, session: SessionInfo, wsPath: string) => {
    setSessionMenu({
      anchor: { right: anchor.right, bottom: anchor.bottom },
      target: {
        workdir: wsPath,
        agent: session.agent || '',
        sessionId: session.sessionId,
        title: sessionListDisplayText(session).slice(0, 120) || session.sessionId.slice(0, 16),
      },
    });
  }, []);

  useEffect(() => {
    if (!sessionMenu) return;
    const close = () => setSessionMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('mousedown', close);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [sessionMenu]);

  const openDeleteSessionModal = useCallback((target: DeleteSessionTarget) => {
    setDeleteSessionPurgeNative(false);
    setConfirmDeleteSession(target);
    setSessionMenu(null);
  }, []);

  const executeDeleteSession = useCallback(async () => {
    const target = confirmDeleteSession;
    if (!target) return;
    setDeletingSession(true);
    try {
      const res = await api.deleteSession(target.workdir, target.agent, target.sessionId, deleteSessionPurgeNative);
      if (!res.ok) {
        const msg = res.error?.includes('still running') ? t('session.deleteRunningError') : (res.error || t('session.deleteFailed'));
        toastSession(msg, false);
        return;
      }
      setSessionsMap(prev => {
        const list = prev[target.workdir];
        if (!list) return prev;
        const filtered = list.filter(s => !(s.agent === target.agent && s.sessionId === target.sessionId));
        if (filtered.length === list.length) return prev;
        return { ...prev, [target.workdir]: filtered };
      });
      setOpenSessions(prev => {
        const next = prev.filter(s => !(s.workdir === target.workdir && s.agent === target.agent && s.sessionId === target.sessionId));
        if (next.length !== prev.length) setLayoutMode(layoutForCount(next.length, floorModeRef.current));
        return next;
      });
      setConfirmDeleteSession(null);
    } catch (err: any) {
      toastSession(err?.message || t('session.deleteFailed'), false);
    } finally {
      setDeletingSession(false);
    }
  }, [confirmDeleteSession, deleteSessionPurgeNative, t, toastSession]);

  const clearSlotPending = useCallback((mountKey: string) => {
    setOpenSessions(prev => {
      let changed = false;
      const next = prev.map(s => {
        if (s.mountKey === mountKey && (s.pendingPrompt != null || s.pendingImageUrls)) {
          changed = true;
          return { ...s, pendingPrompt: null, pendingImageUrls: undefined };
        }
        return s;
      });
      return changed ? next : prev;
    });
  }, [setOpenSessions]);

  const handleNewSessionCreated = useCallback((next: { agent: string; sessionId: string; workdir: string }, pendingPrompt?: string, pendingImageUrls?: string[]) => {
    warmSession({ agent: next.agent, sessionId: next.sessionId, runState: 'running' }, next.workdir);
    setSessionsMap(prev => {
      const existing = prev[next.workdir] || [];
      const alreadyPresent = existing.some(s => s.sessionId === next.sessionId && s.agent === next.agent);
      if (alreadyPresent) return prev;
      const stub: SessionInfo = {
        sessionId: next.sessionId,
        agent: next.agent,
        runState: 'running',
        lastQuestion: pendingPrompt,
        createdAt: new Date().toISOString(),
        runUpdatedAt: new Date().toISOString(),
      };
      return { ...prev, [next.workdir]: [stub, ...existing] };
    });
    const targetSlot = newSessionSlotRef.current;
    const slot: SessionSlot = {
      ...next,
      mountKey: nextMountKey(),
      pendingPrompt: pendingPrompt || null,
      pendingImageUrls: pendingImageUrls && pendingImageUrls.length ? pendingImageUrls : undefined,
    };
    startTransition(() => {
      setShowNewSession(null);
      setOpenSessions(prev => {
        if (targetSlot >= prev.length) return [...prev, slot];
        const updated = [...prev];
        updated[targetSlot] = slot;
        return updated;
      });
      setActiveSlotIndex(targetSlot >= 0 ? targetSlot : 0);
    });
    void loadSessionsForWorkspace(next.workdir, { background: true, force: true });
  }, [loadSessionsForWorkspace, warmSession, setOpenSessions, setActiveSlotIndex]);

  const handleOpenNewSession = useCallback((wsPath: string) => {
    if (openSessionsRef.current.length >= layoutModeRef.current && layoutModeRef.current < MAX_LAYOUT) {
      setLayoutMode(layoutForCount(layoutModeRef.current + 1, floorModeRef.current));
    }
    setShowNewSession(wsPath);
  }, [setLayoutMode]);

  const handleCloseNewSession = useCallback(() => {
    setShowNewSession(null);
    setLayoutMode(layoutForCount(openSessionsRef.current.length, floorModeRef.current));
  }, [setLayoutMode]);

  const handleSelectSession = useCallback((session: SessionInfo, workdir: string) => {
    warmSession(session, workdir);
    const agent = session.agent || '';
    if (openSessionsRef.current.some(s => s.agent === agent && s.sessionId === session.sessionId)) {
      setLayoutMode(layoutForCount(openSessionsRef.current.length, floorModeRef.current));
    }
    setShowNewSession(null);
    startTransition(() => {
      setSelectedSession({ agent, sessionId: session.sessionId, workdir });
    });
  }, [warmSession, setLayoutMode]);

  const handlePanelSessionChange = useCallback((next: { agent: string; sessionId: string; workdir: string }, fromSlotIdx?: number) => {
    warmSession({ agent: next.agent, sessionId: next.sessionId, runState: 'running' }, next.workdir);
    startTransition(() => {
      if (fromSlotIdx != null) {
        setOpenSessions(prev => {
          if (fromSlotIdx >= prev.length) return prev;
          const updated = [...prev];
          updated[fromSlotIdx] = { ...prev[fromSlotIdx], agent: next.agent, sessionId: next.sessionId, workdir: next.workdir };
          return updated;
        });
        setActiveSlotIndex(fromSlotIdx);
      } else {
        setSelectedSession({ ...next, mountKey: nextMountKey() });
      }
    });
    void loadSessionsForWorkspace(next.workdir, { background: true, force: true });
  }, [loadSessionsForWorkspace, warmSession]);

  const filterFn = useCallback((sessions: SessionInfo[]): SessionInfo[] => {
    let result = sessions;
    if (filter === 'running') result = result.filter(s => sessionDisplayState(s) === 'running');
    else if (filter === 'review') result = result.filter(s => sessionDisplayState(s) === 'incomplete');
    if (deferredSearch.trim()) {
      const q = deferredSearch.toLowerCase();
      result = result.filter(s =>
        (s.lastMessageText || '').toLowerCase().includes(q)
        || (s.lastQuestion || '').toLowerCase().includes(q)
        || (s.lastAnswer || '').toLowerCase().includes(q)
        || (s.title || '').toLowerCase().includes(q)
        || (s.agent || '').toLowerCase().includes(q),
      );
    }
    return result;
  }, [deferredSearch, filter]);

  const filteredByWs = useMemo(() => {
    const out: Record<string, SessionInfo[]> = {};
    for (const ws of workspaces) {
      const all = (sessionsMap[ws.path] || []).map(hydrateSession);
      const promos = promotionsByWs[ws.path];
      const byCanonical = new Map<string, SessionInfo>();
      for (const s of all) {
        const key = sKey(s.agent || '', s.sessionId);
        const live = liveSessionStates[key];
        const promoted = promos ? resolveCanonicalSessionId(promos, s.agent || '', s.sessionId) : s.sessionId;
        const canonical = live?.resolvedKey && live.resolvedKey !== key
          ? live.resolvedKey
          : (promoted !== s.sessionId ? sKey(s.agent || '', promoted) : key);
        const prev = byCanonical.get(canonical);
        if (!prev) {
          byCanonical.set(canonical, s);
          continue;
        }
        const prevKey = sKey(prev.agent || '', prev.sessionId);
        if (prevKey !== canonical && key === canonical) byCanonical.set(canonical, s);
      }
      const filtered = filterFn([...byCanonical.values()]);
      out[ws.path] = groupForkDescendants(filtered);
    }
    return out;
  }, [workspaces, sessionsMap, liveSessionStates, promotionsByWs, filterFn, hydrateSession]);

  const resolveSlotInfo = useCallback((slot: SessionSlot): SessionInfo => {
    const resolved = (sessionsMap[slot.workdir] || []).find(
      s => s.sessionId === slot.sessionId && s.agent === slot.agent,
    ) ?? {
      sessionId: slot.sessionId,
      agent: slot.agent,
      runState: 'running' as const,
    };
    return hydrateSession(resolved);
  }, [hydrateSession, sessionsMap]);

  const openSessionKeys = useMemo(() => new Set(openSessions.map(s => sKey(s.agent, s.sessionId))), [openSessions]);
  const selectedKey = selectedSession ? sKey(selectedSession.agent, selectedSession.sessionId) : null;

  const handleCloseSlot = useCallback((index: number) => {
    setOpenSessions(prev => {
      const next = prev.filter((_, i) => i !== index);
      if (next.length === 0) {
        setActiveSlotIndex(0);
      } else if (activeSlotRef.current >= next.length) {
        setActiveSlotIndex(next.length - 1);
      }
      setLayoutMode(layoutForCount(next.length, floorModeRef.current));
      return next;
    });
  }, [setOpenSessions, setActiveSlotIndex, setLayoutMode]);

  return (
    <div className="h-full overflow-hidden p-4 flex gap-3 mx-auto">
      <div className="panel-isolated w-[252px] shrink-0 flex flex-col overflow-hidden rounded-xl border border-edge bg-panel backdrop-blur-sm" style={{ boxShadow: 'var(--th-card-shadow)' }}>
        <div className="px-3 pt-3 pb-2 space-y-2">
          <div className="relative group">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-5/40 group-focus-within:text-fg-4 transition-colors">
              <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder={t('hub.search')}
              className="w-full rounded-lg border border-edge/40 bg-inset/50 pl-8 pr-7 py-1.5 text-[12px] text-fg outline-none placeholder:text-fg-5/30 focus:border-primary/30 focus:bg-inset focus:shadow-[0_0_0_3px_rgba(99,102,241,0.06)] transition-all duration-200"
            />
            {search && (
              <button
                onClick={() => setSearch('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded text-fg-5/30 hover:text-fg-4 transition-colors"
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            )}
          </div>
          <div className="flex items-center rounded-lg bg-inset/30 border border-edge/20 p-0.5">
            {(['all', 'running', 'review'] as FilterMode[]).map(f => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={cn(
                  'flex-1 px-2 py-[5px] rounded-md text-[11px] font-medium transition-all duration-200',
                  filter === f
                    ? 'bg-panel-h text-fg-2 shadow-[0_1px_2px_rgba(0,0,0,0.1),inset_0_1px_0_rgba(255,255,255,0.04)]'
                    : 'text-fg-5/60 hover:text-fg-4',
                )}
              >
                {t(`hub.filter${f[0].toUpperCase() + f.slice(1)}` as 'hub.filterAll')}
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {sidebarLoading ? (
            <div className="flex items-center justify-center py-12">
              <Spinner className="h-4 w-4 text-fg-5" />
            </div>
          ) : workspaces.length === 0 && !showAddDialog ? (
            <div className="py-12 text-center text-[13px] text-fg-5">{t('hub.noWorkspaces')}</div>
          ) : (
            workspaces.map(ws => (
              <WorkspaceGroup
                key={ws.path}
                workspace={ws}
                sessions={filteredByWs[ws.path] || []}
                loading={!!loadingMap[ws.path] || !(ws.path in sessionsMap)}
                isActive={ws.path === runtimeWorkdir}
                selectedKey={selectedKey}
                openSessionKeys={openSessionKeys}
                onSelectSession={handleSelectSession}
                onNewSession={handleOpenNewSession}
                onRefresh={handleRefreshWorkspace}
                onRemove={handleRemoveWorkspace}
                onExtensions={setExtensionsWorkdir}
                onWarmSession={scheduleSessionWarmup}
                onCancelWarmSession={cancelScheduledWarmup}
                onSessionMenuOpen={handleSessionMenuOpen}
                t={t}
              />
            ))
          )}
        </div>

        <div className="shrink-0 border-t border-edge/20 px-3 py-2 space-y-1.5">
          <div className="flex items-center rounded-md bg-inset/30 border border-edge/20 p-0.5">
            {([1, 2, 3, 6] as const).map(mode => (
              <button
                key={mode}
                onClick={() => handleSelectLayoutMode(mode)}
                className={cn(
                  'flex-1 flex items-center justify-center p-1.5 rounded transition-all',
                  layoutMode === mode ? 'bg-panel-h text-fg-2 shadow-[0_1px_2px_rgba(0,0,0,0.1)]' : 'text-fg-5/40 hover:text-fg-4',
                )}
                title={t(`hub.layout${mode}` as 'hub.layout1')}
              >
                {mode === 1 ? (
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="2" y="2" width="12" height="12" rx="1.5" /></svg>
                ) : mode === 2 ? (
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="1" y="2" width="6" height="12" rx="1.5" /><rect x="9" y="2" width="6" height="12" rx="1.5" /></svg>
                ) : mode === 3 ? (
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="0.5" y="2" width="4" height="12" rx="1" /><rect x="6" y="2" width="4" height="12" rx="1" /><rect x="11.5" y="2" width="4" height="12" rx="1" /></svg>
                ) : (
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2"><rect x="0.5" y="1" width="4" height="5.5" rx="0.8" /><rect x="6" y="1" width="4" height="5.5" rx="0.8" /><rect x="11.5" y="1" width="4" height="5.5" rx="0.8" /><rect x="0.5" y="9.5" width="4" height="5.5" rx="0.8" /><rect x="6" y="9.5" width="4" height="5.5" rx="0.8" /><rect x="11.5" y="9.5" width="4" height="5.5" rx="0.8" /></svg>
                )}
              </button>
            ))}
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowAddDialog(v => !v)}
            className="w-full"
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            {t('hub.addWorkspace')}
          </Button>
        </div>
      </div>

      <div
        className="flex-1 min-w-0 flex flex-col overflow-hidden gap-0"
      >
        <div
          className="flex-1 min-h-0 grid gap-3"
          style={{
            gridTemplateColumns: `repeat(${layoutMode === 6 ? 3 : layoutMode}, 1fr)`,
            gridTemplateRows: layoutMode === 6 ? 'repeat(2, 1fr)' : '1fr',
          }}
        >
          {(() => {
            const newSessionSlot = !showNewSession ? -1
              : openSessions.length < layoutMode ? openSessions.length
              : activeSlotIndex;
            newSessionSlotRef.current = newSessionSlot;
            return Array.from({ length: layoutMode }, (_, slotIdx) => {
              if (showNewSession && slotIdx === newSessionSlot) {
                return (
                  <div key={`new-${showNewSession}`} className="min-w-0 overflow-hidden rounded-xl border border-edge bg-panel flex flex-col" style={{ boxShadow: 'var(--th-card-shadow)' }}>
                    <NewSessionView
                      key={showNewSession}
                      workdir={showNewSession}
                      workspaceName={workspaces.find(ws => ws.path === showNewSession)?.name || showNewSession.split('/').pop() || ''}
                      onSessionCreated={handleNewSessionCreated}
                      onClose={handleCloseNewSession}
                      t={t}
                    />
                  </div>
                );
              }
              const slot = openSessions[slotIdx] ?? null;
              if (!slot) {
                return (
                  <div
                    key={`empty-${slotIdx}`}
                    className="min-w-0 overflow-hidden rounded-xl border border-dashed border-edge/40 bg-panel/30 flex items-center justify-center"
                  >
                    <div className="text-center px-4">
                      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className="mx-auto text-fg-5/20 mb-2">
                        <rect x="3" y="3" width="18" height="18" rx="2" />
                        <line x1="12" y1="8" x2="12" y2="16" /><line x1="8" y1="12" x2="16" y2="12" />
                      </svg>
                      <div className="text-[12px] text-fg-5/40">{t('hub.emptySlot')}</div>
                    </div>
                  </div>
                );
              }
              const info = resolveSlotInfo(slot);
              const isActive = slotIdx === activeSlotIndex;
              return (
                <div
                  key={slot.mountKey || sKey(slot.agent, slot.sessionId)}
                  className={cn(
                    'min-w-0 overflow-hidden rounded-xl border bg-panel flex flex-col transition-[border-color,box-shadow] duration-200',
                    isActive
                      ? 'border-primary/40 ring-[3px] ring-primary/[0.06]'
                      : 'border-edge hover:border-edge-h',
                  )}
                  style={{ boxShadow: isActive ? 'var(--th-card-shadow), 0 0 0 1px rgba(14,165,233,0.08)' : 'var(--th-card-shadow)' }}
                  onClick={() => setActiveSlotIndex(slotIdx)}
                >
                  <div className={cn(
                    'shrink-0 flex items-center gap-2 px-2.5 h-8 border-b border-edge/30',
                    isActive ? 'bg-primary/[0.03]' : 'bg-panel/60',
                  )}>
                    {(() => {
                      const state = sessionDisplayState(info);
                      return <Dot variant={state === 'running' ? 'ok' : state === 'waiting' ? 'info' : state === 'incomplete' ? 'warn' : 'idle'} pulse={state === 'running' || state === 'waiting'} />;
                    })()}
                    <div className="flex-1 min-w-0 flex items-center gap-0">
                      <span className="shrink-0 text-[10px] font-medium text-fg-5">{slot.workdir.split('/').pop() || slot.workdir}</span>
                      <span className="shrink-0 text-fg-6 text-[10px] mx-1">/</span>
                      <span className="min-w-0 truncate text-[11px] font-medium text-fg-3">
                        {info.title || info.lastQuestion?.slice(0, 60) || (isPendingSessionId(slot.sessionId) ? t('hub.newSession') : slot.sessionId.slice(0, 12))}
                      </span>
                    </div>
                    <div className="shrink-0 flex items-center gap-2.5 pl-4 text-[9px] text-fg-5/50 tabular-nums">
                      <span title={t('hub.created')}>{fmtTime(info.createdAt)}</span>
                      {info.runUpdatedAt && <span title={t('hub.updated')}>{fmtRelative(info.runUpdatedAt)}</span>}
                      {!!info.numTurns && (
                        <span className="flex items-center gap-0.5">
                          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="opacity-60">
                            <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
                          </svg>
                          {info.numTurns}
                        </span>
                      )}
                      <button
                        data-filetree-toggle
                        onClick={e => { e.stopPropagation(); setFileTreeOpen(v => !v); }}
                        className={cn(
                          'p-0.5 rounded transition-colors',
                          fileTreeOpen ? 'text-fg-3 bg-panel-h' : 'text-fg-5/40 hover:text-fg-3 hover:bg-panel-h',
                        )}
                        title={t('hub.files')}
                      >
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M2 6a2 2 0 012-2h5l2 2h9a2 2 0 012 2v10a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" /></svg>
                      </button>
                      <button
                        onClick={e => { e.stopPropagation(); handleCloseSlot(slotIdx); }}
                        className="p-0.5 rounded text-fg-5/40 hover:text-fg-2 hover:bg-panel-h transition-colors"
                        title={t('hub.closePanel')}
                      >
                        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                          <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                      </button>
                    </div>
                  </div>
                  <div className="flex-1 min-h-0">
                    <Suspense fallback={<div className="h-full" />}>
                      <SessionPanel
                        key={slot.mountKey}
                        session={info}
                        workdir={slot.workdir}
                        active={active && isActive}
                        onSessionChange={(next) => handlePanelSessionChange(next, slotIdx)}
                        initialPendingPrompt={slot.pendingPrompt ?? null}
                        initialPendingImageUrls={slot.pendingImageUrls}
                        onPendingPromptConsumed={() => clearSlotPending(slot.mountKey)}
                      />
                    </Suspense>
                  </div>
                </div>
              );
            });
          })()}
        </div>
      </div>

      {fileTreeOpen && selectedSession && (
        <FloatingFileTree
          workdir={selectedSession.workdir}
          onClose={() => setFileTreeOpen(false)}
          t={t}
        />
      )}

      <AddWorkspaceModal
        open={showAddDialog}
        initialPath={runtimeWorkdir || undefined}
        onAdd={handleAddWorkspace}
        onClose={() => setShowAddDialog(false)}
        t={t}
      />

      <Modal open={!!confirmRemove} onClose={() => !removing && setConfirmRemove(null)}>
        <ModalHeader title={t('hub.removeWorkspace')} onClose={() => !removing && setConfirmRemove(null)} />
        <div className="text-[13px] text-fg-3 leading-relaxed">
          {t('modal.confirmRemoveWorkspace')}
        </div>
        <div className="mt-1 text-[12px] text-fg-5">
          {t('modal.confirmRemoveWorkspaceHint')}
        </div>
        {confirmRemove && (
          <div className="mt-3 rounded-md bg-inset/50 border border-edge/30 px-3 py-2 font-mono text-[11px] text-fg-4 break-all">
            {confirmRemove}
          </div>
        )}
        <div className="flex justify-end gap-2 mt-4">
          <Button variant="ghost" onClick={() => setConfirmRemove(null)} disabled={removing}>{t('modal.cancel')}</Button>
          <Button variant="primary" onClick={executeRemoveWorkspace} disabled={removing}
            className="!bg-red-500/90 !border-red-500/50 hover:!bg-red-500 !text-white"
          >
            {removing ? t('modal.removing') : t('modal.remove')}
          </Button>
        </div>
      </Modal>

      {sessionMenu && (() => {
        const MENU_WIDTH = 160;
        const left = Math.max(8, Math.min(sessionMenu.anchor.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - 8));
        const top = Math.min(sessionMenu.anchor.bottom + 4, window.innerHeight - 60);
        return (
          <div
            className="fixed z-[60] min-w-[160px] rounded-md border border-edge bg-panel/95 backdrop-blur-md py-1"
            style={{
              left,
              top,
              boxShadow: '0 8px 24px rgba(0,0,0,0.20), 0 2px 6px rgba(0,0,0,0.10)',
            }}
            onMouseDown={e => e.stopPropagation()}
            role="menu"
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => openDeleteSessionModal(sessionMenu.target)}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[12px] text-fg-2 hover:bg-panel-h/60 hover:text-red-400 transition-colors"
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" /><path d="M10 11v6" /><path d="M14 11v6" /><path d="M9 6V4a2 2 0 012-2h2a2 2 0 012 2v2" />
              </svg>
              {t('session.delete')}
            </button>
          </div>
        );
      })()}

      <Modal
        open={!!confirmDeleteSession}
        onClose={() => !deletingSession && setConfirmDeleteSession(null)}
      >
        <ModalHeader
          title={t('session.deleteTitle')}
          onClose={() => !deletingSession && setConfirmDeleteSession(null)}
        />
        <div className="text-[13px] text-fg-3 leading-relaxed">
          {t('session.deleteHint')}
        </div>
        {confirmDeleteSession && (
          <div className="mt-3 rounded-md bg-inset/50 border border-edge/30 px-3 py-2 text-[11px] text-fg-4 break-all">
            <span className="font-mono text-fg-5">{confirmDeleteSession.agent}</span>
            <span className="mx-1.5 text-fg-5/50">·</span>
            <span>{confirmDeleteSession.title}</span>
          </div>
        )}
        <div className="mt-4 space-y-2">
          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="radio"
              name="delete-session-scope"
              checked={!deleteSessionPurgeNative}
              onChange={() => setDeleteSessionPurgeNative(false)}
              disabled={deletingSession}
              className="mt-0.5"
            />
            <div className="flex-1">
              <div className="text-[12px] text-fg-2">{t('session.deletePikiloomOnly')}</div>
              <div className="text-[11px] text-fg-5 leading-snug mt-0.5">{t('session.deletePikiloomOnlyHint')}</div>
            </div>
          </label>
          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="radio"
              name="delete-session-scope"
              checked={deleteSessionPurgeNative}
              onChange={() => setDeleteSessionPurgeNative(true)}
              disabled={deletingSession}
              className="mt-0.5"
            />
            <div className="flex-1">
              <div className="text-[12px] text-fg-2">{t('session.deletePurgeNative')}</div>
              <div className="text-[11px] text-fg-5 leading-snug mt-0.5">{t('session.deletePurgeNativeHint')}</div>
            </div>
          </label>
        </div>
        <div className="flex justify-end gap-2 mt-4">
          <Button variant="ghost" onClick={() => setConfirmDeleteSession(null)} disabled={deletingSession}>
            {t('modal.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={executeDeleteSession}
            disabled={deletingSession}
            className="!bg-red-500/90 !border-red-500/50 hover:!bg-red-500 !text-white"
          >
            {deletingSession ? t('session.deleting') : t('modal.remove')}
          </Button>
        </div>
      </Modal>

      <WorkspaceExtensionsModal
        open={!!extensionsWorkdir}
        onClose={() => setExtensionsWorkdir(null)}
        workdir={extensionsWorkdir || ''}
      />
    </div>
  );
});

function AddWorkspaceModal({
  open,
  initialPath,
  onAdd,
  onClose,
  t,
}: {
  open: boolean;
  initialPath?: string;
  onAdd: (path: string) => void;
  onClose: () => void;
  t: (key: string) => string;
}) {
  const [selectedPath, setSelectedPath] = useState('');
  const handleSelect = useCallback((path: string) => setSelectedPath(path), []);

  useEffect(() => {
    if (open) setSelectedPath('');
  }, [open]);

  return (
    <Modal open={open} onClose={onClose}>
      <ModalHeader title={t('hub.addWorkspace')} onClose={onClose} />
      <DirBrowser
        initialPath={initialPath}
        maxHeight={360}
        minHeight={200}
        onSelect={handleSelect}
        t={t}
      />
      <div className="flex gap-2 mt-4">
        <Button
          disabled={!selectedPath}
          onClick={() => selectedPath && onAdd(selectedPath)}
          className="flex-1"
        >
          {t('hub.add')}
        </Button>
        <Button variant="secondary" onClick={onClose} className="flex-1">
          {t('hub.cancel')}
        </Button>
      </div>
    </Modal>
  );
}

function NewSessionView({
  workdir,
  workspaceName,
  onSessionCreated,
  onClose,
  t,
}: {
  workdir: string;
  workspaceName: string;
  onSessionCreated: (next: { agent: string; sessionId: string; workdir: string }, pendingPrompt?: string, pendingImageUrls?: string[]) => void;
  onClose: () => void;
  t: (key: string) => string;
}) {
  const [pendingPrompt, setPendingPrompt] = useState<string | null>(null);
  const [pendingImageUrls, setPendingImageUrls] = useState<string[]>([]);
  const pendingRef = useRef<string | null>(null);
  const pendingImageUrlsRef = useRef<string[]>([]);

  const stubSession = useMemo((): SessionInfo => ({
    sessionId: '',
    agent: '',
    runState: 'completed',
  }), []);

  const noop = useCallback(() => {}, []);

  const handleSendStart = useCallback((prompt: string, imageUrls?: string[]) => {
    setPendingPrompt(prompt || null);
    pendingRef.current = prompt || null;
    const urls = imageUrls || [];
    setPendingImageUrls(urls);
    pendingImageUrlsRef.current = urls;
  }, []);

  const handleSessionCreated = useCallback((next: { agent: string; sessionId: string; workdir: string }) => {
    const urls = pendingImageUrlsRef.current;
    pendingImageUrlsRef.current = [];
    onSessionCreated(next, pendingRef.current || undefined, urls.length ? urls : undefined);
  }, [onSessionCreated]);

  const hasPending = !!pendingPrompt || pendingImageUrls.length > 0;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="shrink-0 flex items-center gap-2 px-4 h-10 border-b border-edge/50 bg-panel/40 backdrop-blur-md z-10">
        <span className="flex-1 min-w-0 text-[13px] font-medium text-fg truncate">{t('hub.newSession')}</span>
        <span className="flex items-center gap-1 text-[10px] text-fg-5/60 shrink-0">
          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="opacity-60">
            <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
          </svg>
          <span className="max-w-[80px] truncate">{workspaceName}</span>
        </span>
        <Dot variant={hasPending ? 'ok' : 'idle'} pulse={hasPending} />
        {!hasPending && (
          <button
            onClick={onClose}
            className="p-1 rounded text-fg-5 hover:text-fg-2 transition-colors"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        {hasPending ? (
          <div className="max-w-[900px] mx-auto px-6 py-6 space-y-0">
            <UserBubble text={pendingPrompt || ''} blocks={pendingImageUrls.map(u => ({ type: 'image' as const, content: u }))} t={t} />
            <div className="mt-3 mb-4 animate-in">
              <ThinkingDots className="text-fg-5" />
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-center h-full">
            <div className="text-center space-y-1.5">
              <div className="text-[13px] text-fg-5">{t('hub.newSessionHint')}</div>
            </div>
          </div>
        )}
      </div>

      <InputComposer
        session={stubSession}
        workdir={workdir}
        onStreamQueued={noop}
        onSendStart={handleSendStart}
        onSessionChange={handleSessionCreated}
        t={t}
        streamPhase={null}
      />
    </div>
  );
}

function GitBadge({ git }: { git: GitStatus | null }) {
  if (!git) return null;
  const tip = [
    git.detached ? `detached HEAD${git.shortSha ? ` @ ${git.shortSha}` : ''}` : `branch ${git.branch ?? '?'}`,
    git.upstream ? `upstream ${git.upstream}` : git.detached ? '' : 'no upstream',
    git.ahead || git.behind ? `↑${git.ahead} ahead · ↓${git.behind} behind` : '',
    git.changed > 0
      ? `${git.changed} changed (${git.staged} staged · ${git.unstaged} unstaged · ${git.untracked} untracked)`
      : 'clean',
  ].filter(Boolean).join('\n');
  return (
    <Tooltip
      content={tip}
      className={cn(
        'shrink-0 items-center',
        git.changed > 0 ? 'text-amber-400/80' : git.ahead || git.behind ? 'text-sky-400/70' : 'text-fg-5/50',
      )}
      onClick={e => e.stopPropagation()}
    >
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="6" cy="6" r="2.5" /><circle cx="6" cy="18" r="2.5" /><circle cx="18" cy="8" r="2.5" />
        <path d="M6 8.5v7" /><path d="M18 10.5c0 4.5-6 3-6 7.5" />
      </svg>
    </Tooltip>
  );
}

const WorkspaceGroup = memo(function WorkspaceGroup({
  workspace,
  sessions,
  loading,
  isActive,
  selectedKey,
  openSessionKeys,
  onSelectSession,
  onNewSession,
  onRefresh,
  onRemove,
  onExtensions,
  onWarmSession,
  onCancelWarmSession,
  onSessionMenuOpen,
  t,
}: {
  workspace: WorkspaceEntry;
  sessions: SessionInfo[];
  loading: boolean;
  isActive?: boolean;
  selectedKey: string | null;
  openSessionKeys?: Set<string>;
  onSelectSession: (s: SessionInfo, wsPath: string) => void;
  onNewSession: (wsPath: string) => void;
  onRefresh: (wsPath: string) => void;
  onRemove: (wsPath: string) => void;
  onExtensions: (wsPath: string) => void;
  onWarmSession: (s: SessionInfo, wsPath: string) => void;
  onCancelWarmSession: (s: SessionInfo, wsPath: string) => void;
  onSessionMenuOpen: (anchor: DOMRect, s: SessionInfo, wsPath: string) => void;
  t: (key: string) => string;
}) {
  const [expanded, setExpanded] = useState(true);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  useEffect(() => { setVisibleCount(PAGE_SIZE); }, [sessions.length]);

  const visible = sessions.slice(0, visibleCount);
  const remaining = sessions.length - visibleCount;

  const wsPath = workspace.path;

  const [git, setGit] = useState<GitStatus | null>(null);
  const refreshGit = useCallback(() => {
    api.getWorkspaceGit(wsPath).then(r => setGit(r.git)).catch(() => setGit(null));
  }, [wsPath]);
  useEffect(() => { refreshGit(); }, [refreshGit]);

  return (
    <div className="border-b border-edge/30">
      <div
        className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-panel-h/50 transition-colors"
        onClick={() => setExpanded(v => !v)}
      >
        <svg
          width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
          className={cn('shrink-0 text-fg-5 transition-transform duration-150', expanded && 'rotate-90')}
        >
          <polyline points="9 6 15 12 9 18" />
        </svg>
        <div className="flex-1 min-w-0 flex items-center gap-1.5">
          <span className={cn('min-w-0 truncate text-[12px] font-semibold', isActive ? 'text-primary' : 'text-fg-3')}>
            {workspace.name}
          </span>
          <GitBadge git={git} />
        </div>
        {isActive && <Dot variant="ok" />}
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={e => { e.stopPropagation(); onNewSession(wsPath); }}
            className="p-1 rounded text-fg-5 hover:text-primary hover:bg-panel-h/60 transition-colors"
            title={t('hub.newSession')}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
          <button
            onClick={e => { e.stopPropagation(); onExtensions(wsPath); }}
            className="p-1 rounded text-fg-5 hover:text-primary hover:bg-panel-h/60 transition-colors"
            title={t('hub.extensions')}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 22v-5" /><path d="M9 8V2" /><path d="M15 8V2" /><path d="M18 8v5a6 6 0 0 1-12 0V8z" />
            </svg>
          </button>
          <button
            onClick={e => { e.stopPropagation(); onRefresh(wsPath); refreshGit(); }}
            className="p-1 rounded text-fg-5 hover:text-fg-2 hover:bg-panel-h/60 transition-colors"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
            </svg>
          </button>
          {!isActive && (
            <button
              onClick={e => { e.stopPropagation(); onRemove(wsPath); }}
              className="p-1 rounded text-fg-5 hover:text-red-400 hover:bg-panel-h/60 transition-colors"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {expanded && (
        <div className="pb-1">
          {loading ? (
            <div className="flex items-center justify-center py-4">
              <Spinner className="h-3 w-3 text-fg-5" />
            </div>
          ) : sessions.length === 0 ? (
            <div className="py-3 text-center text-[11px] text-fg-5">{t('sessions.noSessions')}</div>
          ) : (
            <>
              {visible.map(session => {
                const sk = sKey(session.agent || '', session.sessionId);
                const depth = (session as SessionInfo & { __forkDepth?: number }).__forkDepth || 0;
                return (
                  <SessionCard
                    key={sk}
                    session={session}
                    isSelected={selectedKey === sk}
                    isOpen={openSessionKeys?.has(sk) ?? false}
                    forkDepth={depth}
                    onClick={() => onSelectSession(session, wsPath)}
                    onWarm={() => onWarmSession(session, wsPath)}
                    onCancelWarm={() => onCancelWarmSession(session, wsPath)}
                    onShowMenu={anchor => onSessionMenuOpen(anchor, session, wsPath)}
                    menuLabel={t('session.openActions')}
                  />
                );
              })}
              {remaining > 0 && (
                <button
                  onClick={() => setVisibleCount(v => v + PAGE_SIZE)}
                  className="flex items-center gap-1.5 w-full px-3 py-1.5 text-[11px] text-fg-5 hover:text-fg-3 hover:bg-panel-h/50 transition-colors"
                >
                  <span>+ {t('hub.nMore').replace('{n}', String(remaining))}</span>
                  <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
});

const SessionCard = memo(function SessionCard({
  session,
  isSelected,
  isOpen,
  forkDepth = 0,
  onClick,
  onWarm,
  onCancelWarm,
  onShowMenu,
  menuLabel,
}: {
  session: SessionInfo;
  isSelected: boolean;
  isOpen?: boolean;
  forkDepth?: number;
  onClick: () => void;
  onWarm: () => void;
  onCancelWarm: () => void;
  onShowMenu: (anchor: DOMRect) => void;
  menuLabel: string;
}) {
  const meta = getAgentMeta(session.agent || '');
  const displayState = sessionDisplayState(session);
  const displayText = sessionListDisplayText(session).slice(0, 500) || (isPendingSessionId(session.sessionId) ? '' : session.sessionId.slice(0, 16));
  const contextText = sessionListContextText(session, displayText).slice(0, 500);
  const modelShort = session.model ? shortenModel(session.model) : null;
  const indentPx = forkDepth > 0 ? Math.min(forkDepth, 3) * 14 : 0;
  const baseLeftPx = isOpen ? 10 : 12;

  const kebabRef = useRef<HTMLButtonElement | null>(null);

  return (
    <div className="relative group">
    <button
      onClick={onClick}
      onMouseEnter={onWarm}
      onFocus={onWarm}
      onMouseLeave={onCancelWarm}
      onBlur={onCancelWarm}
      className={cn(
        'w-full pr-3 py-2 text-left transition-all duration-100',
        isSelected
          ? 'bg-selected hover:bg-selected-h'
          : isOpen
            ? 'bg-panel-h/30 hover:bg-panel-h/50'
            : 'hover:bg-panel-h/50',
      )}
      style={{
        paddingLeft: baseLeftPx + indentPx,
        ...(isOpen ? { borderLeft: `2px solid ${isSelected ? meta.color : `${meta.color}30`}` } : {}),
      }}
    >
      <div className="flex items-center gap-1.5 text-[10px] text-fg-5">
        {forkDepth > 0 && (
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-fg-5/60 shrink-0" aria-label="Fork">
            <circle cx="6" cy="6" r="2" /><circle cx="18" cy="6" r="2" /><circle cx="12" cy="20" r="2" />
            <path d="M6 8v3a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3V8" /><path d="M12 14v4" />
          </svg>
        )}
        <BrandIcon brand={session.agent || ''} size={10} />
        <span className="font-medium shrink-0" style={{ color: meta.color }}>{meta.shortLabel}</span>
        {modelShort && (
          <span className="truncate max-w-[72px] font-mono text-fg-5/40 text-[9px]">{modelShort}</span>
        )}
        <div className="ml-auto flex items-center gap-1.5 shrink-0 transition-opacity group-hover:opacity-0 group-focus-within:opacity-0">
          {!!session.numTurns && (
            <span className="flex items-center gap-0.5 text-fg-5/50 tabular-nums">
              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="opacity-50">
                <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
              </svg>
              {session.numTurns}
            </span>
          )}
          <span className="tabular-nums">{fmtRelative(session.runUpdatedAt || session.createdAt)}</span>
        </div>
      </div>
      <div className="mt-1 flex items-center gap-1.5">
        <Dot
          variant={displayState === 'running' ? 'ok' : displayState === 'waiting' ? 'info' : displayState === 'incomplete' ? 'warn' : 'idle'}
          pulse={displayState === 'running' || displayState === 'waiting'}
        />
        <span className="truncate text-[12px] leading-snug text-fg-2">{displayText}</span>
      </div>
      {contextText && (
        <div className="mt-0.5 pl-[11px]">
          <span className="block truncate text-[10px] leading-snug text-fg-5">{contextText}</span>
        </div>
      )}
    </button>
      <button
        ref={kebabRef}
        type="button"
        aria-label={menuLabel}
        aria-haspopup="menu"
        onMouseDown={e => { e.stopPropagation(); }}
        onClick={e => {
          e.stopPropagation();
          e.preventDefault();
          if (kebabRef.current) onShowMenu(kebabRef.current.getBoundingClientRect());
        }}
        className="absolute top-1.5 right-1.5 p-1 rounded text-fg-5 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:bg-panel-h hover:text-fg-2 transition-opacity"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="12" cy="5" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="12" cy="19" r="1.5" />
        </svg>
      </button>
    </div>
  );
});

const FloatingFileTree = memo(function FloatingFileTree({
  workdir,
  onClose,
  t,
}: {
  workdir: string;
  onClose: () => void;
  t: (key: string) => string;
}) {
  const hostApp = useStore(s => s.state?.hostApp ?? null);
  const platform = useStore(s => s.state?.platform ?? null);
  const toast = useStore(s => s.toast);
  const [openTarget, setOpenTarget] = useState<OpenTarget>(() => inferOpenTarget(hostApp, platform));

  const handleOpenPath = useCallback(async (targetPath: string) => {
    try {
      const res = await api.openInEditor(targetPath, openTarget);
      if (!res.ok) throw new Error(res.error || `Failed to open ${targetPath}`);
    } catch (error: any) {
      toast(error?.message || String(error), false);
    }
  }, [openTarget, toast]);

  return (
    <div
      className="fixed z-50 w-[280px] max-h-[calc(100vh-100px)] flex flex-col rounded-xl border border-edge bg-panel/95 backdrop-blur-md overflow-hidden"
      style={{
        boxShadow: '0 8px 32px rgba(0,0,0,0.18), 0 2px 8px rgba(0,0,0,0.12)',
        right: 16, top: 80,
      }}
    >
      <div className="shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 border-b border-edge/30">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="shrink-0 text-fg-5">
          <path d="M2 6a2 2 0 012-2h5l2 2h9a2 2 0 012 2v10a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
        </svg>
        <span className="flex-1 text-[10px] font-semibold text-fg-4 uppercase tracking-wider">{t('hub.files')}</span>
        <button
          onClick={onClose}
          className="p-0.5 rounded text-fg-5/40 hover:text-fg-2 transition-colors"
          title={t('hub.closePanel')}
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      <div className="shrink-0 px-2.5 py-1.5 border-b border-edge/20 flex items-center gap-2">
        <IconPicker
          value={openTarget}
          options={(platform === 'darwin' ? ['vscode', 'finder'] : ['vscode']).map(v => ({
            value: v,
            label: t(targetLabelKey(v as OpenTarget)),
          }))}
          onChange={value => { if (isOpenTarget(value)) setOpenTarget(value); }}
          renderIcon={v => <OpenTargetIcon target={v as OpenTarget} size={14} />}
        />
        <Button size="sm" variant="ghost" onClick={() => handleOpenPath(workdir)} className="flex-1 min-w-0 text-[11px]">
          {t('hub.openProject')}
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto px-1 py-1.5">
        <FileTree
          basePath={workdir}
          openTarget={openTarget}
          onOpenPath={handleOpenPath}
          t={t}
        />
      </div>
    </div>
  );
});

function OpenTargetIcon({ target, size = 16 }: { target: OpenTarget; size?: number; subtle?: boolean }) {
  if (target === 'default') {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" className="shrink-0 text-fg-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M6 3H4a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-2" />
        <path d="M9 2h5v5" />
        <path d="M14 2L7 9" />
      </svg>
    );
  }
  return <BrandIcon brand={target} size={size} />;
}

interface TreeNode {
  entry: DirEntry;
  expanded: boolean;
  children: TreeNode[] | null;
  loading: boolean;
}

function FileTree({
  basePath,
  includeHidden = false,
  openTarget,
  onOpenPath,
  t,
}: {
  basePath: string;
  includeHidden?: boolean;
  openTarget: OpenTarget;
  onOpenPath: (path: string) => void;
  t: (key: string) => string;
}) {
  const [nodes, setNodes] = useState<TreeNode[]>([]);
  const [rootLoading, setRootLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setRootLoading(true);
    api.lsDir(basePath, true, includeHidden)
      .then(res => {
        if (!cancelled && res.ok) {
          setNodes(res.dirs.slice(0, 50).map(e => ({ entry: e, expanded: false, children: null, loading: false })));
        }
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setRootLoading(false); });
    return () => { cancelled = true; };
  }, [basePath, includeHidden]);

  const toggleDir = useCallback((targetPath: string) => {
    const toggle = (list: TreeNode[]): TreeNode[] =>
      list.map(n => {
        if (n.entry.path === targetPath) {
          if (n.expanded) return { ...n, expanded: false };
          if (n.children === null) {
            api.lsDir(targetPath, true, includeHidden)
              .then(res => {
                if (res.ok) {
                  setNodes(prev => updateNode(prev, targetPath, {
                    children: res.dirs.slice(0, 50).map(e => ({ entry: e, expanded: false, children: null, loading: false })),
                    loading: false,
                  }));
                }
              })
              .catch(() => {
                setNodes(prev => updateNode(prev, targetPath, { children: [], loading: false }));
              });
            return { ...n, loading: true, expanded: true };
          }
          return { ...n, expanded: true };
        }
        if (n.children) return { ...n, children: toggle(n.children) };
        return n;
      });
    setNodes(prev => toggle(prev));
  }, [includeHidden]);

  if (rootLoading) return <div className="flex justify-center py-3"><Spinner className="h-3 w-3 text-fg-5" /></div>;
  if (nodes.length === 0) return <div className="py-3 text-center text-[11px] text-fg-5">—</div>;
  return <div className="space-y-px"><TreeLevel nodes={nodes} depth={0} onToggle={toggleDir} openTarget={openTarget} onOpenPath={onOpenPath} t={t} /></div>;
}

function TreeLevel({ nodes, depth, onToggle, openTarget, onOpenPath, t }: {
  nodes: TreeNode[];
  depth: number;
  onToggle: (path: string) => void;
  openTarget: OpenTarget;
  onOpenPath: (path: string) => void;
  t: (key: string) => string;
}) {
  return <>{nodes.map(node => <TreeItem key={node.entry.path} node={node} depth={depth} onToggle={onToggle} openTarget={openTarget} onOpenPath={onOpenPath} t={t} />)}</>;
}

function TreeItem({ node, depth, onToggle, openTarget, onOpenPath, t }: {
  node: TreeNode;
  depth: number;
  onToggle: (path: string) => void;
  openTarget: OpenTarget;
  onOpenPath: (path: string) => void;
  t: (key: string) => string;
}) {
  const { entry, expanded, children, loading } = node;
  const indent = depth * 14;
  const [hovered, setHovered] = useState(false);
  const openTargetLabel = t(targetLabelKey(openTarget));
  const openTitle = t('hub.openWithTarget').replace('{target}', openTargetLabel);

  return (
    <>
      <div
        onClick={entry.isDir ? () => onToggle(entry.path) : undefined}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        className={cn(
          'flex items-center gap-1.5 py-1 rounded text-[11px] text-fg-3 transition-colors',
          entry.isDir ? 'hover:bg-panel-h/50 cursor-pointer' : 'hover:bg-panel-h/50 cursor-default',
        )}
        style={{ paddingLeft: 8 + indent, paddingRight: 8 }}
      >
        {entry.isDir ? (
          loading ? <Spinner className="h-2 w-2 text-fg-5 shrink-0" /> : (
            <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
              className={cn('shrink-0 text-fg-5/40 transition-transform duration-150', expanded && 'rotate-90')}>
              <polyline points="9 6 15 12 9 18" />
            </svg>
          )
        ) : <span className="w-2 shrink-0" />}

        {entry.isDir ? (
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" className="shrink-0 text-blue-400/70">
            <path d="M2 6a2 2 0 012-2h5l2 2h9a2 2 0 012 2v10a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" fill="currentColor" opacity="0.25" stroke="currentColor" strokeWidth="1.5" />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="shrink-0 text-fg-5">
            <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" /><polyline points="14 2 14 8 20 8" />
          </svg>
        )}

        <span className="truncate flex-1">{entry.name}</span>

        {hovered && (
          <div className="flex items-center gap-0.5 shrink-0">
            <button
              onClick={e => { e.stopPropagation(); onOpenPath(entry.path); }}
              className="inline-flex items-center gap-1 rounded px-1 py-0.5 text-fg-5 hover:text-blue-400 transition-colors"
              title={openTitle}
            >
              <OpenTargetIcon target={openTarget} subtle />
            </button>
            {!entry.isDir && <CopyPathButton filePath={entry.path} t={t} />}
          </div>
        )}
      </div>
      {entry.isDir && expanded && children && children.length > 0 && (
        <TreeLevel nodes={children} depth={depth + 1} onToggle={onToggle} openTarget={openTarget} onOpenPath={onOpenPath} t={t} />
      )}
    </>
  );
}

function CopyPathButton({ filePath, t }: { filePath: string; t: (key: string) => string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={e => { e.stopPropagation(); navigator.clipboard.writeText(filePath).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => {}); }}
      className={cn('p-0.5 rounded transition-colors', copied ? 'text-ok' : 'text-fg-5 hover:text-fg-3')}
      title={t('hub.copied')}
    >
      {copied
        ? <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12" /></svg>
        : <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" /></svg>
      }
    </button>
  );
}

function updateNode(nodes: TreeNode[], targetPath: string, patch: Partial<TreeNode>): TreeNode[] {
  return nodes.map(n => {
    if (n.entry.path === targetPath) return { ...n, ...patch };
    if (n.children) return { ...n, children: updateNode(n.children, targetPath, patch) };
    return n;
  });
}
