import type { UsageResult, UsageWindowInfo } from './types';

export type UsageTone = 'ok' | 'warn' | 'err';

const STATUS_TONE: Record<string, UsageTone> = {
  limit_reached: 'err',
  warning: 'warn',
};

/** Tone for one window. Claude windows carry a driver-set status; codex live
 *  windows don't, so fall back to the same percent thresholds the claude
 *  driver applies (≥100 → limit reached, ≥80 → warning). */
export function usageWindowTone(window: UsageWindowInfo): UsageTone {
  const fromStatus = window.status ? STATUS_TONE[window.status] : undefined;
  if (fromStatus) return fromStatus;
  if (window.usedPercent != null) {
    if (window.usedPercent >= 100) return 'err';
    if (window.usedPercent >= 80) return 'warn';
  }
  return 'ok';
}

/** Overall tone — the worst of the result-level status and every window.
 *  "No data" deliberately maps to 'ok': the usage surfaces stay quiet rather
 *  than alarm on a failed or unsupported usage probe. */
export function usageTone(usage: UsageResult | null): UsageTone {
  if (!usage?.ok) return 'ok';
  let tone: UsageTone = (usage.status && STATUS_TONE[usage.status]) || 'ok';
  for (const window of usage.windows) {
    const windowTone = usageWindowTone(window);
    if (windowTone === 'err') return 'err';
    if (windowTone === 'warn') tone = 'warn';
  }
  return tone;
}

/** Windows with a measured percentage — the ones worth rendering as numbers.
 *  (The claude telemetry fallback emits a status-only window with a null
 *  percent; it still feeds usageTone but can't be drawn inline.) */
export function displayableUsageWindows(usage: UsageResult | null): UsageWindowInfo[] {
  if (!usage?.ok) return [];
  return usage.windows.filter(window => window.usedPercent != null);
}

/** Most-loaded displayable window — drives the compact single-window chip. */
export function worstUsageWindow(usage: UsageResult | null): UsageWindowInfo | null {
  let worst: UsageWindowInfo | null = null;
  for (const window of displayableUsageWindows(usage)) {
    if (!worst || (window.usedPercent ?? 0) > (worst.usedPercent ?? 0)) worst = window;
  }
  return worst;
}

export function usagePercentText(window: UsageWindowInfo): string {
  return `${Math.round(window.usedPercent ?? 0)}%`;
}

/** Live remaining seconds for a window's reset. Anchored to the absolute
 *  `resetAt` timestamp when present, so a stale snapshot still counts down
 *  correctly (the capture-time `resetAfterSeconds` freezes the moment the
 *  driver sampled it). Negative result = the window has already reset and
 *  the snapshot is overdue for a refresh. */
export function resetSecondsFor(window: UsageWindowInfo): number | null {
  if (window.resetAt) {
    const at = Date.parse(window.resetAt);
    if (Number.isFinite(at)) return Math.round((at - Date.now()) / 1000);
  }
  return window.resetAfterSeconds;
}

/** Compact reset countdown: "45m" / "2h15m" / "3d4h". */
export function formatResetShort(seconds: number | null): string | null {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return null;
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${Math.max(mins, 1)}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) {
    const rem = mins % 60;
    return rem ? `${hours}h${rem}m` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours ? `${days}d${remHours}h` : `${days}d`;
}

/** Capture timestamp for display. A bare HH:MM reads as "today", so the
 *  month/day is included whenever the snapshot is older than that. */
export function formatCapturedAt(iso: string): string | null {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  const sameDay = at.toDateString() === new Date().toDateString();
  return sameDay
    ? at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : at.toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
