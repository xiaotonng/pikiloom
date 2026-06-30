import { describe, expect, it } from 'vitest';
import {
  isLikelyImageFile,
  extractImageDataUrlsFromHtml,
  dataUrlToImageFile,
} from '../dashboard/src/pages/sessions/utils.ts';

// 1x1 transparent PNG
const PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

describe('isLikelyImageFile', () => {
  it('accepts files whose MIME type is an image', () => {
    expect(isLikelyImageFile(new File([], 'a.png', { type: 'image/png' }))).toBe(true);
    expect(isLikelyImageFile(new File([], 'a', { type: 'image/webp' }))).toBe(true);
  });

  it('accepts empty-MIME files that have an image extension (Case B: source omits the type)', () => {
    expect(isLikelyImageFile(new File([], 'screenshot.png', { type: '' }))).toBe(true);
    expect(isLikelyImageFile(new File([], 'photo.JPEG', { type: '' }))).toBe(true);
    expect(isLikelyImageFile(new File([], 'clip.heic', { type: '' }))).toBe(true);
  });

  it('rejects non-image MIME types and empty-MIME non-image names', () => {
    expect(isLikelyImageFile(new File([], 'doc.pdf', { type: 'application/pdf' }))).toBe(false);
    expect(isLikelyImageFile(new File([], 'notes.txt', { type: '' }))).toBe(false);
    expect(isLikelyImageFile(new File([], 'archive', { type: '' }))).toBe(false);
  });
});

describe('extractImageDataUrlsFromHtml', () => {
  it('pulls inline data: image URLs out of an <img> fragment (Case A: copied from web/app)', () => {
    const html = `<meta charset="utf-8"><img src="${PNG_DATA_URL}" alt="x">`;
    expect(extractImageDataUrlsFromHtml(html)).toEqual([PNG_DATA_URL]);
  });

  it('extracts multiple images and ignores remote (non-data) srcs', () => {
    const html = `<img src="https://example.com/a.png"><img src='${PNG_DATA_URL}'>`;
    expect(extractImageDataUrlsFromHtml(html)).toEqual([PNG_DATA_URL]);
  });

  it('returns [] when there is no inline image', () => {
    expect(extractImageDataUrlsFromHtml('<p>hello</p>')).toEqual([]);
    expect(extractImageDataUrlsFromHtml('')).toEqual([]);
  });
});

describe('dataUrlToImageFile', () => {
  it('converts a base64 image data URL into a typed File', () => {
    const file = dataUrlToImageFile(PNG_DATA_URL);
    expect(file).not.toBeNull();
    expect(file!.type).toBe('image/png');
    expect(file!.name).toBe('pasted-image.png');
    expect(file!.size).toBeGreaterThan(0);
  });

  it('honours the name hint and derives the extension from the MIME type', () => {
    const webp = 'data:image/webp;base64,UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==';
    const file = dataUrlToImageFile(webp, 'clip');
    expect(file!.name).toBe('clip.webp');
    expect(file!.type).toBe('image/webp');
  });

  it('returns null for non-image or non-base64 data URLs', () => {
    expect(dataUrlToImageFile('data:text/plain;base64,aGk=')).toBeNull();
    expect(dataUrlToImageFile('https://example.com/a.png')).toBeNull();
    expect(dataUrlToImageFile('not a data url')).toBeNull();
  });
});
