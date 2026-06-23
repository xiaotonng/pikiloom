import type { CSSProperties, HTMLAttributes, ReactNode } from 'react';
import { cn } from '../../utils';

export interface FieldProps {
  label?: ReactNode;
  children: ReactNode;
  mono?: boolean;
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

export function DescriptionList({
  items,
  columns = 2,
  className,
}: {
  items: Array<{ label: ReactNode; value: ReactNode; mono?: boolean }>;
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

export interface PageHeaderProps {
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

export interface TileProps extends HTMLAttributes<HTMLDivElement> {
  size?: number;
  framed?: boolean;
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

export function LoadingDots({ className }: { className?: string }) {
  return (
    <span className={cn('thinking-dots inline-flex items-center gap-[3px]', className)}>
      <span /><span /><span />
    </span>
  );
}
