import {
  PROTOCOL_VERSION,
  diffSnapshot,
  type ClientMessage,
  type HostCapability,
  type SessionMeta,
  type ServerMessage,
  type SnapshotPatch,
  type TransportKind,
  type UniversalSnapshot,
} from './protocol.js';
import { encodeServer, decodeClient } from './codec.js';
import type { ChannelConnection } from './transport.js';

export interface PromptCommand {
  sessionKey?: string;
  prompt: string;
  agent?: string;
  workdir?: string;
  model?: string | null;
  effort?: string | null;
  workflow?: boolean;
  attachments?: string[];
}

export interface CommandResult {
  ok: boolean;
  sessionKey?: string;
  taskId?: string;
  error?: string;
}

export type Authenticator = (token: string | undefined, remote: string | undefined) => boolean;

export interface SessionSource {
  hostInfo(): { name: string; version: string; capabilities: HostCapability[]; authRequired?: boolean };
  listSessions(): SessionMeta[];
  getSnapshot(sessionKey: string): { snapshot: UniversalSnapshot; seq: number } | null;
  onUpdate(cb: (sessionKey: string, snapshot: UniversalSnapshot, seq: number) => void): () => void;
  onSessionsChanged(cb: (sessions: SessionMeta[]) => void): () => void;

  prompt(cmd: PromptCommand): Promise<CommandResult>;
  stop(sessionKey: string): CommandResult;
  steer(taskId: string): Promise<CommandResult>;
  recall(taskId: string): CommandResult;
  interact(promptId: string, action: 'select' | 'text' | 'skip' | 'cancel', value?: string, requestFreeform?: boolean): CommandResult;
  handleRequest?(req: TunnelRequest): Promise<TunnelResponse>;
}

export interface TunnelRequest {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
  encoding?: 'utf8' | 'base64';
}

export interface TunnelResponse {
  status: number;
  headers?: Record<string, string>;
  body?: string;
  encoding?: 'utf8' | 'base64';
}

const SUBSCRIBE_ALL = '*';

interface Peer {
  conn: ChannelConnection;
  subs: Set<string>;
  authed: boolean;
}

export class PikichannelHost {
  private peers = new Set<Peer>();
  private unsubscribers: Array<() => void> = [];
  private started = false;
  private lastFull = new Map<string, UniversalSnapshot>();
  private lastSeq = new Map<string, number>();

