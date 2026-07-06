import { useState, useEffect, useLayoutEffect, useRef, useCallback, memo, useMemo } from 'react';
import { useStore } from '../../store';
import { createT } from '../../i18n';
import { api } from '../../api';
import { loadSessionMessages, peekSessionMessages } from '../../session-preload';
import { useDashboardEvent, useDashboardReconnect, type DashboardEvent } from '../../ws';
import { cn, foldUltraEffort, getAgentMeta, getSessionRunFailureDetail, shortenModel, sessionDisplayState } from '../../utils';
import { Spinner, Modal, ModalHeader, Button } from '../../components/ui';
import { hasPlan } from '../../components/PlanProgressCard';
import type { InteractionSnapshot, MessageBlock, QueuedTaskPreview, SessionInfo, StreamPlan, StreamPreviewMeta, StreamSubAgent, SnapshotArtifact } from '../../types';
import { TurnView, UserBubble, TurnDivider } from './TurnView';
import { LivePreview, ThinkingDots, liveStreamShouldRender, liveStreamHasBody, RunEndNotice } from './LivePreview';
import { InputComposer } from './InputComposer';
import { InteractionPromptModal } from './InteractionPromptModal';
import { sendWillQueue, optimisticSendWasQueued, doneAppliesToLivePreview, shouldShowTrailingLoader } from './queue-logic';
import {
  snapshotGate,
  nextAppliedUpdatedAt,
  filterTombstonedIds,
  pruneTombstones,
  type SnapshotSource,
} from './stream-reconcile';
import {
  normalizeTurnHistory,
  mergeOlderHistory,
  mergeLatestHistory,
  sameUserText,
  displayPromptForPending,
  promptEndsWithUserPrompt,
  streamPromptMatchesTurnText,
  type Turn,
  type TurnHistoryWindow,
} from './utils';

const SESSION_PAGE_TURNS = 12;
const TOP_LOAD_THRESHOLD_PX = 160;
const BOTTOM_STICK_THRESHOLD_PX = 96;

const EMPTY_TASK_IDS: string[] = [];
const EMPTY_QUEUED_TASKS: QueuedTaskPreview[] = [];
const EMPTY_INTERACTIONS: InteractionSnapshot[] = [];

const MAX_HISTORY_SNAPSHOTS = 20;
const RECALL_TOMBSTONE_TTL_MS = 60_000;
// How long a local hold (pending send / active stream view) may go without any non-null
// snapshot before a null seed is allowed through to reconcile the panel from disk. Long
// enough that a slow first token or a tool-quiet stretch never trips it (live turns keep
// refreshing the anchor via WS/poll snapshots), short enough that a worker replaced under
// the tab self-heals instead of requiring a manual refresh.
const STREAM_HOLD_TTL_MS = 15_000;
// WS-independent safety net: while the panel believes a task is live, re-seed stream-state
// on this cadence so a silently dead socket still converges (see holdExpired above).
const STREAM_POLL_INTERVAL_MS = 7_000;
const historySnapshots = new Map<string, TurnHistoryWindow>();
function snapshotKey(agent: string, sessionId: string) { return `${agent}:${sessionId}`; }

function saveHistorySnapshot(key: string, h: TurnHistoryWindow) {
  historySnapshots.delete(key);
  historySnapshots.set(key, h);
  while (historySnapshots.size > MAX_HISTORY_SNAPSHOTS) {
    historySnapshots.delete(historySnapshots.keys().next().value!);
  }
}

