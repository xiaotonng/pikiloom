import { useState, useRef, useEffect, useLayoutEffect, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import { CollapsibleCard, CountBadge } from '../../components/ui';
import { PlanProgressCard, hasPlan } from '../../components/PlanProgressCard';
import { createMarkdownComponents, mdPlugins } from './markdown';
import { lastNLines, classifyRunEnd } from './utils';
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
  /** Number of image-generation calls in flight — drives the
   *  "Generating image…" chip while bytes have yet to land. */
  generatingImages?: number;
  /** Live token/usage meta for the in-flight turn. `turnOutputTokens` climbs
   *  from the opening extended-thinking phase through every tool roundtrip;
   *  the TurnDivider header renders it as the "↑n" chip. */
  previewMeta?: StreamPreviewMeta | null;
  /** Files delivered mid-turn via `im_send_file`, in delivery order. */
  artifacts?: SnapshotArtifact[] | null;
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

/** True when the live preview will render any visible element (body or error tile). */
export function liveStreamShouldRender(stream: LiveStreamView): boolean {
  if (liveStreamHasBody(stream)) return true;
  // Streaming with no body yet — still render so the TurnDivider header and the
  // internal ThinkingDots fill the "waiting for the first token" window. Without
  // this branch, IM-initiated turns (no pendingPrompt to bridge) show nothing
  // between session-start and the first text chunk.
  if (stream.phase === 'streaming') return true;
  return stream.phase === 'done' && !!stream.error;
}

export function liveStreamFailureLabelKey(stream: LiveStreamView): string | null {
  if (stream.phase !== 'done' || !stream.error) return null;
  return liveStreamHasBody(stream) ? 'hub.streamErrored' : 'hub.streamFailed';
}

/**
 * Compact, low-profile end-of-turn marker. Replaces the old full-width rose
 * box that occupied three padded lines for every stopped/errored turn.
 *  - A user stop ("Interrupted by user.") renders as a muted neutral chip —
 *    it was intentional, so it must not read as a failure or grab attention.
 *  - Timeouts / max-token stops render neutral with their (short) reason.
 *  - Only genuine errors get a rose tint, and even then as a single tiny line.
 * Used both for the persisted `runDetail` (SessionPanel) and the transient
 * live `stream.error` (LivePreview) so the two stay visually consistent.
 */
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

// Re-parsing the full, growing assistant text through react-markdown on every
// stream delta is O(n) per delta → O(n²) over a long reply (a 16KB answer costs
// ~800ms of main-thread parse work, 12–27ms per late delta). That starves the
// event loop and makes typing in the composer stutter mid-stream. Cap the
// re-parse to ~16fps while streaming — reading doesn't need more, and the gaps
// between parses leave the main thread free for keystrokes. Once the turn is
// done we render immediately (intervalMs 0) so the final text is never stale.
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
  // When not throttling (turn done), return the live value so the final,
  // complete text renders without waiting on a trailing timer.
  return intervalMs <= 0 ? value : throttled;
}

