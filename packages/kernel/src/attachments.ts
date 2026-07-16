import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path, { extname } from 'node:path';

// Attachment vocabulary + normalization, shared by the runtime (Hub) and every driver.
// NOT part of the public API — nothing here is re-exported by any barrel.

// Every driver inlines the same image formats (the Anthropic vision set, which the
// others accept too) and notes non-image files the same way.
const IMAGE_MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp',
};

/** Mime type when the file is an inlineable image, else null. */
export function imageMimeForFile(filePath: string): string | null {
  return IMAGE_MIME_BY_EXT[extname(filePath).toLowerCase()] ?? null;
}

/** The text note substituted for a non-image attachment. */
export function attachedFileNote(filePath: string): string {
  return `[Attached file: ${filePath}]`;
}

/**
 * Anthropic scales any image whose long edge exceeds 1568px before the model sees it, and —
 * once a single request carries MORE THAN 20 images — outright REJECTS any image over 2000px
 * on a side ("dimensions exceed max allowed size for many-image requests"). A long session
 * full of screenshots easily crosses 20 images, at which point one freshly attached (or
 * mid-turn steered) full-resolution screenshot gets the whole image stripped from the turn.
 * Capping the long edge at Anthropic's own downscale threshold loses no detail the model
 * would have kept and makes the many-image rejection unreachable. Other providers only gain
 * from smaller uploads.
 */
export const MAX_IMAGE_EDGE = 1568;

/**
 * Pixel dimensions parsed from an image buffer's header (PNG / JPEG / GIF / WebP),
 * or null when the bytes aren't one of those formats. Header-only: never decodes.
 */
export function imageDimensions(buf: Buffer): { width: number; height: number } | null {
  if (buf.length >= 24 && buf.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length >= 10 && (buf.subarray(0, 6).toString('latin1') === 'GIF87a' || buf.subarray(0, 6).toString('latin1') === 'GIF89a')) {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    // JPEG: walk segments to the first SOF (skips arbitrarily large EXIF/APPn blocks).
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      if (marker === 0xff) { i++; continue; } // fill byte
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
      }
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) { i += 2; continue; } // standalone
      i += 2 + buf.readUInt16BE(i + 2);
    }
    return null;
  }
  if (buf.length >= 30 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') {
    const chunk = buf.subarray(12, 16).toString('latin1');
    if (chunk === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
    if (chunk === 'VP8L') return { width: 1 + (buf.readUInt32LE(21) & 0x3fff), height: 1 + ((buf.readUInt32LE(21) >> 14) & 0x3fff) };
    if (chunk === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  return null;
}

// The resize engine is whatever the OS provides — the kernel allows no image-decoding
// dependency (`ws` is its only runtime dep). darwin always has `sips`; elsewhere try
// ImageMagick 7 (`magick`) then 6 (`convert`), probed once. 'none' = pass originals through.
type Resizer = 'sips' | 'magick' | 'convert' | 'none';
let resizerCache: Resizer | Promise<Resizer> | null = null;

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 10_000 }, (err) => (err ? reject(err) : resolve()));
  });
}

function detectResizer(): Resizer | Promise<Resizer> {
  if (resizerCache) return resizerCache;
  if (process.platform === 'darwin') return (resizerCache = 'sips');
  resizerCache = (async () => {
    for (const cmd of ['magick', 'convert'] as const) {
      try { await run(cmd, ['-version']); return (resizerCache = cmd); } catch { /* try next */ }
    }
    return (resizerCache = 'none');
  })();
  return resizerCache;
}

/** Test seam: force re-probing (and optionally stub) the resize engine. */
export function resetResizerForTest(value: Resizer | null = null): void {
  resizerCache = value;
}

// Downscale `src` so its long edge is `maxEdge`, into a fresh temp file; null = keep the
// original (no engine, or the engine failed/produced nothing). WebP output support varies
// by sips version, so webp is re-encoded as PNG — the extension switch keeps the drivers'
// mime mapping truthful.
async function resizeToTemp(src: string, maxEdge: number): Promise<string | null> {
  const resizer = await detectResizer();
  if (resizer === 'none') return null;
  const srcExt = extname(src).toLowerCase();
  const outExt = srcExt === '.webp' ? '.png' : srcExt;
  const out = path.join(os.tmpdir(), `pikiloom-att-${randomUUID().slice(0, 8)}${outExt}`);
  try {
    if (resizer === 'sips') {
      const format = srcExt === '.webp' ? ['-s', 'format', 'png'] : [];
      await run('sips', [...format, '-Z', String(maxEdge), src, '--out', out]);
    } else {
      await run(resizer, [src, '-resize', `${maxEdge}x${maxEdge}>`, out]);
    }
    return fs.statSync(out).size > 0 ? out : null;
  } catch {
    fs.rmSync(out, { force: true });
    return null;
  }
}

/**
 * Swap oversized raster images (long edge > {@link MAX_IMAGE_EDGE}) for downscaled temp
 * copies, leaving everything else — small images, non-images, unreadable paths, animated
 * gifs — untouched. Best-effort by design: any probe/resize failure keeps the original, so
 * an attachment is never dropped; the worst case is the pre-existing behaviour. Called once
 * per dispatch at the Hub chokepoints (turn start + mid-turn steer), so every driver —
 * built-in or host-plugged — sends model-safe images.
 */
export async function normalizeImageAttachments(
  attachments: string[] | undefined,
  log?: (msg: string) => void,
): Promise<string[] | undefined> {
  if (!attachments?.length) return attachments;
  const out = [...attachments];
  for (let i = 0; i < out.length; i++) {
    const file = out[i];
    const mime = imageMimeForFile(file);
    if (!mime || mime === 'image/gif') continue; // gif: resizing would mangle animation
    try {
      const dims = imageDimensions(fs.readFileSync(file));
      if (!dims || Math.max(dims.width, dims.height) <= MAX_IMAGE_EDGE) continue;
      const resized = await resizeToTemp(file, MAX_IMAGE_EDGE);
      if (resized) {
        out[i] = resized;
        log?.(`[attachments] downscaled ${path.basename(file)} ${dims.width}x${dims.height} -> long edge ${MAX_IMAGE_EDGE}`);
      }
    } catch { /* unreadable — the drivers' own fallback (file note) handles it */ }
  }
  return out;
}
