import { useState, type ComponentType, type KeyboardEvent, type ReactNode } from 'react';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { cn } from '../../utils';
import { api } from '../../api';

export const mdPlugins = [remarkGfm, remarkBreaks];

const isWebUrl = (href: string) => /^https?:\/\//.test(href);
const hasUrlScheme = (href: string) => /^[a-z][a-z0-9+.-]*:\/\//i.test(href);

export interface MarkdownRenderOptions {
  workdir?: string | null;
}

function stripLineSuffix(value: string): string {
  return value.replace(/:(\d+)(?::\d+)?$/, '');
}

function stripWrapping(value: string): string {
  let text = value.trim();
  const pairs: Array<[string, string]> = [['`', '`'], ['"', '"'], ["'", "'"], ['<', '>']];
  let changed = true;
  while (changed && text.length >= 2) {
    changed = false;
    for (const [left, right] of pairs) {
      if (text.startsWith(left) && text.endsWith(right)) {
        text = text.slice(left.length, -right.length).trim();
        changed = true;
      }
    }
  }
  return text;
}

function trimFileToken(value: string): { text: string; trailing: string } {
  let text = stripWrapping(value);
  let trailing = '';
  while (text.length > 1) {
    const last = text[text.length - 1];
    if (!last || !/[),.;!?]/.test(last)) break;
    // Preserve numeric line/column suffixes (`file.ts:12`, `file.ts:12:3`).
    if (last === '.' && /^\.[A-Za-z0-9_-]+$/.test(text)) break;
    trailing = last + trailing;
    text = text.slice(0, -1);
  }
  return { text, trailing };
}

// A locator is a real path — rooted, relative-prefixed, or containing a directory
// segment. Bare file names (`package.json`, `SKILL.md`) are intentionally NOT locators:
// they are ambiguous (which one?) and linkifying every mention buries output in noise.
export function isFileLocator(value: string): boolean {
  const text = trimFileToken(value).text;
  if (!text || isWebUrl(text)) return false;
  if (hasUrlScheme(text) && !text.startsWith('file://')) return false;

  const pathPart = stripLineSuffix(text);
  if (!pathPart) return false;
  if (pathPart.startsWith('file://')) return pathPart.length > 'file://'.length;
  if (/^[A-Za-z]:[\\/]/.test(pathPart)) return true;
  if (/^(\/|~\/|\.{1,2}\/)/.test(pathPart)) return pathPart.length > 1;
  if (pathPart.includes('/')) {
    const firstSegment = pathPart.split('/')[0] || '';
    if (/^[A-Za-z0-9-]+\.[A-Za-z]{2,}$/.test(firstSegment)) return false;
    return true;
  }
  return false;
}

function openFileLocator(locator: string, workdir?: string | null) {
  void api.openInEditor(locator, undefined, workdir || undefined).catch(() => {});
}

function fileKeyDown(e: KeyboardEvent<HTMLElement>, locator: string, workdir?: string | null) {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  e.preventDefault();
  openFileLocator(locator, workdir);
}

function FileLink({ locator, workdir, children }: { locator: string; workdir?: string | null; children?: ReactNode }) {
  return (
    <span
      role="link"
      tabIndex={0}
      title={locator}
      className="text-blue-400 underline underline-offset-2 decoration-blue-400/30 cursor-pointer hover:text-blue-300 transition-colors"
      onClick={() => openFileLocator(locator, workdir)}
      onKeyDown={e => fileKeyDown(e, locator, workdir)}
    >
      {children ?? locator}
    </span>
  );
}

/* ── Copy button for fenced code blocks ── */
export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => { navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }).catch(() => {}); };
  return (
    <button onClick={copy} className="flex items-center text-fg-5/50 hover:text-fg-3 transition-colors">
      {copied
        ? <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#34d399" strokeWidth="2"><polyline points="20 6 9 17 4 12" /></svg>
        : <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
      }
    </button>
  );
}

export function classifyCode(text: string): string {
  const isPath = isFileLocator(text);
  const isCmd = /^(npm |npx |git |python|pip |yarn |pnpm |cargo |go |make )/.test(text);
  if (isPath) return 'bg-blue-500/8 border-blue-400/12 text-blue-300/90';
  if (isCmd) return 'bg-amber-500/8 border-amber-400/10 text-amber-300/80';
  return 'bg-[rgba(255,255,255,0.06)] border-edge/20 text-fg-3';
}

