/**
 * images.ts — unified image pipeline for the agent layer.
 *
 * Every driver produces image blocks through `attachAgentImage`, every IM
 * channel consumes them through `materializeImage`, and every dashboard
 * response routes large images through the attachment HTTP endpoint via
 * `rewriteImageBlocksForTransport`. The shape isolates *where the bytes live*
 * from *how a renderer wants to consume them*, so adding a new driver source
 * (Codex `image_generation_call`, Claude MCP `tool_result` image, Gemini Imagen,
 * future) or a new transport (a fourth IM channel, a CLI exporter, an OG-image
 * preview) doesn't require touching every other site.
 *
 * Storage model
 * -------------
 *  - Agent-native sources (`~/.codex/generated_images/...`, `~/.claude/...`)
 *    keep their files in place. The block's `imagePath` is the authoritative
 *    pointer; the dashboard and channels read directly from there.
 *  - MCP-bridge-buffered sources (image content embedded in MCP tool results)
 *    are persisted under the per-session attachments directory (see
 *    `sessionAttachmentsDir`) so they survive the originating CLI process and
 *    are reachable by an absolute path.
 *
 * Transport model
 * ---------------
 *  - `content` always carries a directly-renderable reference: a `data:` URL
 *    for inline bytes, or an attachment HTTP URL for files on disk.
 *  - Below `INLINE_THRESHOLD_BYTES`, drivers may inline as `data:`. Above the
 *    threshold, `rewriteImageBlocksForTransport` substitutes a relative
 *    `/api/sessions/:agent/:id/attachment?...` URL — keeps RichMessage
 *    payloads small even when a session has many large images.
 *  - IM channels prefer `imagePath` over decoding `content`, avoiding wasted
 *    base64 round-trips.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getHome } from '../core/platform.js';
import { agentLog, agentWarn } from './utils.js';
import { mimeForExt } from './utils.js';
import type { Agent, MessageBlock } from './types.js';

// ---------------------------------------------------------------------------
// Constants & policy
// ---------------------------------------------------------------------------

/**
 * Maximum on-disk size we'll read into memory when materializing image bytes.
 * Larger files are skipped (transport surfaces the `imagePath` reference but
 * doesn't blast a multi-megabyte buffer through the channel send path).
 */
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;

/**
 * Below this size we inline the image as a `data:` URL inside the block's
 * `content`. Larger images travel as on-disk references; the dashboard fetches
 * them lazily through the attachment HTTP endpoint and IM channels read from
 * disk via `imagePath`.
 */
const INLINE_THRESHOLD_BYTES = 256 * 1024;

const IMAGE_MIME_PREFIX = 'image/';

const IMAGE_EXT_BY_MIME: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
};

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** `$CODEX_HOME` or fallback `~/.codex`. */
export function codexHome(): string {
  return process.env.CODEX_HOME || path.join(getHome(), '.codex');
}

/** Per-session attachments directory used by MCP bridge / tool buffering.
 *  Lives next to the user's pikiclaw config so it survives across workdirs. */
export function sessionAttachmentsDir(agent: Agent, sessionId: string): string {
  return path.join(getHome(), '.pikiclaw', 'attachments', agent, sessionId);
}

/**
 * Path roots that the dashboard attachment endpoint is allowed to serve.
 * Every entry is real-resolved at request time; a candidate file must live
 * inside one of them (post-realpath) to be served.
 *
 *  - `~/.codex/generated_images` — Codex built-in `image_gen` outputs.
 *  - `~/.codex/sessions`         — rollout-adjacent assets (rare but legal).
 *  - `~/.claude/projects`        — Claude attached images written to JSONL.
 *  - `~/.gemini`                 — Gemini CLI managed dirs.
 *  - `~/.pikiclaw/attachments`   — MCP-bridge-buffered tool result images.
 *  - workspace tree(s)           — files generated under the project workdir.
 *  - OS tmpdir                   — short-lived staging by drivers / skills.
 *
 * `workdir` accepts a list because a multi-workspace setup serves sessions
 * from several project trees through one endpoint — every entry must come
 * from server-side config (registered workspaces / managed session records),
 * never from request input.
 */
