/**
 * Data display primitives — small typed wrappers for the data shapes that
 * recur across pages. Each one is < 30 LOC; the goal is for pages to stop
 * inlining ad-hoc `<div className="rounded-lg border…">` blocks and instead
 * compose these.
 *
 * Components in this file:
 *   - Field        — `label` + `value` (optional mono). Use inline anywhere.
 *   - Metric       — bordered tile with uppercase label + big value + hint.
 *   - DescriptionList — `key: value` pair grid (replaces shared.DetailGrid).
 *   - EmptyState   — bordered placeholder for empty surfaces.
 *   - PageHeader   — the page hero (eyebrow + title + description + right slot).
 *   - Tile         — square brand-icon avatar tile.
 *   - LoadingDots  — the bouncing-dots indicator (sibling to Spinner).
 *
 * Why one file instead of one-per-component: each is so small that splitting
 * them into 7 files adds more import noise than it removes. The file is still
 * tree-shakeable thanks to ES modules + Vite.
 */

import type { CSSProperties, HTMLAttributes, ReactNode } from 'react';
import { cn } from '../../utils';

/* ─────────────────────────────────────────────────────────────
 * Field — uppercase label + value. Inline atom used anywhere a
 * "labelled value" appears (cards, metrics, settings rows).
 * ─────────────────────────────────────────────────────────── */
export interface FieldProps {
  label?: ReactNode;
  children: ReactNode;
  mono?: boolean;
  /** Stack the label/value vertically (default). 'inline' renders side-by-side. */
  orientation?: 'vertical' | 'inline';
  className?: string;
}

export function Field({
  label,
  children,
  mono,
  orientation = 'vertical',
  className,
}: FieldProps) {
  if (orientation === 'inline') {
    return (
      <div className={cn('flex items-baseline gap-2 min-w-0', className)}>
        {label && (
          <span className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.16em] text-fg-5">
            {label}
          </span>
        )}
        <span className={cn('truncate text-[13px] text-fg-2', mono && 'font-mono text-[12px] text-fg-3')}>
          {children}
        </span>
      </div>
    );
  }
  return (
    <div className={cn('min-w-0', className)}>
      {label && (
        <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-fg-5">
          {label}
        </div>
      )}
      <div className={cn('mt-1 break-words text-[13px] leading-relaxed text-fg-2', mono && 'font-mono text-[12px] text-fg-3')}>
        {children}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
 * Metric — bordered tile with uppercase label + big value + optional hint.
 * Drop-in upgrade for `shared.Metric` (which now delegates here).
 * ─────────────────────────────────────────────────────────── */
export function Metric({
  label,
  value,
  hint,
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('rounded-lg border border-[var(--edge-subtle)] bg-[var(--surface-2)] px-4 py-3', className)}>
      <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-fg-5">{label}</div>
      <div className="mt-1 text-[18px] font-semibold leading-snug text-fg">{value}</div>
      {hint && <div className="mt-1 text-[12px] leading-relaxed text-fg-4">{hint}</div>}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
 * DescriptionList — grid of (label, value) tiles.
 * Use when a section shows many key→value pairs at once.
 * ─────────────────────────────────────────────────────────── */
export function DescriptionList({
  items,
  columns = 2,
  className,
}: {
  items: Array<{ label: ReactNode; value: ReactNode; mono?: boolean }>;
  /** Number of columns above the sm breakpoint. Defaults to 2. */
  columns?: 1 | 2 | 3 | 4;
  className?: string;
}) {
  const gridCols =
    columns === 1 ? 'sm:grid-cols-1' :
    columns === 2 ? 'sm:grid-cols-2' :
    columns === 3 ? 'sm:grid-cols-3' :
    'sm:grid-cols-4';
  return (
    <div className={cn('grid gap-2', gridCols, className)}>
      {items.map((item, i) => (
        <div key={i} className="rounded-lg border border-[var(--edge-subtle)] bg-[var(--surface-2)] px-4 py-3">
          <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-fg-5">{item.label}</div>
          <div className={cn('mt-1 break-words text-sm leading-relaxed text-fg-2', item.mono && 'font-mono text-[12px] text-fg-3')}>
            {item.value}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
 * EmptyState — bordered placeholder for an empty list / section.
 * ─────────────────────────────────────────────────────────── */
export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-[var(--edge-default)] bg-[var(--surface-2)]/60 px-6 py-10 text-center',
        className,
      )}
    >
      {icon && <div className="text-fg-5">{icon}</div>}
      <div className="text-[14px] font-semibold text-fg-2">{title}</div>
      {description && <div className="max-w-md text-[12.5px] leading-relaxed text-fg-4">{description}</div>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
 * PageHeader — the page hero. Replaces `shared.TabHero`. Lives in
 * `components/ui` so any page (including dashboards yet to be built)
 * can mount it without going through the shared.tsx page module.
 * ─────────────────────────────────────────────────────────── */
export interface PageHeaderProps {
  /** Optional uppercase tracked label above the title. */
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  right?: ReactNode;
  className?: string;
}

export function PageHeader({ eyebrow, title, description, right, className }: PageHeaderProps) {
  return (
    <div
      className={cn(
        'flex flex-col gap-3 border-b border-[var(--edge-subtle)] pb-5 xl:flex-row xl:items-end xl:justify-between xl:gap-6',
        className,
      )}
    >
      <div className="max-w-3xl">
        {eyebrow && (
          <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-fg-5">{eyebrow}</div>
        )}
        <div className="mt-1.5 text-[22px] font-semibold leading-tight tracking-tight text-fg">{title}</div>
        {description && (
          <div className="mt-2 text-[13.5px] leading-relaxed text-fg-4">{description}</div>
        )}
      </div>
      {right && <div className="flex shrink-0 flex-wrap items-center gap-2">{right}</div>}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
 * Tile — square avatar / brand-icon tile.
 *
 * One canonical shape so brand identity (the only place color is
 * allowed) renders consistently in row leads, modals, and pickers.
 * ─────────────────────────────────────────────────────────── */
export interface TileProps extends HTMLAttributes<HTMLDivElement> {
  /** Visual size in px. Default 36. */
  size?: number;
  /** True (default) draws the hairline border + dim bg around the content. */
  framed?: boolean;
  /** Inline style overrides — used for brand-color fills on letter avatars. */
  style?: CSSProperties;
  children: ReactNode;
}

export function Tile({
  size = 36,
  framed = true,
  className,
  style,
  children,
  ...rest
}: TileProps) {
  return (
    <div
      className={cn(
        'flex shrink-0 items-center justify-center overflow-hidden rounded-md',
        framed && 'border border-[var(--edge-subtle)] bg-[var(--surface-1)] text-fg-3',
        className,
      )}
      style={{ width: size, height: size, ...style }}
      {...rest}
    >
      {children}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
 * LoadingDots — three bouncing dots. Sibling to Spinner; use for
 * ambient "thinking" indicators that don't suggest progress.
 * ─────────────────────────────────────────────────────────── */
export function LoadingDots({ className }: { className?: string }) {
  return (
    <span className={cn('thinking-dots inline-flex items-center gap-[3px]', className)}>
      <span /><span /><span />
    </span>
  );
}
