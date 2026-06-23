import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  attachAgentImage,
  attachInlineImage,
  materializeImage,
  rewriteAttachmentBlocksForTransport,
  attachmentUrl,
  decodeAttachmentPathParam,
  resolveAllowedAttachmentPath,
} from '../src/agent/images.ts';
import type { MessageBlock } from '../src/agent/types.ts';

const PNG_BYTES = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4'
  + '890000000a49444154789c63000100000005000156c2c4360000000049454e44ae426082',
  'hex',
);

describe('attachAgentImage', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikiloom-img-test-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('inlines small images, uses file:// sentinel above threshold, and returns null for missing files', () => {
    const smallFile = path.join(tmpDir, 'cover.png');
    fs.writeFileSync(smallFile, PNG_BYTES);
    const inlined = attachAgentImage({ imagePath: smallFile, caption: 'pikiloom cover' });
    expect(inlined).not.toBeNull();
    expect(inlined!.type).toBe('image');
    expect(inlined!.content.startsWith('data:image/png;base64,')).toBe(true);
    expect(inlined!.imagePath).toBe(smallFile);
    expect(inlined!.imageMime).toBe('image/png');
    expect(inlined!.imageCaption).toBe('pikiloom cover');

    const bigFile = path.join(tmpDir, 'big.png');
    fs.writeFileSync(bigFile, PNG_BYTES);
    const sentinel = attachAgentImage({ imagePath: bigFile, inlineThresholdBytes: 1 });
    expect(sentinel).not.toBeNull();
    expect(sentinel!.content).toBe(`file://${bigFile}`);
    expect(sentinel!.imagePath).toBe(bigFile);

    expect(attachAgentImage({ imagePath: path.join(tmpDir, 'missing.png') })).toBeNull();
  });
});

describe('attachInlineImage', () => {
  it('persists when requested, inlines as data URL otherwise, and rejects non-image MIME types', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pikiloom-img-test-'));
    const homeSnapshot = process.env.HOME;
    process.env.HOME = tmp;
    try {
      const persisted = attachInlineImage({
        bytes: PNG_BYTES,
        mime: 'image/png',
        persist: { agent: 'codex', sessionId: 'abc', hint: 'cover' },
        inlineThresholdBytes: 1,
      });
      expect(persisted).not.toBeNull();
      expect(persisted!.imagePath).toBeDefined();
      expect(persisted!.imagePath!.endsWith('.png')).toBe(true);
      expect(fs.existsSync(persisted!.imagePath!)).toBe(true);
      expect(persisted!.content.startsWith('file://')).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
      if (homeSnapshot == null) delete process.env.HOME;
      else process.env.HOME = homeSnapshot;
    }

    const inlined = attachInlineImage({ bytes: PNG_BYTES, mime: 'image/png' });
    expect(inlined).not.toBeNull();
    expect(inlined!.content.startsWith('data:image/png;base64,')).toBe(true);
    expect(inlined!.imagePath).toBeUndefined();

    expect(attachInlineImage({ bytes: Buffer.from('hello'), mime: 'text/plain' })).toBeNull();
  });
});

