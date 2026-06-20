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
 *
 * Two channels (see `usageGauge`): the **arc** fills to the live 5h window in
 * its own tone, while the **track** can be painted in a *slower* window's tone
 * (`trackTone`) to surface a near-full weekly / extra-usage ceiling, and an
 * outer **halo** (`alert`) fires when that slow window has actually hit its
 * hard limit. So a short green arc sitting in a red well reads as "free right
 * now, but the weekly/budget wall is here".
 */
export function UsageRing({ percent, tone, trackTone, alert = false, size = 14 }: {
  percent: number;
  tone: UsageTone;
  /** Worst slower-window tone — recolors the track when warn/err. */
  trackTone?: UsageTone;
  /** A slower window hit its hard limit — draw the outer alert halo. */
  alert?: boolean;
  size?: number;
}) {
  const clamped = Math.max(0, Math.min(100, percent));
  const radius = 6;
  const circumference = 2 * Math.PI * radius;
  const color = USAGE_TONE_COLOR[tone];
  const trackColor = USAGE_TONE_COLOR[trackTone ?? tone];
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" role="img" aria-label={`${Math.round(clamped)}%`}>
      {/* Track — neutral faded normally; painted in the worst slow window's
          tone (heavier) when that window is near full. */}
      <circle cx="8" cy="8" r={radius} fill="none" stroke={trackColor} strokeOpacity={trackTone ? 0.5 : 0.25} strokeWidth="2.5" />
      {/* Arc — the live 5h fill, in its own tone. */}
      <circle
        cx="8" cy="8" r={radius} fill="none"
        stroke={color} strokeWidth="2.5" strokeLinecap="round"
        strokeDasharray={`${(clamped / 100) * circumference} ${circumference}`}
        transform="rotate(-90 8 8)"
      />
      {/* Alert halo — a slow window hit its hard limit (weekly cutoff / budget wall). */}
      {alert && (
        <circle cx="8" cy="8" r="7.3" fill="none" stroke={USAGE_TONE_COLOR[trackTone ?? 'err']} strokeWidth="1.1" strokeOpacity="0.95" />
      )}
    </svg>
  );
}
