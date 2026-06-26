import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  deliverArtifact,
  readDeliveredArtifacts,
  deliveredArtifactBlocks,
  tailDeliveredBlocks,
  latestDeliveredTaskId,
  mimeForArtifact,
} from '../src/agent/artifacts.ts';

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
    process.env.HOME = home;
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

    expect(rec!.path).toContain(path.join('.pikiloom', 'attachments', 'claude', 'sess-1', 'delivered'));
    expect(rec!.path).not.toBe(src);
    expect(fs.existsSync(rec!.path)).toBe(true);
    expect(fs.readFileSync(rec!.path, 'utf-8')).toBe('PDF-CONTENT');

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

    fs.rmSync(docRec!.path);
    const after = deliveredArtifactBlocks('gemini', 'sess-3');
    expect(after).toHaveLength(1);
    expect(after[0].type).toBe('image');
  });

  it('scopes blocks to the latest task so prior turns do not bleed onto the current reply', () => {
    const q1 = path.join(workdir, 'qr1.png');
    const q2 = path.join(workdir, 'qr2.png');
    const shot = path.join(workdir, 'final.png');
    for (const f of [q1, q2, shot]) fs.writeFileSync(f, PNG_BYTES);

    // two earlier turns each deliver a QR, a later turn delivers the final screenshot
    deliverArtifact('claude', 'sess-bleed', q1, { kind: 'photo', taskId: 't-1' });
    deliverArtifact('claude', 'sess-bleed', q2, { kind: 'photo', taskId: 't-2' });
    deliverArtifact('claude', 'sess-bleed', shot, { kind: 'photo', taskId: 't-3' });

    expect(latestDeliveredTaskId('claude', 'sess-bleed')).toBe('t-3');

    const latest = latestDeliveredTaskId('claude', 'sess-bleed');
    const scoped = deliveredArtifactBlocks('claude', 'sess-bleed', a => a.taskId === latest);
    expect(scoped).toHaveLength(1);
    expect(scoped[0].imagePath).toContain('final.png');

    // unscoped still returns the whole session (used as the legacy fallback)
    expect(deliveredArtifactBlocks('claude', 'sess-bleed')).toHaveLength(3);
  });

  it('tailDeliveredBlocks surfaces only the last-run turn\'s deliveries', () => {
    const q1 = path.join(workdir, 'qr1.png');
    const shot = path.join(workdir, 'final.png');
    for (const f of [q1, shot]) fs.writeFileSync(f, PNG_BYTES);
    deliverArtifact('claude', 'sess-tail', q1, { kind: 'photo', taskId: 't-1' });
    deliverArtifact('claude', 'sess-tail', shot, { kind: 'photo', taskId: 't-2' });

    // last-run task is t-2 -> only its file, never t-1's.
    const blocks = tailDeliveredBlocks('claude', 'sess-tail', 't-2');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].imagePath).toContain('final.png');
  });

  it('tailDeliveredBlocks suppresses a prior turn\'s image once a newer turn runs (the bleed)', () => {
    const shot = path.join(workdir, 'arch.png');
    fs.writeFileSync(shot, PNG_BYTES);
    // turn t-1 delivered an image; later turns t-2/t-3 ran but delivered nothing.
    deliverArtifact('claude', 'sess-bleed2', shot, { kind: 'photo', taskId: 't-1' });

    // viewing while the last-run task is t-2 (which delivered nothing) -> no bleed.
    expect(tailDeliveredBlocks('claude', 'sess-bleed2', 't-2')).toEqual([]);
    // and t-1 itself still shows its own file when it is the last-run task.
    expect(tailDeliveredBlocks('claude', 'sess-bleed2', 't-1')).toHaveLength(1);
  });

  it('tailDeliveredBlocks shows nothing when the last-run task is unknown (cold start)', () => {
    const shot = path.join(workdir, 'cold.png');
    fs.writeFileSync(shot, PNG_BYTES);
    deliverArtifact('claude', 'sess-cold', shot, { kind: 'photo', taskId: 't-1' });
    // no snapshot / unknown task id -> never guess by time, so no stale bleed.
    expect(tailDeliveredBlocks('claude', 'sess-cold', null)).toEqual([]);
    expect(tailDeliveredBlocks('claude', 'sess-cold', undefined)).toEqual([]);
  });

  it('returns no latest task id for legacy deliveries that predate taskId tagging', () => {
    const a = path.join(workdir, 'legacy.png');
    fs.writeFileSync(a, PNG_BYTES);
    deliverArtifact('claude', 'sess-legacy', a, { kind: 'photo' });
    expect(latestDeliveredTaskId('claude', 'sess-legacy')).toBeUndefined();
  });

  it('maps common extensions to sensible MIME types', () => {
    expect(mimeForArtifact('/x/a.pdf')).toBe('application/pdf');
    expect(mimeForArtifact('/x/a.png')).toBe('image/png');
    expect(mimeForArtifact('/x/a.zip')).toBe('application/zip');
    expect(mimeForArtifact('/x/a.unknownext')).toBe('application/octet-stream');
  });
});
