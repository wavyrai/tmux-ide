import { describe, expect, it } from "vitest";
import {
  TERMINAL_ATTACHMENT_INPUT_FRAME_HEADER_BYTES,
  TERMINAL_ATTACHMENT_MAX_INPUT_FRAME_BYTES,
  TerminalAttachmentInputAckFrameSchemaZ,
  TerminalAttachmentInputCapabilitySchemaZ,
  decodeTerminalAttachmentInputFrame,
  encodeTerminalAttachmentInputFrame,
} from "../terminal-attachment-stream.ts";

describe("terminal attachment input wire", () => {
  it("round-trips an exact binary payload and big-endian monotonic sequence", () => {
    const payload = Uint8Array.of(0, 1, 0x80, 0xff);
    const encoded = encodeTerminalAttachmentInputFrame(0x0102_0304, payload);

    expect([...encoded.slice(0, TERMINAL_ATTACHMENT_INPUT_FRAME_HEADER_BYTES)]).toEqual([
      1, 1, 2, 3, 4,
    ]);
    const decoded = decodeTerminalAttachmentInputFrame(encoded);
    expect(decoded?.sequence).toBe(0x0102_0304);
    expect(decoded?.payload).toEqual(payload);
  });

  it("rejects empty, malformed, zero-sequence, and oversized input without payload reflection", () => {
    expect(() => encodeTerminalAttachmentInputFrame(0, Uint8Array.of(1))).toThrow(/sequence/u);
    expect(() => encodeTerminalAttachmentInputFrame(1, new Uint8Array())).toThrow(/non-empty/u);
    expect(() =>
      encodeTerminalAttachmentInputFrame(
        1,
        new Uint8Array(TERMINAL_ATTACHMENT_MAX_INPUT_FRAME_BYTES + 1),
      ),
    ).toThrow(/wire bound/u);
    expect(decodeTerminalAttachmentInputFrame(Uint8Array.of(1, 0, 0, 0, 0, 7))).toBeNull();
    expect(decodeTerminalAttachmentInputFrame(Uint8Array.of(2, 0, 0, 0, 1, 7))).toBeNull();
  });

  it("keeps ready limits and acknowledgements strict and renderer-safe", () => {
    const limits = {
      maxFrameBytes: 16 * 1024,
      maxAcceptedBytes: 256 * 1024,
      maxAcceptedFrames: 8_192,
    };
    expect(TerminalAttachmentInputCapabilitySchemaZ.parse({ mode: "bounded", limits })).toEqual({
      mode: "bounded",
      limits,
    });
    expect(
      TerminalAttachmentInputCapabilitySchemaZ.safeParse({
        mode: "bounded",
        limits: { ...limits, maxFrameBytes: limits.maxAcceptedBytes + 1 },
      }).success,
    ).toBe(false);

    const ack = {
      type: "input-ack" as const,
      protocolVersion: 1 as const,
      generation: 2,
      sequence: 3,
      byteLength: 4,
      state: "open" as const,
      acceptedBytes: 12,
      acceptedFrames: 3,
      remainingBytes: 100,
      remainingFrames: 20,
    };
    expect(TerminalAttachmentInputAckFrameSchemaZ.parse(ack)).toEqual(ack);
    expect(
      TerminalAttachmentInputAckFrameSchemaZ.safeParse({ ...ack, redemptionTicket: "secret" })
        .success,
    ).toBe(false);
  });
});
