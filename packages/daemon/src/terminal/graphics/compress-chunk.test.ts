import { randomBytes } from "node:crypto";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  decodeTerminalGraphicsCompressed,
  TERMINAL_GRAPHICS_BLOB_CHUNK_BYTES,
} from "@tmux-ide/contracts";
import { compressGraphicsChunk } from "./compress-chunk.ts";
const header = {
  pane: "pane.one",
  blob: {
    digest: "a".repeat(32),
    format: "rgba" as const,
    width: 256,
    height: 512,
    total: TERMINAL_GRAPHICS_BLOB_CHUNK_BYTES,
    offset: 0,
  },
};
describe("bounded asynchronous raw image compression", () => {
  it("preserves original bytes and metadata", async () => {
    const raw = Buffer.alloc(TERMINAL_GRAPHICS_BLOB_CHUNK_BYTES, 42);
    const frame = await compressGraphicsChunk(header, raw);
    expect(frame).not.toBeNull();
    const decoded = decodeTerminalGraphicsCompressed(frame!);
    expect(decoded.header).toEqual({ ...header, compression: "zlib", decodedBytes: raw.length });
    expect(inflateSync(decoded.bytes)).toEqual(raw);
  });
  it("falls back without queueing when two chunks are already in flight", async () => {
    const raw = Buffer.alloc(TERMINAL_GRAPHICS_BLOB_CHUNK_BYTES, 42);
    const first = compressGraphicsChunk(header, raw);
    const second = compressGraphicsChunk(header, raw);
    const busy = compressGraphicsChunk(header, raw);
    expect(await busy).toBeNull();
    expect((await Promise.all([first, second])).every(Boolean)).toBe(true);
    expect(await compressGraphicsChunk(header, raw)).not.toBeNull();
  });
  it("skips tiny, encoded and incompressible payloads", async () => {
    expect(await compressGraphicsChunk(header, Buffer.alloc(4095))).toBeNull();
    expect(
      await compressGraphicsChunk(
        { ...header, blob: { ...header.blob, format: "png" } },
        Buffer.alloc(8192),
      ),
    ).toBeNull();
    expect(await compressGraphicsChunk(header, randomBytes(8192))).toBeNull();
  });
});
