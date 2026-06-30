import type { Agent, StreamPreviewMeta, StreamPreviewPlan, StreamResult } from './bot.js';
import type { MessageBlock } from '../agent/index.js';
import { materializeImage } from '../agent/index.js';
import { fmtUptime, formatThinkingForDisplay, thinkLabel } from './bot.js';
import { formatActivityCommandSummary, parseActivitySummary, renderPlanForPreview, summarizeActivityForPreview } from './streaming.js';
import { supportsChannelCapability, type Channel } from '../channels/base.js';
import { agentLog, agentWarn } from '../agent/index.js';
import { effortLabel } from '../core/config/runtime-config.js';

export type FooterStatus = 'running' | 'done' | 'failed';

export interface ProviderUsageSnapshot {
  ok: boolean;
  capturedAt: string | null;
  status: string | null;
  windows: Array<{
    label: string;
    usedPercent: number | null;
    remainingPercent: number | null;
    resetAfterSeconds: number | null;
    status: string | null;
  }>;
  error: string | null;
}

export interface StreamPreviewRenderInput {
  agent: Agent;
  elapsedMs: number;
  bodyText: string;
  thinking: string;
  activity: string;
  meta?: StreamPreviewMeta | null;
  plan?: StreamPreviewPlan | null;
  model?: string | null;
  effort?: string | null;
}

export function parseGfmTable(tableLines: string[]): { headers: string[]; rows: string[][] } | null {
  if (tableLines.length < 3) return null;
  const parseRow = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
  const isSep = (line: string) => {
    const cells = parseRow(line);
    return cells.length > 0 && cells.every(c => /^:?-{2,}:?$/.test(c));
  };

  let headerIdx = -1;
  for (let i = 0; i < tableLines.length - 1; i++) {
    if (isSep(tableLines[i + 1])) { headerIdx = i; break; }
  }
  if (headerIdx < 0) return null;

  const headers = parseRow(tableLines[headerIdx]);
  const rows: string[][] = [];
  for (let i = headerIdx + 2; i < tableLines.length; i++) {
    if (isSep(tableLines[i])) continue;
    rows.push(parseRow(tableLines[i]));
  }
  return rows.length ? { headers, rows } : null;
}

export function fmtCompactUptime(ms: number): string {
  return fmtUptime(ms).replace(/\s+/g, '');
}

export function footerStatusSymbol(status: FooterStatus): string {
  switch (status) {
    case 'running': return '●';
    case 'done': return '✓';
    case 'failed': return '✗';
  }
}

export interface FooterDecorations {
  model?: string | null;
  effort?: string | null;
  provider?: string | null;
  profileName?: string | null;
}

export interface FooterParts {
  identity: string;
  runtime: string;
}

function compactModelLabel(model: string): string {
  const trimmed = model.trim();
  if (trimmed.length <= 24) return trimmed;
  const slashIdx = trimmed.indexOf('/');
  return slashIdx > 0 ? trimmed.slice(slashIdx + 1) : trimmed;
}

export function formatFooterParts(
  agent: Agent,
  elapsedMs: number,
  meta?: StreamPreviewMeta | null,
  contextPercent?: number | null,
  decorations?: FooterDecorations,
): FooterParts {
  const identityParts: string[] = [agent];
  const modelLabel = decorations?.profileName ?? meta?.profileName ?? decorations?.model ?? null;
  if (modelLabel) identityParts.push(compactModelLabel(modelLabel));

  const runtimeParts: string[] = [];
  if (decorations?.effort) runtimeParts.push(effortLabel(decorations.effort));
  const ctx = contextPercent ?? meta?.contextPercent ?? null;
  if (ctx != null) runtimeParts.push(`${ctx}%`);
  runtimeParts.push(fmtCompactUptime(Math.max(0, Math.round(elapsedMs))));
  const providerName = meta?.providerName ?? decorations?.provider ?? null;
  if (providerName) runtimeParts.push(`via ${providerName}`);

  return {
    identity: identityParts.join(' · '),
    runtime: runtimeParts.join(' · '),
  };
}

