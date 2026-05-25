/**
 * Design tokens — typed bindings for CSS variables defined in `src/index.css`.
 *
 * Why this exists:
 *   - One TypeScript-side source of truth for the semantic palette so
 *     components stop reaching for raw Tailwind colours (`cyan-400`,
 *     `amber-500/10`, …) and instead reference *meaning* (`status.running`,
 *     `surface[2]`).
 *   - Switching themes is still a CSS-only operation — values are
 *     `var(--*)` strings, resolved by the browser at paint time.
 *   - Refactors only need to edit one file when a semantic role changes.
 *
 * Rules:
 *   - Chrome stays on the SURFACE ladder (achromatic).
 *   - Color belongs in three places ONLY: status pills, agent identity,
 *     and the single primary CTA accent (`brand.accent`).
 *   - Ambient streaming pulses use `brand.glow.*`, NOT a status colour.
 */

export const colors = {
  /** Achromatic background ladder. surface[0] = page; surface[1] = chrome
   *  (sidebar, dimmer than content); surface[2] = card/row; surface[3] = hover. */
  surface: {
    0: 'var(--surface-0)',
    1: 'var(--surface-1)',
    2: 'var(--surface-2)',
    3: 'var(--surface-3)',
    elev: 'var(--surface-elev)',
  },
  /** Foreground (text) — 6 emphasis levels. fg[1] = title; fg[6] = divider-text. */
  fg: {
    1: 'var(--th-fg)',
    2: 'var(--th-fg-2)',
    3: 'var(--th-fg-3)',
    4: 'var(--th-fg-4)',
    5: 'var(--th-fg-5)',
    6: 'var(--th-fg-6)',
  },
  /** Hairline border tokens — the only allowed divider widths. */
  edge: {
    subtle: 'var(--edge-subtle)',
    default: 'var(--edge-default)',
    strong: 'var(--edge-strong)',
  },
  /** Semantic status — pills, dots, verb-phrase indicators. */
  status: {
    ok: 'var(--th-ok)',
    warn: 'var(--th-warn)',
    err: 'var(--th-err)',
    info: 'var(--th-info)',
    running: 'var(--th-running)',
    idle: 'var(--th-idle)',
  },
  /** Glow for status dots / soft halos. */
  statusGlow: {
    ok: 'var(--th-ok-glow)',
    warn: 'var(--th-warn-glow)',
    err: 'var(--th-err-glow)',
    info: 'var(--th-info-glow)',
    running: 'var(--th-running-glow)',
  },
  /** Brand — used ONLY on the primary CTA + ambient streaming pulse. */
  brand: {
    accent: 'var(--brand-accent)',
    accentFg: 'var(--brand-accent-fg)',
    glowA: 'var(--brand-glow-a)',
    glowB: 'var(--brand-glow-b)',
    glowIdle: 'var(--brand-glow-idle)',
  },
} as const;

/** Corner radii. Only four allowed values across the app. */
export const radii = {
  sm: '4px',   // inline pills, dots
  md: '6px',   // controls (Button, Input, Select)
  lg: '8px',   // cards, rows, modal panels
  xl: '12px',  // hero cards, large surfaces
  full: '9999px',
} as const;

/** Spacing scale — multiples of 4px. Use sparingly; Tailwind already covers most. */
export const spacing = {
  0.5: '2px', 1: '4px', 1.5: '6px',
  2: '8px', 2.5: '10px', 3: '12px',
  4: '16px', 5: '20px', 6: '24px',
  8: '32px', 10: '40px',
} as const;

/**
 * Typography scale — six tiers, all in single line-heights.
 * size = font-size · leading = line-height · use weight + tracking from Tailwind.
 */
export const typography = {
  display: { size: '28px', leading: '36px' },  // page hero
  title:   { size: '18px', leading: '26px' },  // section title
  heading: { size: '15px', leading: '22px' },  // card heading
  body:    { size: '14px', leading: '22px' },  // body
  small:   { size: '13px', leading: '20px' },  // dense body
  caption: { size: '12px', leading: '18px' },  // meta
  label:   { size: '11px', leading: '16px', letterSpacing: '0.16em' }, // uppercase form label
  mono:    { size: '12px', leading: '18px' },  // technical id / token
} as const;

/** Motion durations — keep all transitions in this set. */
export const motion = {
  instant: '120ms',
  fast: '180ms',
  base: '240ms',
  slow: '380ms',
  ambient: '2400ms', // streaming breath
} as const;

/** Easing curves. Use `out` for entrances, `inOut` for state changes. */
export const easings = {
  out: 'cubic-bezier(0.21, 0.47, 0.32, 0.98)',
  inOut: 'cubic-bezier(0.65, 0, 0.35, 1)',
  spring: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
} as const;

export type SurfaceLevel = keyof typeof colors.surface;
export type FgLevel = keyof typeof colors.fg;
export type EdgeLevel = keyof typeof colors.edge;
export type StatusKind = keyof typeof colors.status;
export type RadiusToken = keyof typeof radii;
export type TypeScale = keyof typeof typography;