export function createMarkdownComponents(options: MarkdownRenderOptions = {}): Record<string, ComponentType<any>> {
  const workdir = options.workdir || null;
  return {
    h1: ({ children }: any) => <h2 className="text-[16px] font-bold text-fg mt-4 mb-2">{children}</h2>,
    h2: ({ children }: any) => <h3 className="text-[14.5px] font-semibold text-fg mt-4 mb-1.5">{children}</h3>,
    h3: ({ children }: any) => <h4 className="text-[13.5px] font-semibold text-fg mt-3 mb-1">{children}</h4>,
    p: ({ children }: any) => <p className="my-1.5 whitespace-pre-wrap break-words">{children}</p>,
    strong: ({ children }: any) => <strong className="font-semibold text-fg">{children}</strong>,
    em: ({ children }: any) => <em className="italic text-fg-3">{children}</em>,
    a: ({ href, children }: any) => {
      if (href && isWebUrl(href)) {
        return <a href={href} target="_blank" rel="noopener noreferrer" className="text-blue-400 underline underline-offset-2 decoration-blue-400/30 cursor-pointer hover:text-blue-300 transition-colors">{children}</a>;
      }
      if (href && isFileLocator(href)) {
        return <FileLink locator={trimFileToken(href).text} workdir={workdir}>{children}</FileLink>;
      }
      return <span className="text-blue-400 underline underline-offset-2 decoration-blue-400/30">{children}</span>;
    },
    ul: ({ children }: any) => <ul className="space-y-1 my-2 ml-1">{children}</ul>,
    ol: ({ children }: any) => <ol className="space-y-1 my-2 ml-1 list-decimal list-inside">{children}</ol>,
    li: ({ children }: any) => (
      <li className="flex gap-2 items-start">
        <span className="shrink-0 mt-[10px] w-[5px] h-[5px] rounded-full bg-fg-5/40" />
        <span className="flex-1">{children}</span>
      </li>
    ),
    blockquote: ({ children }: any) => <blockquote className="border-l-2 border-fg-5/30 pl-3 my-2 text-fg-4 italic">{children}</blockquote>,
    hr: () => <hr className="border-edge/30 my-4" />,
    code: ({ className, children }: any) => {
      const text = String(children).replace(/\n$/, '');
      const langMatch = /language-(\w+)/.exec(className || '');

      // Inline code (no language class, no embedded newlines)
      if (!langMatch && !className && !text.includes('\n')) {
        if (isFileLocator(text)) {
          return (
            <code
              role="link"
              tabIndex={0}
              title={text}
              className={cn('px-1.5 py-[1px] rounded text-[12px] font-mono border cursor-pointer hover:brightness-125 transition-all', classifyCode(text))}
              onClick={() => openFileLocator(text, workdir)}
              onKeyDown={e => fileKeyDown(e, text, workdir)}
            >
              {text}
            </code>
          );
        }
        return <code className={cn('px-1.5 py-[1px] rounded text-[12px] font-mono border', classifyCode(text))}>{text}</code>;
      }

      // Fenced code block
      const lang = langMatch?.[1] || '';
      return (
        <div className="rounded-lg overflow-hidden border border-edge/30 bg-[rgba(0,0,0,0.25)] my-3 not-prose">
          <div className="flex items-center justify-between px-3.5 py-1.5 border-b border-edge/15 bg-[rgba(0,0,0,0.12)]">
            <span className="text-[10px] font-mono text-fg-5/50">{lang || 'text'}</span>
            <CopyButton text={text} />
          </div>
          <pre className="px-3.5 py-3 text-[12px] leading-[1.65] text-fg-3 font-mono whitespace-pre-wrap break-words overflow-x-auto">
            <code>{text}</code>
          </pre>
        </div>
      );
    },
    pre: ({ children }: any) => <>{children}</>,
    table: ({ children }: any) => (
      <div className="my-3 overflow-x-auto rounded-lg border border-edge/30">
        <table className="w-full text-[12.5px]">{children}</table>
      </div>
    ),
    thead: ({ children }: any) => <thead className="bg-[rgba(0,0,0,0.1)]">{children}</thead>,
    th: ({ children }: any) => <th className="px-3 py-1.5 text-left font-semibold text-fg-3 border-b border-edge/30">{children}</th>,
    td: ({ children }: any) => <td className="px-3 py-1.5 text-fg-4 border-t border-edge/12">{children}</td>,
    tr: ({ children }: any) => <tr className="even:bg-[rgba(255,255,255,0.015)]">{children}</tr>,
  };
}

export const mdComponents = createMarkdownComponents();
