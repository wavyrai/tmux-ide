import { describe, it, expect } from "bun:test";
import {
  WS_V3_VERSION,
  WsV3MessageType,
  encodeWsV3Frame,
  decodeWsV3Frame,
  encodeWsV3SubscribePayload,
  decodeWsV3SubscribePayload,
  encodeWsV3ResizePayload,
  decodeWsV3ResizePayload,
} from "./protocol.ts";

const allMessageTypes = Object.values(WsV3MessageType).filter(
  (v): v is WsV3MessageType => typeof v === "number",
);

describe("ws-v3 protocol", () => {
  it("encode/decode round-trip for each frame type with session + payload", () => {
    const payload = new TextEncoder().encode("payload-bytes");
    for (const type of allMessageTypes) {
      const encoded = encodeWsV3Frame({
        type,
        sessionId: `sess-${type}`,
        payload,
      });
      const decoded = decodeWsV3Frame(encoded);
      expect(decoded).not.toBeNull();
      expect(decoded!.type).toBe(type);
      expect(decoded!.sessionId).toBe(`sess-${type}`);
      expect(Buffer.from(decoded!.payload).equals(Buffer.from(payload))).toBe(true);
    }
  });

  it("round-trip with empty session id and empty payload", () => {
    const encoded = encodeWsV3Frame({
      type: WsV3MessageType.PING,
      sessionId: "",
      payload: new Uint8Array(),
    });
    const decoded = decodeWsV3Frame(encoded);
    expect(decoded).toEqual({
      type: WsV3MessageType.PING,
      sessionId: "",
      payload: new Uint8Array(),
    });
  });

  it("defaults sessionId and payload to empty", () => {
    const encoded = encodeWsV3Frame({ type: WsV3MessageType.HELLO });
    expect(decodeWsV3Frame(encoded)).toEqual({
      type: WsV3MessageType.HELLO,
      sessionId: "",
      payload: new Uint8Array(),
    });
  });

  it("returns null for invalid magic bytes", () => {
    const buf = encodeWsV3Frame({ type: WsV3MessageType.HELLO });
    buf[0] ^= 0xff;
    expect(decodeWsV3Frame(buf)).toBeNull();
  });

  it("returns null for wrong version", () => {
    const buf = encodeWsV3Frame({ type: WsV3MessageType.HELLO });
    buf[2] = WS_V3_VERSION + 1;
    expect(decodeWsV3Frame(buf)).toBeNull();
  });

  it("returns null when buffer is shorter than fixed header", () => {
    expect(decodeWsV3Frame(new Uint8Array(10))).toBeNull();
  });

  it("returns null on truncated frame (fragmented input): missing sessionId bytes", () => {
    const full = encodeWsV3Frame({
      type: WsV3MessageType.STDOUT,
      sessionId: "abc",
      payload: new Uint8Array([1, 2]),
    });
    for (let len = 0; len < full.byteLength; len++) {
      const partial = full.subarray(0, len);
      const d = decodeWsV3Frame(partial);
      if (len < full.byteLength) {
        expect(d).toBeNull();
      } else {
        expect(d).not.toBeNull();
      }
    }
  });

  it("subscribe payload encode/decode round-trip", () => {
    const p = encodeWsV3SubscribePayload({
      flags: 7,
      snapshotMinIntervalMs: 100,
      snapshotMaxIntervalMs: 500,
    });
    expect(decodeWsV3SubscribePayload(p)).toEqual({
      flags: 7,
      snapshotMinIntervalMs: 100,
      snapshotMaxIntervalMs: 500,
    });
  });

  it("subscribe decode returns null when payload too short", () => {
    expect(decodeWsV3SubscribePayload(new Uint8Array(11))).toBeNull();
  });

  it("resize payload encode/decode round-trip", () => {
    const p = encodeWsV3ResizePayload(120, 40);
    expect(decodeWsV3ResizePayload(p)).toEqual({ cols: 120, rows: 40 });
  });

  it("resize decode returns null when payload too short", () => {
    expect(decodeWsV3ResizePayload(new Uint8Array(4))).toBeNull();
  });

  it("decode uses byteOffset/byteLength (subarray of larger buffer)", () => {
    const inner = encodeWsV3Frame({
      type: WsV3MessageType.PONG,
      sessionId: "x",
      payload: new Uint8Array(),
    });
    const padded = new Uint8Array(inner.byteLength + 4);
    padded.set(inner, 2);
    const slice = padded.subarray(2, 2 + inner.byteLength);
    expect(decodeWsV3Frame(slice)).not.toBeNull();
  });
});
