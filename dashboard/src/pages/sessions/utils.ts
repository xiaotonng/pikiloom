import type { MessageBlock, RichMessage, SessionMessagesResult, StreamPlan } from '../../types';

export interface Turn {
  user: RichMessage | null;
  assistant: RichMessage | null;
}

export interface TurnHistoryWindow {
  turns: Turn[];
  startTurn: number;
  endTurn: number;
  totalTurns: number;
  hasOlder: boolean;
}

export function normalizeUserText(text: string | null | undefined): string {
  return (text || '').replace(/\s+/g, ' ').trim();
}

export function sameUserText(a: string | null | undefined, b: string | null | undefined): boolean {
  return normalizeUserText(a) === normalizeUserText(b);
}

export function promptEndsWithUserPrompt(
  fullPrompt: string | null | undefined,
  userPrompt: string | null | undefined,
): boolean {
  const full = normalizeUserText(fullPrompt);
  const user = normalizeUserText(userPrompt);
  return !!full && !!user && full !== user && full.endsWith(user);
}

export function displayPromptForPending(
  pendingPrompt: string | null | undefined,
  liveQuestion: string | null | undefined,
): string | null {
  if (liveQuestion && (!pendingPrompt || promptEndsWithUserPrompt(liveQuestion, pendingPrompt))) {
    return liveQuestion;
  }
  return pendingPrompt || liveQuestion || null;
}

export function shouldCarryLatestPlanIntoLiveStream(
  pendingPrompt: string | null | undefined,
  liveQuestion: string | null | undefined,
): boolean {
  return !displayPromptForPending(pendingPrompt, liveQuestion);
}

// The plan card an assistant turn renders = its OWN latest task-list snapshot only (TodoWrite /
// TaskCreate / TaskUpdate — latest wins within the turn), or none. A turn NEVER inherits a plan
// from another turn: cross-turn carry-forward is confined to the live stream
// (`shouldCarryLatestPlanIntoLiveStream`), so a settled/reconciled reply can no longer surface an
// earlier — often already completed — turn's plan under a new, unrelated message.
export function latestOwnPlan(planBlocks: MessageBlock[]): StreamPlan | null {
  for (let i = planBlocks.length - 1; i >= 0; i--) {
    const plan = planBlocks[i].plan;
    if (plan?.steps?.length) return plan;
  }
  return null;
}

// While a turn streams (before its native transcript is parseable) the history turn can
// carry a managed-fallback preview of the prompt truncated by shortValue ("<prefix>...").
// That truncated text never equals the full live prompt, so a plain sameUserText dedup
// fails and the same turn renders twice (truncated history bubble + full live-question
// bubble). Treat a truncated prefix as the same turn. Gated on a trailing ellipsis + a
// substantial prefix so unrelated earlier turns never false-match.
export function streamPromptMatchesTurnText(
  turnText: string | null | undefined,
  streamPrompt: string | null | undefined,
): boolean {
  if (sameUserText(turnText, streamPrompt)) return true;
  const turn = normalizeUserText(turnText);
  const prompt = normalizeUserText(streamPrompt);
  if (!turn || !prompt || turn.length >= prompt.length) return false;
  if (!/(?:\.\.\.|…)$/.test(turn)) return false;
  const core = turn.replace(/(?:\s*(?:\.\.\.|…))+$/, '').trim();
  // Compare a slightly shortened prefix so a cut landing mid-token (and whitespace
  // re-normalization at the boundary) doesn't defeat the match.
  const probeLen = core.length - 4;
  if (probeLen < 32) return false;
  return prompt.startsWith(core.slice(0, probeLen));
}

export function normalizeTurnHistory(result: SessionMessagesResult): TurnHistoryWindow {
  const richMessages = result.richMessages?.length
    ? result.richMessages
    : result.messages?.map(m => ({ role: m.role, text: m.text, blocks: [{ type: 'text' as const, content: m.text }] })) || [];
  const turns = groupIntoTurns(richMessages);
  const totalTurns = Math.max(result.window?.totalTurns ?? result.totalTurns ?? turns.length, turns.length);
  const endTurn = result.window?.endTurn ?? totalTurns;
  const startTurn = result.window?.startTurn ?? Math.max(0, endTurn - turns.length);
  return {
    turns,
    startTurn,
    endTurn,
    totalTurns,
    hasOlder: result.window?.hasOlder ?? startTurn > 0,
  };
}

