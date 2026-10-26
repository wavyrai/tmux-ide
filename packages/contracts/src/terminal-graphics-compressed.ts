import { z } from "zod";
import {
  TerminalGraphicsBinaryHeaderSchemaZ,
  TERMINAL_GRAPHICS_BINARY_HEADER_BYTES,
  TERMINAL_GRAPHICS_BLOB_CHUNK_BYTES,
} from "./terminal-graphics.ts";

/** TGB2 uses an independent zlib stream per chunk. Digest/offset/total still
 * describe the original image bytes. Decoders must require exact output length,
 * stream termination and complete input consumption before hashing or painting. */
export const TerminalGraphicsCompressedHeaderSchemaZ = TerminalGraphicsBinaryHeaderSchemaZ.extend({
  compression: z.literal("zlib"),
  decodedBytes: z.number().int().min(1).max(TERMINAL_GRAPHICS_BLOB_CHUNK_BYTES),
}).superRefine((header, context) => {
  if (
    header.blob.offset + header.decodedBytes > header.blob.total ||
    (header.blob.format !== "rgb" && header.blob.format !== "rgba")
  )
    context.addIssue({ code: "custom", message: "Invalid compressed graphics range or format" });
});
export type TerminalGraphicsCompressedHeader = z.infer<
  typeof TerminalGraphicsCompressedHeaderSchemaZ
>;
export function encodeTerminalGraphicsCompressed(
  header: TerminalGraphicsCompressedHeader,
  bytes: Uint8Array,
): Uint8Array {
  const parsed = TerminalGraphicsCompressedHeaderSchemaZ.parse(header);
  const json = new TextEncoder().encode(JSON.stringify(parsed));
  if (
    json.length > TERMINAL_GRAPHICS_BINARY_HEADER_BYTES ||
    bytes.length < 1 ||
    bytes.length >= parsed.decodedBytes
  )
    throw new Error("Invalid compressed graphics bounds");
  const result = new Uint8Array(8 + json.length + bytes.length);
  result.set([84, 71, 66, 50]);
  new DataView(result.buffer).setUint32(4, json.length, false);
  result.set(json, 8);
  result.set(bytes, 8 + json.length);
  return result;
}
/** Only parses the envelope; inflation belongs on the receiving worker. */
export function decodeTerminalGraphicsCompressed(data: Uint8Array): {
  header: TerminalGraphicsCompressedHeader;
  bytes: Uint8Array;
} {
  if (
    data.length < 10 ||
    data.length > 8 + TERMINAL_GRAPHICS_BINARY_HEADER_BYTES + TERMINAL_GRAPHICS_BLOB_CHUNK_BYTES ||
    data[0] !== 84 ||
    data[1] !== 71 ||
    data[2] !== 66 ||
    data[3] !== 50
  )
    throw new Error("Invalid compressed graphics frame");
  const length = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(4, false);
  if (length < 1 || length > TERMINAL_GRAPHICS_BINARY_HEADER_BYTES || 8 + length >= data.length)
    throw new Error("Invalid compressed graphics header");
  const header = TerminalGraphicsCompressedHeaderSchemaZ.parse(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(8, 8 + length))),
  );
  const bytes = data.subarray(8 + length);
  if (bytes.length >= header.decodedBytes) throw new Error("Invalid compressed graphics payload");
  return { header, bytes };
}
