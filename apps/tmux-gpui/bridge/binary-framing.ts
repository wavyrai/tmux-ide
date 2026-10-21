import {
  TerminalGraphicsBlobSchemaZ,
  TERMINAL_GRAPHICS_BLOB_CHUNK_BYTES,
} from "../../../packages/contracts/src/terminal-graphics.ts";
import { z } from "zod";

export const BINARY_WIRE_CAPABILITY = "binary-rle-v1";
export const BINARY_HEADER_BYTES = 12;
export const MAX_BINARY_BODY = 8 * 1024 * 1024;
export const MAX_IMAGE_METADATA = 4096;
export type BinaryFrameType = 1 | 2 | 3;
export type BinaryFrame = { type: BinaryFrameType; payload: Uint8Array };
const MAGIC = Buffer.from("TIGF");
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
function limit(type: number): number {
  if (type === 1 || type === 2) return MAX_BINARY_BODY;
  if (type === 3) return 4 + MAX_IMAGE_METADATA + TERMINAL_GRAPHICS_BLOB_CHUNK_BYTES;
  throw new Error("Unknown binary frame type");
}
export function encodeBinaryFrame(type: BinaryFrameType, payload: Uint8Array): Buffer {
  if (payload.length < 1 || payload.length > limit(type))
    throw new Error("Invalid binary frame length");
  const frame = Buffer.allocUnsafe(BINARY_HEADER_BYTES + payload.length);
  MAGIC.copy(frame);
  frame[4] = 1;
  frame[5] = type;
  frame.writeUInt16BE(0, 6);
  frame.writeUInt32BE(payload.length, 8);
  frame.set(payload, BINARY_HEADER_BYTES);
  return frame;
}

/** One owned payload at a time. Caller retains unconsumed input and pauses its source on blocked.
 * A callback returning false ACCEPTS that frame; resume() admits subsequent frames, never replays it.
 * Corruption/partial EOF/callback failure retires the parser; there is no magic scanning or fallback.
 */
export function createBinaryFrameParser(accept: (frame: BinaryFrame) => boolean) {
  const header = Buffer.alloc(BINARY_HEADER_BYTES);
  let headerBytes = 0,
    payload: Buffer | null = null,
    payloadBytes = 0;
  let type: BinaryFrameType = 1,
    blocked = false,
    closed = false;
  const fail = () => {
    closed = true;
    payload = null;
  };
  return {
    get bufferedBytes() {
      return headerBytes + payloadBytes;
    },
    resume() {
      if (closed) throw new Error("Binary parser retired");
      blocked = false;
    },
    push(input: Uint8Array): { consumed: number; blocked: boolean } {
      if (closed) throw new Error("Binary parser retired");
      let consumed = 0;
      try {
        while (consumed < input.length && !blocked) {
          if (payload === null) {
            const n = Math.min(BINARY_HEADER_BYTES - headerBytes, input.length - consumed);
            header.set(input.subarray(consumed, consumed + n), headerBytes);
            headerBytes += n;
            consumed += n;
            if (headerBytes !== BINARY_HEADER_BYTES) break;
            if (
              !header.subarray(0, 4).equals(MAGIC) ||
              header[4] !== 1 ||
              header.readUInt16BE(6) !== 0
            )
              throw new Error("Invalid binary frame header");
            type = header[5] as BinaryFrameType;
            const length = header.readUInt32BE(8);
            if (length < 1 || length > limit(type)) throw new Error("Invalid binary frame length");
            payload = Buffer.allocUnsafe(length);
            payloadBytes = 0;
          }
          const n = Math.min(payload.length - payloadBytes, input.length - consumed);
          payload.set(input.subarray(consumed, consumed + n), payloadBytes);
          payloadBytes += n;
          consumed += n;
          if (payloadBytes === payload.length) {
            const frame = { type, payload };
            payload = null;
            payloadBytes = 0;
            headerBytes = 0;
            blocked = !accept(frame);
          }
        }
        return { consumed, blocked };
      } catch (error) {
        fail();
        throw error;
      }
    },
    end() {
      if (closed) throw new Error("Binary parser retired");
      closed = true;
      if (headerBytes !== 0 || payload !== null) {
        fail();
        throw new Error("Truncated binary frame");
      }
    },
  };
}

export function encodeBinaryJson(value: unknown): Buffer {
  return encodeBinaryFrame(1, Buffer.from(JSON.stringify(value), "utf8"));
}
export function decodeBinaryJson(payload: Uint8Array): unknown {
  if (payload.length < 1 || payload.length > MAX_BINARY_BODY)
    throw new Error("Invalid JSON frame length");
  return JSON.parse(utf8.decode(payload));
}
const imageMetadata = TerminalGraphicsBlobSchemaZ.extend({
  image: z.string().min(1).max(600).optional(),
}).strict();
export type BinaryImageMetadata = z.infer<typeof imageMetadata>;
function validateImage(metadata: BinaryImageMetadata, length: number) {
  if (
    length < 1 ||
    length > TERMINAL_GRAPHICS_BLOB_CHUNK_BYTES ||
    metadata.offset + length > metadata.total
  )
    throw new Error("Invalid binary image chunk length");
}
/** Image offsets/order/digest completion remain owned by the existing image assembler. */
export function encodeBinaryImage(metadata: BinaryImageMetadata, data: Uint8Array): Buffer {
  const value = imageMetadata.parse(metadata);
  validateImage(value, data.length);
  const json = Buffer.from(JSON.stringify(value), "utf8");
  if (json.length > MAX_IMAGE_METADATA) throw new Error("Binary image metadata too large");
  const body = Buffer.allocUnsafe(4 + json.length + data.length);
  body.writeUInt32BE(json.length);
  body.set(json, 4);
  body.set(data, 4 + json.length);
  return encodeBinaryFrame(3, body);
}
export function decodeBinaryImage(payload: Uint8Array): {
  metadata: BinaryImageMetadata;
  data: Uint8Array;
} {
  if (payload.length < 5 || payload.length > limit(3))
    throw new Error("Invalid binary image payload");
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const length = view.getUint32(0, false);
  if (length < 1 || length > MAX_IMAGE_METADATA || 4 + length >= payload.length)
    throw new Error("Invalid binary image metadata length");
  const metadata = imageMetadata.parse(JSON.parse(utf8.decode(payload.subarray(4, 4 + length))));
  const data = payload.subarray(4 + length);
  validateImage(metadata, data.length);
  return { metadata, data };
}