export function trimActivityForPreview(text: string, maxChars = 900): string {
  if (text.length <= maxChars) return text;

  const lines = text.split('\n').filter(line => line.trim());
  if (lines.length <= 1) {
    return '...' + text.slice(text.length - Math.max(0, maxChars - 3));
  }

  const ellipsis = '...';
  const budget = Math.max(0, maxChars - ellipsis.length - 1);
  const tail: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const extra = line.length + (tail.length ? 1 : 0);
    if (used + extra > budget) break;
    tail.unshift(line);
    used += extra;
  }
  if (!tail.length) {
    return ellipsis + '\n' + lines[lines.length - 1].slice(-Math.max(0, maxChars - ellipsis.length - 1));
  }
  if (tail.length === lines.length) return tail.join('\n');
  return [ellipsis, ...tail].join('\n');
}

function rawUsageLine(parts: Array<string | null | undefined>): string {
  return parts.filter(part => !!part && String(part).trim()).join(' ');
}

export interface ProviderUsageLine {
  text: string;
  bold?: boolean;
}

export function buildProviderUsageLines(usage: ProviderUsageSnapshot): ProviderUsageLine[] {
  const lines: ProviderUsageLine[] = [
    { text: '', bold: false },
    { text: 'Provider Usage', bold: true },
  ];

  if (!usage.ok) {
    lines.push({ text: `  Unavailable: ${usage.error || 'No recent usage data found.'}` });
    return lines;
  }

  if (usage.capturedAt) {
    const capturedAtMs = Date.parse(usage.capturedAt);
    if (Number.isFinite(capturedAtMs)) {
      lines.push({ text: `  Updated: ${fmtUptime(Math.max(0, Date.now() - capturedAtMs))} ago` });
    }
  }

  if (!usage.windows.length) {
    lines.push({ text: `  ${usage.status ? `status=${usage.status}` : 'No window data'}` });
    return lines;
  }

  for (const window of usage.windows) {
    const details = rawUsageLine([
      window.usedPercent != null ? `${window.usedPercent}% used` : null,
      window.status ? `status=${window.status}` : null,
      window.resetAfterSeconds != null ? `resetAfterSeconds=${window.resetAfterSeconds}` : null,
    ]);
    lines.push({ text: `  ${window.label}: ${details || 'No details'}` });
  }

  return lines;
}

export interface DispatchImageOpts {
  chatId: number | string;
  replyTo?: number | string;
  messageThreadId?: number;
  log?: (message: string) => void;
}

export interface DispatchedImage {
  messageId: number | string | null;
  caption?: string;
}

export async function dispatchImageBlocks(
  channel: Channel,
  blocks: MessageBlock[] | undefined,
  opts: DispatchImageOpts,
): Promise<DispatchedImage[]> {
  if (!blocks?.length) return [];
  if (!supportsChannelCapability(channel, 'sendImage')) return [];

  const out: DispatchedImage[] = [];
  let index = 0;
  for (const block of blocks) {
    if (block.type !== 'image') continue;
    index++;
    const materialized = materializeImage(block);
    if (!materialized) {
      (opts.log || agentLog)(`[image-dispatch] skipped block #${index}: could not materialize bytes`);
      continue;
    }
    try {
      const messageId = await channel.sendImage(opts.chatId, materialized.bytes, {
        mime: materialized.mime,
        caption: materialized.caption,
        replyTo: opts.replyTo,
        messageThreadId: opts.messageThreadId,
      });
      out.push({ messageId, caption: materialized.caption });
    } catch (err: any) {
      (opts.log || agentWarn)(`[image-dispatch] send failed #${index}: ${err?.message || err}`);
    }
  }
  return out;
}

export interface FinalReplyData {
  footerStatus: FooterStatus;
  activityNarrative: string | null;
  activityCommandSummary: string | null;
  thinkingDisplay: string | null;
  thinkLabel: string;
  statusLines: string[] | null;
  bodyMessage: string;
  elapsedMs: number;
}

