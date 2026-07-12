import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { NativeSessionInfo } from '../contracts/driver.js';

// ---- Native session discovery ----
//
// Each coding-agent CLI keeps its OWN session transcripts in its own home dir, in its own
// format. To present a single, unified session list (the kernel's managed sessions PLUS the
// agent's native ones), the kernel reads those transcript stores directly. These are pure,
// node-builtins-only readers — faithful, leaner ports of pikiloom's per-driver discovery.
//
// `home` is injectable so this is hermetically testable; it defaults to os.homedir().

export type { NativeSessionInfo } from '../contracts/driver.js';

export interface DiscoverOptions {
  home?: string;
  limit?: number;
  /** A session whose file changed within this window is treated as "running". */
  runningThresholdMs?: number;
}

const NATIVE_SESSION_RUNNING_THRESHOLD_MS = 10_000;

function homeOf(opts?: DiscoverOptions): string {
  return opts?.home || os.homedir();
}

function cleanTitle(raw: string | null | undefined, max = 120): string | null {
  if (!raw) return null;
  const s = raw.replace(/\s+/g, ' ').trim();
  if (!s) return null;
  return s.length <= max ? s : `${s.slice(0, max - 3).trimEnd()}...`;
}

function statSafe(p: string): fs.Stats | null {
  try { return fs.statSync(p); } catch { return null; }
}

// A transcript's title/preview/model/effort/turns all live in a BOUNDED slice of the file: the HEAD
// (first prompt, model, ai-title) and the TAIL (latest reply, last turn_context). We read only those
// slices — never the whole file — so discovery stays O(bounded) per session even when a rollout grows
// to hundreds of MB. Results are memoized by the file's (mtime,size): an unchanged transcript is read
// once and every later list call is free, so adding the tail read costs nothing on repeat. Any real
// change moves mtime+size and re-reads, so the cache can never go stale.
const HEAD_BYTES = 256 * 1024;
const TAIL_BYTES = 256 * 1024;

/** Read a bounded byte region as UTF-8. A partial leading/trailing line is expected; callers skip unparseable lines. */
function readRegion(filePath: string, start: number, length: number): string {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(Math.max(0, length));
    const n = fs.readSync(fd, buf, 0, buf.length, Math.max(0, start));
    return buf.toString('utf8', 0, n);
  } finally {
    fs.closeSync(fd);
  }
}

function memoized<T>(cache: Map<string, { mtimeMs: number; size: number; value: T }>, filePath: string, stat: fs.Stats, compute: () => T): T {
  const hit = cache.get(filePath);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.value;
  const value = compute();
  cache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, value });
  return value;
}

/** Extract plain text from a Codex `response_item` message content (array of `{type,text}` blocks). */
function codexText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return (content as Array<{ type?: string; text?: string }>)
    .filter((b) => b && typeof b.text === 'string' && (b.type === 'text' || (b.type ?? '').endsWith('_text')))
    .map((b) => b.text as string)
    .join('');
}

/** Reasoning effort from a Codex `turn_context` payload: top-level `effort`, else the nested collaboration setting. */
function codexEffortOf(payload: any): string | null {
  const top = payload?.effort;
  if (typeof top === 'string' && top.trim()) return top.trim();
  const re = payload?.collaboration_mode?.settings?.reasoning_effort;
  return typeof re === 'string' && re.trim() ? re.trim() : null;
}

// ---- Claude: ~/.claude/projects/<encoded-workdir>/<sessionId>.jsonl ----

/** Claude encodes a workdir into a project dir name by replacing non-alphanumerics with '-'. */
export function encodeClaudeProjectDir(workdir: string): string {
  return path.resolve(workdir).replace(/[^a-zA-Z0-9]/g, '-');
}

/** Extract plain text from a Claude `message.content` (string or block array). */
function claudeText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === 'object' && (block as any).type === 'text' && typeof (block as any).text === 'string') {
      parts.push((block as any).text);
    }
  }
  return parts.join(' ');
}

const claudeMetaCache = new Map<string, { mtimeMs: number; size: number; value: { title: string | null; model: string | null; preview: string | null; turns: number } }>();

