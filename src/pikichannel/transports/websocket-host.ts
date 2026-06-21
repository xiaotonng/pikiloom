/**
 * pikichannel/transports/websocket-host.ts — the WebSocket L1 binding (host).
 *
 * The baseline transport: protocol frames ride a raw WebSocket. Same-machine /
 * LAN clients (the Dashboard case) want exactly this — there is no NAT to
 * traverse, so a TCP WebSocket is the optimal path. It is the control against
 * which the WebRTC binding is compared.
 *
 * The server wiring owns upgrade routing and feeds matching upgrades to
 * `handleUpgrade`; this class only manages the noServer WebSocketServer and
 * wraps each socket as a {@link ChannelConnection}.
 */

import type http from 'node:http';
import type internal from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { BaseConnection, type ChannelConnection, type ChannelTransport } from '../transport.js';

const WS_KEEPALIVE_MS = 25_000;
let connCounter = 0;

class WsConnection extends BaseConnection {
  readonly id: string;
  readonly kind = 'websocket';

  constructor(private readonly ws: WebSocket, remote?: string) {
    super();
    this.id = `ws-${++connCounter}`;
    this.remote = remote;

    ws.on('message', (raw) => {
      const data = raw as unknown;
      const frame = typeof data === 'string'
        ? data
        : Buffer.isBuffer(data)
          ? data.toString('utf8')
          : Array.isArray(data)
            ? Buffer.concat(data as Buffer[]).toString('utf8')
            : Buffer.from(data as ArrayBuffer).toString('utf8');
      this.emitMessage(frame);
    });
    ws.on('close', () => this.emitClose());
    ws.on('error', () => this.emitClose());
  }

  send(frame: string): void {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(frame);
  }

  isOpen(): boolean {
    return this.ws.readyState === this.ws.OPEN;
  }

  close(): void {
    try { this.ws.close(); } catch { /* ignore */ }
    this.emitClose();
  }
}

export class WebSocketTransport implements ChannelTransport {
  readonly kind = 'websocket';
  private wss = new WebSocketServer({ noServer: true });
  private onConn: ((conn: ChannelConnection) => void) | null = null;

  start(onConnection: (conn: ChannelConnection) => void): void {
    this.onConn = onConnection;
    this.wss.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
      const remote = req.socket.remoteAddress ? `${req.socket.remoteAddress}:${req.socket.remotePort}` : undefined;
      const keepalive = setInterval(() => {
        if (ws.readyState === ws.OPEN) ws.ping();
      }, WS_KEEPALIVE_MS);
      ws.on('close', () => clearInterval(keepalive));
      this.onConn?.(new WsConnection(ws, remote));
    });
  }

  /** Server wiring routes a matching upgrade request here. */
  handleUpgrade(req: http.IncomingMessage, socket: internal.Duplex, head: Buffer): void {
    this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit('connection', ws, req));
  }

  stop(): void {
    this.wss.close();
  }
}
