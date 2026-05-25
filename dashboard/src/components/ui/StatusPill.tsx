import { forwardRef, type HTMLAttributes, type ReactNode } from 'react';
import { cn } from '../../utils';
import { Dot, type DotTone } from './Badge';

/**
 * StatusPill — a *live* status indicator with a coloured dot and a
 * verb-phrase label. Modelled on Cursor 3's agent rows ("Reading docs",
 * "Generating plan", "Fetching data") and Linear's delegation pills.
 *
 * When `state` is 'running', the dot pulses softly. Idle / completed states
 * are visually quiet — no chrome distractions.
 *
 * Why a separate component from <Badge>?
 *   - Badge is for static labels ("Connected", "Disabled").
 *   - StatusPill ties a *behavior* (animated dot + uppercase verb) to a
 *     known semantic state — agents and sessions consume the same
 *     vocabulary across the dashboard.
 *
 * Typical use:
 *   <StatusPill state="running" label="Reading docs" />
 *   <StatusPill state="ok" label="Done" detail="2 turns" />
 */

export type StatusState = 'running' | 'ok' | 'warn' | 'err' | 'info' | 'idle';

const STATE_TO_DOT: Record<StatusState, DotTone> = {
  running: 'running',
  ok: 'ok',
  warn: 'warn',
  err: 'err',
  info: 'info',
  idle: 'idle',
};

const STATE_TO_TEXT: Record<StatusState, string> = {
  running: 'text-[var(--th-badge-running-text)]',
  ok: 'text-[var(--th-badge-ok-text)]',
  warn: 'text-[var(--th-badge-warn-text)]',
  err: 'text-[var(--th-badge-err-text)]',
  info: 'text-[var(--th-badge-info-text)]',
  idle: 'text-fg-4',
};

const STATE_TO_BG: Record<StatusState, string> = {
  running: 'bg-[var(--th-badge-running-bg)] border-[var(--th-badge-running-border)]',
  ok: 'bg-[var(--th-badge-ok-bg)] border-[var(--th-badge-ok-border)]',
  warn: 'bg-[var(--th-badge-warn-bg)] border-[var(--th-badge-warn-border)]',
  err: 'bg-[var(--th-badge-err-bg)] border-[var(--th-badge-err-border)]',
  info: 'bg-[var(--th-badge-info-bg)] border-[var(--th-badge-info-border)]',
  idle: 'bg-transparent border-[var(--edge-subtle)]',
};

export interface StatusPillProps extends HTMLAttributes<HTMLSpanElement> {
  state: StatusState;
  /** Verb-phrase label, e.g. "Reading docs", "Generating plan", "Done". */
  label: ReactNode;
  /** Optional dim secondary detail (monospace), e.g. elapsed time. */
  detail?: ReactNode;
  /** Visual shape. 'pill' (rounded-full) is default; 'rect' for inline lists. */
  shape?: 'pill' | 'rect';
}

export const StatusPill = forwardRef<HTMLSpanElement, StatusPillProps>(function StatusPill(
  { state, label, detail, shape = 'pill', className, ...rest },
  ref,
) {
  return (
    <span
      ref={ref}
      className={cn(
        'inline-flex h-6 items-center gap-1.5 border px-2 text-[11px] font-medium tracking-[0.01em]',
        shape === 'pill' ? 'rounded-full' : 'rounded-md',
        STATE_TO_BG[state],
        STATE_TO_TEXT[state],
        className,
      )}
      {...rest}
    >
      <Dot tone={STATE_TO_DOT[state]} pulse={state === 'running'} />
      <span className="truncate">{label}</span>
      {detail && (
        <span className="font-mono text-[10px] text-fg-5 ml-0.5">{detail}</span>
      )}
    </span>
  );
});
