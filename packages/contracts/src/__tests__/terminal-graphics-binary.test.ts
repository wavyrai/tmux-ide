import { describe, expect, it } from "vitest";
import {
  decodeTerminalGraphicsBinary,
  encodeTerminalGraphicsBinary,
  TERMINAL_GRAPHICS_BLOB_CHUNK_BYTES,
} from "../terminal-graphics.ts";
const header = {
  pane: "pane.one",
  blob: {
    digest: "a".repeat(32),
    format: "png" as const,
    width: 1,
    height: 1,
    total: 3,
    offset: 0,
  },
};
describe("binary graphics envelope", () => {
  it("preserves non-UTF8 bytes and respects subarray offsets", () => {
    const bytes = Uint8Array.of(0, 128, 255);
    const encoded = encodeTerminalGraphicsBinary(header, bytes);
    const padded = new Uint8Array(encoded.length + 12);
    padded.set(encoded, 7);
    const result = decodeTerminalGraphicsBinary(padded.subarray(7, 7 + encoded.length));
    expect(result.header).toEqual(header);
    expect(result.bytes).toEqual(bytes);
  });
  it("rejects truncated metadata, malformed lengths, empty and oversized payloads", () => {
    const encoded = encodeTerminalGraphicsBinary(header, Uint8Array.of(0, 128, 255));
    for (const length of [0, 1, 7, 8, 9, encoded.length - 3])
      expect(() => decodeTerminalGraphicsBinary(encoded.subarray(0, length))).toThrow();
    for (const magicIndex of [0, 3]) {
      const badMagic = encoded.slice();
      badMagic[magicIndex] = 0;
      expect(() => decodeTerminalGraphicsBinary(badMagic)).toThrow();
    }
    expect(() =>
      encodeTerminalGraphicsBinary(
        { ...header, blob: { ...header.blob, total: 64 * 1024 * 1024, offset: 64 * 1024 * 1024 } },
        Uint8Array.of(1),
      ),
    ).toThrow();
    const bad = encoded.slice();
    new DataView(bad.buffer).setUint32(4, 0xffffffff);
    expect(() => decodeTerminalGraphicsBinary(bad)).toThrow();
    expect(() => encodeTerminalGraphicsBinary(header, new Uint8Array())).toThrow();
    expect(() =>
      encodeTerminalGraphicsBinary(
        { ...header, blob: { ...header.blob, total: TERMINAL_GRAPHICS_BLOB_CHUNK_BYTES + 1 } },
        new Uint8Array(TERMINAL_GRAPHICS_BLOB_CHUNK_BYTES + 1),
      ),
    ).toThrow();
    expect(() =>
      encodeTerminalGraphicsBinary(
        { ...header, blob: { ...header.blob, offset: 3 } },
        Uint8Array.of(1),
      ),
    ).toThrow();
  });
  it("rejects malformed UTF8 and unknown metadata fields", () => {
    for (const json of [
      '{"pane":"pane.one","blob":{},"extra":true}',
      JSON.stringify({ ...header, blob: { ...header.blob, extra: true } }),
    ]) {
      const bytes = new TextEncoder().encode(json),
        data = new Uint8Array(9 + bytes.length);
      data.set([84, 71, 66, 49]);
      new DataView(data.buffer).setUint32(4, bytes.length);
      data.set(bytes, 8);
      expect(() => decodeTerminalGraphicsBinary(data)).toThrow();
    }
    const bad = encodeTerminalGraphicsBinary(header, Uint8Array.of(1));
    bad[8] = 255;
    expect(() => decodeTerminalGraphicsBinary(bad)).toThrow();
  });
});
