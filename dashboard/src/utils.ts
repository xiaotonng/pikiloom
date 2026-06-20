import type { Agent } from './types';
import type { SessionInfo } from './types';

/**
 * Which ProviderKinds each agent driver can route BYOK Profiles through.
 * Mirrors the static `acceptedProviderKinds` declarations on the driver
 * classes in src/agent/drivers/*.ts and the runtime-time check in
 * src/model/injector.ts — those are the authority; this constant lets the
 * dashboard pre-filter the "我的模型" group without an extra API round-trip.
 *
 * Gemini is the strict one: the CLI doesn't accept a custom baseURL, so
 * only `google` (Google AI Studio keys) is a valid BYOK target.
 */
export const AGENT_ACCEPTED_PROVIDER_KINDS: Record<Agent, readonly string[]> = {
  claude: ['anthropic', 'openai-compatible'],
  codex: ['openai', 'openai-compatible'],
  gemini: ['google'],
  hermes: ['anthropic', 'openai', 'openai-compatible', 'google'],
};

export function fmtBytes(b: number): string {
  if (b < 1024) return b + 'B';
  if (b < 1048576) return (b / 1024).toFixed(0) + 'KB';
  if (b < 1073741824) return (b / 1048576).toFixed(1) + 'MB';
  if (b < 1099511627776) return (b / 1073741824).toFixed(1) + 'GB';
  return (b / 1099511627776).toFixed(1) + 'TB';
}

export function fmtUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  return h < 24 ? h + 'h ' + (m % 60) + 'm' : Math.floor(h / 24) + 'd ' + (h % 24) + 'h';
}

export function fmtTime(iso?: string): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export function fmtRelative(iso?: string | null): string {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return '<1m';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h';
  const d = Math.floor(h / 24);
  return d + 'd';
}

export function cn(...classes: (string | false | undefined | null)[]): string {
  return classes.filter(Boolean).join(' ');
}

export interface AgentMeta {
  label: string;
  /** Shortened label for compact UI (sidebar cards, etc.) */
  shortLabel: string;
  color: string;
  bg: string;
  letter: string;
  glow: string;
  border: string;
  advantageKey: string;
}

const defaultMeta: AgentMeta = {
  label: '?',
  shortLabel: '?',
  color: '#94a3b8',
  bg: 'rgba(148,163,184,0.1)',
  letter: '?',
  glow: 'rgba(148,163,184,0.16)',
  border: 'rgba(148,163,184,0.18)',
  advantageKey: '',
};

export const agentMeta: Record<string, AgentMeta> = {
  claude: {
    label: 'Claude Code',
    shortLabel: 'Claude',
    color: '#b4c6ff',
    bg: 'rgba(180,198,255,0.12)',
    letter: 'C',
    glow: 'rgba(180,198,255,0.2)',
    border: 'rgba(180,198,255,0.2)',
    advantageKey: 'config.agentAdvantageClaude',
  },
  codex: {
    label: 'Codex',
    shortLabel: 'Codex',
    color: '#7dd3fc',
    bg: 'rgba(125,211,252,0.12)',
    letter: 'O',
    glow: 'rgba(125,211,252,0.2)',
    border: 'rgba(125,211,252,0.2)',
    advantageKey: 'config.agentAdvantageCodex',
  },
  gemini: {
    label: 'Gemini CLI',
    shortLabel: 'Gemini',
    color: '#c4b5fd',
    bg: 'rgba(196,181,253,0.12)',
    letter: 'G',
    glow: 'rgba(196,181,253,0.2)',
    border: 'rgba(196,181,253,0.2)',
    advantageKey: 'config.agentAdvantageGemini',
  },
  hermes: {
    label: 'Hermes',
    shortLabel: 'Hermes',
    color: '#fbbf24',
    bg: 'rgba(251,191,36,0.12)',
    letter: 'H',
    glow: 'rgba(251,191,36,0.2)',
    border: 'rgba(251,191,36,0.2)',
    advantageKey: 'config.agentAdvantageHermes',
  },
};

export function getAgentMeta(agent: string): AgentMeta {
  return agentMeta[agent] || { ...defaultMeta, label: agent, shortLabel: agent };
}

export const EFFORT_OPTIONS: Record<Agent, string[]> = {
  // "ultra" is the top rung: max reasoning depth + multi-agent Workflow
  // orchestration, the same bundle as Claude's native `ultracode`. It is not a
  // real --effort value — the backend decomposes it into (max, workflow=on) on
  // every write path (decomposeEffortSelection), and picking any concrete rung
  // turns orchestration back off. This is the single knob; there is no separate
  // workflow toggle.
  claude: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  codex: ['low', 'medium', 'high', 'xhigh'],
  gemini: ['low', 'high'],
  // The Hermes driver forwards the chosen value via ACP `session/set_mode`;
  // upstream may or may not act on it depending on the bound model, but we
  // surface the standard knob so users can change it from any picker.
  hermes: ['low', 'medium', 'high', 'xhigh'],
};

