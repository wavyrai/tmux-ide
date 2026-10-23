import { isOwnedTerminalReplicaRow } from "./terminal-replica-owned-row.ts";
import { z } from "zod";
import {
  TERMINAL_DELIVERY_MAX_REPRESENTATION_BYTES,
  TerminalProjectionSnapshotSchemaZ,
  TerminalProjectionPatchSchemaZ,
  TerminalProjectionPayloadSchemaZ,
  TerminalDeferredHistorySchemaZ,
  TerminalProjectionEnvelopeSchemaZ,
  TerminalProjectionReceiptSchemaZ,
  type TerminalReplicaSnapshot,
  type TerminalProjectionSnapshot,
  type TerminalProjectionPatch,
  type TerminalProjectionPayload,
  type TerminalDeferredHistory,
  type TerminalProjectionEnvelope,
  type TerminalProjectionReceipt,
} from "@tmux-ide/contracts";
import {
  hashTerminalReplicaRows,
  hashTerminalReplicaTombstone,
  freezeTerminalReplicaRow,
  terminalReplicaRowsEqual,
} from "./terminal-replica.ts";
import { hashCanonicalTerminalValue } from "./terminal-replica-hash-cache.ts";
import {
  BinaryTerminalWriter,
  BinaryTerminalLimitError,
  decodeBinaryTerminalTuple,
} from "./terminal-delivery-binary.ts";
import {
  TerminalDeliveryStateTooLargeError,
  writeTerminalProjectionRowCooperatively,
  encodeTerminalProjectionMetadataTuple,
  encodeTerminalProjectionViewportTuple,
  decodeTerminalProjectionViewportTuple,
  encodeTerminalProjectionPatchTuple,
  decodeTerminalProjectionPatchTuple,
  hashTerminalDeliveryRepresentation,
} from "./terminal-delivery.ts";

export function terminalHistoryCommitment(
  snapshot: TerminalReplicaSnapshot,
): TerminalDeferredHistory {
  return Object.freeze(
    TerminalDeferredHistorySchemaZ.parse({
      rows: snapshot.history.length,
      digest: hashTerminalReplicaRows(snapshot.history),
    }),
  );
}
export function projectAlternateSnapshot(
  snapshot: TerminalReplicaSnapshot,
): TerminalProjectionSnapshot {
  const { history: _history, ...viewport } = snapshot;
  void _history;
  const candidate = { ...viewport, deferredHistory: terminalHistoryCommitment(snapshot) };
  if (snapshot.grid.every(isOwnedTerminalReplicaRow)) {
    const metadata = projectionMetadata(candidate);
    validateViewportShape(snapshot.grid, metadata);
    return freezeProjection({ ...metadata, grid: snapshot.grid });
  }
  return freezeProjection(TerminalProjectionSnapshotSchemaZ.parse(candidate));
}
function freezeProjection(value: TerminalProjectionSnapshot): TerminalProjectionSnapshot {
  return Object.freeze({
    ...value,
    grid: (Object.isFrozen(value.grid) && value.grid.every(isOwnedTerminalReplicaRow)
      ? value.grid
      : Object.freeze(
          value.grid.map((row) =>
            isOwnedTerminalReplicaRow(row) ? row : freezeTerminalReplicaRow(row),
          ),
        )) as unknown as TerminalProjectionSnapshot["grid"],
    cursor: Object.freeze(value.cursor),
    modes: Object.freeze(value.modes),
    placements: Object.freeze(
      value.placements.map((p) => Object.freeze(p)),
    ) as unknown as TerminalProjectionSnapshot["placements"],
    bootstrap: Object.freeze(value.bootstrap),
    deferredHistory: Object.freeze(value.deferredHistory),
  });
}
const { grid: _projectionGrid, ...projectionMetadataShape } =
  TerminalProjectionSnapshotSchemaZ.shape;
