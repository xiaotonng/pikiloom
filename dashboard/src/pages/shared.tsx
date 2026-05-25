import type { ReactNode } from 'react';
import {
  Badge,
  Button,
  Card,
  DescriptionList,
  Dot,
  EmptyState,
  Field,
  LoadingDots,
  Metric as MetricPrimitive,
  PageHeader,
  Row,
  RowGroup,
  Section,
  Spinner,
  StatusPill,
  Tile,
  type StatusState,
} from '../components/ui';
import { cn } from '../utils';

/**
 * Page-level composites — thin compatibility layer over the canonical
 * primitives in `components/ui/`. Every component in this file is a
 * one-line delegator so consumers don't need to migrate import paths in
 * lock-step with the design-system refactor; they get the new look for free.
 *
 * Adding new things here is OK if they're truly *page-shape* (page hero,
 * action bar). Anything reusable across pages belongs in `components/ui`.
 */

export type Tone = 'ok' | 'warn' | 'err' | 'accent' | 'muted';
const TONE_TO_STATE: Record<Tone, StatusState> = {
  ok: 'ok', warn: 'warn', err: 'err', accent: 'info', muted: 'idle',
};

/** Page hero — delegate to PageHeader. */
export function TabHero({
  eyebrow,
  title,
  description,
  right,
}: {
  eyebrow: string;
  title: string;
  description: string;
  right?: ReactNode;
}) {
  return <PageHeader eyebrow={eyebrow} title={title} description={description} right={right} />;
}

/** Status badge — delegate to StatusPill. Loading uses the running-pulse pill. */
export function StatusBadge({
  tone,
  label,
  loading,
}: {
  tone: Tone;
  label: string;
  loading?: boolean;
}) {
  if (loading) {
    return (
      <Badge tone={tone === 'accent' ? 'accent' : tone === 'ok' ? 'ok' : tone === 'warn' ? 'warn' : tone === 'err' ? 'err' : 'muted'}>
        <Spinner />
        {label}
      </Badge>
    );
  }
  return <StatusPill state={TONE_TO_STATE[tone]} label={label} />;
}

/** Metric tile — delegate. */
export function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return <MetricPrimitive label={label} value={value} hint={hint} />;
}

/** Description list — delegate. */
export function DetailGrid({
  items,
}: {
  items: Array<{ label: string; value: ReactNode; mono?: boolean }>;
}) {
  return <DescriptionList items={items} columns={2} />;
}

/** Vertical list of bordered step-tiles. */
export function StepList({ steps }: { steps: string[] }) {
  return (
    <ol className="space-y-2 text-sm leading-relaxed text-fg-3">
      {steps.map(step => (
        <li key={step} className="rounded-lg border border-[var(--edge-subtle)] bg-[var(--surface-2)] px-3 py-2">
          {step}
        </li>
      ))}
    </ol>
  );
}

export function ActionBar({
  primary,
  secondary,
  tertiary,
}: {
  primary?: { label: string; onClick: () => void | Promise<void>; disabled?: boolean; loading?: boolean };
  secondary?: { label: string; onClick: () => void | Promise<void>; disabled?: boolean };
  tertiary?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 pt-1 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
      <div className="flex flex-wrap items-center gap-2">
        {primary && (
          <Button tone="primary" onClick={primary.onClick} disabled={primary.disabled}>
            {primary.loading && <Spinner />}
            {primary.label}
          </Button>
        )}
        {secondary && (
          <Button tone="secondary" onClick={secondary.onClick} disabled={secondary.disabled}>
            {secondary.label}
          </Button>
        )}
      </div>
      {tertiary && <div className="text-xs leading-relaxed text-fg-4">{tertiary}</div>}
    </div>
  );
}

export function StatusRail({
  label,
  value,
  tone,
  pulse,
}: {
  label: string;
  value: string;
  tone: 'ok' | 'warn' | 'err' | 'idle';
  pulse?: boolean;
}) {
  return (
    <div className="flex items-center gap-2 rounded-full border border-[var(--edge-subtle)] bg-[var(--surface-2)] px-3 py-1.5 text-xs text-fg-4">
      <Dot tone={tone} pulse={pulse} />
      <span className="font-semibold uppercase tracking-[0.16em] text-fg-5">{label}</span>
      <span className="text-fg-2">{value}</span>
    </div>
  );
}

export function SectionCard({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <Card padding="md" elevation="flat" className={className}>
      {children}
    </Card>
  );
}

/* ─────────────────────────────────────────────────────────────
 * SettingRow* — preserved API delegating to the canonical Row primitives.
 *
 * The previous version rendered per-cell uppercase labels which produced
 * variable-height cells and made columns drift between rows. The new Row
 * is single-line-per-cell with full-width Description rows for secondary
 * text, so the wrapper here drops the `label` prop's prominence — it
 * still renders (for non-migrated consumers) but as a quiet inline prefix
 * rather than a full second line.
 * ─────────────────────────────────────────────────────────── */

export function SettingRowCard({ children, className }: { children: ReactNode; className?: string }) {
  return <Row inline={false} className={className}>{children}</Row>;
}

export function SettingRowLead({
  icon,
  title,
  subtitle,
  badge,
  className,
  iconWrap = true,
}: {
  icon: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  badge?: ReactNode;
  className?: string;
  iconWrap?: boolean;
}) {
  return (
    <Row.Lead
      icon={icon}
      title={title}
      subtitle={subtitle}
      badge={badge}
      className={className}
      iconWrap={iconWrap}
    />
  );
}

export function SettingRowField({
  label,
  children,
  className,
}: {
  label: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Row.Field label={label} className={className}>
      {children}
    </Row.Field>
  );
}

export function SettingRowAction({ children, className }: { children: ReactNode; className?: string }) {
  return <Row.Action className={className}>{children}</Row.Action>;
}

/* Re-export the canonical primitives so pages can switch over progressively. */
export { Row, RowGroup, Section, Field, EmptyState, LoadingDots, Tile, PageHeader };
