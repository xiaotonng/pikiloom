import { forwardRef, type HTMLAttributes, type ReactNode } from 'react';
import { cn } from '../../utils';

const ROW_GRID_VAR = '--row-grid';

const DEFAULT_GRID = '260px 120px minmax(0,1fr) auto';

const GRID_COLS_CLASS =
  'lg:grid-cols-[var(--row-grid,260px_120px_minmax(0,1fr)_auto)]';

export function RowGroup({
  children,
  className,
  columns,
}: {
  children: ReactNode;
  className?: string;
  columns?: string;
}) {
  return (
    <div
      className={cn(
        'overflow-hidden rounded-lg border border-[var(--edge-subtle)] bg-[var(--surface-2)]',
        '[&>*+*]:border-t [&>*+*]:border-[var(--edge-subtle)]',
        className,
      )}
      style={{ [ROW_GRID_VAR]: columns ?? DEFAULT_GRID } as React.CSSProperties}
    >
      {children}
    </div>
  );
}

export function Section({
  title,
  description,
  right,
  children,
  className,
}: {
  title?: ReactNode;
  description?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('flex flex-col gap-3', className)}>
      {(title || right) && (
        <div className="flex items-end justify-between gap-3 px-0.5">
          <div className="min-w-0">
            {title && (
              <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-fg-5">
                {title}
              </div>
            )}
            {description && (
              <div className="mt-1.5 text-[13px] leading-relaxed text-fg-4">{description}</div>
            )}
          </div>
          {right && <div className="shrink-0">{right}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

interface RowComposition {
  Lead: typeof RowLead;
  Field: typeof RowField;
  Status: typeof RowStatus;
  Action: typeof RowAction;
  Description: typeof RowDescription;
  Header: typeof RowHeader;
}

interface RowProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  inline?: boolean;
}

const RowImpl = forwardRef<HTMLDivElement, RowProps>(function Row(
  { children, className, inline = true, ...rest },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cn(
        'grid gap-x-5 gap-y-2 px-4 py-3 min-h-[64px]',
        GRID_COLS_CLASS,
        'lg:items-center',
        'transition-[background] duration-200 hover:bg-[var(--surface-3)]',
        inline
          ? ''
          : 'rounded-lg border border-[var(--edge-subtle)] bg-[var(--surface-2)]',
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
});

export const Row = RowImpl as typeof RowImpl & RowComposition;

function RowHeader({
  columns,
  className,
}: {
  columns: ReactNode[];
  className?: string;
}) {
  return (
    <div
      className={cn(
        'hidden lg:grid gap-x-5 px-4 py-2',
        GRID_COLS_CLASS,
        'lg:items-center',
        'bg-[var(--surface-1)]',
        className,
      )}
    >
      {columns.map((label, i) => (
        <div
          key={i}
          className="truncate text-[10px] font-semibold uppercase tracking-[0.16em] text-fg-5"
        >
          {label}
        </div>
      ))}
    </div>
  );
}
Row.Header = RowHeader;

function RowLead({
  icon,
  title,
  subtitle,
  badge,
  className,
  iconWrap = true,
}: {
  icon?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  badge?: ReactNode;
  className?: string;
  iconWrap?: boolean;
}) {
  return (
    <div className={cn('flex min-w-0 items-center gap-3', className)}>
      {icon && (
        iconWrap ? (
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-[var(--edge-subtle)] bg-[var(--surface-1)] text-fg-3">
            {icon}
          </div>
        ) : (
          <div className="flex h-9 w-9 shrink-0 items-center justify-center">
            {icon}
          </div>
        )
      )}
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <div className="truncate text-[13.5px] font-semibold text-fg">{title}</div>
          {badge}
        </div>
        {subtitle && (
          <div className="mt-0.5 truncate text-[12px] leading-snug text-fg-5">{subtitle}</div>
        )}
      </div>
    </div>
  );
}
Row.Lead = RowLead;

function RowField({
  label,
  children,
  className,
  mono,
}: {
  label?: ReactNode;
  children: ReactNode;
  className?: string;
  mono?: boolean;
}) {
  return (
    <div className={cn('min-w-0', className)}>
      {label && (
        <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-fg-5 mb-1">
          {label}
        </div>
      )}
      <div
        className={cn(
          'truncate text-[13px] text-fg-3',
          mono && 'font-mono text-[12px]',
        )}
      >
        {children}
      </div>
    </div>
  );
}
Row.Field = RowField;

function RowStatus({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('flex shrink-0 items-center', className)}>
      {children}
    </div>
  );
}
Row.Status = RowStatus;

function RowAction({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('flex shrink-0 items-center gap-2 justify-start lg:justify-end', className)}>
      {children}
    </div>
  );
}
Row.Action = RowAction;

function RowDescription({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'col-span-full lg:col-span-full',
        'text-[12.5px] leading-relaxed text-fg-4',
        'pl-12',
        '-mt-1',
        className,
      )}
      style={{ gridColumn: '1 / -1' }}
    >
      {children}
    </div>
  );
}
Row.Description = RowDescription;
