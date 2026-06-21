/**
 * pikichannel/rendezvous-broker.ts — the public signaling broker (NAT traversal).
 *
 * This is the "route, don't relay data" rendezvous from the original design. A
 * pikiloom host that sits behind NAT dials OUT to a broker and registers a
 * NodeID; a client dials the same broker by NodeID. The broker pairs them and
 * relays ONLY signaling envelopes (SDP offer/answer + ICE candidates) — it never
 * sees datachannel data, which flows directly P2P (DTLS-encrypted) once ICE
 * hole-punches through. It is dependency-light (no werift) so any pikiloom can
 * act as a broker for reachable peers, or it can be run standalone.
 *
 * Wire protocol (JSON over the rendezvous WebSocket):
 *   host→  {t:'register', nodeId}            ← register to receive dials
 *      ←   {t:'registered', nodeId} | {t:'error', message}
 *   client→{t:'dial', nodeId}                ← reach a registered host
 *      ←   {t:'dialed', sessionId} | {t:'error', message}
 *   broker→host {t:'open', sessionId}        ← a client dialed; prepare answerer
 *   peer↔  {t:'signal', sessionId, data}     ← relayed to the other end verbatim
 *   broker→peer {t:'close', sessionId}       ← the other end went away
 */

import crypto from 'node:crypto';
import type http from 'node:http';
import type internal from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { writeScopedLog } from '../core/logging.js';

const rlog = (msg: string) => writeScopedLog('pikichannel', `[rendezvous] ${msg}`, { level: 'info' });

interface Session { client: WebSocket; host: WebSocket; nodeId: string; }

export class RendezvousBroker {
  private wss = new WebSocketServer({ noServer: true });
  private hosts = new Map<string, WebSocket>();        // nodeId → host socket
  private sessions = new Map<string, Session>();        // sessionId → pair

  constructor() {
    this.wss.on('connection', (ws: WebSocket) => this.onConnection(ws));
  }

  handleUpgrade(req: http.IncomingMessage, socket: internal.Duplex, head: Buffer): void {
    this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit('connection', ws, req));
  }

  stop(): void { this.wss.close(); }

  get stats() { return { hosts: this.hosts.size, sessions: this.sessions.size }; }

  private send(ws: WebSocket, msg: unknown): void {
    if (ws.readyState === ws.OPEN) { try { ws.send(JSON.stringify(msg)); } catch { /* ignore */ } }
  }

  private onConnection(ws: WebSocket): void {
    let myNodeId: string | null = null;          // set if this socket registers as a host
    const mySessions = new Set<string>();         // sessions this socket participates in

    ws.on('message', (raw) => {
      let m: any; try { m = JSON.parse(String(raw)); } catch { return; }
      switch (m?.t) {
        case 'register': {
          const nodeId = String(m.nodeId || '').trim();
          if (!nodeId) { this.send(ws, { t: 'error', message: 'nodeId required' }); return; }
          // Last registration wins (a host reconnecting replaces its stale socket).
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
