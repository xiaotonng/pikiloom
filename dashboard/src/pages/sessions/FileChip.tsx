import { cn } from '../../utils';
import { formatFileSize } from './utils';

export function FileChip({
  url,
  fileName,
  fileSize,
  caption,
}: {
  url: string;
  fileName: string;
  fileSize?: number;
  caption?: string;
}) {
  return (
    <div className="flex flex-col gap-1 max-w-[340px]">
      <a
        href={url}
        download={fileName}
        target="_blank"
        rel="noreferrer"
        title={caption || fileName}
        className={cn(
          'group inline-flex items-center gap-2.5 rounded-md no-underline',
          'border border-fg-6/40 bg-fg-6/[0.05] px-3 py-2',
          'hover:bg-fg-6/[0.12] hover:border-fg-6/60 transition-colors',
        )}
      >
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded bg-fg-6/10 text-fg-3">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
          </svg>
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12.5px] font-medium text-fg-2">{fileName}</span>
          {typeof fileSize === 'number' && fileSize > 0 && (
            <span className="block text-[11px] text-fg-5/70">{formatFileSize(fileSize)}</span>
          )}
        </span>
        <span className="shrink-0 text-fg-5/50 group-hover:text-fg-3 transition-colors">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
        </span>
      </a>
      {caption && (
        <span className="px-0.5 text-[11.5px] leading-[1.55] text-fg-4 break-words">{caption}</span>
      )}
    </div>
  );
}