export function allowedAttachmentRoots(workdir?: string | readonly string[] | null): string[] {
  const home = getHome();
  const roots: string[] = [
    path.join(codexHome(), 'generated_images'),
    path.join(codexHome(), 'sessions'),
    path.join(home, '.claude', 'projects'),
    path.join(home, '.gemini'),
    path.join(home, '.pikiclaw', 'attachments'),
    os.tmpdir(),
  ];
  const workdirs = typeof workdir === 'string' ? [workdir] : (workdir ?? []);
  for (const wd of workdirs) {
    if (wd && wd.trim()) roots.push(path.resolve(wd));
  }
  return roots;
}

/**
 * Verify a resolved file path lives under one of the allowed roots, defending
 * against `..` traversal AND symlinks that escape the allowlist. Returns the
 * realpath when the file is allowed, or null when not.
 */
export function resolveAllowedAttachmentPath(
  requested: string,
  workdir?: string | readonly string[] | null,
): string | null {
  if (!requested) return null;
  let real: string;
  try { real = fs.realpathSync(requested); } catch { return null; }
  for (const root of allowedAttachmentRoots(workdir)) {
    let realRoot: string;
    try { realRoot = fs.realpathSync(root); } catch { continue; }
    const rel = path.relative(realRoot, real);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return real;
    if (rel === '') return real;
  }
  return null;
}

// ---------------------------------------------------------------------------
// MIME helpers
// ---------------------------------------------------------------------------

function mimeFromPath(filePath: string): string {
  return mimeForExt(path.extname(filePath).toLowerCase());
}

function extFromMime(mime: string): string {
  return IMAGE_EXT_BY_MIME[mime.toLowerCase()] || '.bin';
}

function isImageMime(mime: string): boolean {
  return mime.toLowerCase().startsWith(IMAGE_MIME_PREFIX);
}

// ---------------------------------------------------------------------------
// attachAgentImage — driver-facing builder
// ---------------------------------------------------------------------------

export interface AttachAgentImageOpts {
  /** Authoritative on-disk path; required for file-backed images. */
  imagePath: string;
  /** MIME type override. Inferred from the path extension when omitted. */
  mime?: string;
  /** Optional caption (e.g. Codex `revised_prompt`). */
  caption?: string;
  /** Phase tag, matching codex's commentary vs final_answer surface. */
  phase?: 'commentary' | 'final_answer';
  /**
   * Bytes ≤ this are inlined as a `data:` URL in `content` for instant render.
   * Larger images skip inlining; the dashboard fetches through the attachment
   * endpoint and IM channels read from `imagePath` directly.
   */
  inlineThresholdBytes?: number;
}

/**
 * Build a `MessageBlock` of type `image` from an on-disk file produced by an
 * agent (Codex built-in `image_gen`, MCP tool buffered to attachments dir, …).
 * Returns null when the file is missing or unreadable — drivers should treat
 * that as a soft failure and continue without the block.
 */
