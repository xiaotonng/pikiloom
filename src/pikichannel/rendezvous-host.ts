import WebSocket from 'ws';
import { writeScopedLog } from '../core/logging.js';
import type { ChannelConnection } from './transport.js';
import { createAnswerer, type Answerer, type SignalData } from './transports/webrtc-shared.js';

const rlog = (msg: string) => writeScopedLog('pikichannel', `[rendezvous-host] ${msg}`, { level: 'info' });

export class RendezvousHostClient {
  private ws: WebSocket | null = null;
  private answerers = new Map<string, Answerer>();
  private adopted = new Set<string>();
  private stopped = false;
  private reconnectDelay = 1000;

  constructor(
    private readonly url: string,
    private readonly nodeId: string,
    private readonly onConnection: (conn: ChannelConnection) => void,
  ) {}

  start(): void { this.stopped = false; this.connect(); }

  stop(): void {
    this.stopped = true;
    const ws = this.ws; this.ws = null;
    try { ws?.close(); } catch {  }
    for (const a of this.answerers.values()) a.close();
    this.answerers.clear();
    this.adopted.clear();
  }

  private connect(): void {
    if (this.stopped) return;
    let ws: WebSocket;
    try { ws = new WebSocket(this.url); } catch { this.scheduleReconnect(); return; }
    this.ws = ws;
    ws.on('open', () => {
      this.reconnectDelay = 1000;
      ws.send(JSON.stringify({ t: 'register', nodeId: this.nodeId }));
      rlog(`registering nodeId=${this.nodeId} at ${this.url}`);
    });
    ws.on('message', (raw) => this.onMessage(raw));
    ws.on('close', () => {
      if (this.ws === ws) this.ws = null;
      for (const a of this.answerers.values()) a.close();
      this.answerers.clear(); this.adopted.clear();
      this.scheduleReconnect();
    });
    ws.on('error', () => {  });
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    setTimeout(() => this.connect(), this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 15_000);
  }

  private onMessage(raw: WebSocket.RawData): void {
    let m: any; try { m = JSON.parse(String(raw)); } catch { return; }
    switch (m?.t) {
      case 'registered': rlog(`registered nodeId=${m.nodeId}`); return;
      case 'error': rlog(`broker error: ${m.message}`); return;
      case 'open': this.ensureAnswerer(m.sessionId); return;
      case 'close': {
        const a = this.answerers.get(m.sessionId);
        if (a) { a.close(); this.answerers.delete(m.sessionId); }
        this.adopted.delete(m.sessionId);
        return;
      }
      case 'signal': {
        if (this.adopted.has(m.sessionId)) return;
        const a = this.ensureAnswerer(m.sessionId);
        void a.onSignal(m.data as SignalData);
        return;
      }
    }
  }

  private ensureAnswerer(sessionId: string): Answerer {
    let a = this.answerers.get(sessionId);
    if (a) return a;
    a = createAnswerer({
      remote: `rendezvous:${sessionId.slice(0, 8)}`,
      log: rlog,
      onConnection: (conn) => {
        this.adopted.add(sessionId);
        this.answerers.delete(sessionId);
        this.onConnection(conn);
      },
      sendSignal: (data) => {
        const ws = this.ws;
        if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: 'signal', sessionId, data }));
      },
    });
    this.answerers.set(sessionId, a);
    return a;
  }
}
