import { forwardRef, type HTMLAttributes, type ReactNode } from 'react';
import { cn } from '../../utils';

/**
 * AmbientGlow — wraps any surface that is currently running an AI stream,
 * adding a soft rotating gradient ring + breathing pulse. When idle the
 * ring is invisible — zero visual cost. Modelled on Lovable's hero pulse
 * and Vercel's globe-node activity, transposed to a bordered surface.
 *
 * Where to use:
 *   - Around a session panel while the agent is streaming.
 *   - Around the input composer while a turn is in flight.
 *   - Around the Agents Window roster items that are actively running.
 *
 * Don't:
 *   - Don't pulse "Idle" / "Completed" / "Stopped" surfaces. The whole
 *     point is that the *only* moving surface is the one currently working.
 *   - Don't apply to >3 surfaces at once. Visual budget = at most a few.
 *
 * Implementation notes:
 *   - The animation is CSS-only (`.ambient-glow[data-streaming="true"]`).
 *   - Uses `@property --ambient-angle` so the conic-gradient can interpolate;
 *     gracefully falls back to a static glow on browsers that don't support
 *     `@property` (still visible, just not rotating).
 *   - Inherits the wrapped element's border-radius via `inherit`.
 */

export interface AmbientGlowProps extends HTMLAttributes<HTMLDivElement> {
  /** Whether this surface is currently streaming. Toggling this turns the
   *  ring on / off without remounting. */
  streaming?: boolean;
  /** Optional class to override the wrapper layout. Note: border-radius
   *  must come from the *wrapped* element or via this class — the ring
   *  reads `inherit`. */
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
