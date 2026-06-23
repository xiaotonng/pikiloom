import type { CSSProperties } from 'react';
import { cn } from '@/lib/utils';

export default function BrowserFrame({
  src,
  video,
  alt,
  ratioW,
  ratioH,
  cropTop = 0,
  label = 'localhost:3939',
  badge,
  className,
}: {
  src?: string;
  video?: string;
  alt: string;
  ratioW: number;
  ratioH: number;
  cropTop?: number;
  label?: string;
  badge?: string;
  className?: string;
}) {
  const visibleRatio = ratioW / (ratioH * (1 - cropTop));
  return (
    <figure className={cn('overflow-hidden rounded-2xl border border-white/10 bg-[#0a0c12] shadow-2xl', className)}>
      <div className="flex items-center gap-1.5 border-b border-white/5 bg-white/[0.02] px-4 py-2.5">
        <span className="h-3 w-3 rounded-full bg-[#ff5f57]" />
        <span className="h-3 w-3 rounded-full bg-[#febc2e]" />
        <span className="h-3 w-3 rounded-full bg-[#28c840]" />
        <span className="mx-auto max-w-[60%] truncate rounded-md bg-white/[0.05] px-3 py-1 font-mono text-[11px] text-neutral-400">
          {label}
        </span>
        {badge ? <span className="text-[11px] font-medium text-neutral-400">{badge}</span> : <span className="w-10" />}
      </div>
      <div className="w-full overflow-hidden bg-[#0a0c12]" style={{ aspectRatio: String(visibleRatio) } as CSSProperties}>
        {video ? (
          <video
            src={video}
            autoPlay
            loop
            muted
            playsInline
            aria-label={alt}
            className="block w-full"
            style={{ transform: `translateY(-${(cropTop * 100).toFixed(3)}%)` }}
          />
        ) : (
          <img
            src={src}
            alt={alt}
            loading="lazy"
            decoding="async"
            className="block w-full"
            style={{ transform: `translateY(-${(cropTop * 100).toFixed(3)}%)` }}
          />
        )}
      </div>
    </figure>
  );
}
