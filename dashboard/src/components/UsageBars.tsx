import { Fragment } from 'react';
import type { UsageResult } from '../types';
import { formatResetShort, resetSecondsFor, usageWindowTone } from '../usage';
import { USAGE_TONE_COLOR } from './UsageRing';

// Compact per-account usage: every resource window (5h / 7d / …) as a labelled bar + reset
// countdown. A fixed 4-column grid (label · bar · % · reset) keeps every row — and every
// instance — aligned. Shared by the agent-config account cards and the header switcher.
export function UsageBars({ usage, emptyText, className = '' }: {
  usage: UsageResult | null;
  emptyText: string;
  className?: string;
}) {
  const windows = usage?.ok ? usage.windows : [];
  if (!windows.length) {
    return <div className={`text-[11px] leading-relaxed text-fg-5 ${className}`}>{usage?.error || emptyText}</div>;
  }
  return (
    <div className={`grid grid-cols-[3.5rem_minmax(0,1fr)_2.25rem_2.75rem] items-center gap-x-1.5 gap-y-1 text-[11px] ${className}`}>
      {windows.map(w => {
        const tone = usageWindowTone(w);
        const pct = w.usedPercent;
        const reset = formatResetShort(resetSecondsFor(w));
        return (
          <Fragment key={w.label}>
            <span className="truncate text-fg-5">{w.label}</span>
            <span className="h-[3px] overflow-hidden rounded-full bg-fg/10">
              {pct != null && (
                <span
                  className="block h-full rounded-full"
                  style={{ width: `${Math.max(2, Math.min(100, pct))}%`, backgroundColor: USAGE_TONE_COLOR[tone] }}
                />
              )}
            </span>
            <span className="text-right font-mono text-fg-3">{pct != null ? `${Math.round(pct)}%` : (w.status || '—')}</span>
            <span className="text-right tabular-nums text-[10px] text-fg-5">{reset ? `↻${reset}` : ''}</span>
          </Fragment>
        );
      })}
    </div>
  );
}
