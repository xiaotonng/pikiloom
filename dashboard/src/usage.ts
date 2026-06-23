import type { UsageResult, UsageWindowInfo } from './types';

export type UsageTone = 'ok' | 'warn' | 'err';

const STATUS_TONE: Record<string, UsageTone> = {
  limit_reached: 'err',
  warning: 'warn',
};

export function usageWindowTone(window: UsageWindowInfo): UsageTone {
  const fromStatus = window.status ? STATUS_TONE[window.status] : undefined;
  if (fromStatus) return fromStatus;
  if (window.usedPercent != null) {
    if (window.usedPercent >= 100) return 'err';
    if (window.usedPercent >= 80) return 'warn';
  }
  return 'ok';
}

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

export function displayableUsageWindows(usage: UsageResult | null): UsageWindowInfo[] {
  if (!usage?.ok) return [];
  return usage.windows.filter(window => window.usedPercent != null);
}

export function worstUsageWindow(usage: UsageResult | null): UsageWindowInfo | null {
  let worst: UsageWindowInfo | null = null;
  for (const window of displayableUsageWindows(usage)) {
    if (!worst || (window.usedPercent ?? 0) > (worst.usedPercent ?? 0)) worst = window;
  }
  return worst;
}

const PRIMARY_WINDOW_LABEL = '5h';

export interface UsageGauge {
  primary: UsageWindowInfo;
  secondaryTone: UsageTone | null;
  secondaryAlert: boolean;
}

export function usageGauge(usage: UsageResult | null): UsageGauge | null {
  const windows = displayableUsageWindows(usage);
  if (!windows.length) return null;
  const primary = windows.find(w => w.label === PRIMARY_WINDOW_LABEL) ?? worstUsageWindow(usage)!;
  let worstSecondary: UsageWindowInfo | null = null;
  for (const w of windows) {
    if (w === primary) continue;
    if (!worstSecondary || (w.usedPercent ?? 0) > (worstSecondary.usedPercent ?? 0)) worstSecondary = w;
  }
  let secondaryTone: UsageTone | null = null;
  let secondaryAlert = false;
  if (worstSecondary) {
    const tone = usageWindowTone(worstSecondary);
    if (tone !== 'ok') secondaryTone = tone;
    if (tone === 'err') secondaryAlert = true;
  }
  return { primary, secondaryTone, secondaryAlert };
}

export function usagePercentText(window: UsageWindowInfo): string {
  return `${Math.round(window.usedPercent ?? 0)}%`;
}

export function resetSecondsFor(window: UsageWindowInfo): number | null {
  if (window.resetAt) {
    const at = Date.parse(window.resetAt);
    if (Number.isFinite(at)) return Math.round((at - Date.now()) / 1000);
  }
  return window.resetAfterSeconds;
}

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

export function formatCapturedAt(iso: string): string | null {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  const sameDay = at.toDateString() === new Date().toDateString();
  return sameDay
    ? at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : at.toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
