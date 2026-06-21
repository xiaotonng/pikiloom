/**
 * pikichannel/protocol.ts — THE universal, agent-agnostic wire protocol (L2).
 *
 * This file is the single source of truth for the pikichannel contract. It is
 * deliberately free of any pikiloom-internal or agent-specific type: a client
 * SDK on any platform (Web / iOS / Android) only needs these shapes to speak to
 * any pikichannel host. The browser SDK in `web/pikichannel-sdk.js` mirrors the
 * string literals and shapes documented here — keep the two in lockstep.
 *
 * Layering:
 *   transport (L1)  — moves opaque frames (a byte/string pipe): WebSocket, WebRTC
 *                     datachannel, relay tunnel. Pluggable; see transport.ts.
 *   protocol (L2)   — THIS file. The session/event semantics framed over L1.
 *
 * Design rules:
 *   - Every message is a flat discriminated union on `type`. No nested envelopes
 *     so clients can `switch (msg.type)` directly.
 *   - The host→client `session` event carries a {@link SnapshotPatch}: a `full`
 *     snapshot on first send / resync, then deltas (append-only suffixes for the
 *     unbounded text/reasoning fields + changed scalar/struct fields). The host
 *     remains the single source of truth — it holds the full snapshot and emits
 *     `full` on (re)subscribe or whenever a client reports a `seq` gap, so the
 *     wire is O(n) for a stream of total size n instead of O(n²).
 *   - `seq` is monotonic per session for ordering / gap detection.
 *   - Auth: a client authenticates in `hello` (token); loopback peers are exempt
 *     by host policy. No session data or control is processed before auth.
 *   - Versioned via PROTOCOL_VERSION; the handshake negotiates it.
 *
 * Extensibility (how this grows without forking the wire):
 *   - ADDITIVE by default: new optional fields on existing messages and brand-new
 *     `type`s are backward-compatible. Both host and client MUST ignore unknown
 *     message `type`s and unknown fields (the switch statements fall through, not
 *     throw) — so an old peer talks to a new peer safely.
 *   - Optional features are negotiated via `HostCapability` (advertised in
 *     `welcome`), not by version bumps — a client checks `host.capabilities`
 *     before using a non-core verb.
 *   - PROTOCOL_VERSION bumps only for a BREAKING change; `hello.v` lets either
 *     side detect a mismatch and degrade.
 *   - The transport (L1) is fully decoupled: a new binding (relay, WebTransport,
 *     QUIC) implements ChannelConnection and carries this protocol unchanged.
 */

export const PROTOCOL_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// Universal snapshot — the normalized projection of one agent turn.
// ---------------------------------------------------------------------------

export type SessionPhase = 'idle' | 'queued' | 'streaming' | 'done';

export interface UniversalPlanStep {
  text: string;
  status: 'pending' | 'inProgress' | 'completed';
}

export interface UniversalPlan {
  explanation: string | null;
  steps: UniversalPlanStep[];
}

export interface UniversalToolCall {
  id: string;
  name: string;
  summary: string;
  input?: string | null;
  result?: string | null;
  status: 'running' | 'done' | 'failed';
}

export interface UniversalSubAgent {
  id: string;
  kind: string | null;
  description: string | null;
  model: string | null;
  tools: Array<{ id: string; name: string; summary: string }>;
  status: 'running' | 'done' | 'failed';
}

export interface UniversalUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  /** Single-call context-window occupancy (for "% used" displays). */
  contextUsedTokens?: number | null;
  contextPercent: number | null;
  turnOutputTokens?: number | null;
  providerName?: string | null;
  /** Image-generation calls currently in flight. */
  generatingImages?: number;
}

/** A prompt waiting behind the running turn (queued follow-up). */
export interface UniversalQueuedTask {
  taskId: string;
  prompt: string;
}

/** A file the agent handed to the user during the turn. `url` is fetchable over
 *  the same origin that serves the SDK (host attachment endpoint). */
