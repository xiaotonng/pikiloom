import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  attachAgentImage,
  attachInlineImage,
  materializeImage,
  rewriteImageBlocksForTransport,
  decodeAttachmentPathParam,
  resolveAllowedAttachmentPath,
} from '../src/agent/images.ts';
import type { MessageBlock } from '../src/agent/types.ts';

// Minimal 1×1 transparent PNG.
const PNG_BYTES = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4'
  + '890000000a49444154789c63000100000005000156c2c4360000000049454e44ae426082',
  'hex',
);

describe('attachAgentImage', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikiclaw-img-test-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('inlines small images as data URLs and records imagePath/imageMime', () => {
    const file = path.join(tmpDir, 'cover.png');
    fs.writeFileSync(file, PNG_BYTES);
    const block = attachAgentImage({ imagePath: file, caption: 'pikiclaw cover' });
    expect(block).not.toBeNull();
    expect(block!.type).toBe('image');
    expect(block!.content.startsWith('data:image/png;base64,')).toBe(true);
    expect(block!.imagePath).toBe(file);
    expect(block!.imageMime).toBe('image/png');
    expect(block!.imageCaption).toBe('pikiclaw cover');
  });

  it('uses a file:// sentinel for images above the inline threshold', () => {
    const file = path.join(tmpDir, 'big.png');
    fs.writeFileSync(file, PNG_BYTES);
    const block = attachAgentImage({ imagePath: file, inlineThresholdBytes: 1 });
    expect(block).not.toBeNull();
    expect(block!.content).toBe(`file://${file}`);
    expect(block!.imagePath).toBe(file);
  });

  it('returns null when the file does not exist', () => {
    const block = attachAgentImage({ imagePath: path.join(tmpDir, 'missing.png') });
    expect(block).toBeNull();
  });
});

describe('attachInlineImage', () => {
  it('persists bytes under the per-session attachments dir when persist is set', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pikiclaw-img-test-'));
    process.env.HOME = tmp; // sessionAttachmentsDir resolves under $HOME
    try {
      const block = attachInlineImage({
        bytes: PNG_BYTES,
        mime: 'image/png',
        persist: { agent: 'codex', sessionId: 'abc', hint: 'cover' },
        inlineThresholdBytes: 1, // force file:// path
      });
      expect(block).not.toBeNull();
      expect(block!.imagePath).toBeDefined();
      expect(block!.imagePath!.endsWith('.png')).toBe(true);
      expect(fs.existsSync(block!.imagePath!)).toBe(true);
      expect(block!.content.startsWith('file://')).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('inlines as data URL when no persistence is requested', () => {
    const block = attachInlineImage({ bytes: PNG_BYTES, mime: 'image/png' });
    expect(block).not.toBeNull();
    expect(block!.content.startsWith('data:image/png;base64,')).toBe(true);
    expect(block!.imagePath).toBeUndefined();
  });

  it('rejects non-image MIME types', () => {
    const block = attachInlineImage({ bytes: Buffer.from('hello'), mime: 'text/plain' });
    expect(block).toBeNull();
  });
});

describe('materializeImage', () => {
  it('prefers imagePath when present', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pikiclaw-img-test-'));
    const file = path.join(tmp, 'inline.png');
    fs.writeFileSync(file, PNG_BYTES);
    try {
      const block: MessageBlock = {
        type: 'image',
        content: 'data:image/png;base64,SHOULD_NOT_BE_USED',
        imagePath: file,
        imageMime: 'image/png',
        imageCaption: 'kept',
      };
      const out = materializeImage(block);
      expect(out).not.toBeNull();
      expect(out!.bytes.equals(PNG_BYTES)).toBe(true);
      expect(out!.mime).toBe('image/png');
      expect(out!.caption).toBe('kept');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('falls back to decoding a data: URL when imagePath is unset', () => {
    const block: MessageBlock = {
      type: 'image',
      content: `data:image/png;base64,${PNG_BYTES.toString('base64')}`,
      imageMime: 'image/png',
    };
    const out = materializeImage(block);
    expect(out).not.toBeNull();
    expect(out!.bytes.equals(PNG_BYTES)).toBe(true);
  });

  it('returns null for non-image blocks', () => {
    const block: MessageBlock = { type: 'text', content: 'hi' };
    expect(materializeImage(block)).toBeNull();
  });
});

describe('rewriteImageBlocksForTransport', () => {
  it('leaves small inline data URLs untouched', () => {
    const dataUrl = `data:image/png;base64,${PNG_BYTES.toString('base64')}`;
    const blocks: MessageBlock[] = [{ type: 'image', content: dataUrl, imageMime: 'image/png' }];
    const out = rewriteImageBlocksForTransport(blocks, { agent: 'codex', sessionId: 's1' });
    expect(out[0].content).toBe(dataUrl);
  });

  it('rewrites file:// sentinels to attachment HTTP URLs', () => {
    const blocks: MessageBlock[] = [{
      type: 'image',
      content: 'file:///tmp/codex/img.png',
      imagePath: '/tmp/codex/img.png',
      imageMime: 'image/png',
    }];
    const out = rewriteImageBlocksForTransport(blocks, { agent: 'codex', sessionId: 's1' });
    expect(out[0].content.startsWith('/api/sessions/codex/s1/attachment?p=')).toBe(true);
    expect(out[0].imagePath).toBe('/tmp/codex/img.png');
  });

  it('preserves the original path through encode → decode round-trip', () => {
    const original = '/Users/admin/.codex/generated_images/abc/img.png';
    const blocks: MessageBlock[] = [{
      type: 'image',
      content: `file://${original}`,
      imagePath: original,
      imageMime: 'image/png',
    }];
    const out = rewriteImageBlocksForTransport(blocks, { agent: 'codex', sessionId: 's1' });
    const token = new URL(out[0].content, 'http://localhost').searchParams.get('p') || '';
    expect(decodeAttachmentPathParam(token)).toBe(original);
  });

  it('passes through non-image blocks unchanged', () => {
    const blocks: MessageBlock[] = [{ type: 'text', content: 'hello' }];
    const out = rewriteImageBlocksForTransport(blocks, { agent: 'codex', sessionId: 's1' });
    expect(out[0]).toEqual(blocks[0]);
  });
});

describe('resolveAllowedAttachmentPath', () => {
  it('rejects paths outside the allowlist', () => {
    const result = resolveAllowedAttachmentPath('/etc/passwd');
    expect(result).toBeNull();
  });

  it('accepts files under the configured workdir', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pikiclaw-img-test-'));
    const file = path.join(tmp, 'asset.png');
    fs.writeFileSync(file, PNG_BYTES);
    try {
      const real = resolveAllowedAttachmentPath(file, tmp);
      expect(real).not.toBeNull();
      expect(fs.realpathSync(real!)).toBe(fs.realpathSync(file));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('rejects paths outside every allowed root (no workdir)', () => {
    // /etc/hosts always exists and is outside every default allowlist root
    // (~/.codex, ~/.claude, ~/.gemini, ~/.pikiclaw/attachments, os.tmpdir()).
    // Verifies the post-realpath allowlist check correctly denies it.
    const real = resolveAllowedAttachmentPath('/etc/hosts');
    expect(real).toBeNull();
  });
});
