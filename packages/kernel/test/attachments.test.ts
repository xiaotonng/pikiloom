import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  MAX_IMAGE_EDGE,
  imageDimensions,
  normalizeImageAttachments,
  resetResizerForTest,
} from '../src/attachments.js';

// A real, decodable PNG (solid color, RGBA, no interlace) — sips/ImageMagick can resize it.
function makePng(width: number, height: number): Buffer {
  const sig = Buffer.from('89504e470d0a1a0a', 'hex');
  const ihdrBody = Buffer.alloc(13);
  ihdrBody.writeUInt32BE(width, 0);
  ihdrBody.writeUInt32BE(height, 4);
  ihdrBody[8] = 8; ihdrBody[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc(height * (1 + width * 4)); // per row: filter byte 0 + pixels
  for (let y = 0; y < height; y++) raw.fill(0x7f, y * (1 + width * 4) + 1, (y + 1) * (1 + width * 4));
  const chunk = (type: string, body: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length, 0);
    const typed = Buffer.concat([Buffer.from(type, 'latin1'), body]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(typed), 0);
    return Buffer.concat([len, typed, crc]);
  };
  return Buffer.concat([sig, chunk('IHDR', ihdrBody), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// Whether THIS machine can actually resize (darwin sips, or ImageMagick on PATH).
const canResize = process.platform === 'darwin'
  || ['magick', 'convert'].some((c) => {
    try { execFileSync(c, ['-version'], { stdio: 'ignore' }); return true; } catch { return false; }
  });

describe('imageDimensions', () => {
  it('reads PNG headers', () => {
    expect(imageDimensions(makePng(2692, 410))).toEqual({ width: 2692, height: 410 });
  });

  it('reads GIF headers', () => {
    const gif = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(7)]);
    gif.writeUInt16LE(320, 6);
    gif.writeUInt16LE(240, 8);
    expect(imageDimensions(gif)).toEqual({ width: 320, height: 240 });
  });

  it('reads JPEG SOF across APPn segments (EXIF-style)', () => {
    // FFD8 · APP1 (oversized padding, as a big EXIF block would be) · SOF0 · EOI
    const app1 = Buffer.alloc(2 + 2 + 300);
    app1[0] = 0xff; app1[1] = 0xe1; app1.writeUInt16BE(302, 2);
    const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x04, 0x60, 0x0a, 0x84, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const jpg = Buffer.concat([Buffer.from([0xff, 0xd8]), app1, sof, Buffer.from([0xff, 0xd9])]);
    expect(imageDimensions(jpg)).toEqual({ width: 2692, height: 1120 });
  });

  it('reads WebP VP8X extended headers', () => {
    const webp = Buffer.alloc(30);
    webp.write('RIFF', 0, 'latin1');
    webp.write('WEBP', 8, 'latin1');
    webp.write('VP8X', 12, 'latin1');
    webp.writeUIntLE(2999, 24, 3); // width-1
    webp.writeUIntLE(499, 27, 3);  // height-1
    expect(imageDimensions(webp)).toEqual({ width: 3000, height: 500 });
  });

  it('returns null for non-image bytes', () => {
    expect(imageDimensions(Buffer.from('not an image at all, definitely'))).toBeNull();
  });
});

describe('normalizeImageAttachments', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-att-norm-'));
    resetResizerForTest();
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    resetResizerForTest();
  });

  it('passes through undefined/empty, small images, non-images, and missing paths', async () => {
    expect(await normalizeImageAttachments(undefined)).toBeUndefined();
    expect(await normalizeImageAttachments([])).toEqual([]);
    const small = path.join(tmp, 'small.png');
    fs.writeFileSync(small, makePng(800, 600));
    const pdf = path.join(tmp, 'doc.pdf');
    fs.writeFileSync(pdf, 'not an image');
    const missing = path.join(tmp, 'gone.png');
    expect(await normalizeImageAttachments([small, pdf, missing])).toEqual([small, pdf, missing]);
  });

  it('keeps the original when no resize engine exists', async () => {
    resetResizerForTest('none');
    const big = path.join(tmp, 'big.png');
    fs.writeFileSync(big, makePng(2692, 410));
    expect(await normalizeImageAttachments([big])).toEqual([big]);
  });

  it.skipIf(!canResize)('downscales an over-limit image to the max long edge, preserving the original', async () => {
    const big = path.join(tmp, 'wide.png');
    fs.writeFileSync(big, makePng(2692, 410)); // the exact shape Anthropic rejected in the field
    const logs: string[] = [];
    const [out] = (await normalizeImageAttachments([big], (m) => logs.push(m)))!;
    expect(out).not.toBe(big);
    const dims = imageDimensions(fs.readFileSync(out))!;
    expect(Math.max(dims.width, dims.height)).toBeLessThanOrEqual(MAX_IMAGE_EDGE);
    expect(dims.width / dims.height).toBeCloseTo(2692 / 410, 0); // aspect kept
    expect(fs.readFileSync(big).length).toBeGreaterThan(0); // source untouched
    expect(logs.some((l) => l.includes('downscaled'))).toBe(true);
    fs.rmSync(out, { force: true });
  });

  it.skipIf(!canResize)('mixes: only the oversized entry is swapped, order preserved', async () => {
    const small = path.join(tmp, 'small.png');
    const big = path.join(tmp, 'big.png');
    fs.writeFileSync(small, makePng(400, 300));
    fs.writeFileSync(big, makePng(410, 2692)); // tall variant
    const out = (await normalizeImageAttachments([small, big]))!;
    expect(out[0]).toBe(small);
    expect(out[1]).not.toBe(big);
    const dims = imageDimensions(fs.readFileSync(out[1]))!;
    expect(Math.max(dims.width, dims.height)).toBeLessThanOrEqual(MAX_IMAGE_EDGE);
    fs.rmSync(out[1], { force: true });
  });
});