export interface UniversalArtifact {
  url: string;
  fileName: string;
  fileSize: number;
  mime: string;
  kind: 'photo' | 'document';
  caption?: string;
}

/** A serialisable human-in-the-loop prompt awaiting the user. */
export interface UniversalInteraction {
  promptId: string;
  kind: 'user-input' | 'permission' | 'confirmation';
  title: string;
  hint?: string | null;
  /** Each question: free text or a pick-list. Shape mirrors the host's
   *  AgentInteraction.questions but is re-declared here to stay agent-agnostic. */
  questions: Array<{
    id: string;
    text: string;
    type?: 'text' | 'select' | string;
    choices?: Array<{ label: string; description?: string }>;
  }>;
  currentIndex?: number;
}

/**
 * The complete state of one agent session at a point in time. Cumulative: a
 * client renders purely from the latest snapshot it has reconstructed. The
 * session key is carried by the envelope ({@link ServerSession.sessionKey}), not
 * duplicated here.
 */
export interface UniversalSnapshot {
  phase: SessionPhase;
  taskId?: string | null;
  agent?: string | null;
  model?: string | null;
  effort?: string | null;
  /** The user's prompt for the active/last turn (so a watching client can render
   *  a turn it did not originate). */
  prompt?: string | null;
  /** Assistant output text (markdown). */
  text?: string;
  /** Extended-thinking / reasoning text. */
  reasoning?: string;
  /** Tool-activity narrative (newline-joined). */
  activity?: string;
  plan?: UniversalPlan | null;
  toolCalls?: UniversalToolCall[];
  subAgents?: UniversalSubAgent[];
  usage?: UniversalUsage | null;
  artifacts?: UniversalArtifact[];
  interactions?: UniversalInteraction[];
  /** Prompts queued behind the running turn (follow-ups), in enqueue order. */
  queued?: UniversalQueuedTask[];
  error?: string | null;
  incomplete?: boolean;
  startedAt?: number;
  updatedAt: number;
}

/** Lightweight session descriptor for list / picker UIs. */
export interface SessionMeta {
  sessionKey: string;
  agent?: string | null;
  title?: string | null;
  phase?: SessionPhase;
  updatedAt?: number;
}

// ---------------------------------------------------------------------------
// Snapshot patch — the delta wire format that keeps a stream O(n), not O(n²).
// ---------------------------------------------------------------------------

/**
 * One on-the-wire update for a session. Either a `full` snapshot (first send /
 * resync) or a delta: append-only suffixes for the unbounded text/reasoning
 * fields plus a `set` of changed scalar/struct fields. `diffSnapshot` produces
 * it; `applySnapshotPatch` consumes it. These two are the single source of truth
 * for the wire shape — the vanilla browser SDK mirrors them; keep in lockstep.
 */
export interface SnapshotPatch {
  /** Complete snapshot — replaces any prior state. Set on first send / resync. */
  full?: UniversalSnapshot;
  /** Suffix appended to `text` (append-only fast path). */
  appendText?: string;
  /** Suffix appended to `reasoning` (append-only fast path). */
  appendReasoning?: string;
  /** Changed scalar / structured fields (bounded; sent whole on change). */
  set?: Partial<UniversalSnapshot>;
}

/** An empty baseline snapshot, used as the starting point before any patch. */
export function emptySnapshot(): UniversalSnapshot {
  return { phase: 'idle', updatedAt: 0 };
}

const APPEND_FIELDS = ['text', 'reasoning'] as const;
const STRUCT_FIELDS = ['plan', 'toolCalls', 'subAgents', 'usage', 'artifacts', 'interactions', 'queued'] as const;
const SCALAR_FIELDS = ['phase', 'taskId', 'agent', 'model', 'effort', 'prompt', 'activity', 'error', 'incomplete', 'startedAt', 'updatedAt'] as const;

/**
 * Diff two full snapshots into a minimal patch. text/reasoning are encoded as
 * append suffixes when the next value extends the prev (the streaming common
 * case); any non-extension falls back to a `set`. Bounded fields are compared by
 * value and sent whole when changed.
 */
