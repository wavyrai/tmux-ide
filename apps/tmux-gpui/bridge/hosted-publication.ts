import { isOwnedTerminalReplicaRow } from "../../../packages/core/src/terminal-replica-owned-row.ts";
import { MAX_COMPACT_CELLS, MAX_COMPACT_GRAPHEME_BYTES } from "./compact-snapshot.ts";
import type { HostedLiveEvent } from "./hosted-live-types.ts";
import { z } from "zod";
import {
  TerminalReplicaSnapshotSchemaZ,
  TerminalReplicaRowSchemaZ,
  type TerminalReplicaRow,
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
  return (value: unknown) => {
    return envelope.parse(value).map(({ paneId, snapshot }) => {
      if (!snapshot || typeof snapshot !== "object") throw Error("Invalid hosted snapshot");
      bounds(snapshot as TerminalReplicaSnapshot);
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

const snapshotMetadata = TerminalReplicaSnapshotSchemaZ.omit({ grid: true, history: true });
type RowBounds = Readonly<{ width: number; graphemeBytes: number }>;

// Only core-owned immutable data rows earn cache reuse. Object.freeze on a foreign
// object does not prove ownership (it may contain getters or mutable nested cells).
// Public mutable snapshots/rows are checked again on every call; snapshot identity
// never bypasses current metadata, row widths, or aggregate history budgets.
function createSnapshotBounds() {
  const knownRows = new WeakMap<TerminalReplicaRow, RowBounds>();
  function rowBounds(row: TerminalReplicaRow): RowBounds {
    const owned = isOwnedTerminalReplicaRow(row);
    const cached = owned ? knownRows.get(row) : undefined;
    if (cached) return cached;
    if (!row || !Array.isArray(row.cells) || row.cells.length > MAX_COMPACT_CELLS)
      throw Error("Hosted snapshot row exceeds bounds");
    // Parse only a changed/untrusted row, never clone the whole grid/history.
    const parsed = TerminalReplicaRowSchemaZ.parse(row);
    let graphemeBytes = 0;
    for (const cell of parsed.cells) {
      graphemeBytes += Buffer.byteLength(cell.grapheme);
      if (graphemeBytes > MAX_COMPACT_GRAPHEME_BYTES)
        throw Error("Hosted snapshot text exceeds bounds");
    }
    const result = { width: parsed.cells.length, graphemeBytes };
    if (owned) knownRows.set(row, result);
    return result;
  }
  return (snapshot: TerminalReplicaSnapshot) => {
    const metadata = Object.fromEntries(
      Object.entries(snapshot).filter(([key]) => key !== "grid" && key !== "history"),
    );
    snapshotMetadata.parse(metadata);
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
    for (const rows of [snapshot.grid, snapshot.history]) {
      for (const row of rows) {
        const measured = rowBounds(row);
        if (measured.width !== snapshot.cols) throw Error("Hosted snapshot row width mismatch");
        // Count occurrences, not distinct identities: history may repeat a cached row.
        bytes += measured.graphemeBytes;
        if (bytes > MAX_COMPACT_GRAPHEME_BYTES) throw Error("Hosted snapshot text exceeds bounds");
      }
    }
    if (Buffer.byteLength(JSON.stringify(metadata)) > 8 * 1024 * 1024)
      throw Error("Hosted snapshot metadata exceeds bounds");
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