void _projectionGrid;
const ProjectionMetadataSchema = z.object(projectionMetadataShape).strict();
function projectionMetadata(
  value: Omit<TerminalReplicaSnapshot, "history"> & { deferredHistory: TerminalDeferredHistory },
) {
  const { grid: _grid, ...metadata } = value;
  void _grid;
  return ProjectionMetadataSchema.parse(metadata);
}
function validateViewportShape(
  grid: TerminalProjectionSnapshot["grid"],
  metadata: Omit<TerminalProjectionSnapshot, "grid">,
): void {
  if (
    grid.length !== metadata.rows ||
    metadata.cols * metadata.rows > 1_000_000 ||
    grid.some((row) => !row || row.cells.length !== metadata.cols) ||
    metadata.cursor.x >= metadata.cols ||
    metadata.cursor.y >= metadata.rows ||
    metadata.placements.some(
      (p) => p.row + p.rows > metadata.rows || p.column + p.columns > metadata.cols,
    )
  )
    throw new TypeError("Invalid projection viewport");
}
export function hashTerminalProjection(value: TerminalProjectionSnapshot): string {
  return hashCanonicalTerminalValue([
    "terminal-projection-v1",
    value.cols,
    value.rows,
    hashTerminalReplicaRows(value.grid),
    value.cursor,
    value.modes,
    value.placements,
    value.bootstrap,
    [value.deferredHistory.rows, value.deferredHistory.digest],
  ]);
}
/** Checks the source root using its omitted-history commitment, not history materialization. */
export function hashSourceSnapshotFromProjection(value: TerminalProjectionSnapshot): string {
  return hashCanonicalTerminalValue([
    "terminal-replica-v1",
    value.cols,
    value.rows,
    hashTerminalReplicaRows(value.grid),
    value.deferredHistory.digest,
    value.cursor,
    value.modes,
    value.placements,
    value.bootstrap,
  ]);
}
function projectionEncodingError(error: unknown): never {
  if (error instanceof BinaryTerminalLimitError)
    throw new TerminalDeliveryStateTooLargeError(TERMINAL_DELIVERY_MAX_REPRESENTATION_BYTES + 1);
  throw error;
}
export function encodeTerminalProjection(input: TerminalProjectionPayload): Uint8Array {
  try {
    return encodeProjection(input);
  } catch (error) {
    return projectionEncodingError(error);
  }
}
function encodeProjection(input: TerminalProjectionPayload): Uint8Array {
  const value = TerminalProjectionPayloadSchemaZ.parse(input);
  const writer = new BinaryTerminalWriter();
  writer.header(
    value.frame,
    value.revision,
    value.frame === "seed" ? undefined : value.baseRevision,
    "TCP1",
  );
  if (value.frame === "tombstone") writer.value(value.tombstone.reason);
  else {
    const data = value.frame === "seed" ? value.projection : value.patch;
    const tuple =
      value.frame === "seed"
        ? encodeTerminalProjectionViewportTuple(value.projection)
        : encodeTerminalProjectionPatchTuple(value.patch);
    writer.value([...tuple, [data.deferredHistory.rows, data.deferredHistory.digest]]);
  }
  return writer.finish();
}
export function decodeTerminalProjection(bytes: Uint8Array): TerminalProjectionPayload {
  const decoded = decodeBinaryTerminalTuple(bytes, "TCP1");
  if (decoded.frame === "tombstone")
    return TerminalProjectionPayloadSchemaZ.parse({
      frame: decoded.frame,
      baseRevision: decoded.baseRevision,
      revision: decoded.revision,
      tombstone: { reason: decoded.value },
    });
  const tuple = decoded.value;
  const expected = decoded.frame === "seed" ? 8 : 7;
  if (!Array.isArray(tuple) || tuple.length !== expected)
    throw new TypeError("Invalid projection tuple");
  const deferred = tuple[expected - 1];
  if (!Array.isArray(deferred) || deferred.length !== 2)
    throw new TypeError("Invalid deferred history tuple");
  const deferredHistory = TerminalDeferredHistorySchemaZ.parse({
    rows: deferred[0],
    digest: deferred[1],
  });
  if (decoded.frame === "seed")
    return {
      frame: "seed",
      revision: decoded.revision,
      projection: freezeProjection(
        TerminalProjectionSnapshotSchemaZ.parse({
          ...decodeTerminalProjectionViewportTuple(tuple.slice(0, -1)),
          deferredHistory,
        }),
      ),
    };
  return TerminalProjectionPayloadSchemaZ.parse({
    frame: "patch",
    baseRevision: decoded.baseRevision,
    revision: decoded.revision,
    patch: { ...decodeTerminalProjectionPatchTuple(tuple.slice(0, -1)), deferredHistory },
  });
}
export function applyTerminalProjectionPatch(
  current: TerminalProjectionSnapshot,
  input: TerminalProjectionPatch,
): TerminalProjectionSnapshot {
  const patch = TerminalProjectionPatchSchemaZ.parse(input);
  const cols = patch.dimensions?.cols ?? current.cols,
    rows = patch.dimensions?.rows ?? current.rows;
  // A resize requires every visible row, avoiding invented blank cells or implicit history.
  if (cols !== current.cols || rows !== current.rows) {
    if (patch.rows.length !== rows || new Set(patch.rows.map((r) => r.index)).size !== rows)
      throw new TypeError("Projection resize requires complete visible rows");
  }
  const grid = current.grid.slice(0, rows);
  const indices = new Set<number>();
  for (const change of patch.rows) {
    if (indices.has(change.index) || change.index >= rows || change.row.cells.length !== cols)
      throw new TypeError("Invalid projection row patch");
    indices.add(change.index);
    const old = grid[change.index];
    grid[change.index] =
      old && terminalReplicaRowsEqual(old, change.row) ? old : freezeTerminalReplicaRow(change.row);
  }
  const candidate = {
    ...current,
    cols,
    rows,
    grid,
    cursor: patch.cursor ?? current.cursor,
    modes: patch.modes ?? current.modes,
    placements: patch.placements ?? current.placements,
    bootstrap: patch.bootstrap ?? current.bootstrap,
    deferredHistory: patch.deferredHistory,
  };
  // Validate without using the parsed copy so unchanged immutable rows retain identity.
  validateViewportShape(grid, projectionMetadata(candidate));
  return freezeProjection(candidate);
}
export interface TerminalProjectionState {
  readonly receipt: TerminalProjectionReceipt;
  readonly projection: TerminalProjectionSnapshot | null;
}
export function hashTerminalProjectionTombstone(reason: string): string {
  return hashCanonicalTerminalValue(["terminal-projection-tombstone-v1", reason]);
}
/** Atomic projection commit. Only this verified path creates a receipt; failures leave current intact. */
export function commitTerminalProjection(
  current: TerminalProjectionState | null,
  envelope: TerminalProjectionEnvelope,
  bytes: Uint8Array,
): TerminalProjectionState {
  const frame = TerminalProjectionEnvelopeSchemaZ.parse(envelope);
  if (
    bytes.length !== frame.representationBytes ||
    hashTerminalDeliveryRepresentation(bytes) !== frame.representationHash
  )
    throw new TypeError("Projection representation mismatch");
  const value = decodeTerminalProjection(bytes);
  if (
    value.frame !== frame.frame ||
    value.revision !== frame.canonicalRevision ||
    (value.frame === "seed"
      ? frame.baseRevision !== null
      : value.baseRevision !== frame.baseRevision)
  )
    throw new TypeError("Projection envelope mismatch");
  if (current) {
    for (const key of [
      "workspaceName",
      "semanticPaneId",
      "generation",
      "incarnation",
      "deliveryNonce",
    ] as const)
      if (current.receipt[key] !== frame[key]) throw new TypeError("Projection lifetime mismatch");
    if (
      value.revision < current.receipt.canonicalRevision ||
      (value.revision === current.receipt.canonicalRevision &&
        (frame.canonicalStateHash !== current.receipt.canonicalStateHash ||
          frame.projectionStateHash !== current.receipt.projectionStateHash))
    )
      throw new TypeError("Stale projection revision");
    if (current.projection === null) throw new TypeError("Projection lifetime is closed");
  }
  if (
    value.frame !== "seed" &&
    (!current || current.receipt.canonicalRevision !== value.baseRevision)
  )
    throw new TypeError("Projection baseline mismatch");
  const projection =
    value.frame === "seed"
      ? value.projection
      : value.frame === "patch"
        ? applyTerminalProjectionPatch(current!.projection!, value.patch)
        : null;
  const projectionHash = projection
    ? hashTerminalProjection(projection)
    : hashTerminalProjectionTombstone(value.frame === "tombstone" ? value.tombstone.reason : "");
  const sourceHash = projection
    ? hashSourceSnapshotFromProjection(projection)
    : hashTerminalReplicaTombstone(value.frame === "tombstone" ? value.tombstone.reason : "");
  if (projectionHash !== frame.projectionStateHash || sourceHash !== frame.canonicalStateHash)
    throw new TypeError("Projection state proof mismatch");
  const receipt = TerminalProjectionReceiptSchemaZ.parse({
    type: "terminal.projection.receipt",
    workspaceName: frame.workspaceName,
    semanticPaneId: frame.semanticPaneId,
    generation: frame.generation,
    incarnation: frame.incarnation,
    deliveryNonce: frame.deliveryNonce,
    transactionId: frame.transactionId,
    canonicalRevision: frame.canonicalRevision,
    canonicalStateHash: frame.canonicalStateHash,
    projectionStateHash: frame.projectionStateHash,
    representationHash: frame.representationHash,
  });
  return Object.freeze({ projection, receipt: Object.freeze(receipt) });
}

