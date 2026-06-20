/**
 * artifacts.ts — delivered-artifact manifest (the single source of truth for
 * "files the agent handed to the user during a session").
 *
 * When the agent calls `im_send_file`, the bot materializes the file into the
 * session attachments dir and appends a record here. IM channels additionally
 * push the bytes to their chat; the dashboard serves the materialized copy over
 * HTTP and renders it. Recording is terminal-agnostic, so a session watched
 * from BOTH a chat and the dashboard shows the same deliveries on either side,
 * and they survive a page reload / workspace cleanup.
 *
 * The manifest lives next to the MCP-buffered image attachments
 * (`sessionAttachmentsDir`), which is already an allowlist root for the
 * dashboard attachment endpoint — so materialized artifacts are servable with
 * no new trust boundary.
 */

import fs from 'node:fs';
import path from 'node:path';
import { sessionAttachmentsDir } from './images.js';
import { agentWarn } from './utils.js';
import type { Agent, MessageBlock } from './types.js';

export type ArtifactKind = 'photo' | 'document';

export interface DeliveredArtifact {
  /** Epoch ms when delivered. */
  ts: number;
  /** Originating task id, when known. */
  taskId?: string;
  /** Absolute on-disk path of the materialized copy (stable + servable). */
  path: string;
  /** Pristine display name (the artifact's original basename). */
  fileName: string;
  /** MIME type. */
  fileMime: string;
  /** Size in bytes. */
  fileSize: number;
  /** `photo` → rendered inline; `document` → download chip. */
  kind: ArtifactKind;
  /** Optional caption supplied at delivery time. */
  caption?: string;
}

const PHOTO_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg']);

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8', '.json': 'application/json', '.xml': 'application/xml',
  '.html': 'text/html; charset=utf-8', '.zip': 'application/zip', '.gz': 'application/gzip',
  '.tar': 'application/x-tar', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.log': 'text/plain; charset=utf-8',
};

/** Best-effort MIME for a delivered artifact; `application/octet-stream` when unknown. */
export function mimeForArtifact(filePath: string): string {
  return MIME_BY_EXT[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function manifestPath(agent: Agent, sessionId: string): string {
  return path.join(sessionAttachmentsDir(agent, sessionId), 'delivered.jsonl');
}

function deliveredDir(agent: Agent, sessionId: string): string {
  return path.join(sessionAttachmentsDir(agent, sessionId), 'delivered');
}

function sanitizeName(name: string): string {
  return (name || 'file').replace(/[/\\\0]+/g, '_').replace(/^\.+/, '').slice(0, 200) || 'file';
}

/**
 * Materialize `srcPath` into the session's delivered-artifacts dir so it is
 * (a) servable by the dashboard attachment endpoint (the dir is an allowlist
 * root) and (b) durable across workspace cleanup. Hardlinks when possible,
 * falling back to a copy across filesystems. The on-disk name is stamped to
 * avoid collisions; the pristine basename travels in the manifest.
 */
export function stageDeliveredArtifact(
  agent: Agent,
  sessionId: string,
  srcPath: string,
): { path: string; fileName: string; fileSize: number; fileMime: string } {
  const fileName = sanitizeName(path.basename(srcPath));
  const stat = fs.statSync(srcPath);
  const dir = deliveredDir(agent, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const dest = path.join(dir, `${stamp}-${fileName}`);
  try {
    fs.linkSync(srcPath, dest);
  } catch {
    fs.copyFileSync(srcPath, dest);
  }
  return { path: dest, fileName, fileSize: stat.size, fileMime: mimeForArtifact(fileName) };
}

/** Append a record to the session's delivered-artifact manifest. */
export function recordDeliveredArtifact(agent: Agent, sessionId: string, entry: DeliveredArtifact): void {
  try {
    const file = manifestPath(agent, sessionId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(entry) + '\n');
  } catch (e: any) {
    agentWarn(`[artifacts] record failed: ${e?.message || e}`);
  }
}

/**
 * Materialize + record a delivered artifact in one step. Best-effort: returns
 * the stored record (with the materialized path), or null on failure — delivery
 * must never crash the stream.
 */
export function deliverArtifact(
  agent: Agent,
  sessionId: string,
  srcPath: string,
  opts: { kind: ArtifactKind; caption?: string; taskId?: string },
): DeliveredArtifact | null {
  try {
    const staged = stageDeliveredArtifact(agent, sessionId, srcPath);
    const record: DeliveredArtifact = {
      ts: Date.now(),
      ...(opts.taskId ? { taskId: opts.taskId } : {}),
      path: staged.path,
      fileName: staged.fileName,
      fileMime: staged.fileMime,
      fileSize: staged.fileSize,
      kind: opts.kind,
      ...(opts.caption ? { caption: opts.caption } : {}),
    };
    recordDeliveredArtifact(agent, sessionId, record);
    return record;
  } catch (e: any) {
    agentWarn(`[artifacts] deliver failed for ${srcPath}: ${e?.message || e}`);
    return null;
  }
}

/** Read the delivered-artifact manifest for a session (tolerant of partial lines). */
export function readDeliveredArtifacts(agent: Agent, sessionId: string): DeliveredArtifact[] {
  const file = manifestPath(agent, sessionId);
  let raw: string;
  try { raw = fs.readFileSync(file, 'utf-8'); } catch { return []; }
  const out: DeliveredArtifact[] = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const rec = JSON.parse(t) as DeliveredArtifact;
      if (rec && typeof rec.path === 'string' && rec.fileName) out.push(rec);
    } catch { /* skip malformed line */ }
  }
  return out;
}

/**
 * Project the delivered-artifact manifest into pre-transport MessageBlocks
 * (content = `file://<abs>`). The dashboard read path rewrites these to
 * attachment HTTP URLs via `rewriteAttachmentBlocksForTransport`. Records whose
 * file no longer exists on disk are dropped.
 */
export function deliveredArtifactBlocks(agent: Agent, sessionId: string): MessageBlock[] {
  const blocks: MessageBlock[] = [];
  for (const a of readDeliveredArtifacts(agent, sessionId)) {
    if (!fs.existsSync(a.path)) continue;
    if (a.kind === 'photo' && PHOTO_EXTS.has(path.extname(a.fileName).toLowerCase())) {
      blocks.push({
        type: 'image',
        content: `file://${a.path}`,
        imagePath: a.path,
        imageMime: a.fileMime,
        ...(a.caption ? { imageCaption: a.caption } : {}),
      });
    } else {
      blocks.push({
        type: 'file',
        content: `file://${a.path}`,
        filePath: a.path,
        fileMime: a.fileMime,
        fileName: a.fileName,
        fileSize: a.fileSize,
        ...(a.caption ? { fileCaption: a.caption } : {}),
      });
    }
  }
  return blocks;
}
