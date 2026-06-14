/**
 * tools/await-resume.ts — "waiting for background work" marker MCP tool.
 *
 *   await_background — Lets the model declare that this turn is ending while
 *                      detached/background work it launched keeps running, and
 *                      it intends to report back later. Purely a UI hint: it
 *                      changes nothing about execution, it only lets the
 *                      dashboard show a "waiting" state instead of "completed"
 *                      for the interval until the session next runs.
 *
 * State lives at <sessionRoot>/awaiting.json; this server resolves the session
 * root from MCP_WORKSPACE_PATH (which points to <sessionRoot>/workspace). The
 * parent reads & clears it (see agent/await-resume.ts) — clearing happens
 * automatically the next time the session runs.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { McpToolModule, ToolContext, ToolResult } from './types.js';
import { toolResult, toolLog } from './types.js';

const AWAIT_FILE = 'awaiting.json';
const MAX_REASON_CHARS = 280;

const tools: McpToolModule['tools'] = [
  {
    name: 'await_background',
    description: [
      'Mark this session as waiting on detached background work.',
      'Call this ONLY when you are ending your turn while work you launched keeps running detached from this turn (a daemon, a build/install that must survive a restart, a long external job) and you intend to report back on it in a later turn.',
      'This is a passive status hint for the dashboard — it does NOT change how you run, does NOT keep the turn open, and does NOT wake you when the work finishes. Do not call it for ordinary tool calls or foreground work, and do not call it just because a task is large.',
      'The marker is cleared automatically the next time this session runs, so you never need to clear it yourself.',
    ].join('\n'),
    inputSchema: {
      type: 'object' as const,
      properties: {
        reason: {
          type: 'string',
          description:
            'Short, human-readable note on what is still running and what you will report back (e.g. "rebuilding + restarting pikiloom, will confirm after it comes back up").',
        },
      },
      required: ['reason'],
    },
  },
];

function sessionRootFromCtx(ctx: ToolContext): string {
  const workspace = path.resolve(ctx.workspace || '');
  if (!workspace) return '';
  return path.basename(workspace) === 'workspace' ? path.dirname(workspace) : workspace;
}

function handleAwaitBackground(args: Record<string, unknown>, ctx: ToolContext): ToolResult {
  const reason = typeof args?.reason === 'string' ? args.reason.trim().slice(0, MAX_REASON_CHARS) : '';
  toolLog('await_background', `reason=${reason.slice(0, 80) || '(empty)'}`);
  if (!reason) {
    return toolResult('Error: `reason` must be a non-empty description of the background work being awaited.', true);
  }
  const root = sessionRootFromCtx(ctx);
  if (!root) return toolResult('Error: MCP workspace path is not configured', true);
  const file = path.join(root, AWAIT_FILE);
  try {
    fs.mkdirSync(root, { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}`;
    fs.writeFileSync(tmp, JSON.stringify({ reason, since: new Date().toISOString() }, null, 2));
    fs.renameSync(tmp, file);
  } catch (err: any) {
    return toolResult(`Error: failed to write awaiting marker: ${err?.message || err}`, true);
  }
  return toolResult(
    'Marked this session as waiting on background work. The dashboard will show a "waiting" state until the session next runs (which clears the marker). Reminder: this does not wake you — you must resume the turn yourself or be re-prompted.',
  );
}

export const awaitResumeTools: McpToolModule = {
  tools,
  handle(name, args, ctx) {
    switch (name) {
      case 'await_background': return handleAwaitBackground(args, ctx);
      default: return toolResult(`Unknown await tool: ${name}`, true);
    }
  },
};
