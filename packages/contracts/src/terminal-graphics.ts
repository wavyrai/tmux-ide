import { z } from "zod";
import { TerminalAttachmentSemanticPaneIdSchemaZ } from "./semantic-identity.ts";

/**
 * Kitty graphics protocol side channel.
 *
 * Image bytes never enter the canonical terminal replica: the replica keeps
 * the cells (including Unicode placeholder cells, which tmux retains as text)
 * and this channel carries, per pane, the image registry those cells refer to
 * plus best-effort cursor-anchored placements. Bytes travel separately, once
 * per content digest, and only when a renderer asks for them.
 *
 * Capability: a renderer that understands these frames adds
 * {@link TERMINAL_GRAPHICS_CAPABILITY_VERSION} to its terminal-delivery offer's
 * `protocolVersions`. Daemons that predate the channel ignore the extra
 * version; daemons that know it send graphics frames only to such renderers.
 */
export const TERMINAL_GRAPHICS_CAPABILITY_VERSION = 101;
/** Raw binary blob frames; requires the graphics side channel (101). */
export const TERMINAL_GRAPHICS_BINARY_CAPABILITY_VERSION = 107;
/** Verified same-host file leases, including binary-blob fallback (107).
 * Offer 108 instead of 107 to retain the existing eight-capability bound.
 * Never infer locality from a loopback URL. */
export const TERMINAL_GRAPHICS_LOCAL_CAPABILITY_VERSION = 108;
/** Renderers that inflate `rgba-zlib`/`rgb-zlib` themselves offer this too. */
export const TERMINAL_GRAPHICS_ZLIB_CAPABILITY_VERSION = 102;
/**
 * Renderers that report their cell size in device pixels offer this; the
 * daemon then marks graphics state with `cellPixels: true` and accepts
 * `terminal-cell-pixels`, so programs size images 1:1 for the window.
 */
export const TERMINAL_GRAPHICS_CELL_PIXELS_CAPABILITY_VERSION = 103;
/** Thousandths of a device pixel, avoiding accumulated per-cell rounding. */
export const TERMINAL_GRAPHICS_PRECISE_PIXELS_CAPABILITY_VERSION = 104;
/** Raw image bytes per blob frame (base64 on the wire stays below 1 MiB). */
export const TERMINAL_GRAPHICS_BLOB_CHUNK_BYTES = 512 * 1024;
/** Largest single image a daemon publishes (a 4K RGBA frame is ~33 MB). */
export const TERMINAL_GRAPHICS_MAX_IMAGE_BYTES = 64 * 1024 * 1024;
/** What renderers without the zlib capability accept. */
export const TERMINAL_GRAPHICS_LEGACY_MAX_IMAGE_BYTES = 32 * 1024 * 1024;
export const TERMINAL_GRAPHICS_MAX_IMAGES = 256;
export const TERMINAL_GRAPHICS_MAX_PLACEMENTS = 256;
export const TERMINAL_GRAPHICS_MAX_REQUEST_DIGESTS = 64;

export const TerminalGraphicsDigestSchemaZ = z.string().regex(/^[0-9a-f]{32}$/u);
/**
 * `*-zlib` carry raw pixels still deflated as the program sent them (`o=z`);
 * only renderers that offered {@link TERMINAL_GRAPHICS_ZLIB_CAPABILITY_VERSION}
 * receive them.
 */
export const TerminalGraphicsFormatSchemaZ = z.enum([
  "png",
  "rgba",
  "rgb",
  "rgba-zlib",
  "rgb-zlib",
]);
export type TerminalGraphicsFormat = z.infer<typeof TerminalGraphicsFormatSchemaZ>;
const Dimension = z.number().int().min(1).max(10_000);
const Cells = z.number().int().min(1).max(1_000);
const CellIndex = z.number().int().min(0).max(1_000);

export const TerminalGraphicsImageSchemaZ = z
  .object({
    /** Program-chosen kitty image id (placeholder cells encode it in colour). */
    imageId: z.number().int().min(0).max(0xffff_ffff),
    digest: TerminalGraphicsDigestSchemaZ,
    format: TerminalGraphicsFormatSchemaZ,
    width: Dimension,
    height: Dimension,
    bytes: z.number().int().min(1).max(TERMINAL_GRAPHICS_MAX_IMAGE_BYTES),
    /** The `U=1` virtual placement's cell grid, when placeholders may show it. */
    placeholder: z.object({ columns: Cells, rows: Cells }).strict().nullable(),
  })
  .strict();
export type TerminalGraphicsImage = z.infer<typeof TerminalGraphicsImageSchemaZ>;

/** A cursor-anchored placement clipped to the pane viewport (best effort). */
export const TerminalGraphicsPlacementSchemaZ = z
  .object({
    digest: TerminalGraphicsDigestSchemaZ,
    row: CellIndex,
    column: CellIndex,
    rows: Cells,
    columns: Cells,
    sourceRow: CellIndex,
    sourceColumn: CellIndex,
    totalRows: Cells,
    totalColumns: Cells,
  })
  .strict();
