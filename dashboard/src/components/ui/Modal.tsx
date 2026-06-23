import { useEffect, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../utils';
import { Button } from './Button';

export type ModalSize = 'sm' | 'md' | 'lg';
const SIZE_CLASS: Record<ModalSize, string> = {
  sm: 'max-w-[480px]',
  md: 'max-w-[640px]',
  lg: 'max-w-[840px]',
};

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  size?: ModalSize;
  wide?: boolean;
  panelStyle?: CSSProperties;
  children: ReactNode;
}

export function Modal({ open, onClose, size, wide, panelStyle, children }: ModalProps) {
  useEffect(() => {
    if (!open) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;
  if (typeof document === 'undefined') return null;

  const resolvedSize: ModalSize = size ?? (wide ? 'lg' : 'sm');

  return createPortal(
    <div className="fixed inset-0 z-100 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 backdrop-blur-[8px] backdrop-saturate-125"
        style={{ background: 'color-mix(in oklab, var(--th-overlay) 78%, transparent)' }}
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        className={cn(
          'relative max-h-[min(88vh,860px)] w-full overflow-hidden rounded-xl border',
          'border-[var(--edge-strong)] bg-[var(--surface-elev)]',
          'shadow-[0_24px_64px_rgba(2,6,23,0.32)] animate-scale',
          SIZE_CLASS[resolvedSize],
        )}
        style={panelStyle}
      >
        <div className="max-h-[inherit] overflow-y-auto p-6">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

export function ModalHeader({
  title,
  description,
  onClose,
}: {
  title: string;
  description?: string;
  onClose: () => void;
}) {
  return (
    <div className="mb-5 flex items-start justify-between gap-4">
      <div className="min-w-0">
        <div className="text-base font-semibold tracking-tight text-fg">{title}</div>
        {description && <div className="mt-1 text-sm leading-relaxed text-fg-4">{description}</div>}
      </div>
      <Button tone="ghost" shape="icon" onClick={onClose} className="-mr-1 -mt-1 shrink-0">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </Button>
    </div>
  );
}
