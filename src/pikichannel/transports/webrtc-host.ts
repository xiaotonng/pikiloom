/**
 * pikichannel/transports/webrtc-host.ts — the DIRECT WebRTC binding (host).
 *
 * SDP/ICE over a same-origin `/pikichannel/signal` WebSocket, for clients that
 * can already reach the host (localhost / LAN / public IP). The cross-NAT path —
 * where the host dials OUT to a public broker — lives in rendezvous.ts. Both
 * paths share the same werift answerer (webrtc-shared.ts), so a connection from
 * either is identical downstream.
 *
 * werift is imported (transitively) here; the server wiring loads this module via
 * a guarded dynamic import, so a missing/broken werift disables WebRTC while the
 * WebSocket binding and the dashboard keep working.
 */

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

  /** Server wiring routes a matching signaling upgrade request here. */
  handleUpgrade(req: http.IncomingMessage, socket: internal.Duplex, head: Buffer): void {
    this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit('connection', ws, req));
  }

  stop(): void {
    this.wss.close();
  }

  /** One signaling WebSocket brokers exactly one peer connection. */
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

    // The signaling socket is only needed for the handshake; once the datachannel
    // carries traffic it can close. If it drops before a channel was adopted,
    // tear the half-open peer down.
    const cleanup = () => { if (!answerer.isAdopted()) answerer.close(); };
    ws.on('close', cleanup);
    ws.on('error', cleanup);
  }
}
