import { forwardRef, type HTMLAttributes, type ReactNode, createElement } from 'react';
import { cn } from '../../utils';

const HEADING_VARIANTS = {
  1: { tag: 'h1' as const, cls: 'text-[26px] leading-[34px] font-semibold tracking-tight text-fg' },
  2: { tag: 'h2' as const, cls: 'text-[18px] leading-[26px] font-semibold tracking-tight text-fg' },
  3: { tag: 'h3' as const, cls: 'text-[15px] leading-[22px] font-semibold text-fg' },
  4: { tag: 'h4' as const, cls: 'text-[13px] leading-[20px] font-semibold text-fg-2' },
};

export interface HeadingProps extends HTMLAttributes<HTMLHeadingElement> {
  level?: 1 | 2 | 3 | 4;
  children: ReactNode;
}

export const Heading = forwardRef<HTMLHeadingElement, HeadingProps>(function Heading(
  { level = 2, className, children, ...rest },
  ref,
) {
  const { tag, cls } = HEADING_VARIANTS[level];
  return createElement(tag, { ref, className: cn(cls, className), ...rest }, children);
});

const TEXT_VARIANTS = {
  body:    'text-[14px] leading-[22px] text-fg-2',
  small:   'text-[13px] leading-[20px] text-fg-3',
  caption: 'text-[12px] leading-[18px] text-fg-4',
  label:   'text-[11px] leading-[16px] uppercase tracking-[0.16em] font-semibold text-fg-5',
};

export type TextVariant = keyof typeof TEXT_VARIANTS;

export interface TextProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: TextVariant;
  as?: 'span' | 'p' | 'div';
  children: ReactNode;
}

export function Text({ variant = 'body', as = 'span', className, children, ...rest }: TextProps) {
  return createElement(as, { className: cn(TEXT_VARIANTS[variant], className), ...rest }, children);
}

export function Mono({
  children,
  className,
  ...rest
}: HTMLAttributes<HTMLSpanElement> & { children: ReactNode }) {
  return (
    <span
      className={cn('font-mono text-[12px] leading-[18px] text-fg-3', className)}
      {...rest}
    >
      {children}
    </span>
  );
}
