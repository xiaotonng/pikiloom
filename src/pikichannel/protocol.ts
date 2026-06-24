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
  generatingImages?: number;
}

export interface UniversalQueuedTask {
  taskId: string;
  prompt: string;
}

export interface UniversalArtifact {
  url: string;
  fileName: string;
  fileSize: number;
  mime: string;
  kind: 'photo' | 'document';
  caption?: string;
}

export interface UniversalInteraction {
  promptId: string;
  kind: 'user-input' | 'permission' | 'confirmation';
  title: string;
  hint?: string | null;
  questions: Array<{
    id: string;
    header?: string;
    text: string;
    type?: 'text' | 'select' | string;
    choices?: Array<{ label: string; description?: string; value?: string }>;
    allowFreeform?: boolean;
    allowEmpty?: boolean;
  }>;
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
  artifacts?: UniversalArtifact[];
  interactions?: UniversalInteraction[];
  queued?: UniversalQueuedTask[];
  error?: string | null;
  incomplete?: boolean;
  startedAt?: number;
  updatedAt: number;
}

export interface SessionMeta {
  sessionKey: string;
  agent?: string | null;
  title?: string | null;
  phase?: SessionPhase;
  updatedAt?: number;
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
const SCALAR_FIELDS = ['phase', 'taskId', 'sessionId', 'agent', 'model', 'effort', 'prompt', 'activity', 'error', 'incomplete', 'startedAt', 'updatedAt'] as const;

export function diffSnapshot(prev: UniversalSnapshot, next: UniversalSnapshot): SnapshotPatch {
  const patch: SnapshotPatch = {};
  let set: Record<string, unknown> | undefined;
  // Coerce undefined → null so a field-clear survives JSON serialization on the
  // wire (JSON.stringify drops undefined-valued keys, which would otherwise leave
  // the receiver's cumulative snapshot holding the previous turn's value).
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

export interface HostInfo {
  name: string;
  version: string;
  transport: TransportKind;
  capabilities: HostCapability[];
  authRequired?: boolean;
}

export type TransportKind = 'websocket' | 'webrtc' | string;

export type HostCapability =
  | 'prompt'
  | 'stop'
  | 'steer'
  | 'recall'
  | 'interact'
  | 'subscribe-all'
  | 'artifacts'
  | 'tunnel';

export interface ClientHello {
  type: 'hello';
  v: number;
  client?: { name?: string; platform?: string };
  token?: string;
  resume?: { sessionKey: string; lastSeq?: number };
}

export interface ClientSubscribe {
  type: 'subscribe';
  sessionKey: string;
}

export interface ClientUnsubscribe {
  type: 'unsubscribe';
  sessionKey: string;
}

export interface ClientPrompt {
  type: 'prompt';
  sessionKey?: string;
  prompt: string;
  agent?: string;
  workdir?: string;
  model?: string | null;
  effort?: string | null;
  workflow?: boolean;
  attachments?: string[];
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
  value?: string;
  requestFreeform?: boolean;
}

export interface ClientGetSnapshot {
  type: 'getSnapshot';
  sessionKey: string;
}

export interface ClientListSessions {
  type: 'listSessions';
}

export interface ClientRequest {
  type: 'request';
  id: string;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
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

export interface ServerWelcome {
  type: 'welcome';
  v: number;
  host: HostInfo;
  sessions: SessionMeta[];
}

export interface ServerSession {
  type: 'session';
  sessionKey: string;
  seq: number;
  patch: SnapshotPatch;
}

export interface ServerSessions {
  type: 'sessions';
  sessions: SessionMeta[];
}

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
  clientRef?: string;
}

export interface ServerResponse {
  type: 'response';
  id: string;
  status: number;
  headers?: Record<string, string>;
  body?: string;
  encoding?: 'utf8' | 'base64';
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

export function isClientMessage(value: unknown): value is ClientMessage {
  return !!value && typeof value === 'object' && typeof (value as any).type === 'string';
}
