import type http from 'node:http';
import type internal from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { writeScopedLog } from '../../core/logging.js';
import type { ChannelConnection, ChannelTransport } from '../transport.js';
import { createAnswerer, type SignalData } from './webrtc-shared.js';

const dlog = (msg: string) => writeScopedLog('pikichannel', `[webrtc] ${msg}`, { level: 'info' });

export class WebRTCTransport implements ChannelTransport {
  readonly kind = 'webrtc';
  private wss = new WebSocketServer({ noServer: true });
  private onConn: ((conn: ChannelConnection) => void) | null = null;

  start(onConnection: (conn: ChannelConnection) => void): void {
    this.onConn = onConnection;
    this.wss.on('connection', (ws: WebSocket, req: http.IncomingMessage) => this.runSignaling(ws, req));
  }

  handleUpgrade(req: http.IncomingMessage, socket: internal.Duplex, head: Buffer): void {
    this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit('connection', ws, req));
  }

  stop(): void {
    this.wss.close();
  }

  private runSignaling(ws: WebSocket, req: http.IncomingMessage): void {
    const remote = req.socket.remoteAddress ? `${req.socket.remoteAddress}:${req.socket.remotePort}` : undefined;
    const answerer = createAnswerer({
      remote,
      log: dlog,
      onConnection: (conn) => this.onConn?.(conn),
      sendSignal: (data) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(data)); },
    });

    ws.on('message', (raw) => {
      let msg: SignalData; try { msg = JSON.parse(String(raw)); } catch { return; }
      void answerer.onSignal(msg);
    });

    const cleanup = () => { if (!answerer.isAdopted()) answerer.close(); };
    ws.on('close', cleanup);
    ws.on('error', cleanup);
  }
}
