import type { ClientMessage, ServerMessage } from './protocol.js';

export type WireFormat = 'json';

export const DEFAULT_WIRE_FORMAT: WireFormat = 'json';

export function encodeServer(msg: ServerMessage, _fmt: WireFormat = DEFAULT_WIRE_FORMAT): string {
  return JSON.stringify(msg);
}

export function encodeClient(msg: ClientMessage, _fmt: WireFormat = DEFAULT_WIRE_FORMAT): string {
  return JSON.stringify(msg);
}

function frameToText(raw: string | Buffer | ArrayBuffer): string {
  if (typeof raw === 'string') return raw;
  if (Buffer.isBuffer(raw)) return raw.toString('utf8');
  return Buffer.from(new Uint8Array(raw)).toString('utf8');
}

export function decodeClient(raw: string | Buffer | ArrayBuffer, _fmt: WireFormat = DEFAULT_WIRE_FORMAT): ClientMessage | null {
  try {
    const value = JSON.parse(frameToText(raw));
    if (!value || typeof value !== 'object' || typeof value.type !== 'string') return null;
    return value as ClientMessage;
  } catch {
    return null;
  }
}

export function decodeServer(raw: string | Buffer | ArrayBuffer, _fmt: WireFormat = DEFAULT_WIRE_FORMAT): ServerMessage | null {
  try {
    const value = JSON.parse(frameToText(raw));
    if (!value || typeof value !== 'object' || typeof value.type !== 'string') return null;
    return value as ServerMessage;
  } catch {
    return null;
  }
}
