import { useState, useRef, useEffect, useLayoutEffect, useMemo, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import { CollapsibleCard, CountBadge } from '../../components/ui';
import { PlanProgressCard, hasPlan } from '../../components/PlanProgressCard';
import { createMarkdownComponents, mdPlugins, LinkifyPaths } from './markdown';
import { lastNLines, classifyRunEnd, formatTokens, formatTokensShort, contextDotClass, formatElapsedCompact } from './utils';
import { cn, shortenModel } from '../../utils';
import { FileChip } from './FileChip';
import type { StreamPlan, StreamSubAgent, StreamPreviewMeta, StreamToolCall, SnapshotArtifact } from '../../types';

export interface LiveStreamView {
  phase: 'streaming' | 'done';
  text: string;
  thinking: string;
  activity?: string;
  plan?: StreamPlan | null;
  subAgents?: StreamSubAgent[] | null;
  error?: string | null;
  generatingImages?: number;
  previewMeta?: StreamPreviewMeta | null;
  artifacts?: SnapshotArtifact[] | null;
  startedAt?: number | null;
}

export function liveStreamHasBody(stream: LiveStreamView): boolean {
  return !!stream.text
    || !!stream.thinking
    || !!(stream.activity && stream.activity.split('\n').filter(Boolean).length)
    || !!(stream.previewMeta?.toolCalls?.length)
    || hasPlan(stream.plan)
    || !!(stream.subAgents && stream.subAgents.length)
    || !!(stream.artifacts && stream.artifacts.length);
}

export function liveStreamShouldRender(stream: LiveStreamView): boolean {
  if (liveStreamHasBody(stream)) return true;
  if (stream.phase === 'streaming') return true;
  return stream.phase === 'done' && !!stream.error;
}

export function liveStreamFailureLabelKey(stream: LiveStreamView): string | null {
  if (stream.phase !== 'done' || !stream.error) return null;
  return liveStreamHasBody(stream) ? 'hub.streamErrored' : 'hub.streamFailed';
}

export function RunEndNotice({ detail, t, className }: {
  detail: string;
  t: (k: string) => string;
  className?: string;
}) {
  const kind = classifyRunEnd(detail);
  if (kind === 'interrupted') {
    return (
      <div className={cn('flex items-center gap-1.5 text-[11px] text-fg-5/55', className)}>
        <span className="inline-block h-2 w-2 rounded-[2px] bg-fg-5/45 shrink-0" />
        <span>{t('hub.turnStopped')}</span>
      </div>
    );
  }
  const tone = kind === 'error'
    ? { dot: 'bg-rose-400/55', text: 'text-rose-300/65' }
    : { dot: 'bg-fg-5/40', text: 'text-fg-5/55' };
  return (
    <div className={cn('flex items-start gap-1.5 text-[11px] leading-[1.6]', tone.text, className)}>
      <span className={cn('mt-[5px] h-1 w-1 rounded-full shrink-0', tone.dot)} />
      <span className="min-w-0 break-words">{detail}</span>
    </div>
  );
}

const STREAM_MARKDOWN_THROTTLE_MS = 64;

function useThrottledValue<T>(value: T, intervalMs: number): T {
  const [throttled, setThrottled] = useState(value);
  const lastAppliedAt = useRef(0);
  const timer = useRef<number | null>(null);
  useEffect(() => {
    if (intervalMs <= 0) return;
    const elapsed = Date.now() - lastAppliedAt.current;
    const apply = () => { lastAppliedAt.current = Date.now(); setThrottled(value); };
    if (elapsed >= intervalMs) {
      apply();
    } else {
      if (timer.current) clearTimeout(timer.current);
      timer.current = window.setTimeout(apply, intervalMs - elapsed);
    }
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [value, intervalMs]);
  return intervalMs <= 0 ? value : throttled;
}

export function LivePreview({
  stream,
  t,
  workdir,
}: {
  stream: LiveStreamView;
  t: (k: string) => string;
  workdir?: string | null;
}) {
  const showPlan = hasPlan(stream.plan);
  const [activityOpen, setActivityOpen] = useState(false);
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const activityScrollRef = useRef<HTMLDivElement>(null);
  const thinkingScrollRef = useRef<HTMLDivElement>(null);
  const failureLabelKey = liveStreamFailureLabelKey(stream);
  const activityLines = useMemo(() =>
    (stream.activity || '').split('\n').filter(Boolean),
    [stream.activity],
  );
  const toolCalls = stream.previewMeta?.toolCalls ?? [];
  const lastActivity = activityLines[activityLines.length - 1]
    || toolCalls[toolCalls.length - 1]?.summary
    || '';

  // Single live-status line: loading pulse + a glanceable count of this turn's tool executions +
  // token usage + elapsed — dot-separated, nothing else. The per-tool detail lives in the
  // Activity card above (so no noisy hover blob of raw commands). The header (TurnDivider)
  // suppresses usage/elapsed for the live turn, so this is the one place they appear; the dots
  // are the sole loading effect (no inline after-text dots).
  const toolCount = toolCalls.length;
  const liveCtxPct = stream.previewMeta?.contextPercent ?? null;
  const liveCtxTokens = stream.previewMeta?.contextUsedTokens ?? 0;
  const liveTurnOutTokens = stream.previewMeta?.turnOutputTokens ?? 0;
  const streaming = stream.phase === 'streaming';
  const showElapsed = streaming && stream.startedAt != null && stream.startedAt > 0;
  const showLiveStatus = streaming;

  useLayoutEffect(() => {
    const el = activityScrollRef.current;
    if (el && activityOpen) el.scrollTop = el.scrollHeight;
  }, [activityOpen, stream.activity, toolCalls.length]);

  useLayoutEffect(() => {
    const el = thinkingScrollRef.current;
    if (el && thinkingOpen) el.scrollTop = el.scrollHeight;
  }, [thinkingOpen, stream.thinking]);

  const subAgents = stream.subAgents ?? null;

  const liveText = useThrottledValue(stream.text, stream.phase === 'streaming' ? STREAM_MARKDOWN_THROTTLE_MS : 0);
  const markdownComponents = useMemo(() => createMarkdownComponents({ workdir }), [workdir]);
  const responseMarkdown = useMemo(
    () => <ReactMarkdown remarkPlugins={mdPlugins} components={markdownComponents}>{liveText}</ReactMarkdown>,
    [liveText, markdownComponents],
  );

  return (
    <div className="space-y-3 animate-in">
      {showPlan && (
        <PlanProgressCard plan={stream.plan!} t={t} className="mb-1 max-w-[760px]" />
      )}

      {subAgents && subAgents.length > 0 && subAgents.map(sub => (
        <SubAgentCard key={sub.id} sub={sub} t={t} />
      ))}

      {(toolCalls.length > 0 || activityLines.length > 0) && (
        <CollapsibleCard
          open={activityOpen}
          onToggle={() => setActivityOpen(v => !v)}
          dot={{ color: 'bg-cyan-400/60', pulse: true }}
          label={t('hub.activity')}
          preview={<span className="text-[12px] text-fg-4 truncate"><LinkifyPaths text={lastActivity} workdir={workdir} /></span>}
          badge={(toolCalls.length || activityLines.length) > 1
            ? <CountBadge>{toolCalls.length || activityLines.length}</CountBadge>
            : undefined}
        >
          <div ref={activityScrollRef} className="px-3.5 py-2.5 space-y-0.5 max-h-[280px] overflow-y-auto">
            {toolCalls.length > 0
              ? toolCalls.map(call => <ToolCallRow key={call.id} call={call} workdir={workdir} />)
              : activityLines.map((line, i) => (
                <div key={i} className="flex items-center gap-1.5 py-[2px]">
                  <span className="w-1 h-1 rounded-full shrink-0 bg-fg-5/30" />
                  <span className="text-[11px] font-mono text-fg-5/60 truncate"><LinkifyPaths text={line} workdir={workdir} /></span>
                </div>
              ))}
          </div>
        </CollapsibleCard>
      )}

      {stream.thinking && (
        <CollapsibleCard
          open={thinkingOpen}
          onToggle={() => setThinkingOpen(v => !v)}
          dot={{ color: 'bg-violet-400/50', pulse: true }}
          label={t('hub.thinking')}
          collapsedContent={
            <div className="px-3.5 pb-2.5 -mt-0.5 text-[12px] text-fg-4 leading-[1.65] whitespace-pre-wrap break-words line-clamp-3">
              {lastNLines(stream.thinking, 3)}
            </div>
          }
        >
          <div ref={thinkingScrollRef} className="px-3.5 py-3 text-[12px] text-fg-4 leading-[1.7] whitespace-pre-wrap break-words max-h-[280px] overflow-y-auto">
            {stream.thinking}
          </div>
        </CollapsibleCard>
      )}

      {stream.text && (
        <div className="session-md text-[13.5px] leading-[1.75] text-fg-2">
          {responseMarkdown}
        </div>
      )}

      {stream.artifacts && stream.artifacts.length > 0 && (
        <div className="flex flex-col gap-2">
          {stream.artifacts.map((a, i) => (
            a.kind === 'photo' ? (
              <a key={i} href={a.url} target="_blank" rel="noreferrer" className="inline-block">
                <img
                  src={a.url}
                  alt={a.caption || a.fileName}
                  className="max-w-[400px] max-h-[300px] rounded-md border border-fg-6/50 object-contain hover:opacity-90 transition-opacity"
                />
              </a>
            ) : (
              <FileChip key={i} url={a.url} fileName={a.fileName} fileSize={a.fileSize} caption={a.caption} />
            )
          ))}
        </div>
      )}

      {stream.phase === 'streaming' && (stream.generatingImages ?? 0) > 0 && (
        <div className="flex items-center gap-2 text-[12px] text-fg-4">
          <span className="relative inline-flex items-center justify-center w-3 h-3">
            <span className="absolute inline-flex w-3 h-3 rounded-full bg-cyan-400/40 animate-ping" />
            <span className="relative inline-block w-1.5 h-1.5 rounded-full bg-cyan-400/80" />
          </span>
          <span>
            {stream.generatingImages === 1
              ? 'Generating image…'
              : `Generating ${stream.generatingImages} images…`}
          </span>
        </div>
      )}

      {showLiveStatus && (
        <div className="flex items-center gap-2 text-[11px] font-mono text-fg-5/50 tabular-nums">
          <ThinkingDots className="text-fg-5/45 shrink-0" />
          <LiveStatusMetrics
            toolCount={toolCount}
            ctxPct={liveCtxPct}
            ctxTokens={liveCtxTokens}
            turnOutTokens={liveTurnOutTokens}
            startedAt={showElapsed ? stream.startedAt! : null}
          />
        </div>
      )}

      {failureLabelKey && stream.error && (
        <RunEndNotice detail={stream.error} t={t} className="pt-0.5" />
      )}
    </div>
  );
}

function ToolCallRow({ call, workdir }: { call: StreamToolCall; workdir?: string | null }) {
  const [open, setOpen] = useState(false);
  const expandable = !!(call.input || call.result);
  const dotColor = call.status === 'failed' ? 'bg-rose-400/70'
    : call.status === 'running' ? 'bg-cyan-400/70'
      : 'bg-fg-5/30';
  return (
    <div>
      <button
        type="button"
        onClick={() => expandable && setOpen(v => !v)}
        className={`flex w-full items-center gap-1.5 py-[2px] text-left min-w-0 ${expandable ? 'cursor-pointer hover:bg-white/[0.03] rounded' : 'cursor-default'}`}
        title={expandable ? undefined : call.summary}
      >
        <span className={`w-1 h-1 rounded-full shrink-0 ${dotColor} ${call.status === 'running' ? 'animate-pulse' : ''}`} />
        <span className="text-[11px] font-mono text-fg-5/60 truncate flex-1"><LinkifyPaths text={call.summary} workdir={workdir} /></span>
        {expandable && (
          <span className={`shrink-0 text-[9px] text-fg-5/40 transition-transform ${open ? 'rotate-90' : ''}`}>▸</span>
        )}
      </button>
      {open && (
        <div className="ml-2.5 mt-0.5 mb-1 space-y-1 border-l border-white/[0.06] pl-2.5">
          {call.input && (
            <pre className="whitespace-pre-wrap break-words text-[10.5px] font-mono leading-[1.55] text-fg-4/80 max-h-[140px] overflow-y-auto"><LinkifyPaths text={call.input} workdir={workdir} /></pre>
          )}
          {call.result && (
            <pre className="whitespace-pre-wrap break-words text-[10.5px] font-mono leading-[1.55] text-fg-5/70 max-h-[140px] overflow-y-auto border-t border-white/[0.04] pt-1"><LinkifyPaths text={call.result} workdir={workdir} /></pre>
          )}
        </div>
      )}
    </div>
  );
}

export function ThinkingDots({ className }: { className?: string }) {
  return (
    <span className={`thinking-dots inline-flex items-center gap-[3px] ${className || ''}`}>
      <span /><span /><span />
    </span>
  );
}

// One live-status row: tool-execution count + context% + cumulative tokens + this turn's output
// + elapsed, rendered as dot-separated segments (each omitted when it has no value).
function LiveStatusMetrics({ toolCount, ctxPct, ctxTokens, turnOutTokens, startedAt }: {
  toolCount: number;
  ctxPct: number | null;
  ctxTokens: number;
  turnOutTokens: number;
  startedAt: number | null;
}) {
  const segs: ReactNode[] = [];
  if (toolCount > 0) {
    segs.push(
      <span key="ops" className="flex items-center gap-1 text-fg-5/55" title={`${toolCount} tool ${toolCount === 1 ? 'call' : 'calls'} this turn`}>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
        </svg>
        {toolCount}
      </span>,
    );
  }
  if (ctxPct != null) {
    segs.push(
      <span key="ctx" className="flex items-center gap-1.5">
        <span className={`h-1.5 w-1.5 rounded-full ${contextDotClass(ctxPct)}`} />{ctxPct.toFixed(1)}%
      </span>,
    );
  }
  if (ctxTokens > 0) segs.push(<span key="tok" className="text-fg-5/40">{formatTokens(ctxTokens)}</span>);
  if (turnOutTokens > 0) segs.push(<span key="out" className="text-fg-5/40">↑{formatTokensShort(turnOutTokens)}</span>);
  if (startedAt != null) segs.push(<LiveElapsed key="elapsed" startedAt={startedAt} />);
  if (!segs.length) return null;
  return (
    <span className="shrink-0 flex items-center gap-1.5">
      {segs.map((seg, i) => (
        <span key={i} className="flex items-center gap-1.5">
          {i > 0 && <span className="text-fg-5/25">·</span>}
          {seg}
        </span>
      ))}
    </span>
  );
}

function LiveElapsed({ startedAt }: { startedAt: number }) {
  const [, forceTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => forceTick(n => n + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  const elapsed = Math.max(0, Date.now() - startedAt);
  return (
    <span className="text-fg-5/55 tabular-nums" title="Elapsed time of the running turn">
      {formatElapsedCompact(elapsed)}
    </span>
  );
}

export function SubAgentCard({ sub, t }: { sub: StreamSubAgent; t: (k: string) => string }) {
  const [open, setOpen] = useState(false);
  const status = sub.status;
  const dotColor = status === 'failed' ? 'bg-rose-400/60'
    : status === 'done' ? 'bg-emerald-400/55'
      : 'bg-amber-400/60';
  const pulse = status === 'running';
  const tools = sub.tools;
  const uniqueToolNames = useMemo(() => {
    const seen = new Set<string>();
    const list: string[] = [];
    for (const tool of tools) {
      if (seen.has(tool.name)) continue;
      seen.add(tool.name);
      list.push(tool.name);
    }
    return list;
  }, [tools]);
  const headerLabel = sub.kind ? `${t('hub.subAgent') || 'Sub-agent'} · ${sub.kind}` : (t('hub.subAgent') || 'Sub-agent');
  const modelLabel = sub.model ? shortenModel(sub.model) : null;
  return (
    <CollapsibleCard
      open={open}
      onToggle={() => setOpen(v => !v)}
      dot={{ color: dotColor, pulse }}
      label={headerLabel}
      preview={
        <span className="flex items-center gap-1.5 min-w-0 text-[12px] text-fg-4">
          {sub.description && <span className="truncate">{sub.description}</span>}
          {modelLabel && <span className="text-[10px] font-mono text-fg-5/55 shrink-0">{modelLabel}</span>}
          {!sub.description && uniqueToolNames.length > 0 && (
            <span className="font-mono text-fg-5/60 truncate">{uniqueToolNames.join(' · ')}</span>
          )}
        </span>
      }
      badge={tools.length > 0 ? <CountBadge>{tools.length}</CountBadge> : undefined}
    >
      <div className="px-3.5 py-2.5 space-y-1 max-h-[260px] overflow-y-auto">
        {sub.description && (
          <div className="mb-1.5 text-[12px] text-fg-3 leading-[1.55]">{sub.description}</div>
        )}
        {tools.length === 0 ? (
          <div className="text-[11px] font-mono text-fg-5/50">— {t('hub.subAgentWaiting') || 'waiting for first tool…'}</div>
        ) : (
          tools.map(tool => (
            <div key={tool.id} className="flex items-center gap-1.5 py-[2px]">
              <span className="w-1 h-1 rounded-full shrink-0 bg-fg-5/30" />
              <span className="text-[11px] font-mono text-fg-5/65 truncate">{tool.summary}</span>
            </div>
          ))
        )}
      </div>
    </CollapsibleCard>
  );
}