export function mergeOlderHistory(current: TurnHistoryWindow, older: TurnHistoryWindow): TurnHistoryWindow {
  const prefixCount = Math.max(0, current.startTurn - older.startTurn);
  const prefix = older.turns.slice(0, prefixCount);
  return {
    turns: [...prefix, ...current.turns],
    startTurn: older.startTurn,
    endTurn: current.endTurn,
    totalTurns: Math.max(current.totalTurns, older.totalTurns),
    hasOlder: older.hasOlder,
  };
}

export function mergeLatestHistory(current: TurnHistoryWindow, latest: TurnHistoryWindow): TurnHistoryWindow {
  if (latest.startTurn <= current.startTurn) return latest;
  const keepCount = Math.max(0, latest.startTurn - current.startTurn);
  const preservedPrefix = current.turns.slice(0, keepCount);
  return {
    turns: [...preservedPrefix, ...latest.turns],
    startTurn: current.startTurn,
    endTurn: latest.endTurn,
    totalTurns: latest.totalTurns,
    hasOlder: current.startTurn > 0,
  };
}

export function mergeRichMessages(lhs: RichMessage, rhs: RichMessage): RichMessage {
  const parts = [lhs.text, rhs.text].filter(Boolean);
  return {
    role: lhs.role,
    text: parts.join('\n\n'),
    blocks: [...lhs.blocks, ...rhs.blocks],
    usage: rhs.usage ?? lhs.usage ?? null,
  };
}

export function groupIntoTurns(msgs: RichMessage[]): Turn[] {
  const turns: Turn[] = [];
  let cur: Turn = { user: null, assistant: null };
  for (const m of msgs) {
    if (m.role === 'user') {
      if (cur.assistant && isContinuationSummary(m.text)) continue;
      if (cur.user || cur.assistant) { turns.push(cur); cur = { user: null, assistant: null }; }
      cur.user = m;
    } else if (cur.assistant) cur.assistant = mergeRichMessages(cur.assistant, m);
    else cur.assistant = m;
  }
  if (cur.user || cur.assistant) turns.push(cur);
  return turns;
}

const SYSTEM_INJECTED_USER_TAGS = new Set([
  'task-notification', 'system-reminder', 'persisted-output',
  'local-command-stdout', 'local-command-caveat', 'local-command-stderr',
  'ide_opened_file', 'ide_diagnostics', 'ide_selection', 'event',
  'analysis', 'case_id', 'tool-use-id', 'output-file',
]);

const CONTINUATION_MARKERS = [
  'continued from a previous',
  'summary below covers',
  'earlier portion of the conversation',
  'Summary:',
  'Key Technical Concepts',
];

export function isContinuationSummary(text: string): boolean {
  const trimmed = text.trim();
  const leading = trimmed.match(/^<([a-z][a-z0-9_-]*)\b/i);
  if (leading && SYSTEM_INJECTED_USER_TAGS.has(leading[1].toLowerCase())) return true;
  return CONTINUATION_MARKERS.some(m => text.includes(m));
}

export function formatTokensShort(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}

export function formatTokens(n: number): string {
  return `${formatTokensShort(n)} tok`;
}

export function contextDotClass(pct: number): string {
  return pct >= 85 ? 'bg-rose-400/70' : pct >= 60 ? 'bg-amber-400/70' : 'bg-emerald-400/70';
}

export function formatElapsedCompact(ms: number): string {
  const totalS = Math.floor(ms / 1000);
  if (totalS < 60) return `${totalS}s`;
  const m = Math.floor(totalS / 60);
  const s = totalS % 60;
  if (m < 60) return `${m}m${s.toString().padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h${(m % 60).toString().padStart(2, '0')}m`;
}

export function lastNLines(text: string, n: number): string {
  const lines = text.split('\n').filter(l => l.trim());
  if (lines.length <= n) return lines.join('\n');
  return lines.slice(-n).join('\n');
}