function readClaudeMeta(filePath: string, stat: fs.Stats): { title: string | null; model: string | null; preview: string | null; turns: number } {
  return memoized(claudeMetaCache, filePath, stat, () => {
    const size = stat.size;
    let title: string | null = null;
    let headModel: string | null = null;
    let lastUser: string | null = null;
    let headAssistant: string | null = null;
    let turns = 0;
    let head = '';
    try {
      head = readRegion(filePath, 0, Math.min(HEAD_BYTES, Math.max(65536, size)));
    } catch { return { title: null, model: null, preview: null, turns: 0 }; }

    for (const line of head.split('\n')) {
      if (!line || line[0] !== '{') continue;
      let ev: any;
      try { ev = JSON.parse(line); } catch { continue; }
      if (ev.type === 'user' && ev.isMeta !== true) {
        const text = claudeText(ev.message?.content).trim();
        if (text && !text.startsWith('<') && !text.startsWith('[Image:')) {
          if (!title) title = cleanTitle(text);
          lastUser = text;
          turns++;
        }
      } else if (ev.type === 'assistant') {
        if (!headModel && ev.message?.model && ev.message.model !== '<synthetic>') headModel = ev.message.model;
        const text = claudeText(ev.message?.content).trim();
        if (text) headAssistant = text;
      }
    }

    // The LATEST reply lives at the end of a long transcript, not in the head — read a bounded tail
    // slice for an accurate preview (and the most recent model). Skipped when the file already fits
    // in the head window (then the head scan above already saw the whole thing).
    let tailAssistant: string | null = null;
    let tailModel: string | null = null;
    if (size > HEAD_BYTES) {
      try {
        for (const line of readRegion(filePath, size - TAIL_BYTES, TAIL_BYTES).split('\n')) {
          if (!line || line[0] !== '{') continue;
          let ev: any;
          try { ev = JSON.parse(line); } catch { continue; }
          if (ev.type !== 'assistant') continue;
          const text = claudeText(ev.message?.content).trim();
          if (text) tailAssistant = text;
          if (ev.message?.model && ev.message.model !== '<synthetic>') tailModel = ev.message.model;
        }
      } catch { /* keep head-derived values */ }
    }

    const preview = cleanTitle(tailAssistant || headAssistant || lastUser, 200);
    return { title, model: tailModel || headModel, preview, turns };
  });
}

export function discoverClaudeNativeSessions(workdir: string, opts: DiscoverOptions = {}): NativeSessionInfo[] {
  const home = homeOf(opts);
  const projectDir = path.join(home, '.claude', 'projects', encodeClaudeProjectDir(workdir));
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(projectDir, { withFileTypes: true }); } catch { return []; }
  const threshold = opts.runningThresholdMs ?? NATIVE_SESSION_RUNNING_THRESHOLD_MS;

  const files: { sessionId: string; filePath: string; stat: fs.Stats }[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    const filePath = path.join(projectDir, entry.name);
    const stat = statSafe(filePath);
    if (stat) files.push({ sessionId: entry.name.slice(0, -6), filePath, stat });
  }
  files.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  const selected = typeof opts.limit === 'number' ? files.slice(0, Math.max(0, opts.limit)) : files;

  const now = Date.now();
  return selected.map(({ sessionId, filePath, stat }) => {
    const { title, model, preview, turns } = readClaudeMeta(filePath, stat);
    return {
      sessionId,
      title,
      preview,
      cwd: path.resolve(workdir),
      model,
      createdAt: stat.birthtime.toISOString(),
      updatedAt: stat.mtime.toISOString(),
      running: now - stat.mtimeMs < threshold,
      messageCount: turns || null,
    };
  });
}

// ---- Codex: ~/.codex/sessions/**/rollout-*.jsonl (filtered by cwd) ----

function loadCodexTitleIndex(home: string): Map<string, { threadName: string; updatedAt: string }> {
  const indexPath = path.join(home, '.codex', 'session_index.jsonl');
  const map = new Map<string, { threadName: string; updatedAt: string }>();
  let data: string;
  try { data = fs.readFileSync(indexPath, 'utf8'); } catch { return map; }
  for (const line of data.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.id) map.set(entry.id, { threadName: entry.thread_name || '', updatedAt: entry.updated_at || '' });
    } catch { /* skip */ }
  }
  return map;
}

