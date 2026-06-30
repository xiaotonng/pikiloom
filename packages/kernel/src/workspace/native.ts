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

export const NATIVE_SESSION_RUNNING_THRESHOLD_MS = 10_000;

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

function readClaudeHead(filePath: string, size: number): { title: string | null; model: string | null; preview: string | null; turns: number } {
  let title: string | null = null;
  let model: string | null = null;
  let lastUser: string | null = null;
  let lastAssistant: string | null = null;
  let turns = 0;
  let head = '';
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(Math.min(256 * 1024, Math.max(65536, size)));
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    head = buf.toString('utf8', 0, n);
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
      if (!model && ev.message?.model && ev.message.model !== '<synthetic>') model = ev.message.model;
      const text = claudeText(ev.message?.content).trim();
      if (text) lastAssistant = text;
    }
  }
  const preview = cleanTitle(lastAssistant || lastUser, 200);
  return { title, model, preview, turns };
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
    const { title, model, preview, turns } = readClaudeHead(filePath, stat.size);
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
    const meta = readCodexHead(filePath);
    if (!meta || meta.isSubagent || path.resolve(meta.cwd) !== resolvedWorkdir) continue;
    if (seen.has(meta.sessionId)) continue;
    seen.add(meta.sessionId);
    const idx = titleIndex.get(meta.sessionId);
    const updatedAt = idx?.updatedAt || stat.mtime.toISOString();
    out.push({
      sessionId: meta.sessionId,
      title: cleanTitle(idx?.threadName || null),
      preview: null,
      cwd: meta.cwd,
      model: null,
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