export type RunEndKind = 'interrupted' | 'incomplete' | 'error';
export function classifyRunEnd(detail: string | null | undefined): RunEndKind {
  const d = String(detail || '').trim().toLowerCase();
  if (!d) return 'error';
  if (d.startsWith('interrupted by user')) return 'interrupted';
  if (d.startsWith('timed out') || d.startsWith('stopped before completion') || d.includes('max tokens')) {
    return 'incomplete';
  }
  return 'error';
}

export type ComposerImageAttachment = { id: string; file: File; previewUrl: string };

export function makeComposerImageAttachment(file: File): ComposerImageAttachment {
  return {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    file,
    previewUrl: URL.createObjectURL(file),
  };
}

export function revokeComposerAttachments(items: ComposerImageAttachment[]) {
  for (const item of items) URL.revokeObjectURL(item.previewUrl);
}

const IMAGE_FILE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg|avif|heic|heif|tiff?|ico)$/i;

// An attachment counts as an image when its MIME type says so. Some clipboard / file sources
// (screenshot tools, file managers, drag payloads) hand over a File with an empty type — fall back
// to the file-name extension there instead of silently dropping it. A non-empty, non-image type
// is rejected so a pasted PDF/zip never sneaks into the image attachment row.
export function isLikelyImageFile(file: File): boolean {
  if (file.type) return file.type.startsWith('image/');
  return IMAGE_FILE_EXT_RE.test(file.name || '');
}

