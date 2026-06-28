import type http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import {
  PROTOCOL_VERSION, type ClientMessage, type ServerMessage, type SnapshotPatch,
  type HostInfo, isClientMessage,
} from '../protocol/index.js';
import type { LoomIO, Surface, SurfaceCapabilities, TuiHost, PtyHandle } from '../contracts/surface.js';
import { randomUUID } from 'node:crypto';

interface Peer { ws: WebSocket; subs: Set<string>; authed: boolean; ptys: Map<string, PtyHandle>; }
const SUBSCRIBE_ALL = '*';

export interface WebSurfaceOptions {
  port?: number;          // omit/0 => OS-assigned ephemeral (read back via .port)
  server?: http.Server;   // attach to an existing http server instead
  token?: string;         // if set, clients must present it in hello
  name?: string;
  allowTui?: boolean;     // gate Lane R (raw PTY); default true when a TuiHost is present
  access?: {              // AccessPolicy: capability scoping for this host (default all allowed)
    prompt?: boolean;     // false => deny structured turns (read-only observer)
    tui?: boolean;        // false => deny opening a raw PTY
    tuiReadonly?: boolean;// true  => stream PTY output but drop client keystrokes (spectator)
  };
}

// The built-in Web/remote terminal: a ws host speaking the UniversalSnapshot wire
// protocol over LoomIO. Any pikichannel client (incl. the existing pikiloom dashboard
// SPA) can connect: hello -> subscribe -> receive `session` patches -> prompt/stop/steer.
export class WebSurface implements Surface {
  readonly id = 'web';
  readonly capabilities: SurfaceCapabilities = { tunnel: true, images: true, buttons: true, editMessages: true };

  private wss?: WebSocketServer;
  private io?: LoomIO;
  private host?: TuiHost;
  private unsub?: () => void;
  private unsubSessions?: () => void;
  private readonly peers = new Set<Peer>();

  constructor(private readonly opts: WebSurfaceOptions = {}) {}

  get port(): number | null {
    const a = this.wss?.address();
    return a && typeof a === 'object' ? a.port : null;
  }

  async start(io: LoomIO, host?: TuiHost): Promise<void> {
    this.io = io;
    this.host = host;
    this.wss = this.opts.server
      ? new WebSocketServer({ server: this.opts.server })
      : new WebSocketServer({ port: this.opts.port ?? 0 });

    if (!this.opts.server) {
      await new Promise<void>((resolve, reject) => {
        this.wss!.once('listening', resolve);
        this.wss!.once('error', reject);
      });
    }

    this.wss.on('connection', (ws: WebSocket) => this.onConnection(ws));
    this.unsub = io.subscribe((key, _snap, patch, seq) => this.broadcastPatch(key, patch, seq));
    this.unsubSessions = io.onSessionsChanged((sessions) => this.broadcast({ type: 'sessions', sessions }, true));
  }

  async stop(): Promise<void> {
    this.unsub?.(); this.unsubSessions?.();
    for (const p of this.peers) { this.killPeerPtys(p); try { p.ws.close(); } catch { /* ignore */ } }
    this.peers.clear();
    await new Promise<void>((resolve) => { if (this.wss) this.wss.close(() => resolve()); else resolve(); });
  }

  private get tuiEnabled(): boolean { return !!this.host && this.opts.allowTui !== false && this.opts.access?.tui !== false; }
  private get promptEnabled(): boolean { return this.opts.access?.prompt !== false; }
  private killPeerPtys(peer: Peer): void {
    for (const b of peer.ptys.values()) { try { b.kill(); } catch { /* ignore */ } }
    peer.ptys.clear();
  }

  private hostInfo(): HostInfo {
    const capabilities: HostInfo['capabilities'] = ['subscribe-all', 'artifacts', 'history', 'catalog'];
    if (this.promptEnabled) capabilities.push('prompt', 'stop', 'steer', 'interact');
    if (this.tuiEnabled) capabilities.push('tui');
    return { name: this.opts.name || 'loom', version: '0.1.0', transport: 'websocket', capabilities, authRequired: !!this.opts.token };
  }

  private onConnection(ws: WebSocket): void {
    const peer: Peer = { ws, subs: new Set(), authed: !this.opts.token, ptys: new Map() };
    this.peers.add(peer);
    ws.on('message', (data) => {
      let msg: unknown;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (!isClientMessage(msg)) return;
      this.handle(peer, msg).catch((err) => this.send(peer, { type: 'error', message: err?.message || String(err) }));
    });
    const cleanup = () => { this.killPeerPtys(peer); this.peers.delete(peer); };
    ws.on('close', cleanup);
    ws.on('error', cleanup);
  }

