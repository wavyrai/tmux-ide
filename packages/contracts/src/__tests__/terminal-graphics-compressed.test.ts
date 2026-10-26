import { deflateSync, inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  decodeTerminalGraphicsCompressed,
  encodeTerminalGraphicsCompressed,
} from "../terminal-graphics-compressed.ts";
const raw = Buffer.alloc(4096, 42);
const header = {
  pane: "pane.one",
  blob: {
    digest: "a".repeat(32),
    format: "rgba" as const,
    width: 32,
    height: 32,
    total: raw.length,
    offset: 0,
  },
  compression: "zlib" as const,
  decodedBytes: raw.length,
};
describe("compressed binary graphics envelope", () => {
  it("round trips bounded independent chunks with a subarray offset", () => {
    const frame = encodeTerminalGraphicsCompressed(header, deflateSync(raw));
    const padded = new Uint8Array(frame.length + 12);
    padded.set(frame, 7);
    const result = decodeTerminalGraphicsCompressed(padded.subarray(7, 7 + frame.length));
    expect(result.header).toEqual(header);
    expect(inflateSync(result.bytes)).toEqual(raw);
  });
  it("rejects malformed framing, unbounded decoded lengths and unsupported formats", () => {
    const frame = encodeTerminalGraphicsCompressed(header, deflateSync(raw));
    for (const length of [0, 7, 8, 9])
      expect(() => decodeTerminalGraphicsCompressed(frame.subarray(0, length))).toThrow();
    const corrupt = frame.slice();
    corrupt[3] = 49;
    expect(() => decodeTerminalGraphicsCompressed(corrupt)).toThrow();
    for (const decodedBytes of [0, 4097, 524289, Number.MAX_SAFE_INTEGER])
      expect(() =>
        encodeTerminalGraphicsCompressed({ ...header, decodedBytes }, deflateSync(raw)),
      ).toThrow();
    expect(() =>
      encodeTerminalGraphicsCompressed(
        { ...header, blob: { ...header.blob, format: "png" } },
        deflateSync(raw),
      ),
    ).toThrow();
    expect(() => encodeTerminalGraphicsCompressed(header, raw)).toThrow();
    expect(() => encodeTerminalGraphicsCompressed(header, new Uint8Array())).toThrow();
  });
});