// Pasting an image copied from a web page or another app frequently yields no file entry at all —
// only a text/html fragment whose <img> carries an inline data: URL. Pull those out so the paste
// handler can still recover the image instead of dropping the paste entirely.
export function extractImageDataUrlsFromHtml(html: string): string[] {
  const urls: string[] = [];
  const re = /<img\b[^>]*?\bsrc\s*=\s*["'](data:image\/[^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) urls.push(m[1]);
  return urls;
}

// Turn a data:image/*;base64 URL into a File so it flows through the same attachment path as a real
// pasted/selected file. Returns null for anything that isn't a base64 image data URL.
export function dataUrlToImageFile(dataUrl: string, nameHint = 'pasted-image'): File | null {
  const m = /^data:(image\/[a-z0-9.+-]+);base64,(.*)$/is.exec(dataUrl.trim());
  if (!m) return null;
  const mime = m[1].toLowerCase();
  try {
    const bin = atob(m[2].replace(/\s+/g, ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const ext = mime.split('/')[1]?.split('+')[0] || 'png';
    return new File([bytes], `${nameHint}.${ext}`, { type: mime });
  } catch {
    return null;
  }
}

// Last-resort recovery: some sources expose a pasted image only through the async Clipboard API
// (nothing usable on the paste event itself, e.g. Safari/Preview bitmaps). Reads image blobs from
// the live clipboard; resolves to [] on any error or denied permission so callers can try blindly.
export async function readImagesFromAsyncClipboard(): Promise<File[]> {
  try {
    if (typeof navigator === 'undefined' || !navigator.clipboard?.read) return [];
    const items = await navigator.clipboard.read();
    const out: File[] = [];
    for (const item of items) {
      const imgType = item.types.find(t => t.startsWith('image/'));
      if (!imgType) continue;
      const blob = await item.getType(imgType);
      const ext = imgType.split('/')[1]?.split('+')[0] || 'png';
      out.push(new File([blob], `pasted-image.${ext}`, { type: imgType }));
    }
    return out;
  } catch {
    return [];
  }
}

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb >= 100 ? 0 : 1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(mb >= 100 ? 0 : 1)} MB`;
}

export async function copyImageFile(file: File): Promise<boolean> {
  if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) return false;
  try {
    await navigator.clipboard.write([new ClipboardItem({ [file.type || 'image/png']: file })]);
    return true;
  } catch {
    return false;
  }
}

function shortValue(value: unknown, max = 120): string {
  if (value == null) return '';
  const s = typeof value === 'string' ? value : String(value);
  const trimmed = s.replace(/\s+/g, ' ').trim();
  if (trimmed.length <= max) return trimmed;
  return trimmed.slice(0, Math.max(0, max - 1)) + '…';
}

function parseToolInput(content: string): Record<string, unknown> | null {
  if (!content) return null;
  try {
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export function summarizeToolUse(block: MessageBlock): string {
  const tool = String(block.toolName || '').trim() || 'Tool';
  const input = parseToolInput(block.content);
  if (!input) return tool;
  const description = shortValue(input.description, 120);
  switch (tool) {
    case 'Read': { const t = shortValue(input.file_path || input.path, 140); return t ? `Read ${t}` : 'Read'; }
    case 'Edit': { const t = shortValue(input.file_path || input.path, 140); return t ? `Edit ${t}` : 'Edit'; }
    case 'Write': { const t = shortValue(input.file_path || input.path, 140); return t ? `Write ${t}` : 'Write'; }
    case 'Glob': { const p = shortValue(input.pattern || input.glob, 120); return p ? `Glob ${p}` : 'Glob'; }
    case 'Grep': { const p = shortValue(input.pattern || input.query, 120); return p ? `Grep ${p}` : 'Grep'; }
    case 'WebFetch': { const u = shortValue(input.url, 120); return u ? `WebFetch ${u}` : 'WebFetch'; }
    case 'WebSearch': { const q = shortValue(input.query, 120); return q ? `WebSearch ${q}` : 'WebSearch'; }
    case 'TodoWrite': return 'Update plan';
    case 'TaskCreate': { const subject = shortValue(input.subject, 120); return subject ? `Create task: ${subject}` : 'Create task'; }
    case 'TaskUpdate': {
      const taskId = shortValue(input.taskId, 24);
      const status = shortValue(input.status, 24);
      return taskId ? `Update task ${taskId}${status ? ` → ${status}` : ''}` : 'Update task';
    }
    case 'AskUserQuestion': {
      const qs = Array.isArray(input.questions) ? (input.questions as any[]) : [];
      const first = qs[0];
      const q = shortValue(first?.question || input.question, 120);
      return q ? `Ask user: ${q}` : 'Ask user';
    }
    case 'Task': { const p = shortValue(input.description || input.prompt, 120); return p ? `Task: ${p}` : 'Task'; }
    case 'Bash': {
      if (description) return `Bash: ${description}`;
      const c = shortValue(input.command, 120);
      return c ? `Bash: ${c}` : 'Bash';
    }
    // Codex rollout tool names (completed turns are re-parsed from the codex jsonl): the live
    // preview shows "Run shell: <cmd>" / "Edit …" via the kernel driver, but in the rollout the
    // shell command lives under `cmd` (a string), not `command` — summarize it the same way so
    // a finished turn's Activity matches what streamed, instead of the bare "exec_command".
    case 'exec_command':
    case 'shell':
    case 'local_shell': {
      const c = shortValue(input.cmd || input.command, 140);
      return c ? `Run shell: ${c}` : 'Run shell';
    }
    case 'apply_patch': {
      const p = shortValue(input.path || input.file_path, 140);
      return p ? `Edit ${p}` : 'Edit files';
    }
    default: {
      const mcp = tool.match(/^mcp__[^_]+__(.+)$/);
      const bare = mcp ? mcp[1] : tool;
      if (bare === 'im_send_file') { const p = shortValue(input.path, 120); return p ? `Send file: ${p}` : 'Send file'; }
      if (bare === 'im_list_files') return 'List workspace files';
      if (description) return `${tool}: ${description}`;
      const d = shortValue(input.file_path || input.path || input.command || input.query || input.pattern || input.url, 120);
      return d ? `${tool}: ${d}` : tool;
    }
  }
}

export function summarizeToolResult(block: MessageBlock): string {
  const raw = (block.content || '').trim();
  if (!raw) return 'result';
  const firstLine = raw.split('\n').map(l => l.trim()).find(Boolean) || '';
  return firstLine ? shortValue(firstLine, 140) : 'result';
}

export function parseSessionKey(sessionKey: string): { agent: string; sessionId: string } | null {
  const separator = sessionKey.indexOf(':');
  if (separator <= 0) return null;
  const agent = sessionKey.slice(0, separator).trim();
  const sessionId = sessionKey.slice(separator + 1).trim();
  if (!agent || !sessionId) return null;
  return { agent, sessionId };
}
