import { useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback, memo } from 'react';
import { createPortal } from 'react-dom';
import { AGENT_ACCEPTED_PROVIDER_KINDS, cn, EFFORT_OPTIONS, foldUltraEffort, getAgentMeta, isPendingSessionId, shortenModel } from '../../utils';
import { usageWindowTone, worstUsageWindow } from '../../usage';
import { api } from '../../api';
import { useStore } from '../../store';
import { Spinner } from '../../components/ui';
import { BrandIcon } from '../../components/BrandIcon';
import { visibleQueuedIds } from './queue-logic';
import {
  makeComposerImageAttachment,
  revokeComposerAttachments,
  formatFileSize,
  copyImageFile,
  parseSessionKey,
  type ComposerImageAttachment,
} from './utils';
import type { SessionInfo, AgentRuntimeStatus, SkillInfo } from '../../types';

type CascadeStep = 'closed' | 'agent' | 'model' | 'effort';

const draftStore = new Map<string, { text: string; files: File[] }>();
function draftKey(agent: string, sessionId: string) { return `${agent}:${sessionId}`; }

function brandIdForProvider(p: { kind: string; baseURL: string }): string {
  const host = (() => { try { return new URL(p.baseURL).host.toLowerCase(); } catch { return ''; } })();
  if (host.includes('openrouter')) return 'openrouter';
  if (host.includes('anthropic')) return 'anthropic';
  if (host.includes('deepseek')) return 'deepseek';
  if (host.includes('googleapis') || host.includes('vertex')) return 'google';
  if (host.includes('openai.com')) return 'openai';
  if (host.includes('dashscope') || host.includes('qwen') || host.includes('aliyun')) return 'qwen';
  if (host.includes('volces') || host.includes('volcengine') || host.includes('doubao')) return 'doubao';
  if (host.includes('bigmodel') || host.includes('zhipu') || host.includes('z.ai')) return 'glm';
  if (host.includes('minimax')) return 'minimax';
  if (p.kind === 'anthropic') return 'anthropic';
  if (p.kind === 'google') return 'google';
  if (p.kind === 'openai') return 'openai';
  return 'custom';
}

