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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikiloom-img-test-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('inlines small images, uses file:// sentinel above threshold, and returns null for missing files', () => {
    // --- inlines small images as data URLs and records imagePath/imageMime ---
    const smallFile = path.join(tmpDir, 'cover.png');
    fs.writeFileSync(smallFile, PNG_BYTES);
    const inlined = attachAgentImage({ imagePath: smallFile, caption: 'pikiloom cover' });
    expect(inlined).not.toBeNull();
    expect(inlined!.type).toBe('image');
    expect(inlined!.content.startsWith('data:image/png;base64,')).toBe(true);
    expect(inlined!.imagePath).toBe(smallFile);
    expect(inlined!.imageMime).toBe('image/png');
    expect(inlined!.imageCaption).toBe('pikiloom cover');

    // --- file:// sentinel for images above the inline threshold ---
    const bigFile = path.join(tmpDir, 'big.png');
    fs.writeFileSync(bigFile, PNG_BYTES);
    const sentinel = attachAgentImage({ imagePath: bigFile, inlineThresholdBytes: 1 });
    expect(sentinel).not.toBeNull();
    expect(sentinel!.content).toBe(`file://${bigFile}`);
    expect(sentinel!.imagePath).toBe(bigFile);

    // --- null when the file does not exist ---
    expect(attachAgentImage({ imagePath: path.join(tmpDir, 'missing.png') })).toBeNull();
  });
});

describe('attachInlineImage', () => {
  it('persists when requested, inlines as data URL otherwise, and rejects non-image MIME types', () => {
    // --- persists bytes under the per-session attachments dir when persist is set ---
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pikiloom-img-test-'));
    const homeSnapshot = process.env.HOME;
    process.env.HOME = tmp; // sessionAttachmentsDir resolves under $HOME
    try {
      const persisted = attachInlineImage({
        bytes: PNG_BYTES,
        mime: 'image/png',
        persist: { agent: 'codex', sessionId: 'abc', hint: 'cover' },
        inlineThresholdBytes: 1, // force file:// path
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

    // --- inlines as data URL when no persistence is requested ---
    const inlined = attachInlineImage({ bytes: PNG_BYTES, mime: 'image/png' });
    expect(inlined).not.toBeNull();
    expect(inlined!.content.startsWith('data:image/png;base64,')).toBe(true);
    expect(inlined!.imagePath).toBeUndefined();

    // --- rejects non-image MIME types ---
    expect(attachInlineImage({ bytes: Buffer.from('hello'), mime: 'text/plain' })).toBeNull();
  });
});

describe('materializeImage & rewriteImageBlocksForTransport', () => {
  it('materializes from imagePath/data URL, rejects non-images, and rewrites transport blocks', () => {
    // --- materializeImage prefers imagePath when present ---
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

    // --- materializeImage falls back to decoding a data: URL when imagePath is unset ---
    const fromDataUrl = materializeImage({
      type: 'image',
      content: `data:image/png;base64,${PNG_BYTES.toString('base64')}`,
      imageMime: 'image/png',
    });
    expect(fromDataUrl).not.toBeNull();
    expect(fromDataUrl!.bytes.equals(PNG_BYTES)).toBe(true);

    // --- materializeImage returns null for non-image blocks ---
    expect(materializeImage({ type: 'text', content: 'hi' })).toBeNull();

    // --- rewriteImageBlocksForTransport leaves small inline data URLs untouched ---
    const dataUrl = `data:image/png;base64,${PNG_BYTES.toString('base64')}`;
    const untouched = rewriteImageBlocksForTransport(
      [{ type: 'image', content: dataUrl, imageMime: 'image/png' }],
      { agent: 'codex', sessionId: 's1' },
    );
    expect(untouched[0].content).toBe(dataUrl);

    // --- rewriteImageBlocksForTransport rewrites file:// sentinels to attachment HTTP URLs ---
    const rewritten = rewriteImageBlocksForTransport(
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

    // --- rewriteImageBlocksForTransport preserves the original path through encode → decode round-trip ---
    const original = '/Users/admin/.codex/generated_images/abc/img.png';
    const roundTrip = rewriteImageBlocksForTransport(
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

    // --- rewriteImageBlocksForTransport passes through non-image blocks unchanged ---
    const textBlocks: MessageBlock[] = [{ type: 'text', content: 'hello' }];
    const passthrough = rewriteImageBlocksForTransport(textBlocks, { agent: 'codex', sessionId: 's1' });
    expect(passthrough[0]).toEqual(textBlocks[0]);
  });
});

describe('resolveAllowedAttachmentPath', () => {
  it('enforces the allowlist across single workdir, no workdir, and multi-workspace setups', () => {
    // --- rejects paths outside the allowlist ---
    expect(resolveAllowedAttachmentPath('/etc/passwd')).toBeNull();

    // --- accepts files under the configured workdir ---
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

    // --- rejects paths outside every allowed root (no workdir) ---
    // /etc/hosts always exists and is outside every default allowlist root
    // (~/.codex, ~/.claude, ~/.gemini, ~/.pikiloom/attachments, os.tmpdir()).
    // Verifies the post-realpath allowlist check correctly denies it.
    expect(resolveAllowedAttachmentPath('/etc/hosts')).toBeNull();

    // --- accepts files under any of multiple workdirs (multi-workspace setup) ---
    // The dashboard attachment endpoint passes every registered workspace
    // root — a session living in a non-primary workspace must still resolve.
    // Workspaces are staged under the repo's gitignored .scratch/ dir because
    // os.tmpdir() is itself an allowed root and would make both assertions
    // pass trivially.
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
      // Still rejected when the hosting workspace is absent from the list.
      expect(resolveAllowedAttachmentPath(wsFile, [wsA])).toBeNull();
    } finally {
      fs.rmSync(wsA, { recursive: true, force: true });
      fs.rmSync(wsB, { recursive: true, force: true });
    }
  });
});
