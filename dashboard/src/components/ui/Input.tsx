import { forwardRef, type InputHTMLAttributes, type ReactNode } from 'react';
import { cn } from '../../utils';
import { tv, type VariantProps } from './variants';

/**
 * Input — hairline form control with the same focus ring as Button.
 *
 * Variants:
 *   - size: 'sm' (h-7) | 'md' (h-9 default) | 'lg' (h-10)
 *   - tone: 'default' (transparent w/ hairline) | 'inset' (filled, for modals)
 *
 * The default tone uses `surface[2]` so inputs sit on the same plane as the
 * row they live in. Use 'inset' inside modals where the panel is elevated
 * and the field needs to be visually distinct.
 */
const input = tv({
  base: [
    'flex w-full text-fg outline-none',
    'border rounded-md',
    'transition-[border-color,box-shadow,background]',
    'placeholder:text-fg-5',
    'focus:shadow-[0_0_0_3px_var(--brand-glow-a)]',
    'disabled:cursor-not-allowed disabled:bg-[var(--surface-2)] disabled:border-[var(--edge-subtle)] disabled:text-fg-5',
    'disabled:shadow-none disabled:hover:border-[var(--edge-subtle)] disabled:placeholder:text-fg-6',
  ].join(' '),
  variants: {
    size: {
      sm: 'h-7 px-2 py-1 text-[12px]',
      md: 'h-9 px-3 py-1.5 text-[13px]',
      lg: 'h-10 px-3 py-2 text-[14px]',
    },
    tone: {
      default: [
        'bg-transparent border-[var(--edge-default)]',
        'hover:border-[var(--edge-strong)]',
        'focus:border-[var(--edge-strong)] focus:bg-[var(--surface-2)]',
      ].join(' '),
      inset: [
        'bg-[var(--surface-2)] border-[var(--edge-default)]',
        'hover:border-[var(--edge-strong)]',
        'focus:border-[var(--edge-strong)] focus:bg-[var(--surface-3)]',
      ].join(' '),
    },
  },
  defaults: { size: 'md', tone: 'default' },
});

export type InputSize = NonNullable<VariantProps<typeof input>['size']>;
export type InputTone = NonNullable<VariantProps<typeof input>['tone']>;

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  size?: InputSize;
  tone?: InputTone;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, size, tone, ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      className={cn(input({ size, tone, className }))}
      style={{ transitionDuration: '180ms' }}
      {...props}
    />
  );
});

/* ─────────────────────────────────────────────────────────────
 * Label — form-field label that sits directly above an Input.
 *
 * Use `<SectionLabel>` (from ./feedback) for the uppercase tracked variant
 * that introduces a *group* of controls.
 * ─────────────────────────────────────────────────────────── */
export function Label({
  children,
  htmlFor,
  className,
}: {
  children: ReactNode;
  htmlFor?: string;
  className?: string;
}) {
  return (
    <label
      htmlFor={htmlFor}
      className={cn('mb-2 block text-sm font-medium text-fg-3', className)}
    >
      {children}
    </label>
  );
}