// A rollout's `session_meta` (id/cwd/timestamp) is written once at creation and never changes, so its
// parsed head is cached by path permanently — the per-list cwd filter then costs one 8 KB read per file
// only the FIRST time it is ever seen, not on every list call.
const codexHeadCache = new Map<string, { sessionId: string; cwd: string; timestamp: string | null; isSubagent: boolean } | null>();
function readCodexHeadCached(filePath: string): { sessionId: string; cwd: string; timestamp: string | null; isSubagent: boolean } | null {
  const hit = codexHeadCache.get(filePath);
  if (hit !== undefined) return hit;
  const v = readCodexHead(filePath);
  codexHeadCache.set(filePath, v);
  return v;
}

function readCodexHead(filePath: string): { sessionId: string; cwd: string; timestamp: string | null; isSubagent: boolean } | null {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(8 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const head = buf.toString('utf8', 0, n);
    if (!head.includes('"session_meta"')) return null;
    const id = head.match(/"id"\s*:\s*"([^"]+)"/);
    const cwd = head.match(/"cwd"\s*:\s*"([^"]+)"/);
    const ts = head.match(/"timestamp"\s*:\s*"([^"]+)"/);
    if (!id || !cwd) return null;
    return {
      sessionId: id[1],
      cwd: cwd[1],
      timestamp: ts?.[1] || null,
      isSubagent: /"source"\s*:\s*\{\s*"subagent"\s*:/.test(head) || /"thread_spawn"\s*:/.test(head),
    };
  } catch { return null; }
}

const codexMetaCache = new Map<string, { mtimeMs: number; size: number; value: { firstPrompt: string | null; preview: string | null; model: string | null; effort: string | null } }>();

/**
 * Bounded per-row metadata for a Codex rollout: the first user prompt (title fallback when the thread
 * has no index name) from a HEAD slice, and the latest reply + last model/effort from a TAIL slice.
 * Memoized by (mtime,size); never reads the whole file.
 */
function readCodexBoundedMeta(filePath: string, stat: fs.Stats): { firstPrompt: string | null; preview: string | null; model: string | null; effort: string | null } {
  return memoized(codexMetaCache, filePath, stat, () => {
    let firstPrompt: string | null = null;
    let firstAny: string | null = null;
    let preview: string | null = null;
    let model: string | null = null;
    let effort: string | null = null;
    try {
      // HEAD: the first real user turn (skip a leading <handover> injected by an agent switch).
      for (const line of readRegion(filePath, 0, Math.min(HEAD_BYTES, stat.size)).split('\n')) {
        const t = line.trim();
        if (!t || t[0] !== '{' || !t.includes('user_message')) continue;
        let ev: any;
        try { ev = JSON.parse(t); } catch { continue; }
        if (ev.type !== 'event_msg' || ev.payload?.type !== 'user_message') continue;
        const text = String(ev.payload.message ?? '').trim();
        if (!text) continue;
        if (!firstAny) firstAny = text;
        if (!String(text).toLowerCase().startsWith('<handover')) { firstPrompt = text; break; }
      }
    } catch { /* best-effort */ }
    try {
      // TAIL: the latest assistant reply + last turn_context (model/effort).
      const start = Math.max(0, stat.size - TAIL_BYTES);
      for (const line of readRegion(filePath, start, Math.min(TAIL_BYTES, stat.size)).split('\n')) {
        const t = line.trim();
        if (!t || t[0] !== '{') continue;
        let ev: any;
        try { ev = JSON.parse(t); } catch { continue; }
        const p = ev.payload;
        if (!p) continue;
        if (ev.type === 'turn_context') {
          if (typeof p.model === 'string' && p.model.trim()) model = p.model.trim();
          const e = codexEffortOf(p);
          if (e) effort = e;
        } else if (ev.type === 'response_item' && p.type === 'message' && p.role === 'assistant') {
          const text = codexText(p.content).trim();
          if (text) preview = text;
        }
      }
    } catch { /* best-effort */ }
    return { firstPrompt: cleanTitle(firstPrompt ?? firstAny), preview: cleanTitle(preview, 200), model, effort };
  });
}