/**
 * Effort value to *display* as the current pick. Workflow is orthogonal under
 * the hood, but the UI folds "orchestration on" into the synthetic `ultra`
 * rung (claude only), mirroring the backend's decomposeEffortSelection. Pass
 * the raw stored effort + the agent's workflow flag.
 */
export function foldUltraEffort(
  agentId: string,
  effort: string | null | undefined,
  workflowEnabled: boolean | null | undefined,
): string {
  if (agentId === 'claude' && workflowEnabled) return 'ultra';
  return effort || '';
}

/**
 * Shorten a model ID for compact display.
 *   claude-opus-4-7          → opus-4-7
 *   claude-sonnet-4-6        → sonnet-4-6
 *   claude-haiku-4-5-20251001 → haiku-4-5
 *   gemini-2.5-pro-preview   → 2.5-pro
 *   gpt-4o-mini              → 4o-mini
 *   o3                       → o3
 */
export function shortenModel(model: string): string {
  let s = model;
  // strip trailing date stamps like -20251001
  s = s.replace(/-\d{8,}$/, '');
  // strip trailing -preview / -latest
  s = s.replace(/-(preview|latest|exp)$/, '');
  // strip agent prefixes
  s = s.replace(/^(claude-|gemini-|gpt-)/, '');
  return s;
}

/** Mirror of the backend `isPendingSessionId` (src/agent/utils.ts): a brand-new
 *  session's optimistic stub id before the agent CLI hands back its native id.
 *  The pending→native swap is the SAME logical session, not a navigation. */
export function isPendingSessionId(sessionId: string | null | undefined): boolean {
  return typeof sessionId === 'string' && sessionId.startsWith('pending_');
}

export type SessionDisplayState = 'running' | 'completed' | 'incomplete' | 'waiting';
export function sessionDisplayState(session: Pick<SessionInfo, 'running' | 'runState' | 'awaiting'>): SessionDisplayState {
  if (session.running || session.runState === 'running') return 'running';
  // A turn ended, but the agent parked detached background work it intends to
  // resume — surface "waiting" rather than a terminal "completed". Outranks
  // completed/incomplete; the marker is cleared the next time the session runs.
  if (session.awaiting) return 'waiting';
  return session.runState === 'incomplete' ? 'incomplete' : 'completed';
}

export interface LiveSessionState {
  key: string;
  resolvedKey: string;
  phase: 'queued' | 'streaming' | 'done';
  sessionId: string | null;
  updatedAt: number;
  incomplete: boolean;
  error: string | null;
}

function parseSessionKey(sessionKey: string): { agent: string; sessionId: string } | null {
  const separator = sessionKey.indexOf(':');
  if (separator <= 0) return null;
  const agent = sessionKey.slice(0, separator).trim();
  const sessionId = sessionKey.slice(separator + 1).trim();
  if (!agent || !sessionId) return null;
  return { agent, sessionId };
}

export function normalizeLiveSessionState(sessionKey: string, snapshot: unknown): LiveSessionState | null {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const rawPhase = typeof (snapshot as any).phase === 'string' ? (snapshot as any).phase.trim() : '';
  if (rawPhase !== 'queued' && rawPhase !== 'streaming' && rawPhase !== 'done') return null;

  const parsedKey = parseSessionKey(sessionKey);
  if (!parsedKey) return null;

  const sessionId = typeof (snapshot as any).sessionId === 'string' && (snapshot as any).sessionId.trim()
    ? (snapshot as any).sessionId.trim()
    : null;
  const updatedAt = typeof (snapshot as any).updatedAt === 'number' && Number.isFinite((snapshot as any).updatedAt)
    ? (snapshot as any).updatedAt
    : Date.now();
  const error = typeof (snapshot as any).error === 'string' && (snapshot as any).error.trim()
    ? (snapshot as any).error.trim()
    : null;
  const resolvedKey = sessionId ? `${parsedKey.agent}:${sessionId}` : sessionKey;

  return {
    key: sessionKey,
    resolvedKey,
    phase: rawPhase,
    sessionId,
    updatedAt,
    incomplete: !!(snapshot as any).incomplete || !!error,
    error,
  };
}

// A terminal 'done' snapshot lingers in the live-state map for up to 15 min
// (its TTL) so the sidebar doesn't flash the stale "running" sessionsMap state
// in the brief gap between a stream ending and the sessions API confirming
// completion. The hazard: that retained 'done' must not bury a *new* run.
//
// The sessions API is authoritative for "is a turn active" — it reflects the
// bot's live runningTaskIds. So when the server reports this session running,
// trust it UNLESS the 'done' we hold is newer than the server's last run update
// by more than this margin (a stream genuinely just ended and the API hasn't
// caught up — the flash window). A 'done' that merely coincides with, or
// predates, the server's run update is stale: a follow-up turn started right
// after the previous one finished (back-to-back, so done ≈ run-start), or a WS
// reconnect replayed no fresh 'start'. The margin is small, so a real run that
// outlasted it still flips to 'completed' on end.
const DONE_OVERRIDES_RUNNING_MARGIN_MS = 2_000;

