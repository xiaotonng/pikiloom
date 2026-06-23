import { forwardRef, type HTMLAttributes, type ReactNode } from 'react';
import { cn } from '../../utils';

export interface AmbientGlowProps extends HTMLAttributes<HTMLDivElement> {
  streaming?: boolean;
  children: ReactNode;
}

export const AmbientGlow = forwardRef<HTMLDivElement, AmbientGlowProps>(function AmbientGlow(
  { streaming, className, children, ...rest },
  ref,
) {
  return (
    <div
      ref={ref}
      data-streaming={streaming ? 'true' : undefined}
      className={cn('ambient-glow', className)}
      {...rest}
    >
      {children}
    </div>
  );
});