function rowCheckpoints(
  writer: BinaryTerminalWriter,
  options: { readonly yieldControl: () => Promise<void>; readonly signal?: AbortSignal },
) {
  let cells = 0,
    bytes = writer.byteLength;
  return async (length: number) => {
    cells += length;
    if (cells >= 256 || writer.byteLength - bytes >= 32 * 1024) {
      cells = 0;
      bytes = writer.byteLength;
      await options.yieldControl();
      options.signal?.throwIfAborted();
    }
  };
}

/** Task checkpoints bound cell validation and emission even for a single giant row. */
async function encodeProjectionCooperatively(
  input: TerminalProjectionPayload,
  options: { readonly yieldControl: () => Promise<void>; readonly signal?: AbortSignal },
): Promise<Uint8Array> {
  options.signal?.throwIfAborted();
  if (input.frame === "tombstone") return encodeTerminalProjection(input);
  if (input.frame === "patch") {
    const { patch, ...header } = input;
    const parsedHeader = z
      .object({
        frame: z.literal("patch"),
        revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
        baseRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
      })
      .strict()
      .parse(header);
    if (parsedHeader.revision <= parsedHeader.baseRevision)
      throw new TypeError("Projection revision must advance");
    const { rows, ...metadata } = patch;
    const { rows: _rowSchema, ...shape } = TerminalProjectionPatchSchemaZ.shape;
    void _rowSchema;
    const parsed = z.object(shape).strict().parse(metadata);
    if (
      !Array.isArray(rows) ||
      rows.length > 4096 ||
      (parsed.dimensions && (parsed.dimensions.cols > 4096 || parsed.dimensions.rows > 4096))
    )
      throw new TypeError("Projection patch bound");
    let cells = 0;
    const indices = new Set<number>();
    const writer = new BinaryTerminalWriter();
    writer.header("patch", parsedHeader.revision, parsedHeader.baseRevision, "TCP1");
    writer.array(7);
    writer.value(parsed.dimensions ? [parsed.dimensions.cols, parsed.dimensions.rows] : null);
    writer.array(rows.length);
    const checkpoint = rowCheckpoints(writer, options);
    for (const entry of rows) {
      const parsedEntry = z
        .object({ index: z.number().int().min(0).max(4095), row: z.unknown() })
        .strict()
        .parse(entry);
      if (indices.has(parsedEntry.index)) throw new TypeError("Duplicate projection row");
      indices.add(parsedEntry.index);
      cells += entry.row.cells.length;
      if (cells > 1_000_000) throw new TypeError("Projection cell bound");
      writer.array(2);
      writer.value(parsedEntry.index);
      await writeTerminalProjectionRowCooperatively(
        writer,
        entry.row,
        parsed.dimensions?.cols ?? null,
        options,
      );
      await checkpoint(entry.row.cells.length);
    }
    const tuple = encodeTerminalProjectionPatchTuple({ ...parsed, rows: [] });
    writer.value(tuple[2]);
    writer.value(tuple[3]);
    if (tuple[4] === null) writer.value(null);
    else {
      const placements = tuple[4] as readonly unknown[];
      writer.array(placements.length);
      for (const value of placements) {
        writer.value(value);
        await options.yieldControl();
        options.signal?.throwIfAborted();
      }
    }
    writer.value(tuple[5]);
    writer.value([parsed.deferredHistory.rows, parsed.deferredHistory.digest]);
    options.signal?.throwIfAborted();
    return writer.finish();
  }
  const { projection, ...header } = input;
  const parsedHeader = z
    .object({
      frame: z.literal("seed"),
      revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    })
    .strict()
    .parse(header);
  const { grid, ...metadata } = projection;
  const { grid: _gridSchema, ...metadataShape } = TerminalProjectionSnapshotSchemaZ.shape;
  void _gridSchema;
  const parsed = z.object(metadataShape).strict().parse(metadata);
  if (
    !Array.isArray(grid) ||
    grid.length !== parsed.rows ||
    parsed.cols * parsed.rows > 1_000_000 ||
    parsed.cursor.x >= parsed.cols ||
    parsed.cursor.y >= parsed.rows ||
    parsed.placements.some(
      (p) => p.row + p.rows > parsed.rows || p.column + p.columns > parsed.cols,
    )
  )
    throw new TypeError("Invalid projection dimensions");
  const writer = new BinaryTerminalWriter();
  writer.header("seed", parsedHeader.revision, undefined, "TCP1");
  writer.array(8);
  writer.value(parsed.cols);
  writer.value(parsed.rows);
  writer.array(grid.length);
  const checkpoint = rowCheckpoints(writer, options);
  for (const row of grid) {
    await writeTerminalProjectionRowCooperatively(writer, row, parsed.cols, options);
    await checkpoint(row.cells.length);
  }
  const tuple = encodeTerminalProjectionMetadataTuple(parsed);
  writer.value(tuple[0]);
  writer.value(tuple[1]);
  const placements = tuple[2] as readonly unknown[];
  writer.array(placements.length);
  for (const placement of placements) {
    writer.value(placement);
    await options.yieldControl();
    options.signal?.throwIfAborted();
  }
  writer.value(tuple[3]);
  writer.value([parsed.deferredHistory.rows, parsed.deferredHistory.digest]);
  options.signal?.throwIfAborted();
  return writer.finish();
}

export async function encodeTerminalProjectionCooperatively(
  input: TerminalProjectionPayload,
  options: { readonly yieldControl: () => Promise<void>; readonly signal?: AbortSignal },
): Promise<Uint8Array> {
  try {
    return await encodeProjectionCooperatively(input, options);
  } catch (error) {
    return projectionEncodingError(error);
  }
}
