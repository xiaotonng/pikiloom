import type { UsageTone } from '../usage';

export const USAGE_TONE_COLOR: Record<UsageTone, string> = {
  err: 'var(--th-badge-err-text)',
  warn: 'var(--th-badge-warn-text)',
  ok: 'var(--th-fg-5)',
};

export function UsageRing({ percent, tone, trackTone, alert = false, size = 14 }: {
  percent: number;
  tone: UsageTone;
  trackTone?: UsageTone;
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
      <circle cx="8" cy="8" r={radius} fill="none" stroke={trackColor} strokeOpacity={trackTone ? 0.5 : 0.25} strokeWidth="2.5" />
      <circle
        cx="8" cy="8" r={radius} fill="none"
        stroke={color} strokeWidth="2.5" strokeLinecap="round"
        strokeDasharray={`${(clamped / 100) * circumference} ${circumference}`}
        transform="rotate(-90 8 8)"
      />
      {alert && (
        <circle cx="8" cy="8" r="7.3" fill="none" stroke={USAGE_TONE_COLOR[trackTone ?? 'err']} strokeWidth="1.1" strokeOpacity="0.95" />
      )}
    </svg>
  );
}
