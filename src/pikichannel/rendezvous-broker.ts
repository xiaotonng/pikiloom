import crypto from 'node:crypto';
import type http from 'node:http';
import type internal from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { writeScopedLog } from '../core/logging.js';

const rlog = (msg: string) => writeScopedLog('pikichannel', `[rendezvous] ${msg}`, { level: 'info' });

interface Session { client: WebSocket; host: WebSocket; nodeId: string; }

export class RendezvousBroker {
  private wss = new WebSocketServer({ noServer: true });
  private hosts = new Map<string, WebSocket>();
  private sessions = new Map<string, Session>();

  constructor() {
    this.wss.on('connection', (ws: WebSocket) => this.onConnection(ws));
  }

  handleUpgrade(req: http.IncomingMessage, socket: internal.Duplex, head: Buffer): void {
    this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit('connection', ws, req));
  }

  stop(): void { this.wss.close(); }

  get stats() { return { hosts: this.hosts.size, sessions: this.sessions.size }; }

  private send(ws: WebSocket, msg: unknown): void {
    if (ws.readyState === ws.OPEN) { try { ws.send(JSON.stringify(msg)); } catch {  } }
  }

  private onConnection(ws: WebSocket): void {
    let myNodeId: string | null = null;
    const mySessions = new Set<string>();

    ws.on('message', (raw) => {
      let m: any; try { m = JSON.parse(String(raw)); } catch { return; }
      switch (m?.t) {
        case 'register': {
          const nodeId = String(m.nodeId || '').trim();
          if (!nodeId) { this.send(ws, { t: 'error', message: 'nodeId required' }); return; }
          this.hosts.set(nodeId, ws);
          myNodeId = nodeId;
          this.send(ws, { t: 'registered', nodeId });
          rlog(`host registered nodeId=${nodeId} (hosts=${this.hosts.size})`);
          return;
        }
        case 'dial': {
          const nodeId = String(m.nodeId || '').trim();
          const host = this.hosts.get(nodeId);
          if (!host || host.readyState !== host.OPEN) { this.send(ws, { t: 'error', message: 'node offline' }); return; }
          const sessionId = crypto.randomUUID();
          this.sessions.set(sessionId, { client: ws, host, nodeId });
          mySessions.add(sessionId);
          this.send(ws, { t: 'dialed', sessionId });
          this.send(host, { t: 'open', sessionId });
          rlog(`dial nodeId=${nodeId} → session=${sessionId.slice(0, 8)}`);
          return;
        }
        case 'signal': {
          const sessionId = String(m.sessionId || '');
          const s = this.sessions.get(sessionId);
          if (!s) return;
          const other = ws === s.client ? s.host : s.client;
          mySessions.add(sessionId);
          this.send(other, { t: 'signal', sessionId, data: m.data });
          return;
        }
      }
    });

    const cleanup = () => {
      if (myNodeId && this.hosts.get(myNodeId) === ws) { this.hosts.delete(myNodeId); rlog(`host gone nodeId=${myNodeId}`); }
      for (const sessionId of mySessions) {
        const s = this.sessions.get(sessionId);
        if (!s) continue;
        const other = ws === s.client ? s.host : s.client;
        this.send(other, { t: 'close', sessionId });
        this.sessions.delete(sessionId);
      }
    };
    ws.on('close', cleanup);
    ws.on('error', cleanup);
  }
}
