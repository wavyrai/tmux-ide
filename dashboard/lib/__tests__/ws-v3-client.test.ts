import { describe, it, expect } from "vitest";
import {
  decodeFrame,
  encodeFrame,
  encodeHelloAuthFrame,
  encodeSubscribeStdoutFrame,
  WsV3MessageType,
  WsV3SubscribeFlags,
  encodeWsV3SubscribePayload,
} from "../ws-v3-client";

describe("ws-v3-client", () => {
  it("round-trips STDOUT with sessionId and payload", () => {
    const sessionId = "my-session:%1";
    const payload = new TextEncoder().encode("hello \x1b[31mworld");
    const encoded = encodeFrame(WsV3MessageType.STDOUT, sessionId, payload);
    const decoded = decodeFrame(encoded);
    expect(decoded).not.toBeNull();
    expect(decoded!.type).toBe(WsV3MessageType.STDOUT);
    expect(decoded!.sessionId).toBe(sessionId);
    expect(new Uint8Array(decoded!.payload)).toEqual(payload);
  });

  it("round-trips HELLO with empty sessionId", () => {
    const encoded = encodeFrame(WsV3MessageType.HELLO, "", new TextEncoder().encode("{}"));
    const decoded = decodeFrame(encoded);
    expect(decoded!.type).toBe(WsV3MessageType.HELLO);
    expect(decoded!.sessionId).toBe("");
    expect(new TextDecoder().decode(decoded!.payload)).toBe("{}");
  });

  it("encodeHelloAuthFrame round-trips token payload", () => {
    const frame = encodeHelloAuthFrame("eyJhbGciOiJIUzI1NiJ9.test");
    const decoded = decodeFrame(frame);
    expect(decoded!.type).toBe(WsV3MessageType.HELLO);
    const j = JSON.parse(new TextDecoder().decode(decoded!.payload)) as { token?: string };
    expect(j.token).toBe("eyJhbGciOiJIUzI1NiJ9.test");
  });

  it("encodeSubscribeStdoutFrame embeds subscribe flags", () => {
    const key = "proj:%1";
    const encoded = encodeSubscribeStdoutFrame(key);
    const decoded = decodeFrame(encoded);
    expect(decoded!.type).toBe(WsV3MessageType.SUBSCRIBE);
    expect(decoded!.sessionId).toBe(key);
    const p = decoded!.payload;
    const view = new DataView(p.buffer, p.byteOffset, p.byteLength);
    expect(view.getUint32(0, true)).toBe(WsV3SubscribeFlags.Stdout);
  });

  it("encodeFrame matches manual encodeWsV3SubscribePayload in frame", () => {
    const inner = encodeWsV3SubscribePayload({
      flags: WsV3SubscribeFlags.Stdout | WsV3SubscribeFlags.Events,
    });
    const manual = encodeFrame(WsV3MessageType.SUBSCRIBE, "s:p", inner);
    const d = decodeFrame(manual);
    expect(d!.type).toBe(WsV3MessageType.SUBSCRIBE);
    expect(d!.sessionId).toBe("s:p");
    expect(d!.payload.byteLength).toBe(12);
  });
});
