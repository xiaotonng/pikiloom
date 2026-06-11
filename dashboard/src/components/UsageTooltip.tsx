import type { UsageResult } from '../types';
import { formatCapturedAt, formatResetShort, resetSecondsFor, usageWindowTone } from '../usage';
import { USAGE_TONE_COLOR } from './UsageRing';

/**
 * UsageTooltipContent — the hover panel behind every usage indicator: one row
 * per rate-limit window (label · bar · percent · reset countdown) plus an
 * "as of" footer. Countdowns are anchored to the absolute reset timestamp,
 * so they stay correct even when the snapshot itself is stale.
 */
export function UsageTooltipContent({ usage, t, title }: {
  usage: UsageResult | null;
  t: (key: string) => string;
  /** Optional header line — used where the surrounding UI doesn't already
   *  name the account the numbers belong to (e.g. the global header). */
  title?: string;
}) {
  if (!usage?.ok || !usage.windows.length) {
    return <>{usage?.error || t('config.balanceUnavailable')}</>;
  }
  const capturedAt = usage.capturedAt ? formatCapturedAt(usage.capturedAt) : null;
  return (
    <div className="flex min-w-[200px] flex-col gap-1 py-0.5">
      {title && <div className="mb-0.5 font-medium text-fg-4">{title}</div>}
      {usage.windows.map(window => {
        const tone = usageWindowTone(window);
        const percent = window.usedPercent;
        const remain = resetSecondsFor(window);
        const reset = remain != null && remain <= 0
          ? t('usage.resetElapsed')
          : formatResetShort(remain) ? `↻ ${formatResetShort(remain)}` : '';
        return (
          <div key={window.label} className="flex items-center gap-2">
            <span className="w-14 shrink-0 text-fg-4">{window.label}</span>
            {percent != null ? (
              <>
                <span className="h-[3px] w-12 shrink-0 overflow-hidden rounded-full bg-fg/10">
                  <span
                    className="block h-full rounded-full"
                    style={{ width: `${Math.max(2, Math.min(100, percent))}%`, backgroundColor: USAGE_TONE_COLOR[tone] }}
                  />
                </span>
                <span className="font-mono text-fg-2">{Math.round(percent)}%</span>
              </>
            ) : (
              <span className="text-fg-4">{window.status || '—'}</span>
            )}
            <span className="ml-auto pl-2 text-fg-5">{reset}</span>
          </div>
        );
      })}
      {capturedAt && (
        <div className="mt-0.5 text-[10px] text-fg-5">{t('usage.asOf')} {capturedAt}</div>
      )}
    </div>
  );
}