export function discoverCodexNativeSessions(workdir: string, opts: DiscoverOptions = {}): NativeSessionInfo[] {
  const home = homeOf(opts);
  const sessionsDir = path.join(home, '.codex', 'sessions');
  const resolvedWorkdir = path.resolve(workdir);
  const titleIndex = loadCodexTitleIndex(home);
  const threshold = opts.runningThresholdMs ?? NATIVE_SESSION_RUNNING_THRESHOLD_MS;

  const files: { filePath: string; stat: fs.Stats }[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.startsWith('rollout-') || !entry.name.endsWith('.jsonl')) continue;
      const stat = statSafe(full);
      if (stat) files.push({ filePath: full, stat });
    }
  };
  walk(sessionsDir);
  files.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);

  const out: NativeSessionInfo[] = [];
  const seen = new Set<string>();
  for (const { filePath, stat } of files) {
    const meta = readCodexHeadCached(filePath);
    if (!meta || meta.isSubagent || path.resolve(meta.cwd) !== resolvedWorkdir) continue;
    if (seen.has(meta.sessionId)) continue;
    seen.add(meta.sessionId);
    const idx = titleIndex.get(meta.sessionId);
    const updatedAt = idx?.updatedAt || stat.mtime.toISOString();
    // Only files that passed the cwd/subagent filter above pay for the bounded head+tail read (first
    // prompt / preview / model / effort) — scoped to THIS workdir's own rollouts, and memoized per file.
    const bounded = readCodexBoundedMeta(filePath, stat);
    out.push({
      sessionId: meta.sessionId,
      // The agent's own thread name wins; otherwise fall back to the first prompt so the row is named + searchable.
      title: cleanTitle(idx?.threadName || null) ?? bounded.firstPrompt,
      preview: bounded.preview,
      cwd: meta.cwd,
      model: bounded.model,
      effort: bounded.effort,
      createdAt: meta.timestamp || stat.birthtime.toISOString(),
      updatedAt,
      running: Date.now() - Date.parse(updatedAt) < threshold,
      messageCount: null,
    });
    if (typeof opts.limit === 'number' && out.length >= opts.limit) break;
  }
  return out;
}

// ---- Gemini: ~/.gemini/projects.json -> tmp/<projectName>/chats/session-*.json[l] ----

function geminiProjectName(home: string, workdir: string): string | null {
  const projectsPath = path.join(home, '.gemini', 'projects.json');
  try {
    const data = JSON.parse(fs.readFileSync(projectsPath, 'utf8'));
    const projects = data?.projects;
    if (!projects || typeof projects !== 'object') return null;
    const resolved = path.resolve(workdir);
    if (projects[resolved]) return projects[resolved];
    for (const [dir, name] of Object.entries(projects)) {
      if (path.resolve(dir) === resolved) return name as string;
    }
  } catch { /* none */ }
  return null;
}

function geminiText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block === 'string') parts.push(block);
      else if (block && typeof block === 'object' && typeof (block as any).text === 'string') parts.push((block as any).text);
    }
    return parts.join(' ');
  }
  return '';
}

