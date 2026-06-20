import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  deliverArtifact,
  readDeliveredArtifacts,
  deliveredArtifactBlocks,
  mimeForArtifact,
} from '../src/agent/artifacts.ts';

// Minimal 1×1 transparent PNG.
const PNG_BYTES = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4'
  + '890000000a49444154789c63000100000005000156c2c4360000000049454e44ae426082',
  'hex',
);

describe('delivered-artifact manifest', () => {
  let home: string;
  let homeSnapshot: string | undefined;
  let workdir: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'pikiloom-artifacts-home-'));
    homeSnapshot = process.env.HOME;
    process.env.HOME = home; // sessionAttachmentsDir resolves under $HOME
    workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikiloom-artifacts-wd-'));
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(workdir, { recursive: true, force: true });
    if (homeSnapshot == null) delete process.env.HOME;
    else process.env.HOME = homeSnapshot;
  });

  it('materializes a delivery into a durable, stamped copy under the session attachments dir', () => {
    const src = path.join(workdir, 'report.pdf');
    fs.writeFileSync(src, 'PDF-CONTENT');

    const rec = deliverArtifact('claude', 'sess-1', src, { kind: 'document', caption: 'final report' });
    expect(rec).not.toBeNull();
    expect(rec!.fileName).toBe('report.pdf');
    expect(rec!.fileMime).toBe('application/pdf');
    expect(rec!.fileSize).toBe(Buffer.byteLength('PDF-CONTENT'));
    expect(rec!.kind).toBe('document');
    expect(rec!.caption).toBe('final report');

    // Materialized copy lives under ~/.pikiloom/attachments/<agent>/<session>/delivered
    // and is a *distinct* path from the source (survives workspace cleanup).
    expect(rec!.path).toContain(path.join('.pikiloom', 'attachments', 'claude', 'sess-1', 'delivered'));
    expect(rec!.path).not.toBe(src);
    expect(fs.existsSync(rec!.path)).toBe(true);
    expect(fs.readFileSync(rec!.path, 'utf-8')).toBe('PDF-CONTENT');

    // Source deletion must NOT take the delivered copy with it.
    fs.rmSync(src);
    expect(fs.existsSync(rec!.path)).toBe(true);
  });

  it('appends each delivery to the manifest and reads them back in order', () => {
    const a = path.join(workdir, 'a.txt');
    const b = path.join(workdir, 'b.log');
    fs.writeFileSync(a, 'aaa');
    fs.writeFileSync(b, 'bbbb');

    deliverArtifact('codex', 'sess-2', a, { kind: 'document' });
    deliverArtifact('codex', 'sess-2', b, { kind: 'document', taskId: 't-9' });

    const records = readDeliveredArtifacts('codex', 'sess-2');
    expect(records.map(r => r.fileName)).toEqual(['a.txt', 'b.log']);
    expect(records[1].taskId).toBe('t-9');
    // Manifests are session-scoped — a different session sees nothing.
    expect(readDeliveredArtifacts('codex', 'other')).toEqual([]);
  });

  it('projects the manifest into image vs file blocks and drops vanished files', () => {
    const img = path.join(workdir, 'shot.png');
    const doc = path.join(workdir, 'data.csv');
    fs.writeFileSync(img, PNG_BYTES);
    fs.writeFileSync(doc, 'a,b,c');

    deliverArtifact('gemini', 'sess-3', img, { kind: 'photo', caption: 'screenshot' });
    const docRec = deliverArtifact('gemini', 'sess-3', doc, { kind: 'document' });

    const blocks = deliveredArtifactBlocks('gemini', 'sess-3');
    expect(blocks).toHaveLength(2);

    const image = blocks.find(b => b.type === 'image')!;
    expect(image.content.startsWith('file://')).toBe(true);
    expect(image.imageCaption).toBe('screenshot');

    const file = blocks.find(b => b.type === 'file')!;
    expect(file.fileName).toBe('data.csv');
    expect(file.fileMime).toBe('text/csv; charset=utf-8');
    expect(file.content.startsWith('file://')).toBe(true);

    // A record whose backing file disappeared is silently dropped.
    fs.rmSync(docRec!.path);
    const after = deliveredArtifactBlocks('gemini', 'sess-3');
    expect(after).toHaveLength(1);
    expect(after[0].type).toBe('image');
  });

  it('maps common extensions to sensible MIME types', () => {
    expect(mimeForArtifact('/x/a.pdf')).toBe('application/pdf');
    expect(mimeForArtifact('/x/a.png')).toBe('image/png');
    expect(mimeForArtifact('/x/a.zip')).toBe('application/zip');
    expect(mimeForArtifact('/x/a.unknownext')).toBe('application/octet-stream');
  });
});
