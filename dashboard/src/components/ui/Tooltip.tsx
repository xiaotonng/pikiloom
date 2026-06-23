import { useEffect, useRef, useState, type HTMLAttributes, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../utils';

const TOOLTIP_MAX_WIDTH = 340;

export interface TooltipProps extends HTMLAttributes<HTMLSpanElement> {
  content: ReactNode;
  side?: 'top' | 'bottom';
  delayMs?: number;
  onShow?: () => void;
  children: ReactNode;
}

export function Tooltip({ content, side = 'bottom', delayMs = 120, onShow, children, className, ...rest }: TooltipProps) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const timerRef = useRef<number | null>(null);
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number } | null>(null);

  useEffect(() => () => {
    if (timerRef.current != null) window.clearTimeout(timerRef.current);
  }, []);

  const hide = () => {
    if (timerRef.current != null) { window.clearTimeout(timerRef.current); timerRef.current = null; }
    setPos(null);
  };

  const scheduleShow = () => {
    if (timerRef.current != null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      const rect = anchorRef.current?.getBoundingClientRect();
      if (!rect) return;
      setPos({
        left: Math.max(8, Math.min(rect.left, window.innerWidth - TOOLTIP_MAX_WIDTH - 8)),
        ...(side === 'top'
          ? { bottom: window.innerHeight - rect.top + 6 }
          : { top: rect.bottom + 6 }),
      });
      onShow?.();
    }, delayMs);
  };

  return (
    <span
      {...rest}
      ref={anchorRef}
      className={cn('inline-flex', className)}
      onMouseEnter={scheduleShow}
      onMouseLeave={hide}
      onMouseDown={hide}
    >
      {children}
      {pos && content != null && createPortal(
        <div
          className="pointer-events-none fixed z-[240] max-w-[340px] whitespace-pre-line rounded-lg border border-edge/40 bg-[var(--th-dropdown)] px-2.5 py-1.5 text-[11px] leading-relaxed text-fg-3 shadow-lg backdrop-blur-xl animate-in"
          style={{ left: pos.left, top: pos.top, bottom: pos.bottom }}
        >
          {content}
        </div>,
        document.body,
      )}
    </span>
  );
}
