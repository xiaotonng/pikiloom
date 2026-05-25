import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cn } from '../../utils';
import { tv, type VariantProps } from './variants';

/**
 * Button — three intent levels + three sizes.
 *
 * Variants (orthogonal):
 *   - tone: 'primary' (filled accent), 'secondary' (hairline outline),
 *           'ghost' (text-only)
 *   - size: 'sm' (h-7), 'md' (h-8 default), 'lg' (h-9)
 *   - shape: 'rect' (default rounded-md), 'icon' (square), 'pill' (rounded-full)
 *
 * Legacy aliases for backward compat:
 *   - variant?: 'primary' | 'secondary' | 'outline' | 'ghost'
 *     → 'outline' maps to tone 'secondary' (they were visually identical).
 *
 * Why split tone from shape: icon-only buttons no longer need a special
 * 'icon' variant; pass shape="icon" with any tone.
 */
const button = tv({
  base: [
    'inline-flex items-center justify-center gap-2 whitespace-nowrap',
    'font-medium select-none',
    'transition-[background,color,border-color,box-shadow,transform]',
    'focus-visible:outline-none',
    'focus-visible:shadow-[0_0_0_3px_var(--brand-glow-a)]',
    'disabled:pointer-events-none disabled:opacity-50',
  ].join(' '),
  variants: {
    tone: {
      primary: [
        'border border-transparent',
        'bg-[var(--brand-accent)] text-[var(--brand-accent-fg)]',
        'hover:opacity-90',
      ].join(' '),
      secondary: [
        'border border-[var(--edge-default)] bg-transparent text-fg-2',
        'hover:border-[var(--edge-strong)] hover:bg-[var(--surface-3)] hover:text-fg',
      ].join(' '),
      ghost: [
        'border border-transparent bg-transparent text-fg-4',
        'hover:bg-[var(--surface-2)] hover:text-fg-2',
      ].join(' '),
      danger: [
        'border border-[var(--edge-default)] bg-transparent text-[var(--th-err)]',
        'hover:bg-[color-mix(in_oklab,var(--th-err)_8%,transparent)] hover:border-[color-mix(in_oklab,var(--th-err)_45%,transparent)]',
      ].join(' '),
    },
    size: {
      sm: 'h-7 text-[11px]',
      md: 'h-8 text-[13px]',
      lg: 'h-9 text-[14px]',
    },
    shape: {
      rect: 'rounded-md',
      icon: 'rounded-md',
      pill: 'rounded-full',
    },
  },
  defaults: { tone: 'secondary', size: 'md', shape: 'rect' },
});

// Padding depends on size+shape combination; encode that off the variant table
// to keep the matrix small and the rules legible.
function paddingClass(size: ButtonSize, shape: ButtonShape): string {
  if (shape === 'icon') {
    return size === 'sm' ? 'w-7 p-0' : size === 'lg' ? 'w-9 p-0' : 'w-8 p-0';
  }
  if (size === 'sm') return 'px-2.5';
  if (size === 'lg') return 'px-4';
  return 'px-3';
}

export type ButtonTone = NonNullable<VariantProps<typeof button>['tone']>;
export type ButtonSize = NonNullable<VariantProps<typeof button>['size']>;
export type ButtonShape = NonNullable<VariantProps<typeof button>['shape']>;

/**
 * Legacy size aliases: pre-refactor call sites passed
 *   `size: 'default' | 'sm' | 'icon'`
 * The `'icon'` value crossed two axes (size+shape) — we untangle it here
 * so consumers can keep working without touching every file.
 */
type LegacySize = 'default' | 'sm' | 'icon';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'size'> {
  tone?: ButtonTone;
  size?: ButtonSize | LegacySize;
  shape?: ButtonShape;
  /** Optional leading element (e.g. spinner / icon). */
  leading?: ReactNode;
  /** Optional trailing element (e.g. chevron / kbd). */
  trailing?: ReactNode;
  /** @deprecated use `tone` — kept for legacy call sites. */
  variant?: 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger';
}

const VARIANT_TO_TONE: Record<NonNullable<ButtonProps['variant']>, ButtonTone> = {
  primary: 'primary',
  secondary: 'secondary',
  outline: 'secondary', // legacy alias
  ghost: 'ghost',
  danger: 'danger',
};

function resolveSizeShape(
  size: ButtonSize | LegacySize | undefined,
  shape: ButtonShape | undefined,
): { size: ButtonSize; shape: ButtonShape } {
  if (size === 'icon') return { size: 'md', shape: 'icon' };
  if (size === 'default') return { size: 'md', shape: shape ?? 'rect' };
  return { size: (size ?? 'md') as ButtonSize, shape: shape ?? 'rect' };
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { tone, size, shape, variant, leading, trailing, className, type = 'button', children, ...props },
  ref,
) {
  const resolvedTone: ButtonTone = tone ?? (variant ? VARIANT_TO_TONE[variant] : 'secondary');
  const { size: rSize, shape: rShape } = resolveSizeShape(size, shape);
  return (
    <button
      ref={ref}
      type={type}
      className={cn(button({ tone: resolvedTone, size: rSize, shape: rShape, className }), paddingClass(rSize, rShape))}
      style={{ transitionDuration: '180ms' }}
      {...props}
    >
      {leading}
      {children}
      {trailing}
    </button>
  );
});
