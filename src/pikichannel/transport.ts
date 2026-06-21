/**
 * pikichannel/transport.ts — the L1 transport abstraction (host side).
 *
 * This is the seam that makes the two delivery mechanisms — WebSocket and
 * WebRTC datachannel — interchangeable. A {@link ChannelTransport} accepts peer
 * connections and surfaces each as a {@link ChannelConnection}: a reliable,
 * ordered, bidirectional frame pipe. The host ({@link PikichannelHost}) drives
 * the L2 protocol over a ChannelConnection and is wholly blind to whether the
 * bytes travel over a TCP WebSocket or an SCTP datachannel — flip the binding,
 * the session behaves identically. That blindness IS the comparability the two
 * bindings are meant to demonstrate.
 *
 * Contract every binding must honour:
 *   - reliable + ordered delivery of whole frames (no partial frames),
 *   - bidirectional,
 *   - a single 'close' notification, exactly once,
 *   - `send()` after close is a silent no-op (never throws).
 */

import type { TransportKind } from './protocol.js';

/** One peer connection, transport-agnostic. */
export interface ChannelConnection {
  /** Stable per-connection id (for logging / subscription bookkeeping). */
  readonly id: string;
  /** Which binding produced this connection. */
  readonly kind: TransportKind;
  /** Best-effort remote label (ip:port / 'webrtc-peer') for logs. */
  readonly remote?: string;
  /** Send one frame. No-op if the connection is closed. */
  send(frame: string): void;
  /** Register the frame handler. Called once per inbound frame. */
  onMessage(cb: (frame: string) => void): void;
  /** Register the close handler. Fires exactly once. */
  onClose(cb: () => void): void;
  /** Whether the pipe is currently open. */
  isOpen(): boolean;
  /** Close the pipe. Idempotent. */
  close(): void;
}

/** A host-side binding that accepts peer connections. */
export interface ChannelTransport {
  readonly kind: TransportKind;
  /** Begin accepting connections; `onConnection` fires per established peer. */
  start(onConnection: (conn: ChannelConnection) => void): void;
  /** Stop accepting and tear down all live connections. */
  stop(): void;
}

/**
 * Minimal base that implements the callback bookkeeping every binding repeats,
 * so concrete connections only push frames in and call `emitClose()` once.
 */
export abstract class BaseConnection implements ChannelConnection {
  abstract readonly id: string;
  abstract readonly kind: TransportKind;
  remote?: string;

  private messageCb: ((frame: string) => void) | null = null;
  private closeCb: (() => void) | null = null;
  private closed = false;

  onMessage(cb: (frame: string) => void): void { this.messageCb = cb; }
  onClose(cb: () => void): void {
    this.closeCb = cb;
    // If close already happened before the handler was attached, fire now.
    if (this.closed) cb();
  }

  /** Concrete bindings call this when a frame arrives. */
  protected emitMessage(frame: string): void {
    if (this.messageCb) this.messageCb(frame);
  }

  /** Concrete bindings call this exactly once when the pipe closes. */
  protected emitClose(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.closeCb) this.closeCb();
  }

  isOpen(): boolean { return !this.closed; }

  abstract send(frame: string): void;
  abstract close(): void;
}
