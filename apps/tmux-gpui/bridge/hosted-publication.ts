import { MAX_COMPACT_CELLS, MAX_COMPACT_GRAPHEME_BYTES } from "./compact-snapshot.ts";
import type { HostedLiveEvent } from "./hosted-live-types.ts";
import { z } from "zod";
import {
  TerminalReplicaSnapshotSchemaZ,
  type TerminalReplicaSnapshot,
} from "../../../packages/contracts/src/terminal-replica.ts";
import {
  TerminalGraphicsBlobSchemaZ,
  TERMINAL_GRAPHICS_BLOB_CHUNK_BYTES,
} from "../../../packages/contracts/src/terminal-graphics.ts";
import type { KittyImageBytes } from "./kitty-graphics.ts";

const envelope = z
  .array(z.object({ paneId: z.string().min(1).max(512), snapshot: z.unknown() }).strict())
  .max(24);
const imageMetadata = TerminalGraphicsBlobSchemaZ.extend({
  image: z.string().min(1).max(600).optional(),
}).strict();
/** Keep the existing snapshot validation while retaining immutable replica row identity. */
export function createHostedSurfaceValidator() {
  const bounds = createSnapshotBounds();
  const validated = new WeakSet<object>();
  return (value: unknown) => {
    return envelope.parse(value).map(({ paneId, snapshot }) => {
      if (!snapshot || typeof snapshot !== "object") throw Error("Invalid hosted snapshot");
      if (!validated.has(snapshot)) {
        bounds(snapshot as TerminalReplicaSnapshot);
        TerminalReplicaSnapshotSchemaZ.parse(snapshot);
        validated.add(snapshot);
      }
      return { paneId, snapshot: snapshot as TerminalReplicaSnapshot };
    });
  };
}
export function validateHostedImage(value: KittyImageBytes) {
  const metadata = imageMetadata.parse(value.metadata),
    bytes = value.bytes;
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength > TERMINAL_GRAPHICS_BLOB_CHUNK_BYTES ||
    metadata.offset + bytes.byteLength > metadata.total
  )
    throw Error("Invalid hosted image chunk");
  return { metadata, bytes };
}

// Preserve the compact helper's per-snapshot limits before retaining typed state.
function createSnapshotBounds() {
  const known = new WeakSet<object>();
  return (snapshot: TerminalReplicaSnapshot) => {
    if (known.has(snapshot)) return;
    if (
      !Number.isSafeInteger(snapshot.cols) ||
      !Number.isSafeInteger(snapshot.rows) ||
      snapshot.cols < 1 ||
      snapshot.cols > 65535 ||
      snapshot.rows < 1 ||
      snapshot.rows > 65535 ||
      !Array.isArray(snapshot.grid) ||
      !Array.isArray(snapshot.history) ||
      snapshot.grid.length !== snapshot.rows ||
      snapshot.cols * (snapshot.rows + snapshot.history.length) > MAX_COMPACT_CELLS
    )
      throw Error("Hosted snapshot dimensions exceed bounds");
    let bytes = 0;
    for (const row of [...snapshot.grid, ...snapshot.history]) {
      if (row.cells.length !== snapshot.cols) throw Error("Hosted snapshot row width mismatch");
      for (const cell of row.cells) {
        bytes += Buffer.byteLength(cell.grapheme);
        if (bytes > MAX_COMPACT_GRAPHEME_BYTES) throw Error("Hosted snapshot text exceeds bounds");
      }
    }
    const { grid: _, history: __, ...metadata } = snapshot;
    if (Buffer.byteLength(JSON.stringify(metadata)) > 8 * 1024 * 1024)
      throw Error("Hosted snapshot metadata exceeds bounds");
    known.add(snapshot);
  };
}
export function createHostedPublicationBounds() {
  const bounds = createSnapshotBounds();
  return (event: HostedLiveEvent) => {
    if (!("connection" in event)) return;
    const { snapshot, surfaces, ...metadata } = event;
    if (surfaces && surfaces.length > 24) throw Error("Too many hosted surfaces");
    if (snapshot) bounds(snapshot);
    for (const surface of surfaces ?? []) bounds(surface.snapshot);
    if (Buffer.byteLength(JSON.stringify(metadata)) > 8 * 1024 * 1024)
      throw Error("Hosted publication metadata exceeds bounds");
  };
}