export type TerminalGraphicsPlacement = z.infer<typeof TerminalGraphicsPlacementSchemaZ>;

export const TerminalGraphicsStateSchemaZ = z
  .object({
    revision: z.number().int().nonnegative(),
    images: z.array(TerminalGraphicsImageSchemaZ).max(TERMINAL_GRAPHICS_MAX_IMAGES),
    placements: z.array(TerminalGraphicsPlacementSchemaZ).max(TERMINAL_GRAPHICS_MAX_PLACEMENTS),
    /** The daemon accepts `terminal-cell-pixels` (only sent to renderers offering 103). */
    cellPixels: z.literal(true).optional(),
    preciseCellPixels: z.literal(true).optional(),
    binaryBlobs: z.literal(true).optional(),
    localFiles: z.literal(true).optional(),
  })
  .strict();
export type TerminalGraphicsState = z.infer<typeof TerminalGraphicsStateSchemaZ>;

export const TerminalGraphicsBlobSchemaZ = z
  .object({
    digest: TerminalGraphicsDigestSchemaZ,
    format: TerminalGraphicsFormatSchemaZ,
    width: Dimension,
    height: Dimension,
    total: z.number().int().min(1).max(TERMINAL_GRAPHICS_MAX_IMAGE_BYTES),
    offset: z.number().int().nonnegative().max(TERMINAL_GRAPHICS_MAX_IMAGE_BYTES),
  })
  .strict();
export type TerminalGraphicsBlob = z.infer<typeof TerminalGraphicsBlobSchemaZ>;

/** Hub → transport messages (in-process; the transport frames them). */
export type TerminalGraphicsServerMessage =
  | { readonly type: "terminal.graphics"; readonly state: TerminalGraphicsState }
  | {
      readonly type: "terminal.graphics.blob";
      readonly blob: TerminalGraphicsBlob;
      readonly bytes: Uint8Array;
    };

/** TGB1 + u32be header bytes + strict JSON {pane,blob} + raw payload.
 * No compression is applied here: PNG and negotiated zlib are already encoded.
 */
export const TERMINAL_GRAPHICS_BINARY_HEADER_BYTES = 4096;
export const TerminalGraphicsBinaryHeaderSchemaZ = z
  .object({
    pane: TerminalAttachmentSemanticPaneIdSchemaZ,
    blob: TerminalGraphicsBlobSchemaZ,
  })
  .strict();
export type TerminalGraphicsBinaryHeader = z.infer<typeof TerminalGraphicsBinaryHeaderSchemaZ>;
export function encodeTerminalGraphicsBinary(
  header: TerminalGraphicsBinaryHeader,
  bytes: Uint8Array,
): Uint8Array {
  const parsed = TerminalGraphicsBinaryHeaderSchemaZ.parse(header);
  const json = new TextEncoder().encode(JSON.stringify(parsed));
  if (
    json.length > TERMINAL_GRAPHICS_BINARY_HEADER_BYTES ||
    bytes.length < 1 ||
    bytes.length > TERMINAL_GRAPHICS_BLOB_CHUNK_BYTES ||
    parsed.blob.offset + bytes.length > parsed.blob.total
  )
    throw new Error("Invalid binary graphics bounds");
  const result = new Uint8Array(8 + json.length + bytes.length);
  result.set([84, 71, 66, 49]);
  new DataView(result.buffer).setUint32(4, json.length, false);
  result.set(json, 8);
  result.set(bytes, 8 + json.length);
  return result;
}
export function decodeTerminalGraphicsBinary(data: Uint8Array): {
  header: TerminalGraphicsBinaryHeader;
  bytes: Uint8Array;
} {
  if (
    data.length < 10 ||
    data.length > 8 + TERMINAL_GRAPHICS_BINARY_HEADER_BYTES + TERMINAL_GRAPHICS_BLOB_CHUNK_BYTES ||
    data[0] !== 84 ||
    data[1] !== 71 ||
    data[2] !== 66 ||
    data[3] !== 49
  )
    throw new Error("Invalid binary graphics frame");
  const length = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(4, false);
  if (length < 1 || length > TERMINAL_GRAPHICS_BINARY_HEADER_BYTES || 8 + length >= data.length)
    throw new Error("Invalid binary graphics header");
  const header = TerminalGraphicsBinaryHeaderSchemaZ.parse(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(8, 8 + length))),
  );
  const bytes = data.subarray(8 + length);
  if (
    bytes.length > TERMINAL_GRAPHICS_BLOB_CHUNK_BYTES ||
    header.blob.offset + bytes.length > header.blob.total
  )
    throw new Error("Invalid binary graphics payload");
  return { header, bytes };
}
