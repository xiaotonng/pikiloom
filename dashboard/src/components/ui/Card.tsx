import { forwardRef, type HTMLAttributes, type ReactNode } from 'react';
import { cn } from '../../utils';
import { tv, type VariantProps } from './variants';

/**
 * Card — neutral container with hairline edge. Surface = `surface[2]`,
 * border = `edge.default`, radius = 8px. The Linear-refresh look:
 * softened corners + low-contrast hairlines, no heavy shadows.
 *
 * Variants:
 *   - elevation: 'flat' (no shadow), 'raised' (soft drop), 'modal' (elev shadow)
 *   - tone: 'default' (surface[2]) | 'inset' (surface[1] — chrome / sidebar feel)
 *   - padding: 'none' | 'sm' | 'md' | 'lg'
 *
 * Streaming behavior: pass `streaming` to wrap the card in the ambient glow
 * ring (see `AmbientGlow` for the standalone wrapper). When streaming is false
 * the card is visually identical to the static version — zero perf cost.
 */
const card = tv({
  base: [
    'rounded-lg border bg-[var(--surface-2)]',
    'transition-[border-color,background,transform,box-shadow]',
  ].join(' '),
  variants: {
    elevation: {
      flat: 'border-[var(--edge-subtle)] shadow-none',
      raised: 'border-[var(--edge-default)] shadow-[0_1px_0_rgba(255,255,255,0.02),0_4px_12px_rgba(2,6,23,0.06)]',
      modal: 'border-[var(--edge-strong)] shadow-[0_24px_64px_rgba(2,6,23,0.24)]',
    },
    tone: {
      default: 'bg-[var(--surface-2)]',
      inset: 'bg-[var(--surface-1)]',
    },
    padding: {
      none: '',
      sm: 'p-2.5',
      md: 'p-4',
      lg: 'p-5',
    },
    interactive: {
      true: 'cursor-pointer hover:border-[var(--edge-strong)] hover:bg-[var(--surface-3)]',
      false: '',
    },
  },
  defaults: { elevation: 'flat', tone: 'default', padding: 'none' },
});

export type CardElevation = NonNullable<VariantProps<typeof card>['elevation']>;
export type CardTone = NonNullable<VariantProps<typeof card>['tone']>;
export type CardPadding = NonNullable<VariantProps<typeof card>['padding']>;

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  elevation?: CardElevation;
  tone?: CardTone;
  padding?: CardPadding;
  interactive?: boolean;
  /** True = wrap with `.ambient-glow` ring that animates when streaming. */
  streaming?: boolean;
  /** @deprecated use elevation='raised' or padding='sm'. */
  glow?: boolean;
}

export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
  { children, className, elevation, tone, padding, interactive, streaming, glow, ...rest },
  ref,
) {
  // Backwards compat: previous default was glassy + raised + p-2.5.
  // We keep that as the *default* so existing call sites don't visually shift.
  const resolvedElevation = elevation ?? 'raised';
  const resolvedPadding = padding ?? 'sm';
  return (
    <div
      ref={ref}
      data-streaming={streaming ? 'true' : undefined}
      className={cn(
        card({
          elevation: resolvedElevation,
          tone,
          padding: resolvedPadding,
          // `tv()` will coerce truthy → "true". `interactive={false}` falls
          // through to the empty-variant default.
          interactive: interactive ? 'true' : undefined,
          className,
        }),
        streaming && 'ambient-glow',
        // Legacy hover-glow opt-in.
        glow && 'card-glow',
      )}
      style={{ transitionDuration: '240ms' }}
      {...rest}
    >
      {children}
    </div>
  );
});
