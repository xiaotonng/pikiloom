/**
 * pikichannel/transports/webrtc-shared.ts — shared werift answerer + connection.
 *
 * The host is always the WebRTC *answerer* (the browser/SDK creates the offer +
 * datachannel). The same answerer logic drives two signaling paths:
 *   - direct  (webrtc-host.ts): SDP/ICE over a same-origin `/pikichannel/signal`
 *     WebSocket — for clients that can already reach the host.
 *   - rendezvous (rendezvous.ts): SDP/ICE relayed through a public broker both
 *     peers dial OUTBOUND — the NAT-traversal path.
 *
 * Once the datachannel opens the bytes are pure P2P (DTLS-encrypted); signaling
 * only brokers the handshake. `getIceServers()` is the STUN/TURN config hook —
 * see turn.ts: STUN by default, Cloudflare-minted short-lived TURN (or a manual
 * PIKICHANNEL_ICE_SERVERS override) when configured, for symmetric-NAT / CGNAT
 * relay fallback.
 */

import { RTCPeerConnection, type RTCDataChannel } from 'werift';
import { BaseConnection, type ChannelConnection } from '../transport.js';
import { getCachedIceServers, toWeriftIceServers, type IceServer } from '../turn.js';

let connCounter = 0;

/**
 * ICE servers for the werift answerer, reduced to exactly what werift consumes
 * (one STUN + one UDP TURN — see {@link toWeriftIceServers}). The resolution
 * policy lives in turn.ts: a manual PIKICHANNEL_ICE_SERVERS override, else cached
 * Cloudflare-minted short-lived credentials, else plain STUN.
 */
export function getIceServers(): IceServer[] {
  return toWeriftIceServers(getCachedIceServers());
}

function coerceFrame(data: unknown): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  try { return Buffer.from(new Uint8Array(data as ArrayBuffer)).toString('utf8'); } catch { return String(data); }
}

/** A pikichannel connection riding an SCTP datachannel. */
export class RtcConnection extends BaseConnection {
  readonly id: string;
  readonly kind = 'webrtc';

  constructor(private readonly channel: RTCDataChannel, private readonly pc: RTCPeerConnection, remote?: string) {
    super();
    this.id = `rtc-${++connCounter}`;
    this.remote = remote || 'webrtc-peer';
    channel.onmessage = (ev: any) => this.emitMessage(coerceFrame(ev?.data));
    channel.onclose = () => this.close();
    pc.connectionStateChange.subscribe((state) => {
      if (state === 'failed' || state === 'closed' || state === 'disconnected') this.close();
    });
  }

  send(frame: string): void {
    if (this.channel.readyState === 'open') {
      try { this.channel.send(frame); } catch { /* drop on closing channel */ }
    }
  }

  isOpen(): boolean { return this.channel.readyState === 'open'; }

  close(): void {
    try { this.channel.close(); } catch { /* ignore */ }
    try { this.pc.close(); } catch { /* ignore */ }
    this.emitClose();
  }
}

/** A signaling envelope payload (transport-agnostic — direct WS or rendezvous). */
export interface SignalData {
  kind: 'offer' | 'answer' | 'candidate' | 'error';
  sdp?: string;
  type?: string;
  candidate?: unknown;
  message?: string;
}

export interface Answerer {
  /** Feed a remote signal (offer / candidate). */
  onSignal(data: SignalData): Promise<void>;
  /** Whether the datachannel has been adopted (connection established). */
  isAdopted(): boolean;
  close(): void;
}

/**
 * Build a werift answerer. The caller wires `sendSignal` to whatever signaling
 * channel it has (a WS, or the rendezvous), feeds inbound signals to `onSignal`,
 * and receives the live {@link ChannelConnection} via `onConnection` once the
 * datachannel opens. Trickle ICE: the answer is sent immediately, candidates
 * follow as they are gathered.
 */
export function createAnswerer(opts: {
  sendSignal: (data: SignalData) => void;
  onConnection: (conn: ChannelConnection) => void;
  remote?: string;
  log?: (m: string) => void;
}): Answerer {
  const pc = new RTCPeerConnection({ iceServers: getIceServers() });
  let adopted = false;

  pc.onDataChannel.subscribe((channel: RTCDataChannel) => {
    adopted = true;
    opts.onConnection(new RtcConnection(channel, pc, opts.remote));
  });
  pc.onIceCandidate.subscribe((candidate) => {
    if (candidate) opts.sendSignal({ kind: 'candidate', candidate: candidate.toJSON ? candidate.toJSON() : candidate });
  });

  return {
    async onSignal(data: SignalData) {
      try {
        if (data.kind === 'offer' && typeof data.sdp === 'string') {
          await pc.setRemoteDescription({ type: 'offer', sdp: data.sdp });
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          const local = pc.localDescription;
          if (local) opts.sendSignal({ kind: 'answer', type: local.type, sdp: local.sdp });
        } else if (data.kind === 'candidate' && data.candidate) {
          await pc.addIceCandidate(data.candidate as any);
        }
      } catch (err) {
        opts.log?.(`answerer signal error: ${(err as Error)?.message || err}`);
        opts.sendSignal({ kind: 'error', message: (err as Error)?.message || 'signaling failed' });
      }
    },
    isAdopted: () => adopted,
    close() { try { pc.close(); } catch { /* ignore */ } },
  };
}