/* ── Live streaming preview ── */
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
  // Stream finished with an error — surface it even when partial text/activity
  // exists, otherwise failed Claude turns can look like normal replies.
  const failureLabelKey = liveStreamFailureLabelKey(stream);
  const activityLines = useMemo(() =>
    (stream.activity || '').split('\n').filter(Boolean),
    [stream.activity],
  );
  const toolCalls = stream.previewMeta?.toolCalls ?? [];
  const lastActivity = activityLines[activityLines.length - 1]
    || toolCalls[toolCalls.length - 1]?.summary
    || '';

  // Auto-scroll activity detail to bottom when content updates
  useLayoutEffect(() => {
    const el = activityScrollRef.current;
    if (el && activityOpen) el.scrollTop = el.scrollHeight;
  }, [activityOpen, stream.activity, toolCalls.length]);

  // Auto-scroll thinking detail to bottom when content updates
  useLayoutEffect(() => {
    const el = thinkingScrollRef.current;
    if (el && thinkingOpen) el.scrollTop = el.scrollHeight;
  }, [thinkingOpen, stream.thinking]);

  const subAgents = stream.subAgents ?? null;

  // Throttle + memoize the response markdown so it re-parses at most ~16fps while
  // streaming (and only when the text actually changes — not when activity /
  // thinking / tool rows update around it).
  const liveText = useThrottledValue(stream.text, stream.phase === 'streaming' ? STREAM_MARKDOWN_THROTTLE_MS : 0);
  const markdownComponents = useMemo(() => createMarkdownComponents({ workdir }), [workdir]);
  const responseMarkdown = useMemo(
    () => <ReactMarkdown remarkPlugins={mdPlugins} components={markdownComponents}>{liveText}</ReactMarkdown>,
    [liveText, markdownComponents],
  );

  return (
    <div className="space-y-3 animate-in">
      {/* Plan — prominent card at top */}
      {showPlan && (
        <PlanProgressCard plan={stream.plan!} t={t} className="mb-1 max-w-[760px]" />
      )}

      {/* Sub-agent invocations — each Task tool gets its own discrete card so
          its model and tool stream stay isolated from the parent's activity. */}
      {subAgents && subAgents.length > 0 && subAgents.map(sub => (
        <SubAgentCard key={sub.id} sub={sub} t={t} />
      ))}

      {/* Activity — expandable, shows latest line as preview. When the driver
          supplies structured tool calls (previewMeta.toolCalls), each row is
          itself click-to-expand with bounded input/result detail; otherwise we
          fall back to the flat summary strings. */}
      {(toolCalls.length > 0 || activityLines.length > 0) && (
        <CollapsibleCard
          open={activityOpen}
          onToggle={() => setActivityOpen(v => !v)}
          dot={{ color: 'bg-cyan-400/60', pulse: true }}
          label={t('hub.activity')}
          preview={<span className="text-[12px] text-fg-4 truncate">{lastActivity}</span>}
          badge={(toolCalls.length || activityLines.length) > 1
            ? <CountBadge>{toolCalls.length || activityLines.length}</CountBadge>
            : undefined}
        >
          <div ref={activityScrollRef} className="px-3.5 py-2.5 space-y-0.5 max-h-[280px] overflow-y-auto">
            {toolCalls.length > 0
              ? toolCalls.map(call => <ToolCallRow key={call.id} call={call} />)
              : activityLines.map((line, i) => (
                <div key={i} className="flex items-center gap-1.5 py-[2px]">
                  <span className="w-1 h-1 rounded-full shrink-0 bg-fg-5/30" />
                  <span className="text-[11px] font-mono text-fg-5/60 truncate">{line}</span>
                </div>
              ))}
          </div>
        </CollapsibleCard>
      )}

      {/* Thinking — 3-line preview, expandable */}
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

      {/* Response text with thinking dots */}
      {stream.text && (
        <div className="session-md text-[13.5px] leading-[1.75] text-fg-2">
          {responseMarkdown}
          {stream.phase === 'streaming' && <ThinkingDots className="ml-1 inline-flex align-text-bottom text-fg-4" />}
        </div>
      )}

      {/* Delivered files — surfaced live as the agent hands them over, so a
          remote user sees the artifact immediately rather than waiting for the
          turn to finalize. Photos render inline; documents get a download chip.
          The durable copy re-renders from the transcript after the turn ends. */}
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

      {/* Loading dots — shown whenever the stream is live but no text body is
          rendered yet. Inline dots (above) only appear once stream.text exists,
          so this fills the gap when activity / thinking / plan are shown alone
          or when no content has arrived at all. The divider already carries
          model/effort/token state, so avoid repeating a textual "thinking"
          label in the body. */}
      {!stream.text && stream.phase === 'streaming' && (
        <div className="py-1">
          <ThinkingDots className="text-fg-5" />
        </div>
      )}

      {/* Image generation in flight — surfaced as a distinct chip so the user
          knows why the turn is taking longer than a typical text reply
          (image_gen wall time is 60-90s). Disappears when the assistant block
          arrives with the actual image. */}
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

      {/* Stream finished — surface a compact, low-profile end marker. A user
          stop is intentional (neutral chip), not an error; only genuine
          failures get rose tint. Replaces the old full-width rose box so a
          stopped/errored turn no longer dominates the conversation. */}
      {failureLabelKey && stream.error && (
        <RunEndNotice detail={stream.error} t={t} className="pt-0.5" />
      )}
    </div>
  );
}

/**
 * One live tool invocation. Rows with input/result detail expand on click —
 * this is what makes the 执行 list inspectable *during* a run instead of only
 * after the turn lands in history.
 */
function ToolCallRow({ call }: { call: StreamToolCall }) {
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
        <span className="text-[11px] font-mono text-fg-5/60 truncate flex-1">{call.summary}</span>
        {expandable && (
          <span className={`shrink-0 text-[9px] text-fg-5/40 transition-transform ${open ? 'rotate-90' : ''}`}>▸</span>
        )}
      </button>
      {open && (
        <div className="ml-2.5 mt-0.5 mb-1 space-y-1 border-l border-white/[0.06] pl-2.5">
          {call.input && (
            <pre className="whitespace-pre-wrap break-words text-[10.5px] font-mono leading-[1.55] text-fg-4/80 max-h-[140px] overflow-y-auto">{call.input}</pre>
          )}
          {call.result && (
            <pre className="whitespace-pre-wrap break-words text-[10.5px] font-mono leading-[1.55] text-fg-5/70 max-h-[140px] overflow-y-auto border-t border-white/[0.04] pt-1">{call.result}</pre>
          )}
        </div>
      )}
    </div>
  );
}

/** Animated ··· indicator for streaming / thinking states */
export function ThinkingDots({ className }: { className?: string }) {
  return (
    <span className={`thinking-dots inline-flex items-center gap-[3px] ${className || ''}`}>
      <span /><span /><span />
    </span>
  );
}

/**
 * Discrete card for a sub-agent (Claude Task tool). Shows its own model, kind
 * (e.g. "Explore"), description, and tool stream — visually separated from the
 * parent agent's activity so the two contexts don't blur into one.
 */
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
