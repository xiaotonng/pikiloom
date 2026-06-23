import { RTCPeerConnection, type RTCDataChannel } from 'werift';
import { BaseConnection, type ChannelConnection } from '../transport.js';
import { getCachedIceServers, toWeriftIceServers, type IceServer } from '../turn.js';

let connCounter = 0;

export function getIceServers(): IceServer[] {
  return toWeriftIceServers(getCachedIceServers());
}

function coerceFrame(data: unknown): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  try { return Buffer.from(new Uint8Array(data as ArrayBuffer)).toString('utf8'); } catch { return String(data); }
}

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
      try { this.channel.send(frame); } catch {  }
    }
  }

  isOpen(): boolean { return this.channel.readyState === 'open'; }

  close(): void {
    try { this.channel.close(); } catch {  }
    try { this.pc.close(); } catch {  }
    this.emitClose();
  }
}

export interface SignalData {
  kind: 'offer' | 'answer' | 'candidate' | 'error';
  sdp?: string;
  type?: string;
  candidate?: unknown;
  message?: string;
}

export interface Answerer {
  onSignal(data: SignalData): Promise<void>;
  isAdopted(): boolean;
  close(): void;
}

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
    close() { try { pc.close(); } catch {  } },
  };
}
