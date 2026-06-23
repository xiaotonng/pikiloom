export const colors = {
  surface: {
    0: 'var(--surface-0)',
    1: 'var(--surface-1)',
    2: 'var(--surface-2)',
    3: 'var(--surface-3)',
    elev: 'var(--surface-elev)',
  },
  fg: {
    1: 'var(--th-fg)',
    2: 'var(--th-fg-2)',
    3: 'var(--th-fg-3)',
    4: 'var(--th-fg-4)',
    5: 'var(--th-fg-5)',
    6: 'var(--th-fg-6)',
  },
  edge: {
    subtle: 'var(--edge-subtle)',
    default: 'var(--edge-default)',
    strong: 'var(--edge-strong)',
  },
  status: {
    ok: 'var(--th-ok)',
    warn: 'var(--th-warn)',
    err: 'var(--th-err)',
    info: 'var(--th-info)',
    running: 'var(--th-running)',
    idle: 'var(--th-idle)',
  },
  statusGlow: {
    ok: 'var(--th-ok-glow)',
    warn: 'var(--th-warn-glow)',
    err: 'var(--th-err-glow)',
    info: 'var(--th-info-glow)',
    running: 'var(--th-running-glow)',
  },
  brand: {
    accent: 'var(--brand-accent)',
    accentFg: 'var(--brand-accent-fg)',
    glowA: 'var(--brand-glow-a)',
    glowB: 'var(--brand-glow-b)',
    glowIdle: 'var(--brand-glow-idle)',
  },
} as const;

export const radii = {
  sm: '4px',
  md: '6px',
  lg: '8px',
  xl: '12px',
  full: '9999px',
} as const;

export const spacing = {
  0.5: '2px', 1: '4px', 1.5: '6px',
  2: '8px', 2.5: '10px', 3: '12px',
  4: '16px', 5: '20px', 6: '24px',
  8: '32px', 10: '40px',
} as const;

export const typography = {
  display: { size: '28px', leading: '36px' },
  title:   { size: '18px', leading: '26px' },
  heading: { size: '15px', leading: '22px' },
  body:    { size: '14px', leading: '22px' },
  small:   { size: '13px', leading: '20px' },
  caption: { size: '12px', leading: '18px' },
  label:   { size: '11px', leading: '16px', letterSpacing: '0.16em' },
  mono:    { size: '12px', leading: '18px' },
} as const;

export const motion = {
  instant: '120ms',
  fast: '180ms',
  base: '240ms',
  slow: '380ms',
  ambient: '2400ms',
} as const;

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
