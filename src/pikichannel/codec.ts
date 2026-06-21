/**
 * pikichannel/codec.ts — frame (de)serialization for the L2 protocol.
 *
 * The transport layer (L1) moves opaque frames; this module is the only place
 * that knows how a {@link ServerMessage} / {@link ClientMessage} becomes a frame
 * and back. Today that is newline-free JSON text. The indirection is deliberate:
 * swapping to a binary codec (CBOR / protobuf) later is a change here alone, with
 * the wire-format tag negotiated in the handshake — no transport or host edits.
 */

import type { ClientMessage, ServerMessage } from './protocol.js';

export type WireFormat = 'json';

export const DEFAULT_WIRE_FORMAT: WireFormat = 'json';

/** Encode a host→client message into a transport frame. */
export function encodeServer(msg: ServerMessage, _fmt: WireFormat = DEFAULT_WIRE_FORMAT): string {
  return JSON.stringify(msg);
}

/** Encode a client→host message into a transport frame. */
export function encodeClient(msg: ClientMessage, _fmt: WireFormat = DEFAULT_WIRE_FORMAT): string {
  return JSON.stringify(msg);
}

/** Coerce a transport frame (string / Buffer / ArrayBuffer) into text. */
function frameToText(raw: string | Buffer | ArrayBuffer): string {
  if (typeof raw === 'string') return raw;
  if (Buffer.isBuffer(raw)) return raw.toString('utf8');
  return Buffer.from(new Uint8Array(raw)).toString('utf8');
}

/** Decode a client→host frame. Returns null on malformed input (never throws). */
export function decodeClient(raw: string | Buffer | ArrayBuffer, _fmt: WireFormat = DEFAULT_WIRE_FORMAT): ClientMessage | null {
  try {
    const value = JSON.parse(frameToText(raw));
    if (!value || typeof value !== 'object' || typeof value.type !== 'string') return null;
    return value as ClientMessage;
  } catch {
    return null;
  }
}

/** Decode a host→client frame. Returns null on malformed input (never throws). */
export function decodeServer(raw: string | Buffer | ArrayBuffer, _fmt: WireFormat = DEFAULT_WIRE_FORMAT): ServerMessage | null {
  try {
    const value = JSON.parse(frameToText(raw));
    if (!value || typeof value !== 'object' || typeof value.type !== 'string') return null;
    return value as ServerMessage;
  } catch {
    return null;
  }
}