export const InputComposer = memo(function InputComposer({ session, workdir, onStreamQueued, onSendStart, onSendTaskAssigned, onSessionChange, t, streamPhase, streamTaskId, queuedTaskIds, queuedTasks, pendingQueuedSends, onRecall, onSteer, onStopAll, editDraft, onEditDraftConsumed, onSelectionChange }: {
  session: SessionInfo;
  workdir: string;
  onStreamQueued: () => void;
  onSendStart: (prompt: string, imageUrls?: string[]) => void;
  onSendTaskAssigned?: (taskId: string) => void;
  onSessionChange?: (next: { agent: string; sessionId: string; workdir: string }) => void;
  t: (k: string) => string;
  streamPhase: string | null;
  streamTaskId?: string | null;
  queuedTaskIds?: string[];
  queuedTasks?: Array<{ taskId: string; prompt: string }>;
  pendingQueuedSends?: Array<{ taskId: string | null; prompt: string; imageUrls?: string[] }>;
  onRecall?: (taskId: string) => void;
  onSteer?: (taskId: string) => void;
  onStopAll?: () => void | Promise<void>;
  editDraft?: string | null;
  onEditDraftConsumed?: () => void;
  onSelectionChange?: (sel: { model: string | null; effort: string | null }) => void;
}) {
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [localTaskId, setLocalTaskId] = useState<string | null>(null);
  const [recallingIds, setRecallingIds] = useState<Set<string>>(() => new Set());
  const [steeringIds, setSteeringIds] = useState<Set<string>>(() => new Set());
  const lastSentRef = useRef<{ prompt: string; files: File[] }>({ prompt: '', files: [] });
  const storeAgents = useStore(s => s.agentStatus?.agents ?? null);
  const [agents, setAgents] = useState<AgentRuntimeStatus[]>(storeAgents || []);
  const [selectedAgent, setSelectedAgent] = useState('');
  const [selectedModel, setSelectedModel] = useState('');
  const [selectedProfileId, setSelectedProfileId] = useState<string | null | undefined>(undefined);
  const [selectedEffort, setSelectedEffort] = useState('');
  const [imageAttachments, setImageAttachments] = useState<ComposerImageAttachment[]>([]);
  const [previewImageId, setPreviewImageId] = useState<string | null>(null);
  const [queuedPreviewUrl, setQueuedPreviewUrl] = useState<string | null>(null);
  const [pendingAgent, setPendingAgent] = useState<string | null>(null);
  const [pendingModel, setPendingModel] = useState<string | null>(null);
  const [pendingEffort, setPendingEffort] = useState<string | null>(null);
  const [pendingProfileSelection, setPendingProfileSelection] = useState<string | null | undefined>(undefined);
  const [cascadeStep, setCascadeStep] = useState<CascadeStep>('closed');
  const [cascadePos, setCascadePos] = useState<{ left: number; bottom: number } | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const attachmentsRef = useRef<ComposerImageAttachment[]>([]);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [skillMenuOpen, setSkillMenuOpen] = useState(false);
  const [skillMenuIndex, setSkillMenuIndex] = useState(0);
  const skillMenuRef = useRef<HTMLDivElement>(null);
  const refreshAgentStatus = useStore(s => s.refreshAgentStatus);

  const [profiles, setProfiles] = useState<Array<{
    id: string; name: string; providerId: string; modelId: string; effort?: string | null;
  }>>([]);
  const [providers, setProviders] = useState<Array<{ id: string; name: string; kind: string; baseURL: string }>>([]);
  const [activeProfiles, setActiveProfiles] = useState<Record<string, string | null>>({});

  const refreshModelLayer = useCallback(async () => {
    try {
      const [pRes, profRes, bRes] = await Promise.all([
        fetch('/api/models/providers').then(r => r.json()),
        fetch('/api/models/profiles').then(r => r.json()),
        fetch('/api/models/agents').then(r => r.json()),
      ]);
      if (pRes?.ok) setProviders(pRes.providers || []);
      if (profRes?.ok) setProfiles(profRes.profiles || []);
      if (bRes?.ok) {
        const map: Record<string, string | null> = {};
        for (const b of bRes.bindings || []) map[b.agent] = b.activeProfileId;
        setActiveProfiles(map);
      }
    } catch {  }
  }, []);

  useEffect(() => { void refreshModelLayer(); }, [refreshModelLayer]);

  useEffect(() => { if (storeAgents?.length) setAgents(storeAgents); }, [storeAgents]);
  useEffect(() => { attachmentsRef.current = imageAttachments; }, [imageAttachments]);

  const dk = draftKey(session.agent || '', session.sessionId);
  const dkRef = useRef(dk);
  dkRef.current = dk;
  useEffect(() => {
    const saved = draftStore.get(dk);
    if (saved) {
      draftStore.delete(dk);
      if (saved.text) setInput(saved.text);
      if (saved.files.length) setImageAttachments(saved.files.map(makeComposerImageAttachment));
    }
    return () => {
      const text = inputRef.current?.value || '';
      const files = attachmentsRef.current.map(a => a.file);
      for (const a of attachmentsRef.current) URL.revokeObjectURL(a.previewUrl);
      if (text || files.length) draftStore.set(dkRef.current, { text, files });
      else draftStore.delete(dkRef.current);
    };
  }, [dk]);

  const prevSessionRef = useRef({ agent: session.agent || '', sessionId: session.sessionId });
  useEffect(() => {
    const prev = prevSessionRef.current;
    const curr = { agent: session.agent || '', sessionId: session.sessionId };
    prevSessionRef.current = curr;
    const isPromotion = prev.agent === curr.agent
      && isPendingSessionId(prev.sessionId) && !isPendingSessionId(curr.sessionId);
    if (isPromotion) return;
    setSelectedAgent('');
    setSelectedModel('');
    setSelectedProfileId(undefined);
    setSelectedEffort('');
    setPendingAgent(null);
    setPendingModel(null);
    setPendingEffort(null);
    setCascadeStep('closed');
  }, [session.agent, session.sessionId]);

  useEffect(() => {
    if (editDraft != null) {
      setInput(editDraft);
      onEditDraftConsumed?.();
      requestAnimationFrame(() => {
        const el = inputRef.current;
        if (el) { el.focus(); el.setSelectionRange(editDraft.length, editDraft.length); }
      });
    }
  }, [editDraft, onEditDraftConsumed]);

  useEffect(() => {
    if (!workdir) return;
    let cancelled = false;
    api.getSkills(workdir).then(res => {
      if (!cancelled && res.ok) setSkills(res.skills);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [workdir]);

  const skillQuery = skillMenuOpen ? (() => {
    const match = input.match(/^\/(\S*)$/);
    return match ? match[1].toLowerCase() : null;
  })() : null;
  const filteredSkills = skillQuery !== null
    ? skills.filter(s => s.name.toLowerCase().includes(skillQuery) || (s.label && s.label.toLowerCase().includes(skillQuery)))
    : [];

  useEffect(() => { setSkillMenuIndex(0); }, [skillMenuOpen, input]);

  useEffect(() => {
    if (!skillMenuOpen || !skillMenuRef.current) return;
    const item = skillMenuRef.current.querySelector(`[data-skill-idx="${skillMenuIndex}"]`);
    if (item) (item as HTMLElement).scrollIntoView({ block: 'nearest' });
  }, [skillMenuIndex, skillMenuOpen]);

  useEffect(() => {
    if (!skillMenuOpen) return;
    const h = (e: MouseEvent) => {
      if (skillMenuRef.current?.contains(e.target as Node)) return;
      if (inputRef.current?.contains(e.target as Node)) return;
      setSkillMenuOpen(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [skillMenuOpen]);

  useEffect(() => {
    if (cascadeStep === 'closed') return;
    const h = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      const portal = document.getElementById('cascade-portal');
      if (portal?.contains(target)) return;
      setCascadeStep('closed'); setPendingAgent(null); setPendingModel(null); setPendingEffort(null);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [cascadeStep]);

  useLayoutEffect(() => {
    if (cascadeStep === 'closed' || !triggerRef.current) { setCascadePos(null); return; }
    const rect = triggerRef.current.getBoundingClientRect();
    setCascadePos({ left: rect.left, bottom: window.innerHeight - rect.top + 8 });
  }, [cascadeStep]);

  const firstQueuedFromSnapshot = queuedTaskIds && queuedTaskIds.length ? queuedTaskIds[0] : null;
  useEffect(() => {
    if (localTaskId) {
      if (firstQueuedFromSnapshot) setLocalTaskId(null);
      else if (streamPhase !== null && streamPhase !== 'queued') setLocalTaskId(null);
    }
  }, [streamPhase, localTaskId, firstQueuedFromSnapshot]);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  }, [input]);

  const addImageAttachments = useCallback((files: ArrayLike<File> | null | undefined) => {
    const nextFiles = Array.from(files || []).filter(file => file.type.startsWith('image/'));
    if (!nextFiles.length) return;
    setImageAttachments(prev => [...prev, ...nextFiles.map(makeComposerImageAttachment)]);
  }, []);

  const clearImageAttachments = useCallback(() => {
    setPreviewImageId(null);
    setImageAttachments(prev => {
      revokeComposerAttachments(prev);
      return [];
    });
  }, []);

  const removeImageAttachment = useCallback((id: string) => {
    setImageAttachments(prev => {
      const target = prev.find(item => item.id === id);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return prev.filter(item => item.id !== id);
    });
    setPreviewImageId(current => current === id ? null : current);
  }, []);

  const handleSend = useCallback(() => {
    const prompt = input.trim();
    const attachments = imageAttachments.map(item => item.file);
    if ((!prompt && attachments.length === 0) || sending) return;
    const targetAgent = selectedAgent
      || session.agent
      || agents.find(a => a.isDefault)?.agent
      || '';
    if (!targetAgent) return;
    const targetStatus = agents.find(a => a.agent === targetAgent) || null;
    const sendOwnsSessionAgent = !!session.agent && targetAgent === session.agent;
    const targetModel = (selectedModel
      || (sendOwnsSessionAgent ? (session.model || '') : '')
      || targetStatus?.selectedModel
      || '').trim() || null;
    const targetProfileId: string | null | undefined = selectedProfileId !== undefined
      ? selectedProfileId
      : (sendOwnsSessionAgent && session.model ? (session.profileId ?? null) : undefined);
    const targetEffort = targetAgent === 'gemini'
      ? null
      : ((selectedEffort
        || (sendOwnsSessionAgent ? foldUltraEffort(targetAgent, session.thinkingEffort, session.workflowEnabled) : '')
        || foldUltraEffort(targetAgent, targetStatus?.selectedEffort, targetStatus?.workflowEnabled)
        || '').trim() || null);
    const isAgentSwitch = targetAgent !== session.agent;
    const targetSessionId = isAgentSwitch ? '' : session.sessionId;
    const previousAgent = isAgentSwitch && session.agent ? session.agent : null;
    const previousSessionId = isAgentSwitch && session.sessionId ? session.sessionId : null;
    setSending(true);
    lastSentRef.current = { prompt, files: attachments };
    setInput('');
    draftStore.delete(dkRef.current);
    const previewUrls = attachments.length ? attachments.map(f => URL.createObjectURL(f)) : undefined;
    clearImageAttachments();
    onSendStart(prompt, previewUrls);
    onStreamQueued();
    api.sendSessionMessage(workdir, targetAgent, targetSessionId, prompt, {
      attachments,
      model: targetModel,
      profileId: targetProfileId,
      effort: targetEffort,
      previousAgent,
      previousSessionId,
    })
      .then(res => {
        if (res.taskId) {
          setLocalTaskId(res.taskId);
          onSendTaskAssigned?.(res.taskId);
        }
        if (!res.ok) return;
        const nextSession = typeof res.sessionKey === 'string' ? parseSessionKey(res.sessionKey) : null;
        const switchedSession = !!nextSession
          && (nextSession.agent !== session.agent || nextSession.sessionId !== session.sessionId);
        if (switchedSession && nextSession) {
          onSessionChange?.({ ...nextSession, workdir });
        }
      })
      .catch(() => {})
      .finally(() => setSending(false));
  }, [
    agents,
    clearImageAttachments,
    imageAttachments,
    input,
    onSendStart,
    onSendTaskAssigned,
    onSessionChange,
    onStreamQueued,
    selectedAgent,
    selectedEffort,
    selectedModel,
    selectedProfileId,
    sending,
    session.agent,
    session.sessionId,
    session.model,
    session.profileId,
    workdir,
  ]);

  const isActiveStream = streamPhase === 'streaming';
  const effectiveQueuedIds: string[] = visibleQueuedIds({
    queuedTaskIds,
    streamPhase,
    streamTaskId,
    localTaskId,
  });
  const effectiveQueuedId = effectiveQueuedIds[effectiveQueuedIds.length - 1] || null;
  const hasQueuedTask = effectiveQueuedIds.length > 0;
  const showTaskBar = hasQueuedTask || isActiveStream;

  useEffect(() => {
    const isLive = (id: string) => effectiveQueuedIds.includes(id) || id === streamTaskId;
    setRecallingIds(prev => {
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) { if (isLive(id)) next.add(id); else changed = true; }
      return changed ? next : prev;
    });
    setSteeringIds(prev => {
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) { if (isLive(id)) next.add(id); else changed = true; }
      return changed ? next : prev;
    });
  }, [effectiveQueuedIds, streamTaskId]);
  useEffect(() => {
    if (!hasQueuedTask && lastSentRef.current.files.length) {
      lastSentRef.current = { prompt: '', files: [] };
    }
  }, [hasQueuedTask]);

  const handleRecallQueued = useCallback((taskId: string) => {
    if (recallingIds.has(taskId)) return;
    setRecallingIds(prev => { const next = new Set(prev); next.add(taskId); return next; });
    if (taskId === effectiveQueuedId) {
      const stash = lastSentRef.current;
      if (stash.prompt) setInput(stash.prompt);
      if (stash.files.length) setImageAttachments(stash.files.map(makeComposerImageAttachment));
      lastSentRef.current = { prompt: '', files: [] };
    }
    onRecall?.(taskId);
    if (taskId === localTaskId) setLocalTaskId(null);
  }, [recallingIds, effectiveQueuedId, localTaskId, onRecall]);

  const [stoppingAll, setStoppingAll] = useState(false);
  const handleStop = useCallback(async () => {
    if (stoppingAll || !onStopAll) return;
    setStoppingAll(true);
    try { await onStopAll(); }
    finally { setStoppingAll(false); }
  }, [stoppingAll, onStopAll]);

  const handleSteerQueued = useCallback((taskId: string) => {
    if (steeringIds.has(taskId)) return;
    setSteeringIds(prev => { const next = new Set(prev); next.add(taskId); return next; });
    onSteer?.(taskId);
    if (taskId === localTaskId) setLocalTaskId(null);
  }, [steeringIds, localTaskId, onSteer]);

  const selectSkill = useCallback((skill: SkillInfo) => {
    setInput(`/${skill.name} `);
    setSkillMenuOpen(false);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
    });
  }, []);

  const handleInputChange = useCallback((value: string) => {
    setInput(value);
    const isSlashCmd = /^\/\S*$/.test(value) && skills.length > 0;
    setSkillMenuOpen(isSlashCmd);
  }, [skills.length]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (skillMenuOpen && filteredSkills.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSkillMenuIndex(i => (i + 1) % filteredSkills.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSkillMenuIndex(i => (i - 1 + filteredSkills.length) % filteredSkills.length); return; }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !composingRef.current)) {
        e.preventDefault();
        selectSkill(filteredSkills[skillMenuIndex]);
        return;
      }
      if (e.key === 'Escape') { e.preventDefault(); setSkillMenuOpen(false); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey && !composingRef.current) { e.preventDefault(); handleSend(); }
  };

  const onPaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData?.items || [])
      .filter(item => item.kind === 'file' && item.type.startsWith('image/'))
      .map(item => item.getAsFile())
      .filter((file): file is File => !!file);
    if (!files.length) return;
    e.preventDefault();
    addImageAttachments(files);
  }, [addImageAttachments]);

  const effectiveAgent = selectedAgent
    || session.agent
    || agents.find(a => a.isDefault)?.agent
    || agents.find(a => a.installed)?.agent
    || agents[0]?.agent
    || '';
  const currentAgent = agents.find(a => a.agent === effectiveAgent) || null;
  const cascadeAgentId = pendingAgent || effectiveAgent;
  const cascadeAgent = agents.find(a => a.agent === cascadeAgentId) || currentAgent;
  type CascadeModelRow = {
    id: string;
    label: string;
    kind: 'native' | 'profile';
    profileId?: string;
    description?: string;
  };
  const models = useMemo<CascadeModelRow[]>(() => {
    if (!cascadeAgent) return [];
    const out: CascadeModelRow[] = [];
    for (const m of cascadeAgent.models || []) {
      out.push({
        id: m.id,
        label: m.id,
        kind: 'native',
        description: m.alias && m.alias.toLowerCase() !== m.id.toLowerCase() ? m.alias : undefined,
      });
    }
    const acceptedKinds = new Set(AGENT_ACCEPTED_PROVIDER_KINDS[cascadeAgentId] || []);
    for (const p of profiles) {
      const provider = providers.find(x => x.id === p.providerId);
      if (!provider || !acceptedKinds.has(provider.kind)) continue;
      const showModelId = p.name.trim().toLowerCase() !== p.modelId.trim().toLowerCase();
      out.push({
        id: p.modelId,
        label: p.name,
        kind: 'profile',
        profileId: p.id,
        description: showModelId ? `${provider.name} · ${p.modelId}` : provider.name,
      });
    }
    return out;
  }, [cascadeAgent, cascadeAgentId, profiles, providers]);
  const firstProfileIdx = useMemo(() => models.findIndex(m => m.kind === 'profile'), [models]);
  const activeProfileIdForAgent = activeProfiles[cascadeAgentId] || null;
  const sessionOwnsAgent = !!session.agent && effectiveAgent === session.agent;
  const sessionProfileId: string | null | undefined = selectedProfileId !== undefined
    ? selectedProfileId
    : (sessionOwnsAgent ? (session.profileId ?? null) : undefined);
  const currentModel = selectedModel
    || (sessionOwnsAgent ? (session.model || '') : '')
    || currentAgent?.selectedModel
    || '';
  const currentEffort = effectiveAgent === 'gemini'
    ? ''
    : (selectedEffort
      || (sessionOwnsAgent ? foldUltraEffort(effectiveAgent, session.thinkingEffort, session.workflowEnabled) : '')
      || foldUltraEffort(effectiveAgent, currentAgent?.selectedEffort, currentAgent?.workflowEnabled)
      || '');
  useEffect(() => {
    onSelectionChange?.({ model: currentModel || null, effort: currentEffort || null });
  }, [currentModel, currentEffort, onSelectionChange]);
  const effortLevels = EFFORT_OPTIONS[cascadeAgentId as keyof typeof EFFORT_OPTIONS] || [];
  const previewAttachment = previewImageId ? imageAttachments.find(item => item.id === previewImageId) || null : null;
  const activePreview: LightboxSource | null = previewAttachment
    ? {
        key: previewAttachment.id,
        url: previewAttachment.previewUrl,
        name: previewAttachment.file.name,
        size: previewAttachment.file.size,
        file: previewAttachment.file,
        onRemove: () => removeImageAttachment(previewAttachment.id),
      }
    : queuedPreviewUrl
      ? { key: queuedPreviewUrl, url: queuedPreviewUrl }
      : null;
  const canSend = (!!input.trim() || imageAttachments.length > 0) && !sending && !!effectiveAgent;

  const resetCascade = () => {
    setPendingAgent(null);
    setPendingModel(null);
    setPendingEffort(null);
    setPendingProfileSelection(undefined);
  };

  const applyCascade = useCallback((agent: string, model: string, effort: string | null) => {
    const nextEffort = agent === 'gemini' ? '' : (effort || '');
    setSelectedAgent(agent);
    setSelectedModel(model);
    if (pendingProfileSelection !== undefined) setSelectedProfileId(pendingProfileSelection);
    setSelectedEffort(nextEffort);
    resetCascade();
    setCascadeStep('closed');
  }, [pendingProfileSelection]);

  const toggleCascade = () => {
    if (cascadeStep === 'closed') {
      resetCascade();
      refreshAgentStatus();
      void refreshModelLayer();
      setCascadeStep('agent');
    } else { resetCascade(); setCascadeStep('closed'); }
  };

  const displayAgent = pendingAgent || effectiveAgent;
  const displayMeta = getAgentMeta(displayAgent);
  const displayModel = pendingModel ?? currentModel;
  const displayEffort = pendingEffort ?? currentEffort;
  const shortModel = displayModel ? shortenModel(displayModel) : '';

  const displayProfile = (() => {
    const id = (!pendingAgent && sessionProfileId !== undefined)
      ? sessionProfileId
      : (activeProfiles[displayAgent] ?? null);
    return id ? profiles.find(p => p.id === id) ?? null : null;
  })();
  const displayProvider = displayProfile
    ? providers.find(p => p.id === displayProfile.providerId) ?? null
    : null;
  const displayProviderBrand = displayProvider ? brandIdForProvider(displayProvider) : null;
  const displayModelLabel = displayProfile
    ? (displayProfile.name.trim().toLowerCase() !== displayProfile.modelId.trim().toLowerCase()
        ? displayProfile.name
        : shortenModel(displayProfile.modelId))
    : shortModel;

  const cascadeLabel = [
    displayMeta.shortLabel,
    displayProvider ? displayProvider.name : null,
    displayModelLabel || null,
    displayEffort ? displayEffort.charAt(0).toUpperCase() + displayEffort.slice(1) : null,
  ].filter(Boolean).join(' / ');

  return (
    <div className="shrink-0" ref={composerRef}>
      <div className="max-w-[680px] mx-auto px-5 pb-4 pt-2">
        {showTaskBar && (
          <div className="mb-2 space-y-1.5">
            {isActiveStream && (
              <div className="flex items-center gap-2.5 rounded-lg border border-primary/20 bg-primary/[0.04] px-3.5 py-1.5 transition-colors">
                <Spinner className="h-3 w-3 text-primary shrink-0" />
                <span className="flex-1 min-w-0 text-[12px] font-medium text-fg-3 truncate">{t('hub.running')}</span>
                <button
                  onClick={handleStop}
                  disabled={stoppingAll}
                  title={t('hub.stopHint')}
                  className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium text-fg-4 hover:text-err hover:bg-err/10 transition-colors disabled:opacity-30 disabled:pointer-events-none shrink-0"
                >
                  {stoppingAll
                    ? <Spinner className="h-2.5 w-2.5" />
                    : <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2" /></svg>}
                  {t('hub.stop')}
                </button>
              </div>
            )}
            {effectiveQueuedIds.map((taskId, idx) => {
              const isLatest = idx === effectiveQueuedIds.length - 1;
              const isSteering = steeringIds.has(taskId);
              const positionLabel = isSteering
                ? t('hub.steering')
                : effectiveQueuedIds.length > 1 ? `${t('hub.queued')} #${idx + 1}` : t('hub.queued');
              const optimistic = pendingQueuedSends?.find(p => p.taskId === taskId)
                || (isLatest ? pendingQueuedSends?.find(p => !p.taskId) : undefined);
              const taskPrompt = queuedTasks?.find(qt => qt.taskId === taskId)?.prompt
                || optimistic?.prompt
                || null;
              const taskImages = optimistic?.imageUrls?.length ? optimistic.imageUrls : [];
              return (
                <div
                  key={taskId}
                  className="flex items-center gap-2.5 rounded-lg border border-warn/25 bg-warn/[0.04] px-3.5 py-1.5 transition-colors"
                >
                  {isSteering
                    ? <Spinner className="h-3 w-3 text-warn shrink-0" />
                    : <span className="h-1.5 w-1.5 rounded-full bg-warn animate-pulse shrink-0" />}
                  <div className="flex-1 min-w-0 flex items-center gap-2">
                    <span className="text-[12px] font-medium text-warn shrink-0">{positionLabel}</span>
                    {taskImages.length > 0 && (
                      <div className="flex items-center gap-1 shrink-0">
                        {taskImages.slice(0, 3).map((url, i) => (
                          <button
                            key={`${url}-${i}`}
                            type="button"
                            onClick={() => setQueuedPreviewUrl(url)}
                            title={t('hub.previewImage')}
                            className="block h-5 w-5 shrink-0 overflow-hidden rounded border border-warn/30 transition-opacity hover:opacity-80"
                          >
                            <img src={url} alt="" className="h-full w-full object-cover" />
                          </button>
                        ))}
                        {taskImages.length > 3 && (
                          <span className="text-[10px] text-fg-5/60">+{taskImages.length - 3}</span>
                        )}
                      </div>
                    )}
                    {taskPrompt && (
                      <span className="text-[11px] text-fg-5/60 truncate">{taskPrompt}</span>
                    )}
                  </div>
                  {!isSteering && (
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        onClick={() => handleSteerQueued(taskId)}
                        title={t('hub.steerHint')}
                        className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium text-fg-4 hover:text-blue-400 hover:bg-blue-400/10 transition-colors disabled:opacity-30 disabled:pointer-events-none"
                      >
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="9 6 15 12 9 18" /></svg>
                        {t('hub.steer')}
                      </button>
                      <button
                        onClick={() => handleRecallQueued(taskId)}
                        disabled={recallingIds.has(taskId)}
                        title={t('hub.recallHint')}
                        className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium text-fg-4 hover:text-err hover:bg-err/10 transition-colors disabled:opacity-30 disabled:pointer-events-none"
                      >
                        {recallingIds.has(taskId)
                          ? <Spinner className="h-2.5 w-2.5" />
                          : <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M18 6 6 18" /><path d="M6 6l12 12" /></svg>}
                        {t('hub.recall')}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        <div className="relative rounded-xl border border-edge/40 bg-panel shadow-sm transition-[border-color,box-shadow] duration-200 focus-within:border-fg-5/40 focus-within:shadow-md">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={e => {
              addImageAttachments(e.target.files);
              e.target.value = '';
            }}
          />

          {imageAttachments.length > 0 && (
            <div className="px-3 pt-3">
              <div className="flex gap-2 overflow-x-auto pb-1">
                {imageAttachments.map(item => (
                  <div key={item.id} className="relative shrink-0">
                    <button
                      type="button"
                      onClick={() => setPreviewImageId(item.id)}
                      title={t('hub.previewImage')}
                      className="group relative h-[72px] w-[72px] overflow-hidden rounded-lg border border-edge/30 bg-panel-alt/30"
                    >
                      <img src={item.previewUrl} alt={item.file.name} className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.03]" />
                      <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/60 via-black/10 to-transparent px-1.5 pb-1 pt-3 text-left">
                        <div className="truncate text-[8px] font-medium text-white/90 leading-tight">{item.file.name}</div>
                      </div>
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        removeImageAttachment(item.id);
                      }}
                      title={t('hub.removeImage')}
                      className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full border border-white/10 bg-black/65 text-white/75 transition-colors hover:bg-black/80 hover:text-white"
                    >
                      <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                        <path d="M18 6 6 18" />
                        <path d="M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {skillMenuOpen && filteredSkills.length > 0 && (
            <div
              ref={skillMenuRef}
              className="absolute bottom-full left-0 right-0 mb-1.5 z-50 max-h-[200px] overflow-y-auto rounded-xl border border-edge/40 bg-[var(--th-dropdown)] backdrop-blur-xl shadow-lg animate-in"
            >
              <div className="px-3 pt-2 pb-1 border-b border-edge/20">
                <span className="text-[10px] font-semibold text-fg-5 uppercase tracking-wider">{t('hub.skills')}</span>
              </div>
              <div className="py-1">
                {filteredSkills.map((skill, idx) => (
                  <button
                    key={skill.name}
                    data-skill-idx={idx}
                    onMouseDown={e => { e.preventDefault(); selectSkill(skill); }}
                    onMouseEnter={() => setSkillMenuIndex(idx)}
                    className={cn(
                      'flex flex-col w-full px-3 py-1.5 text-left transition-colors',
                      idx === skillMenuIndex
                        ? 'bg-panel-h text-fg'
                        : 'text-fg-3 hover:bg-panel-alt/50',
                    )}
                  >
                    <span className="text-[12.5px] font-medium">/{skill.name}</span>
                    {(skill.label || skill.description) && (
                      <span className="text-[11px] text-fg-5 truncate">{skill.label || skill.description}</span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}

          <textarea
            ref={inputRef}
            value={input}
            onChange={e => handleInputChange(e.target.value)}
            onPaste={onPaste}
            onKeyDown={onKeyDown}
            onCompositionStart={() => { composingRef.current = true; }}
            onCompositionEnd={() => { composingRef.current = false; }}
            placeholder={t('hub.inputPlaceholder')}
            rows={1}
            className="w-full resize-none bg-transparent px-4 pt-3 pb-1 text-[13.5px] text-fg outline-none placeholder:text-fg-5/25 leading-[1.6]"
            style={{ maxHeight: 200, overflow: input.split('\n').length > 6 ? 'auto' : 'hidden' }}
          />

          <div className="flex items-center gap-1.5 px-2.5 pb-2 pt-1">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              title={t('hub.addImages')}
              className="flex h-7 w-7 items-center justify-center rounded-lg text-fg-5/50 transition-colors hover:bg-panel-h/60 hover:text-fg-3"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round">
                <path d="M12 5v14" />
                <path d="M5 12h14" />
              </svg>
            </button>

            <button
              ref={triggerRef}
              onClick={toggleCascade}
              disabled={!agents.length}
              title={agents.length ? cascadeLabel : undefined}
              className={cn(
                'flex items-center gap-1.5 h-[28px] px-2.5 rounded-lg text-[11px] font-medium transition-all duration-200 select-none',
                cascadeStep !== 'closed'
                  ? 'bg-panel-h border border-edge-h text-fg-3'
                  : 'text-fg-5/60 hover:text-fg-4 hover:bg-panel-h/50 border border-transparent',
              )}
            >
              {agents.length
                ? <BrandIcon brand={displayAgent} size={12} />
                : <Spinner className="h-3 w-3" />}
              {agents.length ? (
                <span className="flex items-center gap-1 max-w-[460px] min-w-0 truncate">
                  <span className="shrink-0">{displayMeta.shortLabel}</span>
                  {displayProvider && (
                    <>
                      <span className="text-fg-5/40 shrink-0">/</span>
                      <BrandIcon brand={displayProviderBrand || 'custom'} size={12} />
                      <span className="shrink-0 truncate max-w-[140px]">{displayProvider.name}</span>
                    </>
                  )}
                  {displayModelLabel && (
                    <>
                      <span className="text-fg-5/40 shrink-0">/</span>
                      <span className="truncate" title={displayModel || undefined}>{displayModelLabel}</span>
                    </>
                  )}
                  {displayEffort && (
                    <>
                      <span className="text-fg-5/40 shrink-0">/</span>
                      <span className="shrink-0">{displayEffort.charAt(0).toUpperCase() + displayEffort.slice(1)}</span>
                    </>
                  )}
                </span>
              ) : (
                <span className="max-w-[420px] truncate">{t('hub.selectAgent')}</span>
              )}
              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
                className={cn('text-fg-5/30 transition-transform duration-200', cascadeStep !== 'closed' && 'rotate-180')}>
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>

            {cascadeStep !== 'closed' && cascadePos && createPortal(
              <div
                id="cascade-portal"
                className="fixed z-[200] w-[300px] rounded-xl border border-edge/40 bg-[var(--th-dropdown)] backdrop-blur-xl shadow-lg overflow-hidden animate-in"
                style={{ left: cascadePos.left, bottom: cascadePos.bottom }}
              >
                <div className="flex items-center gap-2 px-3 pt-2.5 pb-1.5 border-b border-edge/20">
                  {cascadeStep !== 'agent' && (
                    <button
                      onClick={() => {
                        if (cascadeStep === 'effort') {
                          const supportsModelSwitch = cascadeAgent?.capabilities?.modelSwitch !== false;
                          setCascadeStep(supportsModelSwitch ? 'model' : 'agent');
                        } else {
                          setCascadeStep('agent');
                        }
                      }}
                      className="p-0.5 rounded text-fg-5/50 hover:text-fg-3 transition-colors"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                        <polyline points="15 18 9 12 15 6" />
                      </svg>
                    </button>
                  )}
                  <span className="text-[10px] font-semibold text-fg-5 uppercase tracking-wider">
                    {cascadeStep === 'agent' ? t('hub.selectAgent') : cascadeStep === 'model' ? t('hub.selectModel') : t('hub.selectEffort')}
                  </span>
                  <div className="ml-auto flex items-center gap-0.5">
                    {(() => {
                      const supportsModelSwitch = cascadeAgent?.capabilities?.modelSwitch !== false;
                      const steps = supportsModelSwitch
                        ? (['agent', 'model', 'effort'] as const)
                        : (['agent', 'effort'] as const);
                      const activeIdx = steps.indexOf(cascadeStep as any);
                      return steps.map((step, idx) => (
                        <span key={step} className={cn(
                          'w-1.5 h-1.5 rounded-full transition-colors',
                          cascadeStep === step ? 'bg-primary' : idx < activeIdx ? 'bg-primary/40' : 'bg-fg-5/15',
                        )} />
                      ));
                    })()}
                  </div>
                </div>

                <div className="max-h-[200px] overflow-y-auto py-1">
                  {cascadeStep === 'agent' && agents.filter(a => a.installed).map(a => {
                    const am = getAgentMeta(a.agent);
                    const rowUsage = worstUsageWindow(a.usage);
                    const rowTone = rowUsage ? usageWindowTone(rowUsage) : 'ok';
                    return (
                      <CascadeItem key={a.agent} selected={a.agent === (pendingAgent || effectiveAgent)} onClick={() => {
                        setPendingAgent(a.agent);
                        setPendingModel(a.selectedModel || '');
                        setPendingEffort(a.selectedEffort || '');
                        const supportsModelSwitch = a.capabilities?.modelSwitch !== false;
                        if (!supportsModelSwitch) {
                          const efforts = EFFORT_OPTIONS[a.agent as keyof typeof EFFORT_OPTIONS] || [];
                          if (efforts.length) setCascadeStep('effort');
                          else { void applyCascade(a.agent, a.selectedModel || '', null); }
                          return;
                        }
                        setCascadeStep('model');
                      }}>
                        <BrandIcon brand={a.agent} size={14} />
                        <span style={{ color: am.color }}>{am.label}</span>
                        {rowUsage && (
                          <span className={cn(
                            'ml-auto font-mono text-[10px]',
                            rowTone === 'err' ? 'text-err' : rowTone === 'warn' ? 'text-warn' : 'text-fg-5',
                          )}>
                            {rowUsage.label} {Math.round(rowUsage.usedPercent ?? 0)}%
                          </span>
                        )}
                      </CascadeItem>
                    );
                  })}
                  {cascadeStep === 'model' && (
                    <>
                      {models.map((m, idx) => {
                        const showNativeHeader = idx === 0 && m.kind === 'native';
                        const showProfileHeader = idx === firstProfileIdx && m.kind === 'profile';
                        const stagedProfile = pendingProfileSelection !== undefined
                          ? pendingProfileSelection
                          : (cascadeAgentId === effectiveAgent && sessionProfileId !== undefined
                              ? sessionProfileId
                              : activeProfileIdForAgent);
                        const isSelected = m.kind === 'profile'
                          ? !!m.profileId && m.profileId === stagedProfile
                          : !stagedProfile && m.id === (pendingModel ?? currentModel);
                        return (
                          <div key={`${m.kind}:${m.profileId || m.id}`}>
                            {showNativeHeader && (
                              <div className="px-3 pb-1 pt-1.5 text-[10px] font-medium uppercase tracking-wide text-fg-5">{t('hub.modelGroupNative')}</div>
                            )}
                            {showProfileHeader && (
                              <div className="px-3 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wide text-fg-5">{t('hub.modelGroupProfiles')}</div>
                            )}
                            <CascadeItem selected={isSelected} onClick={() => {
                              const finalAgent = pendingAgent || effectiveAgent;
                              setPendingModel(m.id);
                              setPendingProfileSelection(m.profileId ?? null);
                              if (EFFORT_OPTIONS[finalAgent as keyof typeof EFFORT_OPTIONS]?.length) {
                                setCascadeStep('effort');
                                return;
                              }
                              void applyCascade(finalAgent, m.id, null);
                            }}>
                              <div className="min-w-0 flex-1">
                                <div className={cn('truncate text-[11.5px]', m.kind === 'native' && 'font-mono text-[11px]')} title={m.id}>
                                  {m.label}
                                </div>
                                {m.description && (
                                  <div className="truncate text-[10px] text-fg-5/80">{m.description}</div>
                                )}
                              </div>
                            </CascadeItem>
                          </div>
                        );
                      })}
                      {models.length === 0 && <div className="px-3 py-3 text-[11px] text-fg-5 text-center">{t('config.noModel')}</div>}
                    </>
                  )}
                  {cascadeStep === 'effort' && effortLevels.map(e => (
                    <CascadeItem key={e} selected={e === (pendingEffort || currentEffort)} onClick={() => {
                      setPendingEffort(e);
                      const finalAgent = pendingAgent || effectiveAgent;
                      const finalModel = pendingModel ?? currentModel;
                      void applyCascade(finalAgent, finalModel, e);
                    }}>
                      {e.charAt(0).toUpperCase() + e.slice(1)}
                    </CascadeItem>
                  ))}
                </div>
              </div>,
              document.body,
            )}

            <div className="flex-1" />

            <button
              onClick={handleSend}
              disabled={!canSend}
              className={cn(
                'flex items-center justify-center w-[30px] h-[30px] rounded-lg transition-all duration-200',
                canSend
                  ? 'bg-primary text-primary-fg hover:brightness-110 shadow-sm'
                  : 'bg-fg/6 text-fg-5/20',
              )}
            >
              {sending
                ? <Spinner className="h-3.5 w-3.5" />
                : <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="19" x2="12" y2="5" /><polyline points="5 12 12 5 19 12" /></svg>
              }
            </button>
          </div>
        </div>
      </div>

      <ComposerImageLightbox
        source={activePreview}
        onClose={() => { setPreviewImageId(null); setQueuedPreviewUrl(null); }}
        t={t}
      />
    </div>
  );
});

type LightboxSource = {
  key: string;
  url: string;
  name?: string;
  size?: number;
  file?: File;
  onRemove?: () => void;
};

function ComposerImageLightbox({ source, onClose, t }: {
  source: LightboxSource | null;
  onClose: () => void;
  t: (k: string) => string;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => { setCopied(false); }, [source?.key]);

  useEffect(() => {
    if (!source) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [source, onClose]);

  if (!source) return null;

  const file = source.file;
  const onRemove = source.onRemove;

  return createPortal(
    <div className="fixed inset-0 z-[220] flex items-center justify-center bg-black/72 px-4 py-6 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-[1024px]" onClick={e => e.stopPropagation()}>
        <div className="mb-3 flex items-center gap-2 text-[11px] text-white/72">
          {source.name && <span className="truncate font-medium text-white/90">{source.name}</span>}
          {typeof source.size === 'number' && <span>{formatFileSize(source.size)}</span>}
          <div className="ml-auto flex items-center gap-2">
            {file && (
              <button
                type="button"
                onClick={async () => {
                  if (!await copyImageFile(file)) return;
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1600);
                }}
                className="rounded-lg border border-white/12 bg-white/10 px-3 py-1.5 text-[11px] font-medium text-white/88 transition-colors hover:bg-white/14"
              >
                {copied ? t('hub.copied') : t('hub.copyImage')}
              </button>
            )}
            {onRemove && (
              <button
                type="button"
                onClick={onRemove}
                className="rounded-lg border border-white/12 bg-white/10 px-3 py-1.5 text-[11px] font-medium text-white/88 transition-colors hover:bg-white/14"
              >
                {t('hub.removeImage')}
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="flex h-9 w-9 items-center justify-center rounded-full border border-white/12 bg-white/10 text-white/88 transition-colors hover:bg-white/14"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                <path d="M18 6 6 18" />
                <path d="M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
        <div className="overflow-hidden rounded-xl border border-white/10 bg-black/35 shadow-[0_20px_70px_rgba(0,0,0,0.45)]">
          <img src={source.url} alt={source.name || ''} className="max-h-[80vh] w-full object-contain" />
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function CascadeItem({ selected, onClick, children }: {
  selected?: boolean; onClick: () => void; children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex items-center gap-2 w-full px-3 py-2 text-[12px] text-left transition-colors',
        selected ? 'text-fg bg-panel-h font-medium' : 'text-fg-3 hover:bg-panel-alt/50 hover:text-fg-2',
      )}
    >
      {children}
      {selected && (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="ml-auto text-ok">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      )}
      {!selected && (
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="ml-auto text-fg-5/20">
          <polyline points="9 6 15 12 9 18" />
        </svg>
      )}
    </button>
  );
}
