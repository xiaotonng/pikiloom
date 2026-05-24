/**
 * Stream preview parsing helpers for live message updates.
 *
 * Used by IM channels (Telegram / Feishu / WeChat). The dashboard reads the
 * raw `StreamSnapshot.activity` string directly and renders independently —
 * none of the compaction in this file flows to it. Keep changes that improve
 * IM legibility free to touch this surface; if a change would also alter what
 * the dashboard ultimately shows, do it in the dashboard layer instead.
 */

import type { StreamPreviewMeta, StreamPreviewPlan } from '../agent/index.js';

export interface ActivitySummary {
  narrative: string[];
  failedCommands: number;
  completedCommands: number;
  activeCommands: number;
}

/**
 * Shrink absolute paths that bloat IM cards on small screens. Anything past
 * 48 chars collapses to `…/<last-two-segments>` so directory context is kept
 * while the leading `/Users/…/long/project/root/` noise is dropped. Relative
 * paths and short absolute paths are passed through unchanged.
 */
function compactActivityPath(token: string): string {
  if (token.length <= 48 || !token.includes('/')) return token;
  const segments = token.split('/').filter(Boolean);
  if (segments.length < 2) return token;
  const tail = segments.slice(-2).join('/');
  return `…/${tail}`;
}

function compactPathsInActivityLine(line: string): string {
  // Conservative: only target obviously absolute paths starting with `/` or
  // `~/`. Inline file:line references (`foo/bar.ts:42`) keep their structure
  // since the prefix is short anyway.
  return line.replace(/(^|\s)([~/][^\s]+)/g, (_match, lead: string, raw: string) => {
    const trailingPunct = raw.match(/[)\],.;!?]+$/)?.[0] ?? '';
    const path = trailingPunct ? raw.slice(0, -trailingPunct.length) : raw;
    return `${lead}${compactActivityPath(path)}${trailingPunct}`;
  });
}

const TOOL_DONE_RE = /^(.+?)\s+(done|failed)$/;

const INJECTED_PROMPT_MARKERS = [
  '\n[Session Workspace]',
  '\n[Telegram Artifact Return]',
  '\n[Artifact Return]',
];

export function stripInjectedPrompts(text: string): string {
  for (const marker of INJECTED_PROMPT_MARKERS) {
    const idx = text.indexOf(marker);
    if (idx >= 0) return text.slice(0, idx).trim();
  }
  return text.trim();
}

export function summarizePromptForStatus(prompt: string, maxLen = 50): string {
  const clean = stripInjectedPrompts(prompt).replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  if (clean.length <= maxLen) return clean;
  return clean.slice(0, Math.max(0, maxLen - 3)).trimEnd() + '...';
}

function parseClaudeShellActivity(line: string): {
  key: string;
  status: 'active' | 'done' | 'failed';
} | null {
  const prefix = 'Run shell: ';
  if (!line.startsWith(prefix)) return null;

  const detail = line.slice(prefix.length).trim();
  if (!detail) return { key: prefix.trim(), status: 'active' };

  const doneIdx = detail.indexOf(' -> ');
  if (doneIdx > 0) {
    return {
      key: detail.slice(0, doneIdx).trim(),
      status: 'done',
    };
  }

  const failed = detail.match(/^(.*)\sfailed(?::.*)?$/);
  if (failed?.[1]?.trim()) {
    return {
      key: failed[1].trim(),
      status: 'failed',
    };
  }

  if (detail.endsWith(' done')) {
    const key = detail.slice(0, -' done'.length).trim();
    return { key: key || detail, status: 'done' };
  }

  return { key: detail, status: 'active' };
}