export function diffSnapshot(prev: UniversalSnapshot, next: UniversalSnapshot): SnapshotPatch {
  const patch: SnapshotPatch = {};
  let set: Record<string, unknown> | undefined;
  const put = (k: string, v: unknown) => { (set ||= {})[k] = v; };

  for (const f of APPEND_FIELDS) {
    const a = (prev as any)[f] ?? '';
    const b = (next as any)[f] ?? '';
    if (a === b) continue;
    if (typeof b === 'string' && typeof a === 'string' && b.startsWith(a)) {
      if (f === 'text') patch.appendText = b.slice(a.length);
      else patch.appendReasoning = b.slice(a.length);
    } else {
      put(f, b);
    }
  }
  for (const f of SCALAR_FIELDS) {
    if ((prev as any)[f] !== (next as any)[f]) put(f, (next as any)[f]);
  }
  for (const f of STRUCT_FIELDS) {
    if (JSON.stringify((prev as any)[f]) !== JSON.stringify((next as any)[f])) put(f, (next as any)[f]);
  }
  if (set) patch.set = set as Partial<UniversalSnapshot>;
  return patch;
}

/** Apply a patch onto a prior snapshot, returning the new cumulative snapshot. */
export function applySnapshotPatch(prev: UniversalSnapshot | null, patch: SnapshotPatch): UniversalSnapshot {
  if (patch.full) return patch.full;
  const next: UniversalSnapshot = prev ? { ...prev } : emptySnapshot();
  if (patch.appendText) next.text = (next.text || '') + patch.appendText;
  if (patch.appendReasoning) next.reasoning = (next.reasoning || '') + patch.appendReasoning;
  if (patch.set) Object.assign(next, patch.set);
  return next;
}

// ---------------------------------------------------------------------------
// Host capabilities — advertised in the welcome so clients can adapt.
// ---------------------------------------------------------------------------

export interface HostInfo {
  name: string;
  version: string;
  /** The transport binding this connection arrived on — purely informational,
   *  lets a demo client show "you are connected over webrtc". */
  transport: TransportKind;
  capabilities: HostCapability[];
  /** Whether remote (non-loopback) clients must present a token in `hello`. */
  authRequired?: boolean;
}

export type TransportKind = 'websocket' | 'webrtc' | string;

export type HostCapability =
  | 'prompt'        // accept new prompts / follow-ups
  | 'stop'          // stop a running turn
  | 'steer'         // steer a queued turn
  | 'recall'        // recall a queued turn
  | 'interact'      // answer human-in-the-loop prompts
  | 'subscribe-all' // subscribe to every session with '*'
  | 'artifacts'     // serves artifact files
  | 'tunnel';       // forwards control-plane HTTP requests (the `request` verb)

// ---------------------------------------------------------------------------
// Client → Host messages
// ---------------------------------------------------------------------------

export interface ClientHello {
  type: 'hello';
  v: number;
  client?: { name?: string; platform?: string };
  /** Pairing/access token. Required for remote peers; loopback is exempt by
   *  host policy. Validated before any session data or control is processed. */
  token?: string;
  /** Optional resume hint: the session the client was watching + last seq seen.
   *  The host replies with a `full` patch regardless (it is the source of truth). */
  resume?: { sessionKey: string; lastSeq?: number };
}

export interface ClientSubscribe {
  type: 'subscribe';
  /** A specific `${agent}:${sessionId}` key, or '*' for every session. */
  sessionKey: string;
}

export interface ClientUnsubscribe {
  type: 'unsubscribe';
  sessionKey: string;
}

export interface ClientPrompt {
  type: 'prompt';
  /** Omit to start a brand-new session; the host replies with the created key. */
  sessionKey?: string;
  prompt: string;
  agent?: string;
  workdir?: string;
  model?: string | null;
  effort?: string | null;
  workflow?: boolean;
  /** Absolute paths already staged by the host, or omitted. */
  attachments?: string[];
  /** Echoed back on the resulting `accepted` ack so the client can correlate. */
  clientRef?: string;
}

