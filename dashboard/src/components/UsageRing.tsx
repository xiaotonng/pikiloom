import type { UsageTone } from '../usage';

/** Shared tone → color mapping for the usage visuals (ring, tooltip bars).
 *  Healthy usage stays neutral so an always-on indicator doesn't nag. */
export const USAGE_TONE_COLOR: Record<UsageTone, string> = {
  err: 'var(--th-badge-err-text)',
  warn: 'var(--th-badge-warn-text)',
  ok: 'var(--th-fg-5)',
};

/**
 * UsageRing — minimal donut gauge for a rate-limit window. Reads as "how
 * full is the quota" at a glance (battery-style) without shouting a raw
 * number; the per-window breakdown lives in the wrapping Tooltip. Colors
 * track the badge CSS variables so themes stay consistent.
 */
export function UsageRing({ percent, tone, size = 14 }: {
  percent: number;
  tone: UsageTone;
  size?: number;
}) {
  const clamped = Math.max(0, Math.min(100, percent));
  const radius = 6;
  const circumference = 2 * Math.PI * radius;
  const color = USAGE_TONE_COLOR[tone];
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" role="img" aria-label={`${Math.round(clamped)}%`}>
      <circle cx="8" cy="8" r={radius} fill="none" stroke={color} strokeOpacity="0.25" strokeWidth="2.5" />
      <circle
        cx="8" cy="8" r={radius} fill="none"
        stroke={color} strokeWidth="2.5" strokeLinecap="round"
        strokeDasharray={`${(clamped / 100) * circumference} ${circumference}`}
        transform="rotate(-90 8 8)"
      />
    </svg>
  );
}