  constructor(
    private readonly source: SessionSource,
    private readonly authenticate: Authenticator = () => true,
    private readonly log: (msg: string) => void = () => {},
  ) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    this.unsubscribers.push(
      this.source.onUpdate((sessionKey, snapshot, seq) => this.onSourceUpdate(sessionKey, snapshot, seq)),
    );
    this.unsubscribers.push(
      this.source.onSessionsChanged((sessions) => this.broadcast({ type: 'sessions', sessions }, true)),
    );
  }

  stop(): void {
    for (const u of this.unsubscribers.splice(0)) { try { u(); } catch {  } }
    for (const peer of this.peers) { try { peer.conn.close(); } catch {  } }
    this.peers.clear();
    this.lastFull.clear();
    this.lastSeq.clear();
    this.started = false;
  }

  handleConnection(conn: ChannelConnection): void {
    if (!this.started) this.start();
    const peer: Peer = { conn, subs: new Set(), authed: false };
    this.peers.add(peer);
    this.log(`peer connected id=${conn.id} via=${conn.kind} remote=${conn.remote || '?'}`);

    conn.onMessage((frame) => {
      const msg = decodeClient(frame);
      if (!msg) return;
      this.handleClientMessage(peer, msg).catch((err) => {
        this.send(peer, { type: 'error', message: err?.message || String(err) });
      });
    });
    conn.onClose(() => {
      this.peers.delete(peer);
      this.log(`peer disconnected id=${conn.id} via=${conn.kind}`);
    });
  }

  private onSourceUpdate(sessionKey: string, full: UniversalSnapshot, seq: number): void {
    const prev = this.lastFull.get(sessionKey);
    const patch: SnapshotPatch = prev ? diffSnapshot(prev, full) : { full };
    this.lastFull.set(sessionKey, full);
    this.lastSeq.set(sessionKey, seq);
    const frame: ServerMessage = { type: 'session', sessionKey, seq, patch };
    for (const peer of this.peers) {
      if (peer.authed && (peer.subs.has(SUBSCRIBE_ALL) || peer.subs.has(sessionKey))) this.send(peer, frame);
    }
  }

  private sendFull(peer: Peer, sessionKey: string): void {
    let full = this.lastFull.get(sessionKey);
    let seq = this.lastSeq.get(sessionKey);
    if (!full) {
      const snap = this.source.getSnapshot(sessionKey);
      if (!snap) return;
      full = snap.snapshot; seq = snap.seq;
      this.lastFull.set(sessionKey, full);
      this.lastSeq.set(sessionKey, seq);
    }
    this.send(peer, { type: 'session', sessionKey, seq: seq || 0, patch: { full } });
  }

  private async handleClientMessage(peer: Peer, msg: ClientMessage): Promise<void> {
    if (msg.type === 'ping') { this.send(peer, { type: 'pong', t: msg.t }); return; }

    if (!peer.authed) {
      if (msg.type !== 'hello') { this.send(peer, { type: 'error', message: 'not authenticated', code: 'auth' }); return; }
      if (!this.authenticate(msg.token, peer.conn.remote)) {
        this.log(`peer rejected id=${peer.conn.id} remote=${peer.conn.remote || '?'} (bad/absent token)`);
        this.send(peer, { type: 'error', message: 'unauthorized', code: 'auth' });
        peer.conn.close();
        return;
      }
      peer.authed = true;
      const info = this.source.hostInfo();
      this.send(peer, {
        type: 'welcome',
        v: PROTOCOL_VERSION,
        host: {
          name: info.name,
          version: info.version,
          transport: peer.conn.kind as TransportKind,
          capabilities: info.capabilities,
          authRequired: info.authRequired,
        },
        sessions: this.source.listSessions(),
      });
      if (msg.resume?.sessionKey) { peer.subs.add(msg.resume.sessionKey); this.sendFull(peer, msg.resume.sessionKey); }
      return;
    }

    switch (msg.type) {
      case 'hello':
        return;
      case 'subscribe': {
        peer.subs.add(msg.sessionKey);
        if (msg.sessionKey === SUBSCRIBE_ALL) {
          for (const meta of this.source.listSessions()) this.sendFull(peer, meta.sessionKey);
        } else {
          this.sendFull(peer, msg.sessionKey);
        }
        return;
      }
      case 'unsubscribe':
        peer.subs.delete(msg.sessionKey);
        return;
      case 'getSnapshot':
        this.sendFull(peer, msg.sessionKey);
        return;
      case 'listSessions':
        this.send(peer, { type: 'sessions', sessions: this.source.listSessions() });
        return;
      case 'prompt': {
        const result = await this.source.prompt({
          sessionKey: msg.sessionKey, prompt: msg.prompt, agent: msg.agent, workdir: msg.workdir,
          model: msg.model, effort: msg.effort, workflow: msg.workflow, attachments: msg.attachments,
        });
        if (result.ok && result.sessionKey) {
          peer.subs.add(result.sessionKey);
          this.send(peer, { type: 'accepted', sessionKey: result.sessionKey, taskId: result.taskId || '', clientRef: msg.clientRef });
          this.sendFull(peer, result.sessionKey);
        } else {
          this.send(peer, { type: 'error', message: result.error || 'prompt rejected', clientRef: msg.clientRef });
        }
        return;
      }
      case 'stop': {
        const r = this.source.stop(msg.sessionKey);
        if (!r.ok) this.send(peer, { type: 'error', message: r.error || 'stop failed' });
        return;
      }
      case 'steer': {
        const r = await this.source.steer(msg.taskId);
        if (!r.ok) this.send(peer, { type: 'error', message: r.error || 'steer failed' });
        return;
      }
      case 'recall': {
        const r = this.source.recall(msg.taskId);
        if (!r.ok) this.send(peer, { type: 'error', message: r.error || 'recall failed' });
        return;
      }
      case 'interact': {
        const r = this.source.interact(msg.promptId, msg.action, msg.value, msg.requestFreeform);
        if (!r.ok) this.send(peer, { type: 'error', message: r.error || 'interaction failed' });
        return;
      }
      case 'request': {
        const id = msg.id;
        if (!msg.path || !msg.path.startsWith('/api/')) {
          this.send(peer, { type: 'response', id, status: 403, error: 'only /api/* is tunnelable' });
          return;
        }
        if (!this.source.handleRequest) {
          this.send(peer, { type: 'response', id, status: 501, error: 'tunnel not supported' });
          return;
        }
        try {
          const r = await this.source.handleRequest({ method: msg.method, path: msg.path, headers: msg.headers, body: msg.body, encoding: msg.encoding });
          this.send(peer, { type: 'response', id, status: r.status, headers: r.headers, body: r.body, encoding: r.encoding });
        } catch (err) {
          this.send(peer, { type: 'response', id, status: 500, error: (err as Error)?.message || 'tunnel error' });
        }
        return;
      }
    }
  }

  private broadcast(frame: ServerMessage, authedOnly = false): void {
    for (const peer of this.peers) if (!authedOnly || peer.authed) this.send(peer, frame);
  }

  private send(peer: Peer, frame: ServerMessage): void {
    if (!peer.conn.isOpen()) return;
    try { peer.conn.send(encodeServer(frame)); } catch {  }
  }

  get peerCount(): number { return this.peers.size; }
  get authedPeerCount(): number { let n = 0; for (const p of this.peers) if (p.authed) n++; return n; }
}