describe('materializeImage & rewriteAttachmentBlocksForTransport', () => {
  it('materializes from imagePath/data URL, rejects non-images, and rewrites transport blocks', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pikiloom-img-test-'));
    const file = path.join(tmp, 'inline.png');
    fs.writeFileSync(file, PNG_BYTES);
    try {
      const fromPath = materializeImage({
        type: 'image',
        content: 'data:image/png;base64,SHOULD_NOT_BE_USED',
        imagePath: file,
        imageMime: 'image/png',
        imageCaption: 'kept',
      });
      expect(fromPath).not.toBeNull();
      expect(fromPath!.bytes.equals(PNG_BYTES)).toBe(true);
      expect(fromPath!.mime).toBe('image/png');
      expect(fromPath!.caption).toBe('kept');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }

    const fromDataUrl = materializeImage({
      type: 'image',
      content: `data:image/png;base64,${PNG_BYTES.toString('base64')}`,
      imageMime: 'image/png',
    });
    expect(fromDataUrl).not.toBeNull();
    expect(fromDataUrl!.bytes.equals(PNG_BYTES)).toBe(true);

    expect(materializeImage({ type: 'text', content: 'hi' })).toBeNull();

    const dataUrl = `data:image/png;base64,${PNG_BYTES.toString('base64')}`;
    const untouched = rewriteAttachmentBlocksForTransport(
      [{ type: 'image', content: dataUrl, imageMime: 'image/png' }],
      { agent: 'codex', sessionId: 's1' },
    );
    expect(untouched[0].content).toBe(dataUrl);

    const rewritten = rewriteAttachmentBlocksForTransport(
      [{
        type: 'image',
        content: 'file:///tmp/codex/img.png',
        imagePath: '/tmp/codex/img.png',
        imageMime: 'image/png',
      }],
      { agent: 'codex', sessionId: 's1' },
    );
    expect(rewritten[0].content.startsWith('/api/sessions/codex/s1/attachment?p=')).toBe(true);
    expect(rewritten[0].imagePath).toBe('/tmp/codex/img.png');

    const original = '/Users/admin/.codex/generated_images/abc/img.png';
    const roundTrip = rewriteAttachmentBlocksForTransport(
      [{
        type: 'image',
        content: `file://${original}`,
        imagePath: original,
        imageMime: 'image/png',
      }],
      { agent: 'codex', sessionId: 's1' },
    );
    const token = new URL(roundTrip[0].content, 'http://localhost').searchParams.get('p') || '';
    expect(decodeAttachmentPathParam(token)).toBe(original);

    const textBlocks: MessageBlock[] = [{ type: 'text', content: 'hello' }];
    const passthrough = rewriteAttachmentBlocksForTransport(textBlocks, { agent: 'codex', sessionId: 's1' });
    expect(passthrough[0]).toEqual(textBlocks[0]);

    const fileBlocks: MessageBlock[] = [{
      type: 'file',
      content: 'file:///tmp/codex/report final.pdf',
      filePath: '/tmp/codex/report final.pdf',
      fileMime: 'application/pdf',
      fileName: 'report final.pdf',
      fileSize: 4096,
    }];
    const fileRewritten = rewriteAttachmentBlocksForTransport(fileBlocks, { agent: 'codex', sessionId: 's1' });
    const fileUrl = new URL(fileRewritten[0].content, 'http://localhost');
    expect(fileUrl.pathname).toBe('/api/sessions/codex/s1/attachment');
    expect(decodeAttachmentPathParam(fileUrl.searchParams.get('p') || '')).toBe('/tmp/codex/report final.pdf');
    expect(fileUrl.searchParams.get('n')).toBe('report final.pdf');
    expect(fileRewritten[0].filePath).toBe('/tmp/codex/report final.pdf');
  });
});

describe('attachmentUrl', () => {
  it('builds an opaque, round-trippable attachment URL with an optional download name', () => {
    const url = attachmentUrl('claude', 'sess-1', '/Users/admin/.pikiloom/attachments/claude/sess-1/delivered/x-out.zip', {
      downloadName: 'out.zip',
    });
    const parsed = new URL(url, 'http://localhost');
    expect(parsed.pathname).toBe('/api/sessions/claude/sess-1/attachment');
    expect(decodeAttachmentPathParam(parsed.searchParams.get('p') || ''))
      .toBe('/Users/admin/.pikiloom/attachments/claude/sess-1/delivered/x-out.zip');
    expect(parsed.searchParams.get('n')).toBe('out.zip');

    const bare = new URL(attachmentUrl('claude', 'sess-1', '/tmp/a.png'), 'http://localhost');
    expect(bare.searchParams.has('n')).toBe(false);
  });
});

describe('resolveAllowedAttachmentPath', () => {
  it('enforces the allowlist across single workdir, no workdir, and multi-workspace setups', () => {
    expect(resolveAllowedAttachmentPath('/etc/passwd')).toBeNull();

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pikiloom-img-test-'));
    const file = path.join(tmp, 'asset.png');
    fs.writeFileSync(file, PNG_BYTES);
    try {
      const real = resolveAllowedAttachmentPath(file, tmp);
      expect(real).not.toBeNull();
      expect(fs.realpathSync(real!)).toBe(fs.realpathSync(file));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }

    expect(resolveAllowedAttachmentPath('/etc/hosts')).toBeNull();

    const scratch = path.join(process.cwd(), '.scratch');
    fs.mkdirSync(scratch, { recursive: true });
    const wsA = fs.mkdtempSync(path.join(scratch, 'img-ws-a-'));
    const wsB = fs.mkdtempSync(path.join(scratch, 'img-ws-b-'));
    const wsFile = path.join(wsB, '.pikiloom', 'sessions', 'claude', 's1', 'workspace', 'image.png');
    fs.mkdirSync(path.dirname(wsFile), { recursive: true });
    fs.writeFileSync(wsFile, PNG_BYTES);
    try {
      const real = resolveAllowedAttachmentPath(wsFile, [wsA, wsB]);
      expect(real).not.toBeNull();
      expect(fs.realpathSync(real!)).toBe(fs.realpathSync(wsFile));
      expect(resolveAllowedAttachmentPath(wsFile, [wsA])).toBeNull();
    } finally {
      fs.rmSync(wsA, { recursive: true, force: true });
      fs.rmSync(wsB, { recursive: true, force: true });
    }
  });
});
