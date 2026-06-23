import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getHome } from '../core/platform.js';
import { agentLog, agentWarn } from './utils.js';
import { mimeForExt } from './utils.js';
import type { Agent, MessageBlock } from './types.js';

const MAX_IMAGE_BYTES = 16 * 1024 * 1024;

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

export function codexHome(): string {
  return process.env.CODEX_HOME || path.join(getHome(), '.codex');
}

export function sessionAttachmentsDir(agent: Agent, sessionId: string): string {
  return path.join(getHome(), '.pikiloom', 'attachments', agent, sessionId);
}

export function allowedAttachmentRoots(workdir?: string | readonly string[] | null): string[] {
  const home = getHome();
  const roots: string[] = [
    path.join(codexHome(), 'generated_images'),
    path.join(codexHome(), 'sessions'),
    path.join(home, '.claude', 'projects'),
    path.join(home, '.gemini'),
    path.join(home, '.pikiloom', 'attachments'),
    os.tmpdir(),
  ];
  const workdirs = typeof workdir === 'string' ? [workdir] : (workdir ?? []);
  for (const wd of workdirs) {
    if (wd && wd.trim()) roots.push(path.resolve(wd));
  }
  return roots;
}

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

function mimeFromPath(filePath: string): string {
  return mimeForExt(path.extname(filePath).toLowerCase());
}

function extFromMime(mime: string): string {
  return IMAGE_EXT_BY_MIME[mime.toLowerCase()] || '.bin';
}

function isImageMime(mime: string): boolean {
  return mime.toLowerCase().startsWith(IMAGE_MIME_PREFIX);
}

export interface AttachAgentImageOpts {
  imagePath: string;
  mime?: string;
  caption?: string;
  captionKind?: 'prompt' | 'caption';
  phase?: 'commentary' | 'final_answer';
  inlineThresholdBytes?: number;
}

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
    content = `file://${abs}`;
  }

  const block: MessageBlock = {
    type: 'image',
    content,
    imagePath: abs,
    imageMime: mime,
  };
  if (opts.caption?.trim()) {
    block.imageCaption = opts.caption.trim();
    block.imageCaptionKind = opts.captionKind ?? 'caption';
  }
  if (opts.phase) block.phase = opts.phase;
  return block;
}

export interface AttachInlineImageOpts {
  bytes: Buffer;
  mime: string;
  caption?: string;
  captionKind?: 'prompt' | 'caption';
  phase?: 'commentary' | 'final_answer';
  persist?: { agent: Agent; sessionId: string; hint?: string };
  inlineThresholdBytes?: number;
}

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
  if (opts.caption?.trim()) {
    block.imageCaption = opts.caption.trim();
    block.imageCaptionKind = opts.captionKind ?? 'caption';
  }
  if (opts.phase) block.phase = opts.phase;
  return block;
}

export interface MaterializedImage {
  bytes: Buffer;
  mime: string;
  caption?: string;
}

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
    } catch {  }
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

export interface TransportContext {
  agent: Agent;
  sessionId: string;
  workdir?: string | null;
  apiBase?: string;
}

function encodePathForUrl(value: string): string {
  return Buffer.from(value, 'utf-8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function decodeAttachmentPathParam(value: string): string {
  const padded = value + '='.repeat((4 - (value.length % 4)) % 4);
  const normalized = padded.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(normalized, 'base64').toString('utf-8');
}

export function attachmentUrl(
  agent: Agent,
  sessionId: string,
  absPath: string,
  opts: { apiBase?: string; downloadName?: string } = {},
): string {
  const base = (opts.apiBase || '/api/sessions').replace(/\/+$/, '');
  const encoded = encodePathForUrl(absPath);
  const name = opts.downloadName ? `&n=${encodeURIComponent(opts.downloadName)}` : '';
  return `${base}/${encodeURIComponent(agent)}/${encodeURIComponent(sessionId)}/attachment?p=${encoded}${name}`;
}

export function rewriteAttachmentBlocksForTransport(
  blocks: MessageBlock[],
  ctx: TransportContext,
): MessageBlock[] {
  return blocks.map(block => {
    if (block.type === 'image') {
      const sourcePath = block.imagePath
        || (block.content?.startsWith('file://') ? block.content.slice('file://'.length) : '');
      if (!sourcePath) return block;
      if (block.content?.startsWith('data:')) return block;
      const url = attachmentUrl(ctx.agent, ctx.sessionId, sourcePath, { apiBase: ctx.apiBase });
      return { ...block, content: url, imagePath: sourcePath };
    }
    if (block.type === 'file') {
      const sourcePath = block.filePath
        || (block.content?.startsWith('file://') ? block.content.slice('file://'.length) : '');
      if (!sourcePath) return block;
      const url = attachmentUrl(ctx.agent, ctx.sessionId, sourcePath, {
        apiBase: ctx.apiBase,
        downloadName: block.fileName || undefined,
      });
      return { ...block, content: url, filePath: sourcePath };
    }
    return block;
  });
}

export const _IMAGE_PIPELINE_INTERNALS = {
  MAX_IMAGE_BYTES,
  INLINE_THRESHOLD_BYTES,
};
