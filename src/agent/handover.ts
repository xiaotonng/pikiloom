import type { Agent, HandoverRef, TailMessage } from './types.js';
import { getSessionMessages } from './session.js';

const DEFAULT_AGENT_WINDOW_TOKENS: Record<string, number> = {
  claude: 200_000,
  codex: 256_000,
  gemini: 1_000_000,
  hermes: 128_000,
};

function agentWindowTokens(agent: string, model?: string | null): number {
  const m = (model || '').toLowerCase();
  if (agent === 'gemini' && /(^|-)(2\.5|3|3\.1)/.test(m)) return 1_000_000;
  if (agent === 'claude' && /(opus|sonnet|haiku).*?-?(4|4\.\d)/.test(m)) return 200_000;
  return DEFAULT_AGENT_WINDOW_TOKENS[agent] ?? 128_000;
}

const HANDOVER_WINDOW_FRACTION = 0.5;

const CHARS_PER_TOKEN = 4;

export type HandoverMode = 'verbatim' | 'tail' | 'empty';

export interface CompactForHandoverOpts {
  fromAgent: Agent;
  fromSessionId: string;
  workdir: string;
  toAgent: Agent;
  toModel?: string | null;
}

export interface HandoverResult {
  ok: boolean;
  seed: string;
  mode: HandoverMode;
  messagesIncluded: number;
  messagesTotal: number;
  turnsTotal: number;
  charsIncluded: number;
  budgetChars: number;
  error: string | null;
}

export function makeEmptyHandoverResult(error: string | null = null): HandoverResult {
  return { ok: false, seed: '', mode: 'empty', messagesIncluded: 0, messagesTotal: 0, turnsTotal: 0, charsIncluded: 0, budgetChars: 0, error };
}

export function describeHandoverRef(ref: HandoverRef | null | undefined): string {
  if (!ref) return '(none)';
  return `${ref.agent}:${ref.sessionId}`;
}

export async function compactForHandover(opts: CompactForHandoverOpts): Promise<HandoverResult> {
  const windowTokens = agentWindowTokens(opts.toAgent, opts.toModel);
  const budgetChars = Math.floor(windowTokens * HANDOVER_WINDOW_FRACTION * CHARS_PER_TOKEN);

  let messages: TailMessage[] = [];
  let turnsTotal = 0;
  try {
    const result = await getSessionMessages({
      agent: opts.fromAgent,
      sessionId: opts.fromSessionId,
      workdir: opts.workdir,
    });
    if (!result.ok) {
      return { ...makeEmptyHandoverResult(result.error || 'read failed'), budgetChars };
    }
    messages = result.messages || [];
    turnsTotal = result.totalTurns ?? Math.ceil(messages.length / 2);
  } catch (e: any) {
    return { ...makeEmptyHandoverResult(e?.message || String(e)), budgetChars };
  }

  if (!messages.length) {
    return { ...makeEmptyHandoverResult('no messages'), budgetChars };
  }

  const messagesTotal = messages.length;
  const envelopeOpen = `<handover from="${opts.fromAgent}" to="${opts.toAgent}" turns="${turnsTotal}">`;
  const envelopeClose = `</handover>`;
  const trailerText = `\n[Continuing this conversation. The previous turns above ran under ${opts.fromAgent}; you are now ${opts.toAgent} picking up where it left off. Your next user message follows.]`;
  const overhead = envelopeOpen.length + envelopeClose.length + trailerText.length + 8 ;
  const messageBudget = Math.max(0, budgetChars - overhead);

  const lines: string[] = [];
  let used = 0;
  let kept = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const label = msg.role === 'user' ? 'User' : 'Assistant';
    const line = `${label}: ${msg.text}`;
    if (used + line.length + 1 > messageBudget) break;
    lines.push(line);
    used += line.length + 1;
    kept += 1;
  }
  lines.reverse();

  if (!lines.length) {
    return { ...makeEmptyHandoverResult('budget too small'), budgetChars };
  }

  const seed = [envelopeOpen, ...lines, envelopeClose, trailerText].join('\n');
  const mode: HandoverMode = kept >= messages.length ? 'verbatim' : 'tail';

  return {
    ok: true,
    seed,
    mode,
    messagesIncluded: kept,
    messagesTotal,
    turnsTotal,
    charsIncluded: used,
    budgetChars,
    error: null,
  };
}