export function applyLiveSessionState(session: SessionInfo, liveState?: LiveSessionState | null): SessionInfo {
  if (!liveState) return session;

  // Don't let a stale 'done' paint a server-confirmed running session gray.
  // (Unknown server timestamp → fall through and apply 'done' as before.)
  if (liveState.phase === 'done' && (session.running || session.runState === 'running')) {
    const serverUpdatedMs = session.runUpdatedAt ? Date.parse(session.runUpdatedAt) : NaN;
    if (Number.isFinite(serverUpdatedMs) && liveState.updatedAt - serverUpdatedMs <= DONE_OVERRIDES_RUNNING_MARGIN_MS) {
      return session;
    }
  }

  const nextRunState: SessionDisplayState = liveState.phase === 'done'
    ? (liveState.incomplete ? 'incomplete' : 'completed')
    : 'running';

  return {
    ...session,
    running: nextRunState === 'running',
    runState: nextRunState,
    runUpdatedAt: new Date(liveState.updatedAt).toISOString(),
    runDetail: nextRunState === 'running'
      ? null
      : (liveState.error || session.runDetail || null),
  };
}

export function sessionDisplayDetail(session: Pick<SessionInfo, 'runDetail'>): string | null {
  const detail = String(session.runDetail || '').trim();
  return detail || null;
}

export function getSessionRunFailureDetail(
  session: Pick<SessionInfo, 'running' | 'runState' | 'runDetail' | 'awaiting'>,
  opts: { streaming: boolean; hasLiveStream: boolean; streamPhase: string | null; queuedTaskCount: number },
): string | null {
  const detail = sessionDisplayDetail(session);
  if (!detail) return null;
  if (sessionDisplayState(session) !== 'incomplete') return null;
  if (opts.streaming || opts.hasLiveStream || opts.streamPhase || opts.queuedTaskCount > 0) return null;
  return detail;
}

const SESSION_PREVIEW_IGNORED_USER_PATTERNS = [
  /^\[Request interrupted by user(?: for tool use)?\]$/i,
];

const SESSION_PREVIEW_IMAGE_PLACEHOLDER_RE = /\[Image:[^\]]+\]/gi;
const SESSION_PREVIEW_FILE_PLACEHOLDER_RE = /\[Attached file:[^\]]+\]/gi;
// Claude TUI prepends `@/abs/path/image.png` mentions to the prompt (see
// src/agent/drivers/claude-tui.ts). The backend's `sanitizeSessionUserPreviewText`
// already strips these from `lastQuestion`; the client-side strip is defensive
// for stale cached snapshots that pre-date the backend fix. Keep in lock-step
// with src/agent/utils.ts:CLAUDE_AT_MENTION_IMAGE_RE.
const CLAUDE_AT_MENTION_IMAGE_RE = /(^|\s)@(\/[^\s@\n]+\.(?:png|jpe?g|gif|webp|svg))(?=\s|$)/gi;

function cleanSessionPreviewText(text?: string | null): string {
  return String(text || '')
    .replace(SESSION_PREVIEW_IMAGE_PLACEHOLDER_RE, ' ')
    .replace(SESSION_PREVIEW_FILE_PLACEHOLDER_RE, ' ')
    .replace(CLAUDE_AT_MENTION_IMAGE_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function firstMeaningfulLine(text?: string | null): string {
  for (const line of String(text || '').split('\n')) {
    const cleaned = cleanSessionPreviewText(line)
      .replace(/^[#>*\-\s`]+/, '')
      .trim();
    if (cleaned) return cleaned;
  }
  return '';
}

export function sanitizeSessionQuestionPreview(text?: string | null): string {
  const cleaned = cleanSessionPreviewText(text);
  if (!cleaned) return '';
  if (SESSION_PREVIEW_IGNORED_USER_PATTERNS.some(pattern => pattern.test(cleaned))) return '';
  return cleaned;
}

/**
 * MUST stay in lock-step with `src/agent/utils.ts:sessionListDisplayTitle`
 * (the canonical backend implementation). Same priority order, same
 * filtering — dashboard and IM channels show identical titles for a session.
 *
 * Order:
 *   1. `title`        — set ONCE from the original prompt; stable.
 *   2. `lastQuestion` — fallback only (Claude's Task tool can overwrite this
 *                       with sub-agent prompts; never use it as the primary).
 *   3. `sessionId`    — last-resort identifier.
 */
export function sessionListDisplayText(session: Pick<SessionInfo, 'lastQuestion' | 'title' | 'sessionId'>): string {
  return cleanSessionPreviewText(session.title) || sanitizeSessionQuestionPreview(session.lastQuestion) || session.sessionId;
}

export function sessionListContextText(
  session: Pick<SessionInfo, 'title' | 'lastAnswer' | 'classification' | 'runDetail' | 'sessionId'>,
  primary: string,
): string {
  const title = cleanSessionPreviewText(session.title);
  if (title && title !== primary) return title;

  const summary = firstMeaningfulLine(session.classification?.summary);
  if (summary && summary !== primary) return summary;

  const answer = firstMeaningfulLine(session.lastAnswer);
  if (answer && answer !== primary) return answer;

  const detail = cleanSessionPreviewText(session.runDetail);
  if (detail && !/interrupted by user/i.test(detail) && detail !== primary) return detail;

  return '';
}
