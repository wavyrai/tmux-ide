import { describe, it, expect } from "bun:test";
import { Buffer } from "node:buffer";
import {
  MessageType,
  frameMessage,
  MessageParser,
  MessageBuilder,
  parsePayload,
} from "./socket-protocol.ts";

describe("socket-protocol", () => {
  it("frameMessage round-trips through MessageParser for each JSON-backed type", () => {
    const samples: { type: MessageType; payload: Buffer | string | object }[] = [
      { type: MessageType.CONTROL_CMD, payload: { cmd: "resize", cols: 80, rows: 24 } },
      { type: MessageType.STATUS_UPDATE, payload: { app: "vt", status: "ok" } },
      { type: MessageType.ERROR, payload: { code: "E1", message: "m" } },
      { type: MessageType.STATUS_REQUEST, payload: {} },
      {
        type: MessageType.STATUS_RESPONSE,
        payload: { running: true, port: 4000 },
      },
      {
        type: MessageType.GIT_FOLLOW_REQUEST,
        payload: { enable: true },
      },
      {
        type: MessageType.GIT_FOLLOW_RESPONSE,
        payload: { success: true },
      },
      {
        type: MessageType.GIT_EVENT_NOTIFY,
        payload: { repoPath: "/r", type: "commit" },
      },
      { type: MessageType.GIT_EVENT_ACK, payload: { handled: true } },
    ];

    for (const { type, payload } of samples) {
      const framed = frameMessage(type, payload);
      const p = new MessageParser();
      p.addData(framed);
      const msgs = [...p.parseMessages()];
      expect(msgs.length).toBe(1);
      expect(msgs[0]!.type).toBe(type);
      const decoded = JSON.parse(msgs[0]!.payload.toString("utf8")) as object;
      expect(decoded).toEqual(payload as object);
    }
  });

  it("frameMessage supports raw Buffer and string payloads", () => {
    const buf = frameMessage(MessageType.STDIN_DATA, Buffer.from([0, 1, 2]));
    const p = new MessageParser();
    p.addData(buf);
    const [m] = [...p.parseMessages()];
    expect(m!.type).toBe(MessageType.STDIN_DATA);
    expect(Buffer.from(m!.payload).equals(Buffer.from([0, 1, 2]))).toBe(true);
  });

  it("MessageParser handles fragmented input across chunks", () => {
    const msg = MessageBuilder.resize(100, 50);
    const a = msg.subarray(0, 3);
    const b = msg.subarray(3);
    const p = new MessageParser();
    p.addData(a);
    expect([...p.parseMessages()].length).toBe(0);
    expect(p.pendingBytes).toBe(3);
    p.addData(b);
    const out = [...p.parseMessages()];
    expect(out.length).toBe(1);
    expect(out[0]!.type).toBe(MessageType.CONTROL_CMD);
    expect(p.pendingBytes).toBe(0);
  });

  it("MessageParser yields multiple messages in one chunk", () => {
    const m1 = MessageBuilder.heartbeat();
    const m2 = MessageBuilder.stdin("hi");
    const p = new MessageParser();
    p.addData(Buffer.concat([m1, m2]));
    const out = [...p.parseMessages()];
    expect(out.length).toBe(2);
    expect(out[0]!.type).toBe(MessageType.HEARTBEAT);
    expect(out[1]!.type).toBe(MessageType.STDIN_DATA);
    expect(out[1]!.payload.toString("utf8")).toBe("hi");
  });

  it("MessageParser waits when payload length exceeds available bytes", () => {
    const framed = frameMessage(MessageType.HEARTBEAT, Buffer.alloc(0));
    const partial = framed.subarray(0, framed.length - 1);
    const p = new MessageParser();
    p.addData(partial);
    expect([...p.parseMessages()].length).toBe(0);
    expect(p.pendingBytes).toBe(partial.length);
  });

  it("clear resets pending buffer", () => {
    const p = new MessageParser();
    p.addData(Buffer.from([1, 2, 3]));
    p.clear();
    expect(p.pendingBytes).toBe(0);
  });

  it("parsePayload maps types correctly", () => {
    expect(parsePayload(MessageType.STDIN_DATA, Buffer.from("abc", "utf8"))).toBe("abc");
    expect(parsePayload(MessageType.HEARTBEAT, Buffer.alloc(0))).toBeNull();
    const ctrl = Buffer.from(JSON.stringify({ cmd: "resize", cols: 1, rows: 2 }), "utf8");
    expect(parsePayload(MessageType.CONTROL_CMD, ctrl)).toEqual({
      cmd: "resize",
      cols: 1,
      rows: 2,
    });
  });

  it("parsePayload throws on invalid JSON for JSON message types", () => {
    expect(() => parsePayload(MessageType.ERROR, Buffer.from("not-json", "utf8"))).toThrow(
      /Failed to parse JSON payload/,
    );
  });

  it("MessageBuilder helpers produce decodable frames", () => {
    const parser = new MessageParser();
    parser.addData(MessageBuilder.statusRequest());
    parser.addData(MessageBuilder.statusResponse({ running: false }));
    const [a, b] = [...parser.parseMessages()];
    expect(parsePayload(a!.type, a!.payload)).toEqual({});
    expect(parsePayload(b!.type, b!.payload)).toEqual({ running: false });
  });
});
