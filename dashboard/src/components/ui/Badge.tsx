import { forwardRef, type CSSProperties, type HTMLAttributes, type ReactNode } from 'react';
import { cn } from '../../utils';

/**
 * Badge — small static label. Use for state labels (e.g. "Connected"),
 * category tags, or as a sibling to a row title.
 *
 * For *live* agent / session state with an animated indicator, prefer
 * `<StatusPill>` (see ./StatusPill.tsx). Badge is the static cousin.
 */

export type BadgeTone = 'ok' | 'warn' | 'err' | 'info' | 'running' | 'accent' | 'muted';

/* All badge variants resolve to the same three CSS variables (text / bg / border).
 * Driving them from CSS keeps theme switching free and rules out style drift. */
const TONE_VARS: Record<BadgeTone, CSSProperties> = {
  ok: {
    borderColor: 'var(--th-badge-ok-border)',
    backgroundColor: 'var(--th-badge-ok-bg)',
    color: 'var(--th-badge-ok-text)',
  },
  warn: {
    borderColor: 'var(--th-badge-warn-border)',
    backgroundColor: 'var(--th-badge-warn-bg)',
    color: 'var(--th-badge-warn-text)',
  },
  err: {
    borderColor: 'var(--th-badge-err-border)',
    backgroundColor: 'var(--th-badge-err-bg)',
    color: 'var(--th-badge-err-text)',
  },
  info: {
    borderColor: 'var(--th-badge-info-border)',
    backgroundColor: 'var(--th-badge-info-bg)',
    color: 'var(--th-badge-info-text)',
  },
  running: {
    borderColor: 'var(--th-badge-running-border)',
    backgroundColor: 'var(--th-badge-running-bg)',
    color: 'var(--th-badge-running-text)',
  },
  accent: {
    borderColor: 'var(--th-badge-accent-border)',
    backgroundColor: 'var(--th-badge-accent-bg)',
    color: 'var(--th-badge-accent-text)',
  },
  muted: {
    borderColor: 'var(--th-badge-muted-border)',
    backgroundColor: 'var(--th-badge-muted-bg)',
    color: 'var(--th-badge-muted-text)',
  },
};

export type BadgeSize = 'xs' | 'sm';
const SIZE_CLASSES: Record<BadgeSize, string> = {
  xs: 'h-[18px] px-1.5 text-[10px]',
  sm: 'h-5 px-2 text-[11px]',
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  /** Semantic tone. Defaults to muted. Replaces the legacy `variant` prop. */
  tone?: BadgeTone;
  size?: BadgeSize;
  children: ReactNode;
  /** @deprecated use `tone`. */
  variant?: BadgeTone;
}

export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(function Badge(
  { tone, variant, size = 'sm', children, className, style, ...rest },
  ref,
) {
  const resolvedTone: BadgeTone = tone ?? variant ?? 'muted';
  return (
    <span
      ref={ref}
      style={{ ...TONE_VARS[resolvedTone], ...style }}
      className={cn(
        'inline-flex items-center gap-1 rounded-md border font-medium tracking-[0.01em]',
        SIZE_CLASSES[size],
        className,
      )}
      {...rest}
    >
      {children}
    </span>
  );
});

/* ─────────────────────────────────────────────────────────────
 * Dot — sibling indicator. Tiny color dot with optional pulse.
 * ─────────────────────────────────────────────────────────── */
export type DotTone = 'ok' | 'warn' | 'err' | 'info' | 'running' | 'idle';
const DOT_CLASSES: Record<DotTone, string> = {
  ok:      'bg-[var(--th-ok)] shadow-[0_0_10px_var(--th-ok-glow)]',
  warn:    'bg-[var(--th-warn)] shadow-[0_0_10px_var(--th-warn-glow)]',
  err:     'bg-[var(--th-err)] shadow-[0_0_10px_var(--th-err-glow)]',
  info:    'bg-[var(--th-info)] shadow-[0_0_10px_var(--th-info-glow)]',
  running: 'bg-[var(--th-running)] shadow-[0_0_10px_var(--th-running-glow)]',
  idle:    'bg-fg-5',
};

export function Dot({
  tone,
  variant,
  pulse,
  className,
}: {
  tone?: DotTone;
  /** @deprecated use `tone`. */
  variant?: DotTone;
  pulse?: boolean;
  className?: string;
}) {
  const resolved = tone ?? variant ?? 'idle';
  return (
    <span
      className={cn(
        'h-1.5 w-1.5 shrink-0 rounded-full',
        DOT_CLASSES[resolved],
        pulse && 'animate-pulse-soft',
        className,
      )}
    />
  );
}

/* ─────────────────────────────────────────────────────────────
 * CountBadge — compact monospace counter / id chip.
 * ─────────────────────────────────────────────────────────── */
export function CountBadge({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        'rounded-md border border-[var(--edge-subtle)] bg-[var(--surface-2)] px-1.5 py-0.5',
        'text-[10px] font-mono text-fg-5',
        className,
      )}
    >
      {children}
    </span>
  );
}
