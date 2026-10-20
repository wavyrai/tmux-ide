import { z } from "zod";

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
/** Raw image bytes per blob frame (base64 on the wire stays below 1 MiB). */
export const TERMINAL_GRAPHICS_BLOB_CHUNK_BYTES = 512 * 1024;
/** Largest single image a daemon publishes. */
export const TERMINAL_GRAPHICS_MAX_IMAGE_BYTES = 32 * 1024 * 1024;
export const TERMINAL_GRAPHICS_MAX_IMAGES = 256;
export const TERMINAL_GRAPHICS_MAX_PLACEMENTS = 256;
export const TERMINAL_GRAPHICS_MAX_REQUEST_DIGESTS = 64;

export const TerminalGraphicsDigestSchemaZ = z.string().regex(/^[0-9a-f]{32}$/u);
export const TerminalGraphicsFormatSchemaZ = z.enum(["png", "rgba", "rgb"]);
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