export function attachAgentImage(opts: AttachAgentImageOpts): MessageBlock | null {
  const abs = path.resolve(opts.imagePath);
  let stat: fs.Stats;
  try { stat = fs.statSync(abs); } catch (err: any) {
    agentLog(`[images] attachAgentImage: stat failed for ${abs}: ${err?.message || err}`);
    return null;
  }
  if (!stat.isFile()) return null;
  if (stat.size > MAX_IMAGE_BYTES) {
    agentWarn(`[images] attachAgentImage: ${abs} too large (${stat.size} bytes > ${MAX_IMAGE_BYTES})`);
    return null;
  }

  const mime = (opts.mime || mimeFromPath(abs)).toLowerCase();
  if (!isImageMime(mime)) return null;

  const threshold = opts.inlineThresholdBytes ?? INLINE_THRESHOLD_BYTES;
  let content: string;
  if (stat.size <= threshold) {
    let bytes: Buffer;
    try { bytes = fs.readFileSync(abs); } catch (err: any) {
      agentLog(`[images] attachAgentImage: read failed for ${abs}: ${err?.message || err}`);
      return null;
    }
    content = `data:${mime};base64,${bytes.toString('base64')}`;
  } else {
    // Sentinel: the transport layer rewrites this into an HTTP URL with the
    // right session context. Renderers that bypass `rewriteImageBlocksForTransport`
    // see a `file://` URL and can still resolve it via `materializeImage` since
    // `imagePath` is also populated.
    content = `file://${abs}`;
  }

  const block: MessageBlock = {
    type: 'image',
    content,
    imagePath: abs,
    imageMime: mime,
  };
  if (opts.caption?.trim()) block.imageCaption = opts.caption.trim();
  if (opts.phase) block.phase = opts.phase;
  return block;
}

// ---------------------------------------------------------------------------
// attachInlineImageBytes — for sources that hand us bytes directly
// (MCP tool result image content; Claude assistant images embedded in JSONL).
// ---------------------------------------------------------------------------

export interface AttachInlineImageOpts {
  bytes: Buffer;
  mime: string;
  caption?: string;
  phase?: 'commentary' | 'final_answer';
  /** When set, the bytes are also persisted on disk under this agent+session's
   *  attachments dir so transports can read by path. */
  persist?: { agent: Agent; sessionId: string; hint?: string };
  inlineThresholdBytes?: number;
}

/**
 * Build an image MessageBlock from an in-memory byte buffer. When `persist`
 * is supplied, the bytes are also written to the session's attachments dir
 * and the resulting path attached as `imagePath` — this is the path the MCP
 * bridge uses when a tool returns an image (so downstream IM channels and the
 * dashboard attachment endpoint can serve it without re-encoding).
 */
export function attachInlineImage(opts: AttachInlineImageOpts): MessageBlock | null {
  if (!opts.bytes?.length) return null;
  const mime = opts.mime.toLowerCase();
  if (!isImageMime(mime)) return null;
  if (opts.bytes.length > MAX_IMAGE_BYTES) {
    agentWarn(`[images] attachInlineImage: ${opts.bytes.length} bytes > ${MAX_IMAGE_BYTES}`);
    return null;
  }

  let imagePath: string | undefined;
  if (opts.persist) {
    const dir = sessionAttachmentsDir(opts.persist.agent, opts.persist.sessionId);
    try {
      fs.mkdirSync(dir, { recursive: true });
      const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      const hint = (opts.persist.hint || 'image').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'image';
      const candidate = path.join(dir, `${hint}-${stamp}${extFromMime(mime)}`);
      fs.writeFileSync(candidate, opts.bytes);
      imagePath = candidate;
    } catch (err: any) {
      agentLog(`[images] attachInlineImage: persist failed: ${err?.message || err}`);
    }
  }

  const threshold = opts.inlineThresholdBytes ?? INLINE_THRESHOLD_BYTES;
  const content = opts.bytes.length <= threshold || !imagePath
    ? `data:${mime};base64,${opts.bytes.toString('base64')}`
    : `file://${imagePath}`;

  const block: MessageBlock = { type: 'image', content, imageMime: mime };
  if (imagePath) block.imagePath = imagePath;
  if (opts.caption?.trim()) block.imageCaption = opts.caption.trim();
  if (opts.phase) block.phase = opts.phase;
  return block;
}

// ---------------------------------------------------------------------------
// materializeImage — transport-facing resolver
// ---------------------------------------------------------------------------

export interface MaterializedImage {
  bytes: Buffer;
  mime: string;
  caption?: string;
}

