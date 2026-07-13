// The wire vocabulary shared by the kernel runtime and every transport/terminal.
// This is the SSOT shape: a driver-agnostic, accumulating snapshot of one session,
// plus a small set of control verbs. Ported from pikiloom's pikichannel protocol.

export const PROTOCOL_VERSION = 1 as const;

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
  contextUsedTokens?: number | null;
  contextPercent: number | null;
  turnOutputTokens?: number | null;
  providerName?: string | null;
}

export interface UniversalQueuedTask {
  taskId: string;
  prompt: string;
}

export interface UniversalArtifact {
  url?: string;
  path?: string;
  fileName: string;
  fileSize?: number;
  mime?: string;
  kind: 'photo' | 'document';
  caption?: string;
}

export interface UniversalInteractionQuestion {
  id: string;
  header?: string;
  text: string;
  type?: 'text' | 'select' | string;
  choices?: Array<{ label: string; description?: string; value?: string }>;
  allowFreeform?: boolean;
  allowEmpty?: boolean;
}

export interface UniversalInteraction {
  promptId: string;
  kind: 'user-input' | 'permission' | 'confirmation';
  title: string;
  hint?: string | null;
  questions: UniversalInteractionQuestion[];
  currentIndex?: number;
}

export interface UniversalSnapshot {
  phase: SessionPhase;
  taskId?: string | null;
  sessionId?: string | null;
  agent?: string | null;
  model?: string | null;
  effort?: string | null;
  prompt?: string | null;
  text?: string;
  reasoning?: string;
  activity?: string;
  plan?: UniversalPlan | null;
  toolCalls?: UniversalToolCall[];
  subAgents?: UniversalSubAgent[];
  usage?: UniversalUsage | null;
  /** Set when the CLI compacted the context mid-turn (its `compact_boundary`
   *  event). `trigger` separates an automatic (context-full) compaction from a
   *  manual `/compact`. Drives a live "compacting" affordance; because a runner
   *  owns one turn, it naturally clears on the next turn. */
  compaction?: { trigger: 'auto' | 'manual'; atTokens?: number | null } | null;
  artifacts?: UniversalArtifact[];
  interactions?: UniversalInteraction[];
  queued?: UniversalQueuedTask[];
  error?: string | null;
  incomplete?: boolean;
  startedAt?: number;
  updatedAt: number;
  // Agent-native boundary marker of this settled turn (see DriverResult.anchor) — lets a
  // later fork cut the parent's native transcript exactly after this turn.
  anchor?: string | null;
}

export interface SessionMeta {
  sessionKey: string;
  agent?: string | null;
  title?: string | null;
  phase?: SessionPhase;
  updatedAt?: number;
}

// ---- Session keys ----
// A sessionKey is `${agent}:${sessionId}` — the composite id shared by the runtime, every
// store, and every terminal. These two helpers ARE that contract; nothing else parses it.

export function makeSessionKey(agent: string, sessionId: string): string {
  return `${agent}:${sessionId}`;
}

export function splitSessionKey(sessionKey: string): { agent: string; sessionId: string } {
  const i = sessionKey.indexOf(':');
  return i < 0 ? { agent: '', sessionId: sessionKey } : { agent: sessionKey.slice(0, i), sessionId: sessionKey.slice(i + 1) };
}

export interface SnapshotPatch {
  full?: UniversalSnapshot;
  appendText?: string;
  appendReasoning?: string;
  set?: Partial<UniversalSnapshot>;
}

export function emptySnapshot(): UniversalSnapshot {
  return { phase: 'idle', updatedAt: 0 };
}

const APPEND_FIELDS = ['text', 'reasoning'] as const;
const STRUCT_FIELDS = ['plan', 'toolCalls', 'subAgents', 'usage', 'artifacts', 'interactions', 'queued'] as const;
const SCALAR_FIELDS = ['phase', 'taskId', 'sessionId', 'agent', 'model', 'effort', 'prompt', 'activity', 'error', 'incomplete', 'startedAt', 'updatedAt', 'anchor'] as const;