export function discoverGeminiNativeSessions(workdir: string, opts: DiscoverOptions = {}): NativeSessionInfo[] {
  const home = homeOf(opts);
  const projectName = geminiProjectName(home, workdir);
  if (!projectName) return [];
  const chatsDir = path.join(home, '.gemini', 'tmp', projectName, 'chats');
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(chatsDir, { withFileTypes: true }); } catch { return []; }
  const threshold = opts.runningThresholdMs ?? NATIVE_SESSION_RUNNING_THRESHOLD_MS;

  const byId = new Map<string, NativeSessionInfo>();
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith('session-')) continue;
    if (!entry.name.endsWith('.json') && !entry.name.endsWith('.jsonl')) continue;
    const filePath = path.join(chatsDir, entry.name);
    const stat = statSafe(filePath);
    if (!stat) continue;
    let data: any;
    try { data = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { continue; }
    const sessionId = data?.sessionId ? String(data.sessionId) : null;
    if (!sessionId) continue;
    const messages: any[] = Array.isArray(data.messages) ? data.messages : [];
    let title: string | null = null;
    let lastUser: string | null = null;
    let lastAssistant: string | null = null;
    let turns = 0;
    for (const msg of messages) {
      if (msg?.type === 'user') {
        const t = geminiText(msg.content).trim();
        if (t) { if (!title) title = cleanTitle(t); lastUser = t; turns++; }
      } else if (msg?.type === 'model' || msg?.type === 'assistant' || msg?.type === 'gemini') {
        const t = geminiText(msg.content).trim();
        if (t) lastAssistant = t;
      }
    }
    const updatedAt = data.lastUpdated || data.startTime || data.createdAt || stat.mtime.toISOString();
    const existing = byId.get(sessionId);
    if (existing && existing.updatedAt && updatedAt && Date.parse(updatedAt) <= Date.parse(existing.updatedAt)) continue;
    byId.set(sessionId, {
      sessionId,
      title,
      preview: cleanTitle(lastAssistant || lastUser, 200),
      cwd: path.resolve(workdir),
      model: null,
      createdAt: data.startTime || data.createdAt || null,
      updatedAt,
      running: data.lastUpdated ? Date.now() - Date.parse(data.lastUpdated) < threshold : false,
      messageCount: turns || null,
    });
  }
  const out = [...byId.values()].sort((a, b) => Date.parse(b.updatedAt || '') - Date.parse(a.updatedAt || ''));
  return typeof opts.limit === 'number' ? out.slice(0, Math.max(0, opts.limit)) : out;
}

// ---- Fork anchors: the CURRENT tail keep-boundary of a native transcript ----
// Same terms as AgentTurnInput.fork.anchor: claude = transcript record uuid, codex = turn id.
// Used by fork-capable drivers' resolveNativeAnchor so Hub.forkSession can pin a tail cut at
// fork time (the branch must not absorb turns the parent runs afterwards). Bounded tail reads.

/** Claude: uuid of the last user/assistant record in the session's transcript. */
export function claudeTranscriptTailAnchor(workdir: string, sessionId: string, opts: DiscoverOptions = {}): string | null {
  const home = homeOf(opts);
  const filePath = path.join(home, '.claude', 'projects', encodeClaudeProjectDir(workdir), `${sessionId}.jsonl`);
  const stat = statSafe(filePath);
  if (!stat) return null;
  let anchor: string | null = null;
  try {
    const start = Math.max(0, stat.size - TAIL_BYTES);
    for (const line of readRegion(filePath, start, Math.min(TAIL_BYTES, stat.size)).split('\n')) {
      const t = line.trim();
      if (!t || t[0] !== '{') continue;
      let ev: any;
      try { ev = JSON.parse(t); } catch { continue; }
      if ((ev.type === 'assistant' || ev.type === 'user') && typeof ev.uuid === 'string' && ev.uuid) anchor = ev.uuid;
    }
  } catch { return null; }
  return anchor;
}

/** Codex: the last turn id recorded in the session's rollout. */
export function codexRolloutTailAnchor(sessionId: string, opts: DiscoverOptions = {}): string | null {
  const filePath = findCodexRolloutPath(homeOf(opts), sessionId);
  const stat = filePath ? statSafe(filePath) : null;
  if (!filePath || !stat) return null;
  let anchor: string | null = null;
  try {
    const start = Math.max(0, stat.size - TAIL_BYTES);
    for (const line of readRegion(filePath, start, Math.min(TAIL_BYTES, stat.size)).split('\n')) {
      const t = line.trim();
      if (!t || t[0] !== '{' || !t.includes('turn_id')) continue;
      let ev: any;
      try { ev = JSON.parse(t); } catch { continue; }
      const tid = ev.payload?.turn_id;
      if (typeof tid === 'string' && tid) anchor = tid;
    }
  } catch { return null; }
  return anchor;
}

/** Locate a codex rollout by session id (filenames end in `-<sessionId>.jsonl`). */
function findCodexRolloutPath(home: string, sessionId: string): string | null {
  const suffix = `${sessionId}.jsonl`;
  let found: string | null = null;
  const walk = (dir: string) => {
    if (found) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (found) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (entry.name.startsWith('rollout-') && entry.name.endsWith(suffix)) { found = full; return; }
    }
  };
  walk(path.join(home, '.codex', 'sessions'));
  return found;
}