export function parseActivitySummary(activity: string): ActivitySummary {
  const narrative: string[] = [];
  let failedCommands = 0;
  let activeCommands = 0;
  let completedCommands = 0;
  const activeClaudeShells = new Map<string, number>();
  // Track narrative indices keyed by their normalized start text so a later
  // "X done" / "X failed" line collapses the prior "X" entry instead of
  // appending. Avoids the double-line spam in IM cards where each tool call
  // shows both its in-progress and completed line.
  const pendingNarrative = new Map<string, number[]>();

  const pushPending = (key: string, index: number) => {
    const slot = pendingNarrative.get(key);
    if (slot) slot.push(index);
    else pendingNarrative.set(key, [index]);
  };
  const popPending = (key: string): number | null => {
    const slot = pendingNarrative.get(key);
    if (!slot || !slot.length) return null;
    const idx = slot.shift()!;
    if (!slot.length) pendingNarrative.delete(key);
    return idx;
  };

  for (const rawLine of activity.split('\n')) {
    const line = compactPathsInActivityLine(rawLine.replace(/\s+/g, ' ').trim());
    if (!line) continue;
    const claudeShell = parseClaudeShellActivity(line);
    if (claudeShell) {
      const key = claudeShell.key || 'Run shell';
      const current = activeClaudeShells.get(key) || 0;
      if (claudeShell.status === 'active') {
        activeClaudeShells.set(key, current + 1);
      } else {
        if (current > 0) activeClaudeShells.set(key, current - 1);
        if (claudeShell.status === 'done') completedCommands++;
        else failedCommands++;
      }
      continue;
    }
    if (line.startsWith('$ ')) {
      activeCommands++;
      continue;
    }
    if (line.startsWith('Ran: ')) {
      completedCommands++;
      continue;
    }
    const executed = line.match(/^Executed (\d+) command(?:s)?\.$/);
    if (executed) {
      completedCommands = Math.max(completedCommands, parseInt(executed[1], 10) || 0);
      continue;
    }
    const running = line.match(/^Running (\d+) command(?:s)?\.\.\.$/);
    if (running) {
      activeCommands = Math.max(activeCommands, parseInt(running[1], 10) || 0);
      continue;
    }
    const failed = line.match(/^Command failed \((\d+)\):/);
    if (failed) {
      failedCommands++;
      continue;
    }
    if (/^Command failed \(\d+\)$/.test(line)) {
      failedCommands++;
      continue;
    }

    // Pair "X" → "X done"/"X failed": rewrite the prior in-progress entry in
    // place rather than appending a second line. Falls back to a plain append
    // when no matching start exists (e.g. the start line was trimmed off by a
    // history window earlier in the run).
    const doneMatch = line.match(TOOL_DONE_RE);
    if (doneMatch) {
      const baseKey = doneMatch[1].trim();
      const status = doneMatch[2];
      const idx = popPending(baseKey);
      if (idx != null) {
        narrative[idx] = status === 'failed' ? `${baseKey} failed` : baseKey;
        continue;
      }
      narrative.push(status === 'failed' ? `${baseKey} failed` : baseKey);
      continue;
    }

    pushPending(line, narrative.length);
    narrative.push(line);
  }

  for (const pending of activeClaudeShells.values()) {
    activeCommands += pending;
  }

  return { narrative, failedCommands, completedCommands, activeCommands };
}

export function formatActivityCommandSummary(completedCommands: number, activeCommands: number, failedCommands = 0): string {
  const parts: string[] = [];
  if (failedCommands > 0) parts.push(`${failedCommands} failed`);
  if (completedCommands > 0) parts.push(`${completedCommands} done`);
  if (activeCommands > 0) parts.push(`${activeCommands} running`);
  return parts.length ? `commands: ${parts.join(', ')}` : '';
}

export function summarizeActivityForPreview(activity: string): string {
  const summary = parseActivitySummary(activity);
  const lines = [...summary.narrative];

  const commandSummary = formatActivityCommandSummary(
    summary.completedCommands,
    summary.activeCommands,
    summary.failedCommands,
  );
  if (commandSummary) lines.push(commandSummary);

  return lines.join('\n');
}

export function hasPreviewMeta(meta: StreamPreviewMeta | null | undefined): boolean {
  return meta?.contextPercent != null;
}

export function samePreviewMeta(a: StreamPreviewMeta | null, b: StreamPreviewMeta | null): boolean {
  return (a?.contextPercent ?? null) === (b?.contextPercent ?? null);
}

export function samePreviewPlan(a: StreamPreviewPlan | null, b: StreamPreviewPlan | null): boolean {
  if ((a?.explanation ?? null) !== (b?.explanation ?? null)) return false;
  const aSteps = a?.steps ?? [];
  const bSteps = b?.steps ?? [];
  if (aSteps.length !== bSteps.length) return false;
  for (let i = 0; i < aSteps.length; i++) {
    if (aSteps[i].status !== bSteps[i].status) return false;
    if (aSteps[i].step !== bSteps[i].step) return false;
  }
  return true;
}

function normalizePlanStep(step: string): string {
  return step.replace(/\s+/g, ' ').trim();
}

export function renderPlanForPreview(plan: StreamPreviewPlan | null): string {
  if (!plan?.steps.length) return '';
  const total = plan.steps.length;
  const completed = plan.steps.filter(step => step.status === 'completed').length;
  const lines = [`Plan ${completed}/${total}`];
  // Show the most recent / currently-active slice of the plan. Live viewers
  // care about the in-progress + upcoming steps; the dozen already-completed
  // ones at the top of the list are just visual ballast (the `completed/total`
  // header already conveys the overall progress).
  const WINDOW = 4;
  let startIdx = 0;
  if (total > WINDOW) {
    // Center the window on the in-progress step when one exists; otherwise
    // anchor to the tail so the next pending steps are visible.
    const inProgressIdx = plan.steps.findIndex(step => step.status === 'inProgress');
    const anchor = inProgressIdx >= 0 ? inProgressIdx : total - 1;
    startIdx = Math.max(0, Math.min(total - WINDOW, anchor - Math.floor(WINDOW / 2)));
  }
  const dropped = startIdx;
  if (dropped > 0) lines.push(`... +${dropped} earlier`);
  for (const step of plan.steps.slice(startIdx, startIdx + WINDOW)) {
    const prefix = step.status === 'completed' ? '[x]' : step.status === 'inProgress' ? '[>]' : '[ ]';
    lines.push(`${prefix} ${normalizePlanStep(step.step)}`);
  }
  const remaining = total - (startIdx + WINDOW);
  if (remaining > 0) lines.push(`... +${remaining} more`);
  return lines.join('\n');
}