export function extractFinalReplyData(agent: Agent, result: StreamResult): FinalReplyData {
  const footerStatus: FooterStatus = result.incomplete || !result.ok ? 'failed' : 'done';
  const elapsedMs = result.elapsedS * 1000;

  let activityNarrative: string | null = null;
  let activityCommandSummary: string | null = null;
  if (result.activity) {
    const summary = parseActivitySummary(result.activity);
    const narrative = summary.narrative.join('\n');
    if (narrative) {
      activityNarrative = narrative.length > 1600 ? '...\n' + narrative.slice(-1600) : narrative;
    }
    const cmdSummary = formatActivityCommandSummary(
      summary.completedCommands,
      summary.activeCommands,
      summary.failedCommands,
    );
    if (cmdSummary) activityCommandSummary = cmdSummary;
  }

  let thinkingDisplay: string | null = null;
  if (result.thinking) {
    thinkingDisplay = formatThinkingForDisplay(result.thinking, 1600);
  }

  let statusLines: string[] | null = null;
  if (result.incomplete) {
    statusLines = [];
    if (result.stopReason === 'max_tokens') statusLines.push('Output limit reached. Response may be truncated.');
    if (result.stopReason === 'timeout') {
      statusLines.push(`Timed out after ${fmtUptime(Math.max(0, Math.round(elapsedMs)))} before the agent reported completion.`);
    }
    if (!result.ok) {
      const detail = result.error?.trim();
      if (detail && detail !== result.message.trim() && !statusLines.includes(detail)) statusLines.push(detail);
      else if (result.stopReason !== 'timeout') statusLines.push('Agent exited before reporting completion.');
    }
  }

  return {
    footerStatus,
    activityNarrative,
    activityCommandSummary,
    thinkingDisplay,
    thinkLabel: thinkLabel(agent),
    statusLines,
    bodyMessage: result.message,
    elapsedMs,
  };
}

export interface StreamPreviewData {
  display: string;
  rawThinking: string;
  thinkDisplay: string;
  planDisplay: string;
  activityDisplay: string;
  subAgentsDisplay: string;
  maxActivity: number;
  label: string;
  thinkSnippet: string;
  preview: string;
  thinkingProgressText: string | null;
}

function renderSubAgentsForPreview(meta?: StreamPreviewMeta | null): string {
  const subs = meta?.subAgents;
  if (!subs?.length) return '';
  const lines: string[] = [];
  for (const sub of subs) {
    if (sub.status !== 'running') continue;
    const label = (sub.description || sub.kind || 'sub-agent').trim().slice(0, 80);
    const lastTool = sub.tools.length ? sub.tools[sub.tools.length - 1].summary : 'starting…';
    const modelTag = sub.model ? ` · ${sub.model}` : '';
    lines.push(`↳ ${label}${modelTag}`);
    lines.push(`  · ${lastTool}`);
  }
  return lines.join('\n');
}

export function extractStreamPreviewData(input: StreamPreviewRenderInput): StreamPreviewData {
  const maxBody = 2400;
  const display = input.bodyText.trim();
  const rawThinking = input.thinking.trim();
  const thinkDisplay = formatThinkingForDisplay(input.thinking, maxBody);
  const planDisplay = renderPlanForPreview(input.plan ?? null);
  const activityDisplay = summarizeActivityForPreview(input.activity);
  const subAgentsDisplay = renderSubAgentsForPreview(input.meta);
  const maxActivity = !display && !thinkDisplay && !planDisplay ? 2400 : 1400;
  const label = thinkLabel(input.agent);

  const thinkSnippet = rawThinking ? formatThinkingForDisplay(input.thinking, 600) : '';
  const preview = display.length > maxBody ? '(...truncated)\n' + display.slice(-maxBody) : display;

  const elapsedMs = Math.max(0, input.elapsedMs);
  const thinkingProgressText = elapsedMs >= 1000 ? fmtCompactUptime(elapsedMs) : null;

  return {
    display,
    rawThinking,
    thinkDisplay,
    planDisplay,
    activityDisplay,
    subAgentsDisplay,
    maxActivity,
    label,
    thinkSnippet,
    preview,
    thinkingProgressText,
  };
}
