import { forwardRef, type HTMLAttributes, type ReactNode } from 'react';
import { cn } from '../../utils';
import { tv, type VariantProps } from './variants';

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
  streaming?: boolean;
  glow?: boolean;
}

export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
  { children, className, elevation, tone, padding, interactive, streaming, glow, ...rest },
  ref,
) {
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
          interactive: interactive ? 'true' : undefined,
          className,
        }),
        streaming && 'ambient-glow',
        glow && 'card-glow',
      )}
      style={{ transitionDuration: '240ms' }}
      {...rest}
    >
      {children}
    </div>
  );
});