export const SessionPanel = memo(function SessionPanel({
  session, workdir, active = true, onSessionChange, initialPendingPrompt, initialPendingImageUrls, onPendingPromptConsumed,
}: {
  session: SessionInfo;
  workdir: string;
  active?: boolean;
  onSessionChange?: (next: { agent: string; sessionId: string; workdir: string }) => void;
  initialPendingPrompt?: string | null;
  initialPendingImageUrls?: string[];
  onPendingPromptConsumed?: () => void;
}) {
  const locale = useStore(s => s.locale);
  const agentRuntime = useStore(s => s.agentStatus?.agents?.find(a => a.agent === session.agent) ?? null);
  const globalEffort = agentRuntime?.selectedEffort ?? null;
  const globalModel = agentRuntime?.selectedModel ?? null;
  // Provider/profile shown for THIS session must reflect its OWN binding (session.profileId),
  // not the agent's GLOBAL active profile — else a session switched to a native model still shows
  // the global BYOK provider it no longer uses (e.g. "via 豆包火山" on a native gpt-5.5 turn).
  // Tri-state: undefined = legacy/unbound → global; null = native (no provider); string = that profile.
  const modelLayer = useStore(s => s.modelLayer);
  const sessionProfile = session.profileId
    ? (modelLayer?.profiles.find(p => p.id === session.profileId) ?? null)
    : null;
  const sessionProvider = sessionProfile
    ? (modelLayer?.providers.find(pr => pr.id === sessionProfile.providerId) ?? null)
    : null;
  const byokProviderName = session.profileId === undefined
    ? (agentRuntime?.byokProviderName ?? null)
    : (sessionProvider?.name ?? null);
  const byokProfileName = session.profileId === undefined
    ? (agentRuntime?.byokProfileName ?? null)
    : (sessionProfile && sessionProfile.name.trim().toLowerCase() !== sessionProfile.modelId.trim().toLowerCase()
        ? sessionProfile.name
        : null);
  const t = useMemo(() => createT(locale), [locale]);
  const meta = getAgentMeta(session.agent || '');
  const displayState = sessionDisplayState(session);

  const hasInitialPending = !!initialPendingPrompt || !!(initialPendingImageUrls && initialPendingImageUrls.length);
  const [history, setHistory] = useState<TurnHistoryWindow | null>(null);
  const [loading, setLoading] = useState(!hasInitialPending);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [liveStream, setLiveStream] = useState<{
    taskId: string | null;
    phase: 'streaming' | 'done';
    text: string;
    thinking: string;
    activity?: string;
    plan?: StreamPlan | null;
    model?: string | null;
    effort?: string | null;
    previewMeta?: StreamPreviewMeta | null;
    subAgents?: StreamSubAgent[] | null;
    generatingImages?: number;
    artifacts?: SnapshotArtifact[] | null;
    startedAt?: number | null;
    error?: string | null;
    question?: string | null;
    questionBlocks?: MessageBlock[] | null;
  } | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [streamPhase, setStreamPhase] = useState<string | null>(null);
  const [streamPollNonce, setStreamPollNonce] = useState(0);
  const [streamTaskId, setStreamTaskId] = useState<string | null>(null);
  const [queuedTaskIds, setQueuedTaskIds] = useState<string[]>([]);
  const [queuedTasks, setQueuedTasks] = useState<QueuedTaskPreview[]>([]);
  const [interactions, setInteractions] = useState<InteractionSnapshot[]>([]);
  const [pendingPrompt, setPendingPrompt] = useState<string | null>(initialPendingPrompt || null);
  const [pendingImageUrls, setPendingImageUrls] = useState<string[]>(initialPendingImageUrls || []);
  const [pendingTaskId, setPendingTaskId] = useState<string | null>(null);
  const pendingTaskIdRef = useRef<string | null>(null);
  pendingTaskIdRef.current = pendingTaskId;
  const pendingPromptRef = useRef<string | null>(pendingPrompt);
  pendingPromptRef.current = pendingPrompt;
  type PendingQueuedSend = { localId: string; taskId: string | null; prompt: string; imageUrls: string[] };
  const [pendingQueuedSends, setPendingQueuedSends] = useState<PendingQueuedSend[]>([]);
  const pendingQueuedSendsRef = useRef<PendingQueuedSend[]>([]);
  pendingQueuedSendsRef.current = pendingQueuedSends;
  const lastSendQueuedLocalIdRef = useRef<string | null>(null);
  const [editDraft, setEditDraft] = useState<string | null>(null);
  const [forkRequest, setForkRequest] = useState<{ atTurn: number } | null>(null);
  const [forkPrompt, setForkPrompt] = useState('');
  const [forkSubmitting, setForkSubmitting] = useState(false);
  const canFork = !!agentRuntime?.capabilities?.fork;
  const submitForkRef = useRef<(() => Promise<void>) | null>(null);
  const pendingImageUrlsRef = useRef<string[]>(initialPendingImageUrls || []);
  const liveStreamRef = useRef(liveStream);
  const streamingRef = useRef(streaming);
  liveStreamRef.current = liveStream;
  streamingRef.current = streaming;
  const queuedTaskIdsRef = useRef<string[]>(queuedTaskIds);
  queuedTaskIdsRef.current = queuedTaskIds;
  const streamPhaseRef = useRef<string | null>(streamPhase);
  streamPhaseRef.current = streamPhase;
  const scrollRef = useRef<HTMLDivElement>(null);
  const prependAnchorRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);
  const stickToBottomRef = useRef(true);
  const scrollToBottomRef = useRef(false);
  const loadingLatestRef = useRef<string | null>(null);
  const loadingOlderRef = useRef(false);
  const localStreamPendingRef = useRef(hasInitialPending);
  const clearPendingOnLoadRef = useRef(false);
  const clearLiveStreamOnLoadRef = useRef<{ taskId: string | null } | true | false>(false);
  const initialPendingConsumedRef = useRef(false);
  const promotingRef = useRef(false);
  const reconcileTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastAppliedUpdatedAtRef = useRef(0);
  // Last proof-of-life for the local hold: refreshed by every applied non-null snapshot and by
  // each local send. When a null seed arrives and this is older than the TTL, the task the hold
  // was waiting for no longer exists anywhere (worker replaced under the tab) — see holdExpired.
  const holdAnchorRef = useRef(Date.now());
  const recalledTombstonesRef = useRef<Map<string, number>>(new Map());
  const composerSelectionRef = useRef<{ model: string | null; effort: string | null }>({ model: null, effort: null });
  const handleComposerSelectionChange = useCallback((sel: { model: string | null; effort: string | null }) => {
    composerSelectionRef.current = sel;
  }, []);

  useEffect(() => {
    if (initialPendingConsumedRef.current || !hasInitialPending) return;
    initialPendingConsumedRef.current = true;
    if (initialPendingPrompt && !pendingPrompt) setPendingPrompt(initialPendingPrompt);
    if (initialPendingImageUrls && initialPendingImageUrls.length && !pendingImageUrls.length) {
      setPendingImageUrls(initialPendingImageUrls);
      pendingImageUrlsRef.current = initialPendingImageUrls;
    }
    setLoading(false);
    setStreamPollNonce(n => n + 1);
    onPendingPromptConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasInitialPending, onPendingPromptConsumed]);

  const clearPending = useCallback(() => {
    setPendingPrompt(null);
    setPendingImageUrls(prev => { for (const u of prev) URL.revokeObjectURL(u); return []; });
    pendingImageUrlsRef.current = [];
    setPendingTaskId(null);
  }, []);

  const clearPendingQueuedSends = useCallback(() => {
    setPendingQueuedSends(prev => {
      if (!prev.length) return prev;
      for (const s of prev) for (const url of s.imageUrls) URL.revokeObjectURL(url);
      return [];
    });
    lastSendQueuedLocalIdRef.current = null;
  }, []);

  const handleSendStart = useCallback((prompt: string, imageUrls?: string[]) => {
    holdAnchorRef.current = Date.now();
    const willBeQueued = sendWillQueue({
      streaming: streamingRef.current,
      liveStreamPhase: liveStreamRef.current?.phase ?? null,
      streamPhase: streamPhaseRef.current,
      queuedTaskCount: queuedTaskIdsRef.current.length,
      pendingQueuedCount: pendingQueuedSendsRef.current.length,
    });
    const urls = imageUrls || [];
    if (willBeQueued) {
      const localId = `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      lastSendQueuedLocalIdRef.current = localId;
      setPendingQueuedSends(prev => [...prev, { localId, taskId: null, prompt: prompt || '', imageUrls: urls }]);
      return;
    }
    if (liveStreamRef.current?.phase === 'done') setLiveStream(null);
    for (const u of pendingImageUrlsRef.current) URL.revokeObjectURL(u);
    lastSendQueuedLocalIdRef.current = null;
    setPendingPrompt(prompt || null);
    setPendingImageUrls(urls);
    pendingImageUrlsRef.current = urls;
    setPendingTaskId(null);
  }, []);

  const handleSendTaskAssigned = useCallback((taskId: string) => {
    const queuedLocalId = lastSendQueuedLocalIdRef.current;
    if (queuedLocalId) {
      lastSendQueuedLocalIdRef.current = null;
      setPendingQueuedSends(prev => {
        const idx = prev.findIndex(s => s.localId === queuedLocalId);
        if (idx < 0) return prev;
        const next = prev.slice();
        next[idx] = { ...next[idx], taskId };
        return next;
      });
      return;
    }
    setPendingTaskId(taskId);
  }, []);

  const submitFork = useCallback(async () => {
    if (!forkRequest) return;
    const trimmed = forkPrompt.trim();
    if (!trimmed) return;
    setForkSubmitting(true);
    try {
      const res = await api.forkSession(
        workdir,
        session.agent || '',
        session.sessionId,
        forkRequest.atTurn,
        trimmed,
        {},
      );
      if (!res.ok || !res.sessionKey) {
        setForkSubmitting(false);
        return;
      }
      const [agent, sessionId] = res.sessionKey.split(':');
      setForkRequest(null);
      setForkPrompt('');
      onSessionChange?.({ agent, sessionId, workdir });
    } finally {
      setForkSubmitting(false);
    }
  }, [forkRequest, forkPrompt, workdir, session.agent, session.sessionId, onSessionChange]);
  submitForkRef.current = submitFork;

  const fetchTurnWindow = useCallback(async (
    query: { turnOffset?: number; turnLimit?: number; lastNTurns?: number },
    opts: { force?: boolean } = {},
  ) => {
    try {
      const res = await loadSessionMessages({
        workdir,
        agent: session.agent || '',
        sessionId: session.sessionId,
        rich: true,
        turnOffset: query.turnOffset,
        turnLimit: query.turnLimit,
        lastNTurns: query.lastNTurns,
      }, { force: opts.force });
      if (!res.ok) return null;
      return normalizeTurnHistory(res);
    } catch {
      return null;
    }
  }, [workdir, session.agent, session.sessionId]);

  const loadLatestTurns = useCallback(async ({ keepOlder, force = false, scrollToBottom = false }: { keepOlder: boolean; force?: boolean; scrollToBottom?: boolean }) => {
    const callSessionId = session.sessionId;
    if (loadingLatestRef.current === callSessionId) return false;
    loadingLatestRef.current = callSessionId;
    try {
      const next = await fetchTurnWindow({ turnOffset: 0, turnLimit: SESSION_PAGE_TURNS }, { force });
      if (!next) return false;
      if (session.sessionId !== callSessionId) return false;
      if (scrollToBottom) scrollToBottomRef.current = true;
      setHistory(current => {
        if (!current || !keepOlder) return next;
        return mergeLatestHistory(current, next);
      });
      setLoading(false);
      if (clearPendingOnLoadRef.current) {
        clearPendingOnLoadRef.current = false;
        clearPending();
      }
      if (clearLiveStreamOnLoadRef.current) {
        const pending = clearLiveStreamOnLoadRef.current;
        clearLiveStreamOnLoadRef.current = false;
        const scopedTaskId = pending !== true ? pending.taskId : null;
        const owned = !!liveStreamRef.current
          && (pending === true || liveStreamRef.current.taskId === scopedTaskId);
        if (owned) setLiveStream(null);
      }
      return true;
    } finally {
      if (loadingLatestRef.current === callSessionId) {
        loadingLatestRef.current = null;
      }
    }
  }, [fetchTurnWindow, clearPending, session.sessionId]);

  const loadOlderTurns = useCallback(async () => {
    if (!history?.hasOlder || loadingOlderRef.current) return;
    const el = scrollRef.current;
    if (el) prependAnchorRef.current = { scrollHeight: el.scrollHeight, scrollTop: el.scrollTop };
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    try {
      const next = await fetchTurnWindow({
        turnOffset: Math.max(0, history.totalTurns - history.startTurn),
        turnLimit: SESSION_PAGE_TURNS,
      });
      if (next) setHistory(current => current ? mergeOlderHistory(current, next) : next);
      else prependAnchorRef.current = null;
    } finally {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    }
  }, [fetchTurnWindow, history]);

  const prevPhaseRef = useRef<'queued' | 'streaming' | 'done' | null>(null);

  const applyStreamSnapshot = useCallback((state: any | null, source: SnapshotSource = 'ws') => {
    const holdsActiveState = streamingRef.current || queuedTaskIdsRef.current.length > 0;
    const holdExpired = Date.now() - holdAnchorRef.current > STREAM_HOLD_TTL_MS;
    const decision = snapshotGate({
      updatedAt: state?.updatedAt,
      isNull: !state,
      source,
      lastAppliedUpdatedAt: lastAppliedUpdatedAtRef.current,
      localStreamPending: localStreamPendingRef.current,
      holdsActiveState,
      holdExpired,
    });
    if (decision !== 'apply') return;
    // An applied null that only got through because the hold expired = the worker serving this
    // tab was replaced (or the send's task died with it). Reconcile from disk instead of
    // wedging: drop the local echo and reload the transcript — the self-service version of the
    // manual refresh users had to do.
    const expiredHoldReconcile = !state && holdExpired && (localStreamPendingRef.current || holdsActiveState);
    if (state) {
      holdAnchorRef.current = Date.now();
      lastAppliedUpdatedAtRef.current = nextAppliedUpdatedAt(lastAppliedUpdatedAtRef.current, state.updatedAt);
    }
    if (state?.sessionId && state.sessionId !== session.sessionId) {
      promotingRef.current = true;
      sessionKeyRef.current = `${session.agent}:${state.sessionId}`;
      onSessionChange?.({ agent: session.agent || '', sessionId: state.sessionId, workdir });
    }
    if (!state) {
      const prev = prevPhaseRef.current;
      setStreaming(false);
      if (expiredHoldReconcile) {
        localStreamPendingRef.current = false;
        clearPendingOnLoadRef.current = true;
        clearLiveStreamOnLoadRef.current = true;
        clearPendingQueuedSends();
        void loadLatestTurns({ keepOlder: true, force: true, scrollToBottom: stickToBottomRef.current });
      } else if (prev === 'streaming') {
        clearPendingOnLoadRef.current = true;
        clearLiveStreamOnLoadRef.current = true;
        void loadLatestTurns({ keepOlder: true, force: true, scrollToBottom: stickToBottomRef.current });
      } else {
        setLiveStream(null);
      }
      if (expiredHoldReconcile) {
        // handled above — echo dropped, transcript reload in flight
      } else if (localStreamPendingRef.current && prev !== 'streaming') {
        void loadLatestTurns({ keepOlder: true, force: true });
      } else {
        if (prev === 'done') {
          clearPending();
          clearPendingQueuedSends();
        }
        if (prev !== null) localStreamPendingRef.current = false;
      }
      setStreamTaskId(null);
      setStreamPhase(null);
      setQueuedTaskIds([]);
      setQueuedTasks([]);
      setInteractions([]);
      prevPhaseRef.current = null;
      return;
    }
    setStreamPhase(state.phase);
    setStreamTaskId(state.taskId || null);
    const authoritativeIds: string[] = [];
    if (state.taskId) authoritativeIds.push(state.taskId);
    if (Array.isArray(state.queuedTaskIds)) authoritativeIds.push(...state.queuedTaskIds);
    recalledTombstonesRef.current = pruneTombstones(recalledTombstonesRef.current, authoritativeIds, Date.now(), RECALL_TOMBSTONE_TTL_MS);
    const tomb = recalledTombstonesRef.current;
    const visibleQueuedTaskIds = filterTombstonedIds(state.queuedTaskIds, tomb);
    const visibleQueuedTasks = (Array.isArray(state.queuedTasks) ? state.queuedTasks : [])
      .filter((qt: { taskId: string }) => !tomb.has(qt.taskId));
    setQueuedTaskIds(visibleQueuedTaskIds.length ? visibleQueuedTaskIds : EMPTY_TASK_IDS);
    setQueuedTasks(visibleQueuedTasks.length ? visibleQueuedTasks : EMPTY_QUEUED_TASKS);
    setInteractions(Array.isArray(state.interactions) && state.interactions.length ? state.interactions : EMPTY_INTERACTIONS);
    if (optimisticSendWasQueued({
      pendingTaskId: pendingTaskIdRef.current,
      streamTaskId: state.taskId || null,
      queuedTaskIds: state.queuedTaskIds,
    })) {
      const pendingId = pendingTaskIdRef.current!;
      const demotedPrompt = pendingPromptRef.current || '';
      const demotedImages = pendingImageUrlsRef.current;
      setPendingQueuedSends(prev => prev.some(s => s.taskId === pendingId)
        ? prev
        : [...prev, { localId: `demote-${pendingId}`, taskId: pendingId, prompt: demotedPrompt, imageUrls: demotedImages }]);
      setPendingPrompt(null);
      setPendingImageUrls([]);
      pendingImageUrlsRef.current = [];
      setPendingTaskId(null);
      pendingTaskIdRef.current = null;
    }
    if (state.phase === 'streaming') {
      setLiveStream({
        taskId: state.taskId || null,
        phase: 'streaming',
        text: state.text || '',
        thinking: state.thinking || '',
        activity: state.activity,
        plan: state.plan ?? null,
        model: state.model ?? null,
        effort: state.effort ?? null,
        previewMeta: state.previewMeta ?? null,
        subAgents: state.previewMeta?.subAgents ?? null,
        generatingImages: state.previewMeta?.generatingImages ?? 0,
        artifacts: state.artifacts ?? null,
        startedAt: typeof state.startedAt === 'number' ? state.startedAt : null,
        error: null,
        question: state.question ?? null,
        questionBlocks: state.questionBlocks ?? null,
      });
      setStreaming(true);
      if (state.taskId && state.taskId !== pendingTaskIdRef.current) {
        const queue = pendingQueuedSendsRef.current;
        const idx = queue.findIndex(s => s.taskId === state.taskId);
        if (idx >= 0) {
          const promoted = queue[idx];
          for (const url of pendingImageUrlsRef.current) URL.revokeObjectURL(url);
          setPendingPrompt(promoted.prompt || null);
          setPendingImageUrls(promoted.imageUrls);
          pendingImageUrlsRef.current = promoted.imageUrls;
          setPendingTaskId(state.taskId);
          setPendingQueuedSends(prev => prev.filter((_, i) => i !== idx));
        }
      }
      if (stickToBottomRef.current) scrollToBottomRef.current = true;
    } else if (state.phase === 'queued') {
      setLiveStream(null);
      setStreaming(false);
    } else if (state.phase === 'done') {
      const doneForCurrent = doneAppliesToLivePreview(liveStreamRef.current?.taskId ?? null, state.taskId || null);
      const hasMoreQueued = visibleQueuedTaskIds.length > 0;
      if (doneForCurrent) {
        setStreaming(false);
        setLiveStream(prev => prev
          ? { ...prev, phase: 'done', error: state.error ?? null }
          : state.error
            ? {
                taskId: state.taskId || null,
                phase: 'done',
                text: '',
                thinking: '',
                activity: '',
                plan: null,
                model: state.model ?? null,
                effort: state.effort ?? null,
                previewMeta: state.previewMeta ?? null,
                subAgents: state.previewMeta?.subAgents ?? null,
                generatingImages: state.previewMeta?.generatingImages ?? 0,
                artifacts: state.artifacts ?? null,
                error: state.error,
                question: state.question ?? null,
                questionBlocks: state.questionBlocks ?? null,
              }
            : prev);
        const live = liveStreamRef.current;
        const hasPartialBody = !!live && liveStreamHasBody(live);
        const freezePartial = !!state.incomplete && hasPartialBody && !hasMoreQueued;
        if (prevPhaseRef.current !== 'done') {
          if (!hasMoreQueued) clearPendingOnLoadRef.current = true;
          clearLiveStreamOnLoadRef.current = freezePartial ? false : { taskId: state.taskId || null };
          void loadLatestTurns({ keepOlder: true, force: true, scrollToBottom: stickToBottomRef.current });
          const recAgent = session.agent || '';
          const recSid = session.sessionId;
          const recKey = sessionKeyRef.current;
          if (reconcileTimerRef.current) clearTimeout(reconcileTimerRef.current);
          reconcileTimerRef.current = setTimeout(() => {
            reconcileTimerRef.current = null;
            void api.getSessionStreamState(recAgent, recSid)
              .then(res => { if (sessionKeyRef.current === recKey) applyStreamSnapshotRef.current(res.state, 'seed'); })
              .catch(() => {});
          }, 900);
        }
      }
      if (!hasMoreQueued) localStreamPendingRef.current = false;
    }
    const liveTaskIds = new Set<string>();
    if (state.taskId) liveTaskIds.add(state.taskId);
    if (Array.isArray(state.queuedTaskIds)) for (const id of state.queuedTaskIds) liveTaskIds.add(id);
    setPendingQueuedSends(prev => {
      let changed = false;
      const next: PendingQueuedSend[] = [];
      for (const send of prev) {
        if (!send.taskId || liveTaskIds.has(send.taskId)) {
          next.push(send);
        } else {
          for (const url of send.imageUrls) URL.revokeObjectURL(url);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
    prevPhaseRef.current = state.phase;
  }, [clearPending, clearPendingQueuedSends, loadLatestTurns, session.sessionId, session.agent, onSessionChange, workdir]);

  const applyStreamSnapshotRef = useRef(applyStreamSnapshot);
  applyStreamSnapshotRef.current = applyStreamSnapshot;

  const requestStreamPolling = useCallback(() => {
    localStreamPendingRef.current = true;
    holdAnchorRef.current = Date.now();
    setStreamPollNonce(current => current + 1);
  }, []);

  useEffect(() => () => {
    if (reconcileTimerRef.current) { clearTimeout(reconcileTimerRef.current); reconcileTimerRef.current = null; }
  }, []);

  const handleRecallTask = useCallback(async (taskId: string) => {
    try {
      recalledTombstonesRef.current.set(taskId, Date.now());
      await api.recallSessionMessage(taskId);
      if (pendingTaskIdRef.current === taskId) clearPending();
      setPendingQueuedSends(prev => {
        let changed = false;
        const next: PendingQueuedSend[] = [];
        for (const send of prev) {
          if (send.taskId === taskId) {
            for (const url of send.imageUrls) URL.revokeObjectURL(url);
            changed = true;
          } else {
            next.push(send);
          }
        }
        return changed ? next : prev;
      });
      setQueuedTaskIds(prev => prev.filter(id => id !== taskId));
      setQueuedTasks(prev => prev.filter(t => t.taskId !== taskId));
      setStreamTaskId(prev => prev === taskId ? null : prev);
    } catch {}
  }, [clearPending]);

  const handleSteerTask = useCallback(async (taskId: string) => {
    // Steering interrupts the current turn so this queued task jumps ahead as a fresh turn.
    // During the interrupt→start transition the task briefly leaves both the running slot and
    // the queue, so the queue-prune (which revokes blob URLs of sends that leave liveTaskIds)
    // would drop its attached images before the snapshot-driven promotion can claim them — the
    // bubble then falls back to the live-question path, which renders text but no image.
    // Promote the send's prompt + images into the live bubble HERE (transfer blob ownership,
    // never revoke) so the image survives and renders via the optimistic pending path.
    const promoted = pendingQueuedSendsRef.current.find(s => s.taskId === taskId) || null;
    if (promoted && promoted.imageUrls.length > 0) {
      for (const u of pendingImageUrlsRef.current) URL.revokeObjectURL(u);
      setPendingPrompt(promoted.prompt || null);
      setPendingImageUrls(promoted.imageUrls);
      pendingImageUrlsRef.current = promoted.imageUrls;
      setPendingTaskId(taskId);
      pendingTaskIdRef.current = taskId;
      setPendingQueuedSends(prev => prev.filter(s => s.taskId !== taskId));
    }
    try { await api.steerSession(taskId); } catch {}
  }, []);

  const handleStopAll = useCallback(async () => {
    try {
      await api.stopSession(session.agent || '', session.sessionId);
    } catch {  }
  }, [session.agent, session.sessionId]);

  const sk = snapshotKey(session.agent || '', session.sessionId);
  useEffect(() => {
    if (promotingRef.current) {
      promotingRef.current = false;
      let cancelled = false;
      void loadLatestTurns({ keepOlder: true, force: true }).finally(() => { if (!cancelled) setLoading(false); });
      return () => { cancelled = true; };
    }
    let c = false;
    const cachedLatest = peekSessionMessages({
      workdir,
      agent: session.agent || '',
      sessionId: session.sessionId,
      rich: true,
      turnOffset: 0,
      turnLimit: SESSION_PAGE_TURNS,
    }, { allowStale: true });
    const isNewSession = hasInitialPending && !initialPendingConsumedRef.current;
    const initialHistory = cachedLatest?.ok
      ? normalizeTurnHistory(cachedLatest)
      : historySnapshots.get(sk) || null;
    setLoading(isNewSession ? false : !initialHistory);
    setHistory(initialHistory);
    setLiveStream(null);
    setStreaming(false);
    setStreamPhase(null);
    setQueuedTaskIds([]);
    setQueuedTasks([]);
    setInteractions([]);
    lastAppliedUpdatedAtRef.current = 0;
    holdAnchorRef.current = Date.now();
    recalledTombstonesRef.current = new Map();
    if (!isNewSession) {
      clearPending();
      clearPendingQueuedSends();
      localStreamPendingRef.current = false;
      clearPendingOnLoadRef.current = false;
      clearLiveStreamOnLoadRef.current = false;
    }
    stickToBottomRef.current = true;
    scrollToBottomRef.current = true;
    if (!isNewSession) {
      loadLatestTurns({ keepOlder: false, force: true }).finally(() => { if (!c) setLoading(false); });
    }
    return () => { c = true; };
  }, [loadLatestTurns, session.agent, session.sessionId, workdir, sk, clearPending, clearPendingQueuedSends]);

  useEffect(() => {
    if (history && history.turns.length > 0) saveHistorySnapshot(sk, history);
  }, [sk, history]);

  useEffect(() => {
    if (!active) return;
    void loadLatestTurns({ keepOlder: true, force: true });
  }, [active, loadLatestTurns]);

  const sessionKeyRef = useRef(`${session.agent}:${session.sessionId}`);
  sessionKeyRef.current = `${session.agent}:${session.sessionId}`;

  useDashboardEvent(
    'stream-update',
    useCallback((event: DashboardEvent) => {
      if (event.key !== sessionKeyRef.current) return;
      applyStreamSnapshot(event.snapshot ?? null);
    }, [applyStreamSnapshot]),
  );

  useEffect(() => {
    let mounted = true;
    void api.getSessionStreamState(session.agent || '', session.sessionId).then(res => {
      if (mounted) applyStreamSnapshotRef.current(res.state, 'seed');
    }).catch(() => {});
    return () => { mounted = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.agent, session.sessionId, streamPollNonce]);

  useDashboardReconnect(useCallback(() => {
    void api.getSessionStreamState(session.agent || '', session.sessionId).then(res => {
      applyStreamSnapshot(res.state, 'seed');
    }).catch(() => {});
    void loadLatestTurns({ keepOlder: true, force: true });
  }, [applyStreamSnapshot, session.agent, session.sessionId, loadLatestTurns]));

  // WS-independent safety net: while this panel believes a task is live (streaming, queued, or
  // a just-sent local echo), re-seed stream-state on an interval. If the worker was replaced
  // under the tab (socket silently dead, task gone with the old worker), the polls return null
  // and the hold-TTL path in applyStreamSnapshot reconciles the panel from disk — instead of a
  // send that shows nothing and a view that only recovers on manual refresh.
  const pollHoldActive = streaming || !!streamPhase || queuedTaskIds.length > 0
    || !!pendingPrompt || pendingQueuedSends.length > 0;
  useEffect(() => {
    if (!active || !pollHoldActive) return;
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      void api.getSessionStreamState(session.agent || '', session.sessionId)
        .then(res => applyStreamSnapshotRef.current(res.state, 'seed'))
        .catch(() => {});
    }, STREAM_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [active, pollHoldActive, session.agent, session.sessionId]);

  useEffect(() => {
    if (!localStreamPendingRef.current
        && displayState !== 'running' && !streaming && !liveStream
        && !streamPhase && queuedTaskIds.length === 0) {
      clearPending();
      clearPendingQueuedSends();
    }
  }, [displayState, streaming, liveStream, streamPhase, queuedTaskIds.length, clearPending, clearPendingQueuedSends]);

  useLayoutEffect(() => {
    const anchor = prependAnchorRef.current;
    const el = scrollRef.current;
    if (!anchor || !el) return;
    prependAnchorRef.current = null;
    el.scrollTop = anchor.scrollTop + (el.scrollHeight - anchor.scrollHeight);
  }, [history?.turns.length]);

  useLayoutEffect(() => {
    if (!scrollToBottomRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    scrollToBottomRef.current = false;
    el.scrollTop = el.scrollHeight;
    requestAnimationFrame(() => {
      if (stickToBottomRef.current) el.scrollTop = el.scrollHeight;
    });
  }, [history, liveStream]);

  useLayoutEffect(() => {
    if (!pendingPrompt) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [pendingPrompt]);

  useEffect(() => {
    if (!history?.hasOlder || loading || loadingOlder) return;
    const el = scrollRef.current;
    if (!el) return;
    if (el.scrollHeight <= el.clientHeight + TOP_LOAD_THRESHOLD_PX) {
      void loadOlderTurns();
    }
  }, [history?.hasOlder, history?.turns.length, loadOlderTurns, loading, loadingOlder]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const remaining = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = remaining <= BOTTOM_STICK_THRESHOLD_PX;
    if (el.scrollTop <= TOP_LOAD_THRESHOLD_PX) void loadOlderTurns();
  }, [loadOlderTurns]);

  const displayModel = (liveStream?.model || session.model || globalModel) || null;
  const displayEffort = foldUltraEffort(
    session.agent || '',
    (liveStream?.effort || session.thinkingEffort || globalEffort) || null,
    session.workflowEnabled ?? agentRuntime?.workflowEnabled,
  ) || null;
  const displayModelShort = (byokProfileName && (!displayModel || displayModel === globalModel))
    ? byokProfileName
    : (displayModel ? shortenModel(displayModel) : null);
  const runFailureDetail = getSessionRunFailureDetail(session, {
    streaming,
    hasLiveStream: !!liveStream,
    streamPhase,
    queuedTaskCount: queuedTaskIds.length,
  });

  const rawTurns = history?.turns || [];
  const optimisticBridgesImages = useMemo(() => {
    if (!pendingImageUrls.length || !rawTurns.length) return false;
    const last = rawTurns[rawTurns.length - 1];
    if (!last.user) return false;
    if (!sameUserText(last.user.text, pendingPrompt)) return false;
    const serverImages = last.user.blocks.filter(b => b.type === 'image').length;
    return serverImages < pendingImageUrls.length;
  }, [rawTurns, pendingPrompt, pendingImageUrls.length]);
  const pendingBubbleBlocks = useMemo<MessageBlock[]>(() => {
    if (pendingImageUrls.length) {
      return pendingImageUrls.map(u => ({ type: 'image' as const, content: u }));
    }
    if (!pendingPrompt || !liveStream?.questionBlocks?.length) return [];
    if (!sameUserText(pendingPrompt, liveStream.question)) return [];
    return liveStream.questionBlocks;
  }, [pendingImageUrls, pendingPrompt, liveStream]);
  const liveQuestion = liveStream?.question || null;
  const effectiveStreamPrompt = displayPromptForPending(pendingPrompt, liveQuestion);
  const liveQuestionCoversPending = promptEndsWithUserPrompt(liveQuestion, pendingPrompt);
  const rawLastUserText = rawTurns.length > 0 ? rawTurns[rawTurns.length - 1]?.user?.text : null;
  const pendingAlreadyInHistory = !!effectiveStreamPrompt
    && rawTurns.length > 0
    && streamPromptMatchesTurnText(rawLastUserText, effectiveStreamPrompt);

  const turns = useMemo(() => {
    let result = rawTurns;
    if (optimisticBridgesImages) {
      const last = result[result.length - 1];
      result = [...result.slice(0, -1), { ...last, user: null }];
    }
    if (!liveStream || !result.length) return result;
    const last = result[result.length - 1];
    const streamPrompt = effectiveStreamPrompt;
    if (!last.assistant) {
      const shouldReplaceUser = !!last.user && !!streamPrompt
        && !sameUserText(last.user.text, streamPrompt)
        && (streamPromptMatchesTurnText(last.user.text, streamPrompt)
          || promptEndsWithUserPrompt(streamPrompt, last.user.text));
      return shouldReplaceUser
        ? [...result.slice(0, -1), { ...last, user: { ...last.user!, text: streamPrompt } }]
        : result;
    }
    const liveText = (liveStream.text || '').trim();
    const lastAssistantText = last.assistant.text?.trim() || '';
    const isStreamingTurn = streamPrompt != null
      ? streamPromptMatchesTurnText(last.user?.text, streamPrompt)
      : !!lastAssistantText && !!liveText
        && (liveText.startsWith(lastAssistantText) || lastAssistantText.startsWith(liveText));
    if (!isStreamingTurn) return result;
    // If the history turn is only a truncated preview of the streaming prompt, show the
    // authoritative full prompt instead of the truncated text.
    const user = last.user && streamPrompt && !sameUserText(last.user.text, streamPrompt)
      ? { ...last.user, text: streamPrompt }
      : last.user;
    return [...result.slice(0, -1), { ...last, user, assistant: null }];
  }, [rawTurns, liveStream, effectiveStreamPrompt, optimisticBridgesImages]);

  // A loading affordance is already on screen when the optimistic pending bubble shows its own
  // dots, or when the live preview is actively streaming (it renders its own live-status row).
  const pendingBubbleShown = (!!pendingPrompt || pendingBubbleBlocks.length > 0)
    && !liveQuestionCoversPending
    && (optimisticBridgesImages || !pendingAlreadyInHistory);
  const pendingBubbleDots = pendingBubbleShown && !liveStream;
  const liveTurnStreaming = !!liveStream && liveStreamShouldRender(liveStream) && liveStream.phase === 'streaming';
  // Keep the "still working" affordance alive whenever the session is in progress but nothing
  // above is already showing it — e.g. a turn has reconciled into history while the next task
  // is only queued, or a follow-up turn is running but its snapshot hasn't reached us yet.
  const showTrailingLoader = shouldShowTrailingLoader({
    sessionRunning: displayState === 'running',
    streaming,
    streamPhase,
    queuedTaskCount: queuedTaskIds.length,
    pendingQueuedCount: pendingQueuedSends.length,
    liveTurnStreaming,
    pendingBubbleDots,
  });

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto overscroll-contain">
        {loading && !pendingPrompt && !pendingImageUrls.length && !liveStream ? (
          <div className="flex items-center justify-center py-20"><Spinner className="h-5 w-5 text-fg-4" /></div>
        ) : turns.length === 0 && !pendingPrompt && !pendingImageUrls.length && !liveStream && !runFailureDetail ? (
          <div className="py-20 text-center text-[13px] text-fg-5">{t('hub.noMessages')}</div>
        ) : (
          <div className="max-w-[900px] mx-auto px-6 py-6 space-y-0">
            {(history?.hasOlder || loadingOlder) && (
              <div className="mb-4 flex items-center justify-center gap-2 text-[11px] text-fg-5">
                {loadingOlder ? <Spinner className="h-3 w-3 text-fg-5" /> : <span className="h-1.5 w-1.5 rounded-full bg-fg-5/35" />}
                <span>{loadingOlder ? t('hub.loadingOlderTurns') : t('hub.loadOlderTurnsHint')}</span>
              </div>
            )}
            {session.migratedFrom?.kind === 'fork' && session.migratedFrom.sessionId && (
              <button
                type="button"
                onClick={() => onSessionChange?.({
                  agent: session.migratedFrom!.agent || session.agent || '',
                  sessionId: session.migratedFrom!.sessionId,
                  workdir,
                })}
                className="mb-4 inline-flex items-center gap-1.5 rounded-md border border-edge bg-panel-alt px-2.5 py-1 text-[11px] text-fg-5 transition hover:border-edge-h hover:text-fg-2"
                title={`#${session.migratedFrom.sessionId.slice(0, 8)}`}
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="6" cy="6" r="2" /><circle cx="18" cy="6" r="2" /><circle cx="12" cy="20" r="2" />
                  <path d="M6 8v3a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3V8" /><path d="M12 14v4" />
                </svg>
                <span>{t('hub.forkBadge')}</span>
                <span className="font-mono">#{session.migratedFrom.sessionId.slice(0, 8)}</span>
                {typeof session.migratedFrom.forkedAtTurn === 'number' && (
                  <span className="text-fg-5/70">· {t('hub.forkBadgeAt').replace('{turn}', String(session.migratedFrom.forkedAtTurn + 1))}</span>
                )}
              </button>
            )}
            {turns.map((turn, i) => {
              const absoluteTurnIndex = (history?.startTurn || 0) + i;
              return (
                <TurnView key={`${history?.startTurn || 0}:${i}`}
                  turn={turn}
                  turnIndex={absoluteTurnIndex}
                  agent={session.agent || ''} meta={meta} model={displayModelShort} effort={displayEffort} providerName={byokProviderName} t={t}
                  workdir={workdir}
                  onResend={(txt) => {
                    scrollToBottomRef.current = true;
                    handleSendStart(txt);
                    const sel = composerSelectionRef.current;
                    api.sendSessionMessage(workdir, session.agent || '', session.sessionId, txt, {
                      model: sel.model || displayModel || undefined,
                      effort: sel.effort || displayEffort || undefined,
                    })
                      .then((res) => { if (res.ok) requestStreamPolling(); })
                      .catch(() => { clearPending(); });
                  }}
                  onEdit={(txt) => setEditDraft(txt)}
                  onFork={canFork ? (atTurn) => { setForkPrompt(''); setForkRequest({ atTurn }); } : undefined}
                />
              );
            })}
            {runFailureDetail && <div className="mb-5 animate-in"><RunEndNotice detail={runFailureDetail} t={t} /></div>}
            {(pendingPrompt || pendingBubbleBlocks.length > 0)
              && !liveQuestionCoversPending
              && (optimisticBridgesImages || !pendingAlreadyInHistory) && (
              <div className="session-turn">
                <UserBubble text={pendingPrompt || ''} blocks={pendingBubbleBlocks} t={t} />
                {!liveStream && (
                  <div className="mt-3 mb-5 animate-in">
                    <ThinkingDots className="text-fg-5" />
                  </div>
                )}
              </div>
            )}
            {liveStream && liveStreamShouldRender(liveStream) && liveStream.question
              && (!pendingPrompt || liveQuestionCoversPending)
              && !(rawTurns.length > 0
                   && streamPromptMatchesTurnText(rawLastUserText, liveStream.question)) && (
              <div className="session-turn">
                <UserBubble text={liveStream.question} blocks={liveStream.questionBlocks || undefined} t={t} />
              </div>
            )}
            {liveStream && liveStreamShouldRender(liveStream) && (
              <div className="mb-6">
                <TurnDivider agent={session.agent || ''} meta={meta} model={displayModelShort} effort={displayEffort} providerName={byokProviderName} previewMeta={liveStream.previewMeta} hideContextUsage />
                <LivePreview stream={liveStream} t={t} workdir={workdir} />
              </div>
            )}
            {showTrailingLoader && (
              <div className="mt-3 mb-5 animate-in">
                <ThinkingDots className="text-fg-5" />
              </div>
            )}
            <div className="h-4" />
          </div>
        )}
      </div>

      <InputComposer
        session={session}
        workdir={workdir}
        onStreamQueued={requestStreamPolling}
        onSendStart={handleSendStart}
        onSendTaskAssigned={handleSendTaskAssigned}
        onSessionChange={onSessionChange}
        t={t}
        streamPhase={streamPhase}
        streamTaskId={streamTaskId}
        queuedTaskIds={queuedTaskIds}
        queuedTasks={queuedTasks}
        pendingQueuedSends={pendingQueuedSends}
        onRecall={handleRecallTask}
        onSteer={handleSteerTask}
        onStopAll={handleStopAll}
        editDraft={editDraft}
        onEditDraftConsumed={() => setEditDraft(null)}
        onSelectionChange={handleComposerSelectionChange}
      />

      {forkRequest && (
        <Modal open onClose={() => { if (!forkSubmitting) setForkRequest(null); }}>
          <ModalHeader
            title={t('hub.forkPromptTitle')}
            description={t('hub.forkPromptHint')}
            onClose={() => { if (!forkSubmitting) setForkRequest(null); }}
          />
          <textarea
            autoFocus
            value={forkPrompt}
            disabled={forkSubmitting}
            onChange={(e) => setForkPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && forkPrompt.trim() && !forkSubmitting) {
                e.preventDefault();
                void submitForkRef.current?.();
              }
            }}
            placeholder={t('hub.forkPromptPlaceholder')}
            className="w-full min-h-[120px] resize-y rounded-md border border-edge bg-panel-alt px-3 py-2 text-[13px] leading-relaxed text-fg outline-none focus:border-edge-h"
          />
          <div className="mt-4 flex items-center justify-end gap-2">
            <Button variant="ghost" disabled={forkSubmitting} onClick={() => setForkRequest(null)}>
              {t('modal.cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={forkSubmitting || !forkPrompt.trim()}
              onClick={() => void submitForkRef.current?.()}
            >
              {forkSubmitting ? t('hub.forkSubmitting') : t('hub.forkSubmit')}
            </Button>
          </div>
        </Modal>
      )}

      {active && interactions.length > 0 && (
        <InteractionPromptModal
          key={interactions[interactions.length - 1].promptId}
          snapshot={interactions[interactions.length - 1]}
        />
      )}
    </div>
  );
});
