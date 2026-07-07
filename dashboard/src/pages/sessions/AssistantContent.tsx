import { useState, useRef, useLayoutEffect, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import { cn } from '../../utils';
import { CollapsibleCard, CountBadge } from '../../components/ui';
import { PlanProgressCard, hasPlan } from '../../components/PlanProgressCard';
import { createMarkdownComponents, mdPlugins, LinkifyPaths } from './markdown';
import { lastNLines, summarizeToolResult, summarizeToolUse } from './utils';
import { ImageLightbox } from './TurnView';
import { SubAgentCard } from './LivePreview';
import { FileChip } from './FileChip';
import type { RichMessage, MessageBlock, StreamPlan } from '../../types';

export function AssistantMsg({ message, t, workdir, fallbackPlan }: {
  message: RichMessage; t: (k: string) => string; workdir?: string | null;
  // The session's latest known task list from earlier turns. A turn without its own todo
  // update (e.g. a resumed continuation) still shows the current plan — latest wins.
  fallbackPlan?: StreamPlan | null;
}) {
  const { activityBlocks, thinkingBlocks, planBlocks, subAgentBlocks, outputBlocks, noticeBlocks } = categorizeAssistantBlocks(message.blocks);
  const latestPlan = [...planBlocks].reverse().find(block => hasPlan(block.plan));
  const planToShow = latestPlan?.plan ?? (hasPlan(fallbackPlan) ? fallbackPlan : null);
  const hasContent = activityBlocks.length > 0 || subAgentBlocks.length > 0 || !!planToShow || thinkingBlocks.length > 0 || outputBlocks.length > 0 || noticeBlocks.length > 0;
  if (!hasContent) return null;
  return (
    <div className="space-y-3">
      {activityBlocks.length > 0 && <ActivitySection blocks={activityBlocks} t={t} workdir={workdir} />}
      {subAgentBlocks.map(block => block.subAgent ? (
        <SubAgentCard key={block.toolId || block.subAgent.id} sub={block.subAgent} t={t} />
      ) : null)}
      {planToShow && <PlanProgressCard plan={planToShow} t={t} className="max-w-[760px]" />}
      {thinkingBlocks.length > 0 && <ThinkingSection blocks={thinkingBlocks} t={t} />}
      {outputBlocks.length > 0 && <OutputBlock blocks={outputBlocks} t={t} workdir={workdir} />}
      {noticeBlocks.length > 0 && <SystemNoticeSection blocks={noticeBlocks} t={t} />}
    </div>
  );
}

export function hasRenderableAssistant(message: RichMessage): boolean {
  const { activityBlocks, thinkingBlocks, planBlocks, subAgentBlocks, outputBlocks, noticeBlocks } = categorizeAssistantBlocks(message.blocks);
  return outputBlocks.length > 0
    || activityBlocks.length > 0
    || subAgentBlocks.length > 0
    || thinkingBlocks.length > 0
    || planBlocks.some(b => hasPlan(b.plan))
    || noticeBlocks.length > 0;
}

export function categorizeAssistantBlocks(blocks: MessageBlock[]): {
  activityBlocks: MessageBlock[];
  thinkingBlocks: MessageBlock[];
  planBlocks: MessageBlock[];
  subAgentBlocks: MessageBlock[];
  outputBlocks: MessageBlock[];
  noticeBlocks: MessageBlock[];
} {
  const normalized = blocks.filter(block =>
    block.type === 'plan'
    || block.type === 'tool_use'
    || block.type === 'tool_result'
    || block.type === 'image'
    || block.type === 'file'
    || block.type === 'sub_agent'
    || !!block.content.trim(),
  );
  return {
    activityBlocks: normalized.filter(b => b.type === 'tool_use' || b.type === 'tool_result'),
    thinkingBlocks: normalized.filter(b => b.type === 'thinking'),
    planBlocks: normalized.filter(b => b.type === 'plan' && hasPlan(b.plan)),
    subAgentBlocks: normalized.filter(b => b.type === 'sub_agent'),
    outputBlocks: normalized.filter(b => b.type === 'text' || b.type === 'image' || b.type === 'file'),
    noticeBlocks: normalized.filter(b => b.type === 'system_notice'),
  };
}

export function SystemNoticeSection({ blocks, t }: { blocks: MessageBlock[]; t: (k: string) => string }) {
  const text = blocks.map(b => b.content).filter(Boolean).join('\n\n').trim();
  if (!text) return null;
  return (
    <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/[0.06] px-3 py-2 text-[12.5px] leading-[1.7] text-fg-3">
      <span className="mt-[6px] h-1.5 w-1.5 rounded-full bg-amber-400/70 shrink-0" />
      <div className="min-w-0">
        <div className="text-[11px] font-mono uppercase tracking-wide text-amber-300/80">{t('hub.systemNotice') || 'Agent notice'}</div>
        <div className="mt-0.5 break-words whitespace-pre-wrap">{text}</div>
      </div>
    </div>
  );
}

export function ActivitySection({ blocks, t, workdir }: { blocks: MessageBlock[]; t: (k: string) => string; workdir?: string | null }) {
  const [open, setOpen] = useState(false);
  const useBlocks = blocks.filter(b => b.type === 'tool_use');
  const totalOps = useBlocks.length;
  const lastUse = useBlocks[useBlocks.length - 1];
  const preview = lastUse ? summarizeToolUse(lastUse) : '';

  return (
    <CollapsibleCard
      open={open}
      onToggle={() => setOpen(v => !v)}
      dot={{ color: 'bg-cyan-400/60' }}
      label={t('hub.activity')}
      preview={<span className="text-[11.5px] font-mono text-fg-4 truncate"><LinkifyPaths text={preview} workdir={workdir} /></span>}
      badge={totalOps > 0 ? <CountBadge>{totalOps}</CountBadge> : undefined}
    >
      <div className="px-3.5 py-2.5 space-y-0.5">
        {blocks.map((block, i) => <ActivityLine key={i} block={block} workdir={workdir} />)}
      </div>
    </CollapsibleCard>
  );
}

export function ActivityLine({ block, workdir }: { block: MessageBlock; workdir?: string | null }) {
  const [open, setOpen] = useState(false);
  const isUse = block.type === 'tool_use';
  const summary = isUse ? summarizeToolUse(block) : summarizeToolResult(block);
  const expanded = block.content.length > 3000 ? block.content.slice(0, 3000) + '\n\u2026' : block.content;
  return (
    <div>
      <button onClick={() => block.content && setOpen(v => !v)} className={cn('flex items-center gap-2 py-[3px] w-full text-left group rounded-sm transition-colors', block.content && 'hover:bg-panel-h/30')}>
        <span className={cn('h-1.5 w-1.5 rounded-full shrink-0', isUse ? 'bg-fg-5/40' : 'bg-ok/40')} />
        <span className="text-[11px] font-mono text-fg-5/60 group-hover:text-fg-3 transition-colors truncate">
          <LinkifyPaths text={summary} workdir={workdir} />
        </span>
      </button>
      {open && block.content && (
        <pre className="ml-3 mt-1 mb-2 p-3 rounded-md bg-inset border border-edge text-[11px] leading-[1.6] text-fg-4 font-mono whitespace-pre-wrap break-words max-h-[240px] overflow-y-auto">
          <LinkifyPaths text={expanded} workdir={workdir} />
        </pre>
      )}
    </div>
  );
}

export function ThinkingSection({ blocks, t }: { blocks: MessageBlock[]; t: (k: string) => string }) {
  const [open, setOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const text = blocks.map(b => b.content).filter(Boolean).join('\n\n').trim();
  if (!text) return null;

  const preview = lastNLines(text, 3);

  return (
    <CollapsibleCard
      open={open}
      onToggle={() => setOpen(v => !v)}
      dot={{ color: 'bg-violet-400/50' }}
      label={t('hub.thinking')}
      collapsedContent={
        preview ? (
          <div className="px-3.5 pb-2.5 -mt-0.5 text-[12px] text-fg-4 leading-[1.65] whitespace-pre-wrap break-words line-clamp-3">
            {preview}
          </div>
        ) : undefined
      }
    >
      <ThinkingExpandedContent scrollRef={scrollRef} text={text} />
    </CollapsibleCard>
  );
}

export function ThinkingExpandedContent({ scrollRef, text }: { scrollRef: React.RefObject<HTMLDivElement | null>; text: string }) {
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [scrollRef]);

  return (
    <div ref={scrollRef} className="px-3.5 py-3 text-[12px] text-fg-4 leading-[1.7] whitespace-pre-wrap break-words max-h-[320px] overflow-y-auto">
      {text}
    </div>
  );
}

function ImageFigure({
  block,
  onLightbox,
  t,
}: {
  block: MessageBlock;
  onLightbox: (src: string) => void;
  t: (k: string) => string;
}) {
  const caption = block.imageCaption?.trim() || '';
  const isPrompt = block.imageCaptionKind === 'prompt';
  const [showPrompt, setShowPrompt] = useState(false);
  return (
    <figure className="flex flex-col gap-1.5 max-w-[400px]">
      <img
        src={block.content}
        alt={caption || ''}
        className="max-w-[400px] max-h-[300px] rounded-md border border-fg-6/50 object-contain cursor-zoom-in hover:opacity-90 transition-opacity"
        onClick={() => onLightbox(block.content)}
      />
      {caption && (isPrompt ? (
        <>
          <button
            type="button"
            onClick={() => setShowPrompt(v => !v)}
            aria-expanded={showPrompt}
            className={cn(
              'self-start inline-flex items-center gap-1 px-2 py-[3px] rounded-md',
              'text-[11px] font-medium tracking-wide',
              'border border-fg-6/40 bg-fg-6/[0.06] text-fg-3',
              'hover:bg-fg-6/[0.12] hover:text-fg-2 hover:border-fg-6/60',
              'transition-colors',
            )}
            title={showPrompt ? t('hub.imagePromptHide') : t('hub.imagePromptShow')}
          >
            <span aria-hidden className="text-[9px] leading-none">{showPrompt ? '▾' : '▸'}</span>
            <span>{t('hub.imagePrompt')}</span>
          </button>
          {showPrompt && (
            <div className="rounded-md border border-fg-6/30 bg-fg-6/[0.05] px-3 py-2 max-w-[400px] max-h-[260px] overflow-y-auto">
              <div className="text-[11.5px] leading-[1.65] text-fg-3 whitespace-pre-wrap break-words">
                {caption}
              </div>
            </div>
          )}
        </>
      ) : (
        <figcaption className="text-[11px] leading-[1.55] text-fg-5 max-w-[400px] break-words whitespace-pre-wrap">
          {caption}
        </figcaption>
      ))}
    </figure>
  );
}

export function OutputBlock({ blocks, t, workdir }: { blocks: MessageBlock[]; t: (k: string) => string; workdir?: string | null }) {
  const textBlocks = blocks.filter(b => b.type === 'text');
  const imageBlocks = blocks.filter(b => b.type === 'image');
  const fileBlocks = blocks.filter(b => b.type === 'file');
  const text = textBlocks.map(b => b.content).filter(Boolean).join('\n\n');
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const markdownComponents = useMemo(() => createMarkdownComponents({ workdir }), [workdir]);
  if (!text.trim() && imageBlocks.length === 0 && fileBlocks.length === 0) return null;
  return (
    <>
      {text.trim() && (
        <div className="session-md text-[13.5px] leading-[1.75] text-fg-2">
          <ReactMarkdown remarkPlugins={mdPlugins} components={markdownComponents}>
            {text}
          </ReactMarkdown>
        </div>
      )}
      {imageBlocks.length > 0 && (
        <div className="flex flex-wrap gap-3 mt-2">
          {imageBlocks.map((img, i) => (
            <ImageFigure key={i} block={img} onLightbox={setLightboxSrc} t={t} />
          ))}
        </div>
      )}
      {fileBlocks.length > 0 && (
        <div className="flex flex-col gap-2 mt-2">
          {fileBlocks.map((file, i) => (
            <FileChip
              key={i}
              url={file.content}
              fileName={file.fileName || 'file'}
              fileSize={file.fileSize}
              caption={file.fileCaption}
            />
          ))}
        </div>
      )}
      {lightboxSrc && <ImageLightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />}
    </>
  );
}