/**
 * Resolve an image block to raw bytes for transport (IM channel image send,
 * export bundling, …). Preference order:
 *   1. `imagePath` — read straight from disk, no base64 decode.
 *   2. `content` is `data:image/...;base64,...` — decode the URL.
 *   3. `content` is `file://...` — read that path from disk.
 *   4. otherwise — return null.
 */
export function materializeImage(block: MessageBlock): MaterializedImage | null {
  if (block.type !== 'image') return null;
  const caption = block.imageCaption?.trim() || undefined;

  if (block.imagePath) {
    try {
      const stat = fs.statSync(block.imagePath);
      if (stat.isFile() && stat.size <= MAX_IMAGE_BYTES) {
        const bytes = fs.readFileSync(block.imagePath);
        const mime = (block.imageMime || mimeFromPath(block.imagePath)).toLowerCase();
        return { bytes, mime, caption };
      }
    } catch { /* fall through to content */ }
  }

  const content = block.content || '';
  if (content.startsWith('data:')) {
    const m = /^data:([^;,]+);base64,(.+)$/i.exec(content);
    if (!m) return null;
    const mime = m[1].toLowerCase();
    try {
      const bytes = Buffer.from(m[2], 'base64');
      if (bytes.length > MAX_IMAGE_BYTES) return null;
      return { bytes, mime, caption };
    } catch { return null; }
  }

  if (content.startsWith('file://')) {
    const filePath = content.slice('file://'.length);
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) return null;
      const bytes = fs.readFileSync(filePath);
      const mime = (block.imageMime || mimeFromPath(filePath)).toLowerCase();
      return { bytes, mime, caption };
    } catch { return null; }
  }

  return null;
}

// ---------------------------------------------------------------------------
// rewriteImageBlocksForTransport — for JSON responses crossing the wire
// ---------------------------------------------------------------------------

export interface TransportContext {
  agent: Agent;
  sessionId: string;
  /** Workdir bound to this response, used to widen the attachment allowlist. */
  workdir?: string | null;
  /** Base URL prefix for served attachments. Default: `/api/sessions`. */
  apiBase?: string;
}

function encodePathForUrl(value: string): string {
  // base64url makes the path opaque in URLs (no `?`, `#`, `/` collisions) and
  // round-trips losslessly back to the original absolute path.
  return Buffer.from(value, 'utf-8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function decodeAttachmentPathParam(value: string): string {
  const padded = value + '='.repeat((4 - (value.length % 4)) % 4);
  const normalized = padded.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(normalized, 'base64').toString('utf-8');
}

/**
 * Rewrite a block array for transport: any image block whose `content` is a
 * `file://` sentinel becomes an attachment HTTP URL, and any inline `data:`
 * URL above the threshold is also promoted to an HTTP URL (keeping the
 * RichMessage payload compact even when a session has many large images).
 *
 * Pure: returns a new array; the input is not mutated.
 */
export function rewriteImageBlocksForTransport(
  blocks: MessageBlock[],
  ctx: TransportContext,
): MessageBlock[] {
  const base = (ctx.apiBase || '/api/sessions').replace(/\/+$/, '');
  return blocks.map(block => {
    if (block.type !== 'image') return block;
    const sourcePath = block.imagePath
      || (block.content?.startsWith('file://') ? block.content.slice('file://'.length) : '');
    if (!sourcePath) return block;
    // Inline content under the threshold: leave the data URL alone — the
    // dashboard renders it directly, no extra request.
    if (block.content?.startsWith('data:')) return block;
    const encoded = encodePathForUrl(sourcePath);
    const url = `${base}/${encodeURIComponent(ctx.agent)}/${encodeURIComponent(ctx.sessionId)}/attachment?p=${encoded}`;
    return { ...block, content: url, imagePath: sourcePath };
  });
}

// ---------------------------------------------------------------------------
// Constants exported for tests
// ---------------------------------------------------------------------------

export const _IMAGE_PIPELINE_INTERNALS = {
  MAX_IMAGE_BYTES,
  INLINE_THRESHOLD_BYTES,
};