export function diffSnapshot(prev: UniversalSnapshot, next: UniversalSnapshot): SnapshotPatch {
  const patch: SnapshotPatch = {};
  let set: Record<string, unknown> | undefined;
  // Coerce undefined -> null so a field-clear survives JSON serialization on the wire
  // (JSON.stringify drops undefined-valued keys, which would otherwise leave the
  // receiver's cumulative snapshot holding the previous turn's value).
  const put = (k: string, v: unknown) => { (set ||= {})[k] = v === undefined ? null : v; };

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

export function applySnapshotPatch(prev: UniversalSnapshot | null, patch: SnapshotPatch): UniversalSnapshot {
  if (patch.full) return patch.full;
  const next: UniversalSnapshot = prev ? { ...prev } : emptySnapshot();
  if (patch.appendText) next.text = (next.text || '') + patch.appendText;
  if (patch.appendReasoning) next.reasoning = (next.reasoning || '') + patch.appendReasoning;
  if (patch.set) Object.assign(next, patch.set);
  return next;
}

// ---- Discovery descriptors (opaque; the wire vocabulary for ServerCatalog) ----
// Capabilities derive from the driver registry; the rest come from the app's Catalog port.

export interface AgentInfo {
  id: string;
  capabilities?: { steer?: boolean; interact?: boolean; resume?: boolean; tui?: boolean };
}
export interface ModelDescriptor { id: string; label?: string; providerName?: string | null; contextWindow?: number | null }
export interface EffortOption { id: string; label?: string }
export interface ToolDescriptor { id: string; name: string; description?: string; enabled?: boolean }
export interface SkillDescriptor { id: string; name: string; description?: string }

// ---- Wire messages (client <-> host) ----

export type TransportKind = 'websocket' | 'webrtc' | 'cli' | string;

export type HostCapability =
  | 'prompt' | 'stop' | 'steer' | 'interact' | 'subscribe-all' | 'artifacts' | 'history' | 'catalog' | 'tui';

export interface HostInfo {
  name: string;
  version: string;
  transport: TransportKind;
  capabilities: HostCapability[];
  authRequired?: boolean;
}

export interface ClientHello { type: 'hello'; v: number; client?: { name?: string; platform?: string }; token?: string; }
export interface ClientSubscribe { type: 'subscribe'; sessionKey: string; }
export interface ClientUnsubscribe { type: 'unsubscribe'; sessionKey: string; }
export interface ClientPrompt {
  type: 'prompt';
  sessionKey?: string; prompt: string; agent?: string; workdir?: string;
  model?: string | null; effort?: string | null; attachments?: string[]; clientRef?: string;
}
export interface ClientStop { type: 'stop'; sessionKey: string; }
export interface ClientSteer { type: 'steer'; taskId: string; prompt: string; }
export interface ClientInteract { type: 'interact'; promptId: string; action: 'select' | 'text' | 'skip' | 'cancel'; value?: string; }
export interface ClientGetSnapshot { type: 'getSnapshot'; sessionKey: string; }
export interface ClientListSessions { type: 'listSessions'; }
export interface ClientGetHistory { type: 'getHistory'; sessionKey: string; ref?: string; }
export interface ClientGetCatalog { type: 'getCatalog'; agent?: string; model?: string | null; workdir?: string; ref?: string; }
export interface ClientPing { type: 'ping'; t?: number; }

// ---- Lane R (raw PTY / TUI passthrough) — binary-ish over the same connection ----
// Bytes ride as utf8 strings (node-pty yields strings; JSON escapes control codes).
export interface ClientOpenTui { type: 'openTui'; agent?: string; workdir?: string; model?: string | null; sessionId?: string | null; cols?: number; rows?: number; ref?: string; }
export interface ClientTuiInput { type: 'tuiInput'; tuiId: string; data: string; }     // keystrokes -> PTY
export interface ClientTuiResize { type: 'tuiResize'; tuiId: string; cols: number; rows: number; }
export interface ClientTuiClose { type: 'tuiClose'; tuiId: string; }

export type ClientMessage =
  | ClientHello | ClientSubscribe | ClientUnsubscribe | ClientPrompt | ClientStop
  | ClientSteer | ClientInteract | ClientGetSnapshot | ClientListSessions
  | ClientGetHistory | ClientGetCatalog
  | ClientOpenTui | ClientTuiInput | ClientTuiResize | ClientTuiClose | ClientPing;

export interface ServerWelcome { type: 'welcome'; v: number; host: HostInfo; sessions: SessionMeta[]; }
export interface ServerSession { type: 'session'; sessionKey: string; seq: number; patch: SnapshotPatch; }
export interface ServerSessions { type: 'sessions'; sessions: SessionMeta[]; }
export interface ServerHistory { type: 'history'; sessionKey: string; turns: UniversalSnapshot[]; ref?: string; }
export interface ServerCatalog {
  type: 'catalog'; agents: AgentInfo[]; agent?: string;
  models: ModelDescriptor[]; effort: EffortOption[]; tools: ToolDescriptor[]; skills: SkillDescriptor[]; ref?: string;
}
export interface ServerAccepted { type: 'accepted'; sessionKey: string; taskId: string; clientRef?: string; }
export interface ServerError { type: 'error'; message: string; code?: string; clientRef?: string; }
export interface ServerPong { type: 'pong'; t?: number; }
export interface ServerTuiOpened { type: 'tuiOpened'; tuiId: string; ref?: string; }
export interface ServerTuiData { type: 'tuiData'; tuiId: string; data: string; }       // PTY -> client (raw bytes)
export interface ServerTuiExit { type: 'tuiExit'; tuiId: string; exitCode: number; signal?: number; }

export type ServerMessage =
  | ServerWelcome | ServerSession | ServerSessions | ServerHistory | ServerCatalog
  | ServerTuiOpened | ServerTuiData | ServerTuiExit
  | ServerAccepted | ServerError | ServerPong;

export function isClientMessage(value: unknown): value is ClientMessage {
  return !!value && typeof value === 'object' && typeof (value as any).type === 'string';
}
