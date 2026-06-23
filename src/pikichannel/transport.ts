import type { TransportKind } from './protocol.js';

export interface ChannelConnection {
  readonly id: string;
  readonly kind: TransportKind;
  readonly remote?: string;
  send(frame: string): void;
  onMessage(cb: (frame: string) => void): void;
  onClose(cb: () => void): void;
  isOpen(): boolean;
  close(): void;
}

export interface ChannelTransport {
  readonly kind: TransportKind;
  start(onConnection: (conn: ChannelConnection) => void): void;
  stop(): void;
}

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
    if (this.closed) cb();
  }

  protected emitMessage(frame: string): void {
    if (this.messageCb) this.messageCb(frame);
  }

  protected emitClose(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.closeCb) this.closeCb();
  }

  isOpen(): boolean { return !this.closed; }

  abstract send(frame: string): void;
  abstract close(): void;
}