  private async handle(peer: Peer, msg: ClientMessage): Promise<void> {
    if (msg.type === 'ping') { this.send(peer, { type: 'pong', t: msg.t }); return; }

    if (!peer.authed) {
      if (msg.type !== 'hello') { this.send(peer, { type: 'error', message: 'not authenticated', code: 'auth' }); return; }
      if (this.opts.token && msg.token !== this.opts.token) {
        this.send(peer, { type: 'error', message: 'unauthorized', code: 'auth' });
        peer.ws.close();
        return;
      }
      peer.authed = true;
    }
    if (msg.type === 'hello') {
      this.send(peer, { type: 'welcome', v: PROTOCOL_VERSION, host: this.hostInfo(), sessions: this.io!.listSessions() });
      return;
    }

    switch (msg.type) {
      case 'subscribe': {
        peer.subs.add(msg.sessionKey);
        if (msg.sessionKey === SUBSCRIBE_ALL) for (const m of this.io!.listSessions()) this.sendFull(peer, m.sessionKey);
        else this.sendFull(peer, msg.sessionKey);
        return;
      }
      case 'unsubscribe': peer.subs.delete(msg.sessionKey); return;
      case 'getSnapshot': this.sendFull(peer, msg.sessionKey); return;
      case 'listSessions': this.send(peer, { type: 'sessions', sessions: this.io!.listSessions() }); return;
      case 'getHistory': {
        const turns = await this.io!.getHistory(msg.sessionKey);
        this.send(peer, { type: 'history', sessionKey: msg.sessionKey, turns, ref: msg.ref });
        return;
      }
      case 'getCatalog': {
        const agent = msg.agent;
        const agents = this.io!.listAgentInfo();
        const models = agent ? await this.io!.listModels(agent) : [];
        const effort = agent ? await this.io!.listEffort(agent, msg.model ?? null) : [];
        const tools = agent ? await this.io!.listTools(agent, msg.workdir) : [];
        const skills = agent ? await this.io!.listSkills(agent, msg.workdir) : [];
        this.send(peer, { type: 'catalog', agents, agent, models, effort, tools, skills, ref: msg.ref });
        return;
      }
      case 'prompt': {
        if (!this.promptEnabled) { this.send(peer, { type: 'error', message: 'prompt not permitted (read-only)', code: 'access', clientRef: msg.clientRef }); return; }
        const res = await this.io!.prompt({
          sessionKey: msg.sessionKey, prompt: msg.prompt, agent: msg.agent, workdir: msg.workdir,
          model: msg.model, effort: msg.effort, attachments: msg.attachments,
        }).catch((e) => ({ error: e?.message || 'prompt failed' } as any));
        if ((res as any).error) { this.send(peer, { type: 'error', message: (res as any).error, clientRef: msg.clientRef }); return; }
        peer.subs.add(res.sessionKey);
        this.send(peer, { type: 'accepted', sessionKey: res.sessionKey, taskId: res.taskId, clientRef: msg.clientRef });
        this.sendFull(peer, res.sessionKey);
        return;
      }
      case 'stop': this.io!.stop(msg.sessionKey); return;
      case 'steer': await this.io!.steer(msg.taskId, msg.prompt); return;
      case 'interact': this.io!.interact(msg.promptId, msg.action, msg.value); return;
      // ---- Lane R: raw PTY (TUI passthrough) ----
      case 'openTui': {
        if (!this.tuiEnabled || !this.host) { this.send(peer, { type: 'error', message: 'TUI not available', code: 'tui', clientRef: msg.ref }); return; }
        let bridge: PtyHandle;
        try {
          bridge = await this.host.openTui({ agent: msg.agent, workdir: msg.workdir, model: msg.model, sessionId: msg.sessionId, cols: msg.cols, rows: msg.rows });
        } catch (e: any) { this.send(peer, { type: 'error', message: e?.message || 'openTui failed', code: 'tui', clientRef: msg.ref }); return; }
        const tuiId = randomUUID();
        peer.ptys.set(tuiId, bridge);
        bridge.onData((data) => this.send(peer, { type: 'tuiData', tuiId, data }));
        bridge.onExit((e) => { peer.ptys.delete(tuiId); this.send(peer, { type: 'tuiExit', tuiId, exitCode: e.exitCode, signal: e.signal }); });
        this.send(peer, { type: 'tuiOpened', tuiId, ref: msg.ref });
        return;
      }
      case 'tuiInput': if (!this.opts.access?.tuiReadonly) peer.ptys.get(msg.tuiId)?.write(msg.data); return;  // readonly = spectator
      case 'tuiResize': peer.ptys.get(msg.tuiId)?.resize(msg.cols, msg.rows); return;
      case 'tuiClose': { const b = peer.ptys.get(msg.tuiId); if (b) { peer.ptys.delete(msg.tuiId); try { b.kill(); } catch { /* ignore */ } } return; }
    }
  }

  private sendFull(peer: Peer, sessionKey: string): void {
    const snap = this.io!.getSnapshot(sessionKey);
    if (!snap) return;
    this.send(peer, { type: 'session', sessionKey, seq: snap.seq, patch: { full: snap.snapshot } });
  }

  private broadcastPatch(sessionKey: string, patch: SnapshotPatch, seq: number): void {
    const frame: ServerMessage = { type: 'session', sessionKey, seq, patch };
    for (const peer of this.peers) {
      if (peer.authed && (peer.subs.has(SUBSCRIBE_ALL) || peer.subs.has(sessionKey))) this.send(peer, frame);
    }
  }

  private broadcast(frame: ServerMessage, authedOnly = false): void {
    for (const peer of this.peers) if (!authedOnly || peer.authed) this.send(peer, frame);
  }

  private send(peer: Peer, frame: ServerMessage): void {
    if (peer.ws.readyState !== WebSocket.OPEN) return;
    try { peer.ws.send(JSON.stringify(frame)); } catch { /* ignore */ }
  }
}