export interface ClientStop {
  type: 'stop';
  sessionKey: string;
}

export interface ClientSteer {
  type: 'steer';
  taskId: string;
}

export interface ClientRecall {
  type: 'recall';
  taskId: string;
}

export interface ClientInteract {
  type: 'interact';
  promptId: string;
  action: 'select' | 'text' | 'skip' | 'cancel';
  /** For 'select': the option value/label. For 'text': the freeform answer. */
  value?: string;
  /** For 'select' that should then ask for freeform input. */
  requestFreeform?: boolean;
}

export interface ClientGetSnapshot {
  type: 'getSnapshot';
  sessionKey: string;
}

export interface ClientListSessions {
  type: 'listSessions';
}

/**
 * Control-plane HTTP tunnel (the `tunnel` capability): forward a request to the
 * host's management API over the authenticated channel, so a remote client gets
 * full control WITHOUT the host exposing its REST publicly (no CORS, no second
 * auth). The host restricts this to `/api/*` and only for authenticated peers.
 * One generic verb keeps the protocol minimal — management logic stays in the
 * host's existing router (single source of truth), not duplicated as bespoke
 * protocol messages.
 */
export interface ClientRequest {
  type: 'request';
  /** Correlation id echoed on the matching {@link ServerResponse}. */
  id: string;
  method: string;
  /** Must start with `/api/`; other paths are rejected by the host. */
  path: string;
  headers?: Record<string, string>;
  body?: string;
  /** Encoding of `body` — 'utf8' (default) or 'base64' for binary. */
  encoding?: 'utf8' | 'base64';
}

export interface ClientPing {
  type: 'ping';
  t?: number;
}

export type ClientMessage =
  | ClientHello
  | ClientSubscribe
  | ClientUnsubscribe
  | ClientPrompt
  | ClientStop
  | ClientSteer
  | ClientRecall
  | ClientInteract
  | ClientGetSnapshot
  | ClientListSessions
  | ClientRequest
  | ClientPing;

// ---------------------------------------------------------------------------
// Host → Client messages
// ---------------------------------------------------------------------------

export interface ServerWelcome {
  type: 'welcome';
  v: number;
  host: HostInfo;
  sessions: SessionMeta[];
}

export interface ServerSession {
  type: 'session';
  sessionKey: string;
  /** Monotonic per-session sequence for ordering / gap detection. */
  seq: number;
  /** Full snapshot (first send / resync) or a delta. See {@link SnapshotPatch}. */
  patch: SnapshotPatch;
}

export interface ServerSessions {
  type: 'sessions';
  sessions: SessionMeta[];
}

/** Acknowledges a prompt was accepted and queued. */
export interface ServerAccepted {
  type: 'accepted';
  sessionKey: string;
  taskId: string;
  clientRef?: string;
}

export interface ServerError {
  type: 'error';
  message: string;
  code?: string;
  /** Correlates to a client message ref when the error is command-specific. */
  clientRef?: string;
}

/** Reply to a {@link ClientRequest} — the tunneled HTTP response. */
export interface ServerResponse {
  type: 'response';
  id: string;
  status: number;
  headers?: Record<string, string>;
  body?: string;
  encoding?: 'utf8' | 'base64';
  /** Transport-level failure (path rejected, forwarder threw) — distinct from an HTTP status. */
  error?: string;
}

export interface ServerPong {
  type: 'pong';
  t?: number;
}

export type ServerMessage =
  | ServerWelcome
  | ServerSession
  | ServerSessions
  | ServerAccepted
  | ServerResponse
  | ServerError
  | ServerPong;

// ---------------------------------------------------------------------------
// Type guards (host-side convenience)
// ---------------------------------------------------------------------------

export function isClientMessage(value: unknown): value is ClientMessage {
  return !!value && typeof value === 'object' && typeof (value as any).type === 'string';
}
