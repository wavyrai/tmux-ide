import {
  TERMINAL_DELIVERY_CHUNK_BYTES,
  TERMINAL_DELIVERY_MAX_REPRESENTATION_BYTES,
  TERMINAL_DELIVERY_PROTOCOL_VERSION,
  TerminalDeliveryEnvelopeSchemaZ,
  TerminalDeliveryChunkSchemaZ,
  TerminalDeliveryNegotiatedSchemaZ,
  TerminalDeliveryNackSchemaZ,
  TerminalSemanticDeliveryPayloadSchemaZ,
  type TerminalDeliveryAck,
  type TerminalDeliveryChunk,
  type TerminalDeliveryEnvelope,
  type TerminalDeliveryNegotiated,
  type TerminalDeliveryNegotiationResult,
  type TerminalDeliveryNack,
  type TerminalDeliveryOffer,
  type TerminalReplicaPatchPayload,
  type TerminalReplicaCell,
  type TerminalReplicaColor,
  type TerminalReplicaRow,
  type TerminalReplicaSnapshot,
  type TerminalSemanticDeliveryPayload,
} from "@tmux-ide/contracts";
import {
  applyTerminalReplicaPatch,
  freezeTerminalReplicaSnapshot,
  hashTerminalReplicaSnapshot,
  hashTerminalReplicaTombstone,
  hashTerminalReplicaSnapshotCooperatively,
  registerTerminalReplicaRowsDeltaHash,
  terminalReplicaRowsEqual,
} from "./terminal-replica.ts";
import { grantCompactReplicaCapability } from "./terminal-compact-capability.ts";
import {
  hashTerminalReplicaRowCooperatively,
  hashTerminalReplicaRowRunsCooperatively,
  isTerminalReplicaRowDeeplyFrozen,
  primeTerminalReplicaRowHash,
  TerminalReplicaRunEncodingCache,
} from "./terminal-replica-hash-cache.ts";

export class TerminalDeliveryStateTooLargeError extends Error {
  readonly bytes: number;

  constructor(bytes: number) {
    super(
      `Terminal delivery representation is ${bytes} bytes; maximum is ${TERMINAL_DELIVERY_MAX_REPRESENTATION_BYTES}`,
    );
    this.name = "TerminalDeliveryStateTooLargeError";
    this.bytes = bytes;
  }
}

export function negotiateTerminalDelivery(
  offer: TerminalDeliveryOffer,
  generation: string,
  deliveryNonce: string,
): TerminalDeliveryNegotiationResult {
  if (!offer.protocolVersions.includes(TERMINAL_DELIVERY_PROTOCOL_VERSION))
    return { accepted: false, reason: "protocol-version-mismatch" };
  const encoding = (
    ["semantic-compact-v1", "semantic-v1", "ansi-diff-v1", "ansi-raw-v1"] as const
  ).find((value) => offer.encodings.includes(value));
  if (!encoding) return { accepted: false, reason: "encoding-mismatch" };
  if (offer.richPlacements && encoding !== "semantic-v1" && encoding !== "semantic-compact-v1")
    return { accepted: false, reason: "unsupported-capability-combination" };
  return {
    accepted: true,
    negotiated: {
      protocolVersion: TERMINAL_DELIVERY_PROTOCOL_VERSION,
      encoding,
      ...(encoding === "semantic-compact-v1" && offer.encodings.includes("semantic-v1")
        ? { fallbackEncoding: "semantic-v1" as const }
        : {}),
      richPlacements:
        offer.richPlacements && (encoding === "semantic-v1" || encoding === "semantic-compact-v1"),
      generation,
      deliveryNonce,
    },
  };
}

export function encodeSemanticTerminalUpdate(update: TerminalSemanticDeliveryPayload): Uint8Array {
  const bytes = new TextEncoder().encode(
    canonicalJson(TerminalSemanticDeliveryPayloadSchemaZ.parse(update)),
  );
  assertRepresentationSize(bytes);
  return bytes;
}

/**
 * Non-materializing exact counter for the legacy semantic JSON wire. It stops
 * at cap + 1 without building the canonical JSON string or UTF-8 buffer; a
 * candidate within the cap is subsequently encoded and cross-checked.
 */
export function preaccountSemanticTerminalUpdateBytes(
  input: TerminalSemanticDeliveryPayload,
  maximum = TERMINAL_DELIVERY_MAX_REPRESENTATION_BYTES,
): Readonly<{ exact: true; bytes: number } | { exact: false; atLeastBytes: number }> {
  let bytes = 0;
  const saturated = {};
  const add = (amount: number) => {
    bytes += amount;
    if (bytes > maximum) throw saturated;
  };
  const stringBytes = (value: string) => {
    add(2);
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (
        code === 0x22 ||
        code === 0x5c ||
        code === 0x08 ||
        code === 0x0c ||
        code === 0x0a ||
        code === 0x0d ||
        code === 0x09
      )
        add(2);
      else if (code <= 0x1f) add(6);
      else if (code <= 0x7f) add(1);
      else if (code <= 0x7ff) add(2);
      else if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(index + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          add(4);
          index += 1;
        } else add(6);
      } else if (code >= 0xdc00 && code <= 0xdfff) add(6);
      else add(3);
    }
  };
  const visit = (value: unknown): void => {
    if (value === null) {
      add(4);
      return;
    }
    if (typeof value === "string") {
      stringBytes(value);
      return;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      add(String(value).length);
      return;
    }
    if (Array.isArray(value)) {
      add(1);
      for (let index = 0; index < value.length; index += 1) {
        if (index > 0) add(1);
        visit(value[index]);
      }
      add(1);
      return;
    }
    if (typeof value !== "object" || value === undefined)
      throw new TypeError("Unsupported canonical JSON value");
    add(1);
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    let emitted = 0;
    for (const key of keys) {
      const member = record[key];
      if (member === undefined) continue;
      if (emitted > 0) add(1);
      stringBytes(key);
      add(1);
      visit(member);
      emitted += 1;
    }
    add(1);
  };
  try {
    visit(input);
    return Object.freeze({ exact: true, bytes });
  } catch (error) {
    if (error !== saturated) throw error;
    return Object.freeze({ exact: false, atLeastBytes: maximum + 1 });
  }
}

export function decodeSemanticTerminalUpdate(bytes: Uint8Array): TerminalSemanticDeliveryPayload {
  assertRepresentationSize(bytes);
  return TerminalSemanticDeliveryPayloadSchemaZ.parse(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
  );
}

const COMPACT_SEMANTIC_KIND = "terminal-semantic-compact";
const COMPACT_SEMANTIC_VERSION = 1;
const COMPACT_MAX_DIMENSION = 4_096;
const COMPACT_MAX_ROWS = 10_000;
const COMPACT_MAX_RUNS = 1_000_000;
const COMPACT_MAX_EXPANDED_CELLS = 1_000_000;
const COMPACT_MAX_EXPANSION_RATIO = 64;
const COMPACT_MAX_PLACEMENTS = 4_096;
const COMPACT_MAX_STRING_BYTES = 4_096;
const UTF8_ENCODER = new TextEncoder();
const COMPACT_DEFAULT_COLOR = Object.freeze({ kind: "default" as const });
const compactCommitCapabilities = new WeakMap<
  TerminalSemanticDeliveryPayload,
  Readonly<{ snapshot: TerminalReplicaSnapshot | null; hash: string }>
>();

type CompactColor = 0 | readonly [1 | 2, number];
type CompactCellRun = [number, string, 0 | 1 | 2, CompactColor, CompactColor, number];
type CompactRow = readonly [0 | 1, readonly CompactCellRun[]];

/**
 * A negotiated exact semantic representation. It changes only the wire shape:
 * decode always returns the same strict canonical payload and hash authority.
 */
export function encodeCompactSemanticTerminalUpdate(
  input: TerminalSemanticDeliveryPayload,
): Uint8Array {
  const update = TerminalSemanticDeliveryPayloadSchemaZ.parse(input);
  const wire =
    update.frame === "seed"
      ? {
          v: 1,
          k: COMPACT_SEMANTIC_KIND,
          f: "s",
          r: update.revision,
          s: compactSnapshot(update.snapshot),
        }
      : update.frame === "patch"
        ? {
            v: 1,
            k: COMPACT_SEMANTIC_KIND,
            f: "p",
            b: update.baseRevision,
            r: update.revision,
            p: compactPatch(update.patch),
          }
        : {
            v: 1,
            k: COMPACT_SEMANTIC_KIND,
            f: "t",
            b: update.baseRevision,
            r: update.revision,
            t: update.tombstone.reason,
          };
  const bytes = UTF8_ENCODER.encode(canonicalJson(wire));
  assertRepresentationSize(bytes);
  return bytes;
}

export function decodeCompactSemanticTerminalUpdate(
  bytes: Uint8Array,
): TerminalSemanticDeliveryPayload {
  return decodeCompactSemanticTerminalUpdateInternal(bytes);
}

function decodeCompactSemanticTerminalUpdateInternal(
  bytes: Uint8Array,
  suppliedBudget?: CompactDecodeBudget,
): TerminalSemanticDeliveryPayload {
  assertRepresentationSize(bytes);
  const wire: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  const frame =
    wire !== null && typeof wire === "object" && !Array.isArray(wire)
      ? (wire as Record<string, unknown>).f
      : null;
  if (
    !recordWithKeys(
      wire,
      frame === "s"
        ? ["v", "k", "f", "r", "s"]
        : ["v", "k", "f", "b", "r", frame === "p" ? "p" : "t"],
    )
  )
    throw new TypeError("Invalid compact semantic envelope");
  if (wire.v !== COMPACT_SEMANTIC_VERSION || wire.k !== COMPACT_SEMANTIC_KIND)
    throw new TypeError("Unsupported compact semantic version");
  const revision = compactInteger(wire.r, 0, Number.MAX_SAFE_INTEGER, "revision");
  const budget = suppliedBudget ?? compactDecodeBudget(bytes.byteLength);
  let update: TerminalSemanticDeliveryPayload;
  if (wire.f === "s") {
    update = { frame: "seed", revision, snapshot: expandSnapshot(wire.s, budget) };
  } else {
    const baseRevision = compactInteger(wire.b, 0, Number.MAX_SAFE_INTEGER, "base revision");
    if (revision <= baseRevision) throw new TypeError("Compact semantic revision did not advance");
    if (wire.f === "p")
      update = {
        frame: "patch",
        baseRevision,
        revision,
        patch: expandPatch(wire.p, budget),
      };
    else if (
      wire.f === "t" &&
      ["pane-closed", "session-restarted", "runtime-disposed"].includes(String(wire.t))
    )
      update = {
        frame: "tombstone",
        baseRevision,
        revision,
        tombstone: Object.freeze({
          reason: wire.t as "pane-closed" | "session-restarted" | "runtime-disposed",
        }),
      };
    else throw new TypeError("Invalid compact semantic frame");
  }
  return Object.freeze(update);
}

function compactDecodeBudget(bytes: number): CompactDecodeBudget {
  return {
    rows: 0,
    runs: 0,
    cells: 0,
    placements: 0,
    maxCells: Math.min(COMPACT_MAX_EXPANDED_CELLS, bytes * COMPACT_MAX_EXPANSION_RATIO),
    rowCache: new Map(),
    reusedRows: 0,
    allocatedCells: 0,
    canonicalUtf8Allocations: 0,
    canonicalUtf8Bytes: 0,
    validatedCellAllocations: 0,
  };
}

function compactSnapshot(snapshot: TerminalReplicaSnapshot): readonly unknown[] {
  const budget: CompactDecodeBudget = {
    rows: 0,
    runs: 0,
    cells: 0,
    placements: 0,
    maxCells: COMPACT_MAX_EXPANDED_CELLS,
    reusedRows: 0,
    allocatedCells: 0,
    canonicalUtf8Allocations: 0,
    canonicalUtf8Bytes: 0,
    validatedCellAllocations: 0,
  };
  if (
    snapshot.cols > COMPACT_MAX_DIMENSION ||
    snapshot.rows > COMPACT_MAX_DIMENSION ||
    snapshot.grid.length !== snapshot.rows
  )
    compactEncodingLimit();
  return [
    snapshot.cols,
    snapshot.rows,
    compactRows(snapshot.grid, snapshot.cols, budget),
    compactRows(snapshot.history, snapshot.cols, budget),
    compactCursor(snapshot.cursor),
    compactModes(snapshot.modes),
    compactPlacements(snapshot.placements, budget),
    compactBootstrap(snapshot.bootstrap),
  ];
}

function compactPatch(patch: TerminalReplicaPatchPayload): readonly unknown[] {
  const budget: CompactDecodeBudget = {
    rows: 0,
    runs: 0,
    cells: 0,
    placements: 0,
    maxCells: COMPACT_MAX_EXPANDED_CELLS,
    reusedRows: 0,
    allocatedCells: 0,
    canonicalUtf8Allocations: 0,
    canonicalUtf8Bytes: 0,
    validatedCellAllocations: 0,
  };
  const cols = patch.dimensions?.cols ?? null;
  if (
    patch.dimensions &&
    (patch.dimensions.cols > COMPACT_MAX_DIMENSION || patch.dimensions.rows > COMPACT_MAX_DIMENSION)
  )
    compactEncodingLimit();
  if (patch.rows.length > COMPACT_MAX_DIMENSION) compactEncodingLimit();
  return [
    patch.dimensions ? [patch.dimensions.cols, patch.dimensions.rows] : null,
    patch.rows.map(({ index, row }) => [index, compactRow(row, cols, budget)]),
    patch.history ? compactRows(patch.history, cols, budget) : null,
    patch.historyDelta
      ? [patch.historyDelta.trim, compactRows(patch.historyDelta.append, cols, budget)]
      : null,
    patch.cursor ? compactCursor(patch.cursor) : null,
    patch.modes ? compactModes(patch.modes) : null,
    patch.placements ? compactPlacements(patch.placements, budget) : null,
    patch.bootstrap ? compactBootstrap(patch.bootstrap) : null,
  ];
}

function compactRows(
  rows: readonly TerminalReplicaRow[],
  cols: number | null,
  budget: CompactDecodeBudget,
): CompactRow[] {
  return rows.map((row) => compactRow(row, cols, budget));
}

function compactRow(
  row: TerminalReplicaRow,
  cols: number | null,
  budget: CompactDecodeBudget,
): CompactRow {
  if (++budget.rows > COMPACT_MAX_ROWS) compactEncodingLimit();
  if (row.cells.length > COMPACT_MAX_EXPANDED_CELLS || (cols !== null && row.cells.length !== cols))
    compactEncodingLimit();
  budget.cells += row.cells.length;
  if (budget.cells > COMPACT_MAX_EXPANDED_CELLS) compactEncodingLimit();
  const runs: CompactCellRun[] = [];
  for (const cell of row.cells) {
    const prior = runs.at(-1);
    const encoded = compactCell(cell);
    if (prior && compactRunCellEqual(prior, encoded)) prior[0] += 1;
    else {
      if (++budget.runs > COMPACT_MAX_RUNS) compactEncodingLimit();
      runs.push(encoded);
    }
  }
  return [row.wrapped ? 1 : 0, runs];
}

function compactCell(
  cell: TerminalReplicaCell,
): [number, string, 0 | 1 | 2, CompactColor, CompactColor, number] {
  return [
    1,
    compactEncodeString(cell.grapheme),
    cell.width,
    compactColor(cell.foreground),
    compactColor(cell.background),
    cell.attributes,
  ];
}

function compactRunCellEqual(a: CompactCellRun, b: CompactCellRun): boolean {
  return (
    a[1] === b[1] &&
    a[2] === b[2] &&
    compactColorEqual(a[3], b[3]) &&
    compactColorEqual(a[4], b[4]) &&
    a[5] === b[5]
  );
}

function compactColor(color: TerminalReplicaColor): CompactColor {
  return color.kind === "default"
    ? 0
    : [color.kind === "indexed" ? 1 : 2, color.kind === "indexed" ? color.index : color.value];
}

function compactColorEqual(a: CompactColor, b: CompactColor): boolean {
  return a === 0 ? b === 0 : b !== 0 && a[0] === b[0] && a[1] === b[1];
}

function compactCursor(cursor: TerminalReplicaSnapshot["cursor"]): readonly unknown[] {
  return [cursor.x, cursor.y, cursor.hidden ? 1 : 0, cursor.style, cursor.blink ? 1 : 0];
}

function compactModes(modes: TerminalReplicaSnapshot["modes"]): readonly unknown[] {
  return [
    modes.alternateScreen ? 1 : 0,
    modes.applicationCursor ? 1 : 0,
    modes.applicationKeypad ? 1 : 0,
    modes.bracketedPaste ? 1 : 0,
    modes.insert ? 1 : 0,
    modes.origin ? 1 : 0,
    modes.wraparound ? 1 : 0,
    modes.mouseTracking ? 1 : 0,
    modes.mouseProtocol ?? null,
    modes.mouseEncoding ?? null,
    modes.synchronizedOutput ? 1 : 0,
  ];
}

function compactPlacement(
  placement: TerminalReplicaSnapshot["placements"][number],
): readonly unknown[] {
  return [
    compactEncodeString(placement.id),
    compactEncodeString(placement.kind),
    placement.row,
    placement.column,
    placement.columns,
    placement.rows,
    compactEncodeString(placement.contentDigest),
  ];
}

function compactPlacements(
  placements: TerminalReplicaSnapshot["placements"],
  budget: CompactDecodeBudget,
): readonly unknown[] {
  budget.placements += placements.length;
  if (budget.placements > COMPACT_MAX_PLACEMENTS) compactEncodingLimit();
  return placements.map(compactPlacement);
}

function compactBootstrap(bootstrap: TerminalReplicaSnapshot["bootstrap"]): readonly unknown[] {
  return [bootstrap.kind, bootstrap.hiddenState];
}

function expandSnapshot(value: unknown, budget: CompactDecodeBudget): TerminalReplicaSnapshot {
  const input = compactArray(value, 8, "snapshot");
  const cols = compactInteger(input[0], 1, COMPACT_MAX_DIMENSION, "columns");
  const rows = compactInteger(input[1], 1, COMPACT_MAX_DIMENSION, "rows");
  const grid = expandRows(input[2], budget, cols, rows, "grid");
  const history = expandRows(input[3], budget, cols, COMPACT_MAX_ROWS, "history");
  const snapshot = Object.freeze({
    cols,
    rows,
    grid,
    history,
    cursor: expandCursor(input[4], cols, rows),
    modes: expandModes(input[5]),
    placements: expandPlacements(input[6], budget),
    bootstrap: expandBootstrap(input[7]),
  });
  if (
    snapshot.placements.some(
      (placement) =>
        placement.row + placement.rows > rows || placement.column + placement.columns > cols,
    )
  )
    throw new TypeError("Compact placement is outside the viewport");
  return snapshot as unknown as TerminalReplicaSnapshot;
}

function expandPatch(value: unknown, budget: CompactDecodeBudget): TerminalReplicaPatchPayload {
  const input = compactArray(value, 8, "patch");
  const dimensions =
    input[0] === null
      ? undefined
      : (() => {
          const pair = compactArray(input[0], 2, "dimensions");
          return Object.freeze({
            cols: compactInteger(pair[0], 1, COMPACT_MAX_DIMENSION, "columns"),
            rows: compactInteger(pair[1], 1, COMPACT_MAX_DIMENSION, "rows"),
          });
        })();
  const rowInputs = compactArrayAtMost(input[1], COMPACT_MAX_DIMENSION, "dirty rows");
  const rows = rowInputs.map((entry) => {
    const pair = compactArray(entry, 2, "dirty row");
    return Object.freeze({
      index: compactInteger(pair[0], 0, COMPACT_MAX_DIMENSION - 1, "row index"),
      row: expandRow(pair[1], budget, dimensions?.cols ?? null),
    });
  });
  const history =
    input[2] === null ? undefined : expandRows(input[2], budget, null, COMPACT_MAX_ROWS, "history");
  const historyDelta =
    input[3] === null
      ? undefined
      : (() => {
          const pair = compactArray(input[3], 2, "history delta");
          return Object.freeze({
            trim: compactInteger(pair[0], 0, COMPACT_MAX_ROWS, "history trim"),
            append: expandRows(pair[1], budget, null, COMPACT_MAX_ROWS, "history append"),
          });
        })();
  if (history && historyDelta) throw new TypeError("Compact patch has two history representations");
  return Object.freeze({
    ...(dimensions ? { dimensions } : {}),
    rows: Object.freeze(rows.map((row) => Object.freeze(row))),
    ...(history ? { history } : {}),
    ...(historyDelta ? { historyDelta } : {}),
    ...(input[4] === null
      ? {}
      : { cursor: expandCursor(input[4], dimensions?.cols ?? null, dimensions?.rows ?? null) }),
    ...(input[5] === null ? {} : { modes: expandModes(input[5]) }),
    ...(input[6] === null ? {} : { placements: expandPlacements(input[6], budget) }),
    ...(input[7] === null ? {} : { bootstrap: expandBootstrap(input[7]) }),
  }) as unknown as TerminalReplicaPatchPayload;
}

interface CompactDecodeBudget {
  rows: number;
  runs: number;
  cells: number;
  placements: number;
  maxCells: number;
  rowCache?: Map<string, Readonly<{ row: TerminalReplicaRow; runs: number; cells: number }>>;
  rowReuseIndex?: ReadonlyMap<string, TerminalReplicaRow | readonly TerminalReplicaRow[]>;
  rawRowReuseIndex?: ValidatedCompactRawRowIndex;
  reusedRows: number;
  allocatedCells: number;
  canonicalUtf8Allocations: number;
  canonicalUtf8Bytes: number;
  runEncodingCache?: TerminalReplicaRunEncodingCache;
  decodedCellCache?: Map<
    string,
    Map<number, Map<number, Map<number, Map<number, TerminalReplicaCell>>>>
  >;
  validatedCellAllocations: number;
}

const VALIDATED_COMPACT_RAW_ROW = new WeakMap<
  TerminalReplicaRow,
  Readonly<{
    row: TerminalReplicaRow;
    raw: Uint8Array;
    rawHash: number;
    runs: number;
    cells: number;
  }>
>();
interface ValidatedCompactRawRowCandidate {
  readonly row: TerminalReplicaRow;
  readonly raw: Uint8Array;
  readonly runs: number;
  readonly cells: number;
  readonly collisions?: readonly ValidatedCompactRawRowCandidate[];
}
type ValidatedCompactRawRowIndex = ReadonlyMap<number, ValidatedCompactRawRowCandidate>;
const VALIDATED_COMPACT_RAW_ROW_INDEX = new WeakMap<
  TerminalReplicaRow,
  ValidatedCompactRawRowIndex
>();

function expandRows(
  value: unknown,
  budget: CompactDecodeBudget,
  cols: number | null,
  maximum: number,
  label: string,
): TerminalReplicaRow[] {
  const inputs = compactArrayAtMost(value, maximum, label);
  if (label === "grid" && cols !== null && inputs.length !== maximum)
    throw new TypeError("Compact grid cardinality mismatch");
  return Object.freeze(inputs.map((row) => expandRow(row, budget, cols))) as TerminalReplicaRow[];
}

function expandRow(
  value: unknown,
  budget: CompactDecodeBudget,
  cols: number | null,
): TerminalReplicaRow {
  if (++budget.rows > COMPACT_MAX_ROWS) throw new TypeError("Compact semantic row budget exceeded");
  const input = compactArray(value, 2, "row");
  const wrapped = compactBit(input[0], "wrapped");
  const runs = compactArrayAtMost(input[1], COMPACT_MAX_RUNS, "cell runs");
  const cacheKey = budget.rowCache ? JSON.stringify(input) : null;
  const cached = cacheKey === null ? undefined : budget.rowCache?.get(cacheKey);
  if (cached) {
    budget.runs += cached.runs;
    budget.cells += cached.cells;
    if (budget.runs > COMPACT_MAX_RUNS) throw new TypeError("Compact semantic run budget exceeded");
    if (budget.cells > budget.maxCells)
      throw new TypeError("Compact semantic expanded cell budget exceeded");
    budget.reusedRows += 1;
    return cached.row;
  }
  const runsBefore = budget.runs;
  const cellsBefore = budget.cells;
  const cells: TerminalReplicaCell[] = [];
  for (const valueRun of runs) {
    if (++budget.runs > COMPACT_MAX_RUNS)
      throw new TypeError("Compact semantic run budget exceeded");
    const run = compactArray(valueRun, 6, "cell run");
    const count = compactInteger(run[0], 1, COMPACT_MAX_DIMENSION, "cell run count");
    budget.cells += count;
    if (budget.cells > budget.maxCells)
      throw new TypeError("Compact semantic expanded cell budget exceeded");
    const grapheme = compactString(run[1], "grapheme");
    const width = compactInteger(run[2], 0, 2, "cell width") as 0 | 1 | 2;
    const cell = Object.freeze({
      grapheme,
      width,
      foreground: expandColor(run[3]),
      background: expandColor(run[4]),
      attributes: compactInteger(run[5], 0, 0xff, "cell attributes"),
    });
    for (let index = 0; index < count; index += 1) cells.push(cell);
  }
  if (cols !== null && cells.length !== cols) throw new TypeError("Compact row width mismatch");
  if (cells.length < 1 || cells.length > COMPACT_MAX_DIMENSION)
    throw new TypeError("Compact row width is out of bounds");
  for (let index = 0; index < cells.length; index += 1) {
    if (cells[index]!.width === 2 && cells[index + 1]?.width !== 0)
      throw new TypeError("Malformed compact wide cell");
    if (cells[index]!.width === 0 && (index === 0 || cells[index - 1]?.width !== 2))
      throw new TypeError("Malformed compact continuation cell");
  }
  const row = Object.freeze({
    cells: Object.freeze(cells),
    wrapped,
  }) as unknown as TerminalReplicaRow;
  budget.allocatedCells += cells.length;
  if (cacheKey !== null)
    budget.rowCache?.set(
      cacheKey,
      Object.freeze({
        row,
        runs: budget.runs - runsBefore,
        cells: budget.cells - cellsBefore,
      }),
    );
  return row;
}

function expandColor(value: unknown): TerminalReplicaColor {
  if (value === 0) return COMPACT_DEFAULT_COLOR;
  const pair = compactArray(value, 2, "color");
  if (pair[0] === 1)
    return Object.freeze({
      kind: "indexed",
      index: compactInteger(pair[1], 0, 255, "indexed color"),
    });
  if (pair[0] === 2)
    return Object.freeze({
      kind: "rgb",
      value: compactInteger(pair[1], 0, 0xffffff, "rgb color"),
    });
  throw new TypeError("Invalid compact color kind");
}

function expandCursor(
  value: unknown,
  cols: number | null,
  rows: number | null,
): TerminalReplicaSnapshot["cursor"] {
  const input = compactArray(value, 5, "cursor");
  const x = compactInteger(input[0], 0, COMPACT_MAX_DIMENSION - 1, "cursor x");
  const y = compactInteger(input[1], 0, COMPACT_MAX_DIMENSION - 1, "cursor y");
  if ((cols !== null && x >= cols) || (rows !== null && y >= rows))
    throw new TypeError("Compact cursor is outside the viewport");
  if (!(["block", "underline", "bar"] as unknown[]).includes(input[3]))
    throw new TypeError("Invalid compact cursor style");
  return Object.freeze({
    x,
    y,
    hidden: compactBit(input[2], "cursor hidden"),
    style: input[3] as "block" | "underline" | "bar",
    blink: compactBit(input[4], "cursor blink"),
  });
}

function expandModes(value: unknown): TerminalReplicaSnapshot["modes"] {
  const input = compactArray(value, 11, "modes");
  const mouseProtocol = input[8];
  const mouseEncoding = input[9];
  if (
    mouseProtocol !== null &&
    !["none", "x10", "vt200", "drag", "any"].includes(String(mouseProtocol))
  )
    throw new TypeError("Invalid compact mouse protocol");
  if (
    mouseEncoding !== null &&
    !["default", "utf8", "sgr", "sgr-pixels"].includes(String(mouseEncoding))
  )
    throw new TypeError("Invalid compact mouse encoding");
  return Object.freeze({
    alternateScreen: compactBit(input[0], "alternate screen"),
    applicationCursor: compactBit(input[1], "application cursor"),
    applicationKeypad: compactBit(input[2], "application keypad"),
    bracketedPaste: compactBit(input[3], "bracketed paste"),
    insert: compactBit(input[4], "insert"),
    origin: compactBit(input[5], "origin"),
    wraparound: compactBit(input[6], "wraparound"),
    mouseTracking: compactBit(input[7], "mouse tracking"),
    ...(mouseProtocol === null
      ? {}
      : { mouseProtocol: mouseProtocol as TerminalReplicaSnapshot["modes"]["mouseProtocol"] }),
    ...(mouseEncoding === null
      ? {}
      : { mouseEncoding: mouseEncoding as TerminalReplicaSnapshot["modes"]["mouseEncoding"] }),
    synchronizedOutput: compactBit(input[10], "synchronized output"),
  });
}

function expandPlacements(
  value: unknown,
  budget: CompactDecodeBudget,
): TerminalReplicaSnapshot["placements"] {
  const inputs = compactArrayAtMost(value, COMPACT_MAX_PLACEMENTS, "placements");
  budget.placements += inputs.length;
  if (budget.placements > COMPACT_MAX_PLACEMENTS)
    throw new TypeError("Compact placement budget exceeded");
  return Object.freeze(
    inputs.map((value) => {
      const input = compactArray(value, 7, "placement");
      return Object.freeze({
        id: compactString(input[0], "placement id", true),
        kind: compactString(input[1], "placement kind", true),
        row: compactInteger(input[2], 0, COMPACT_MAX_DIMENSION - 1, "placement row"),
        column: compactInteger(input[3], 0, COMPACT_MAX_DIMENSION - 1, "placement column"),
        columns: compactInteger(input[4], 1, COMPACT_MAX_DIMENSION, "placement columns"),
        rows: compactInteger(input[5], 1, COMPACT_MAX_DIMENSION, "placement rows"),
        contentDigest: compactString(input[6], "placement digest", true),
      });
    }),
  ) as unknown as TerminalReplicaSnapshot["placements"];
}

async function expandPlacementsCooperatively(
  value: unknown,
  budget: CompactDecodeBudget,
  control: CompactCooperativeControl,
): Promise<TerminalReplicaSnapshot["placements"]> {
  const inputs = compactArrayAtMost(value, COMPACT_MAX_PLACEMENTS, "placements");
  budget.placements += inputs.length;
  if (budget.placements > COMPACT_MAX_PLACEMENTS)
    throw new TypeError("Compact placement budget exceeded");
  const placements: TerminalReplicaSnapshot["placements"][number][] = [];
  for (let index = 0; index < inputs.length; index += 1) {
    const input = compactArray(inputs[index], 7, "placement");
    placements.push(
      Object.freeze({
        id: compactString(input[0], "placement id", true),
        kind: compactString(input[1], "placement kind", true),
        row: compactInteger(input[2], 0, COMPACT_MAX_DIMENSION - 1, "placement row"),
        column: compactInteger(input[3], 0, COMPACT_MAX_DIMENSION - 1, "placement column"),
        columns: compactInteger(input[4], 1, COMPACT_MAX_DIMENSION, "placement columns"),
        rows: compactInteger(input[5], 1, COMPACT_MAX_DIMENSION, "placement rows"),
        contentDigest: compactString(input[6], "placement digest", true),
      }),
    );
    // The parsed wire container is private and single-use. Drop each expanded
    // placement immediately so a large validated prefix cannot coexist with
    // its canonical replacement until the complete envelope finishes.
    inputs[index] = null;
    if ((index + 1) % 16 === 0) await control.yieldControl();
  }
  return Object.freeze(placements) as unknown as TerminalReplicaSnapshot["placements"];
}

function expandBootstrap(value: unknown): TerminalReplicaSnapshot["bootstrap"] {
  const input = compactArray(value, 2, "bootstrap");
  if (
    !["painted-capture", "authoritative-stream"].includes(String(input[0])) ||
    !["unknown", "observed-from-start"].includes(String(input[1]))
  )
    throw new TypeError("Invalid compact bootstrap");
  return Object.freeze({
    kind: input[0] as "painted-capture" | "authoritative-stream",
    hiddenState: input[1] as "unknown" | "observed-from-start",
  });
}

function compactArray(value: unknown, length: number, label: string): unknown[] {
  if (!Array.isArray(value) || value.length !== length)
    throw new TypeError(`Invalid compact ${label}`);
  return value;
}

function compactArrayAtMost(value: unknown, maximum: number, label: string): unknown[] {
  if (!Array.isArray(value) || value.length > maximum)
    throw new TypeError(`Invalid compact ${label}`);
  return value;
}

function compactInteger(value: unknown, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum)
    throw new TypeError(`Invalid compact ${label}`);
  return value as number;
}

function compactBit(value: unknown, label: string): boolean {
  if (value !== 0 && value !== 1) throw new TypeError(`Invalid compact ${label}`);
  return value === 1;
}

function compactString(value: unknown, label: string, nonempty = false): string {
  if (
    typeof value !== "string" ||
    (nonempty && value.length === 0) ||
    UTF8_ENCODER.encode(value).byteLength > COMPACT_MAX_STRING_BYTES
  )
    throw new TypeError(`Invalid compact ${label}`);
  return value;
}

function compactEncodeString(value: string): string {
  if (
    value.length > COMPACT_MAX_STRING_BYTES / 4 &&
    UTF8_ENCODER.encode(value).byteLength > COMPACT_MAX_STRING_BYTES
  )
    compactEncodingLimit();
  return value;
}

function compactEncodingLimit(): never {
  throw new TerminalDeliveryStateTooLargeError(TERMINAL_DELIVERY_MAX_REPRESENTATION_BYTES + 1);
}

function applyDecodedCompactPatch(
  current: TerminalReplicaSnapshot,
  patch: TerminalReplicaPatchPayload,
): TerminalReplicaSnapshot {
  const cols = patch.dimensions?.cols ?? current.cols;
  const rows = patch.dimensions?.rows ?? current.rows;
  if (patch.history !== undefined && patch.historyDelta !== undefined)
    throw new TypeError("Compact patch has two history representations");
  if ((patch.historyDelta?.trim ?? 0) > current.history.length)
    throw new TypeError("Compact history trim is out of bounds");
  const resizedBlank =
    cols === current.cols && rows === current.rows ? null : compactBlankRow(cols);
  const nextGrid: TerminalReplicaRow[] =
    cols === current.cols && rows === current.rows && patch.rows.length === 0
      ? current.grid
      : cols === current.cols && rows === current.rows
        ? [...current.grid]
        : Array.from({ length: rows }, (_, index) => {
            const prior = current.grid[index];
            return prior?.cells.length === cols ? prior : resizedBlank!;
          });
  const seen = new Set<number>();
  for (const change of patch.rows) {
    if (
      change.index < 0 ||
      change.index >= rows ||
      seen.has(change.index) ||
      change.row.cells.length !== cols
    )
      throw new TypeError("Malformed compact terminal row patch");
    seen.add(change.index);
    nextGrid[change.index] = change.row;
  }
  const history = patch.history
    ? patch.history
    : patch.historyDelta
      ? (() => {
          const retained = current.history.length - patch.historyDelta.trim;
          const nextLength = retained + patch.historyDelta.append.length;
          const unchanged =
            nextLength === current.history.length &&
            current.history.every((row, index) =>
              index < retained
                ? row === current.history[index + patch.historyDelta!.trim]
                : row === patch.historyDelta!.append[index - retained],
            );
          return unchanged
            ? current.history
            : Object.freeze([
                ...current.history.slice(patch.historyDelta.trim),
                ...patch.historyDelta.append,
              ]);
        })()
      : current.history;
  if (patch.historyDelta && history !== current.history)
    registerTerminalReplicaRowsDeltaHash(
      current.history,
      history,
      patch.historyDelta.trim,
      patch.historyDelta.append,
    );
  if (history.length > COMPACT_MAX_ROWS || history.some((row) => row.cells.length !== cols))
    throw new TypeError("Compact patch retained wrong-width history");
  const cursor = patch.cursor ?? current.cursor;
  if (cursor.x >= cols || cursor.y >= rows) throw new TypeError("Compact cursor is out of bounds");
  const placements = patch.placements ?? current.placements;
  if (
    placements.some(
      (placement) =>
        placement.row + placement.rows > rows || placement.column + placement.columns > cols,
    )
  )
    throw new TypeError("Compact placement is outside the viewport");
  return Object.freeze({
    cols,
    rows,
    grid: Object.freeze(nextGrid) as TerminalReplicaRow[],
    history,
    cursor,
    modes: patch.modes ?? current.modes,
    placements,
    bootstrap: patch.bootstrap ?? current.bootstrap,
  }) as unknown as TerminalReplicaSnapshot;
}

function compactBlankRow(cols: number): TerminalReplicaRow {
  const cell = Object.freeze({
    grapheme: " ",
    width: 1 as const,
    foreground: COMPACT_DEFAULT_COLOR,
    background: COMPACT_DEFAULT_COLOR,
    attributes: 0,
  });
  return Object.freeze({
    cells: Object.freeze(Array.from({ length: cols }, () => cell)),
    wrapped: false,
  }) as unknown as TerminalReplicaRow;
}

export interface CompactSemanticCommitProfile {
  readonly reusedCompactPayload: boolean;
  readonly expandedRows: number;
  readonly expandedRuns: number;
  readonly expandedCells: number;
  readonly reusedRows: number;
  readonly allocatedCells: number;
  readonly canonicalUtf8Allocations: number;
  readonly canonicalUtf8Bytes: number;
  readonly validatedCellAllocations: number;
  readonly placements: number;
  readonly schemaTraversals: 1;
  readonly hashTraversals: 1;
  readonly applyTraversals: 0 | 1;
  readonly trustedAdoption: true;
  readonly retainedSnapshots: 0;
}

export function decodeVerifiedCompactSemanticTerminalUpdate(
  bytes: Uint8Array,
  baseline: TerminalReplicaSnapshot | null,
  expectedHash: string,
  options?: {
    readonly grantReducerAdoption?: boolean;
    readonly onComplete?: (profile: CompactSemanticCommitProfile) => void;
  },
): Readonly<{
  payload: TerminalSemanticDeliveryPayload;
  canonicalSnapshot: TerminalReplicaSnapshot | null;
}> {
  const decodeBudget = options?.onComplete ? compactDecodeBudget(bytes.byteLength) : undefined;
  const payload = decodeCompactSemanticTerminalUpdateInternal(bytes, decodeBudget);
  const snapshot =
    payload.frame === "seed"
      ? payload.snapshot
      : payload.frame === "patch"
        ? baseline
          ? applyDecodedCompactPatch(baseline, payload.patch)
          : (() => {
              throw new TypeError("Semantic delivery baseline gap");
            })()
        : null;
  const hash = snapshot
    ? hashTerminalReplicaSnapshot(snapshot)
    : hashTerminalReplicaTombstone(
        payload.frame === "tombstone" ? payload.tombstone.reason : "protocol",
      );
  if (hash !== expectedHash) throw new TypeError("Canonical state hash mismatch");
  compactCommitCapabilities.set(payload, Object.freeze({ snapshot, hash }));
  if (options?.grantReducerAdoption)
    grantCompactReplicaCapability(
      payload.frame === "seed"
        ? payload.snapshot
        : payload.frame === "patch"
          ? payload.patch
          : payload.tombstone,
      baseline,
      snapshot,
      hash,
    );
  if (options?.onComplete && decodeBudget) {
    try {
      options.onComplete(
        Object.freeze({
          reusedCompactPayload: false,
          expandedRows: decodeBudget.rows,
          expandedRuns: decodeBudget.runs,
          expandedCells: decodeBudget.cells,
          reusedRows: decodeBudget.reusedRows,
          allocatedCells: decodeBudget.allocatedCells,
          canonicalUtf8Allocations: decodeBudget.canonicalUtf8Allocations,
          canonicalUtf8Bytes: decodeBudget.canonicalUtf8Bytes,
          validatedCellAllocations: decodeBudget.validatedCellAllocations,
          placements: decodeBudget.placements,
          schemaTraversals: 1,
          hashTraversals: 1,
          applyTraversals: payload.frame === "patch" ? 1 : 0,
          trustedAdoption: true,
          retainedSnapshots: 0,
        }),
      );
    } catch {
      // Detailed observers never own canonical delivery.
    }
  }
  return Object.freeze({ payload, canonicalSnapshot: snapshot });
}

/**
 * Large compact states are expanded a bounded row slice at a time. Nothing is
 * published or capability-branded until the complete canonical hash matches.
 */
export async function decodeVerifiedCompactSemanticTerminalUpdateCooperatively(
  bytes: Uint8Array,
  baseline: TerminalReplicaSnapshot | null,
  expectedHash: string,
  options: {
    readonly yieldControl: () => Promise<void>;
    readonly rowsPerSlice?: number;
    readonly grantReducerAdoption?: boolean;
    readonly onComplete?: (profile: CompactSemanticCommitProfile) => void;
  },
): Promise<
  Readonly<{
    payload: TerminalSemanticDeliveryPayload;
    canonicalSnapshot: TerminalReplicaSnapshot | null;
  }>
> {
  assertRepresentationSize(bytes);
  const wire = await parseCompactJsonCooperatively(bytes, options.yieldControl);
  const frame =
    wire !== null && typeof wire === "object" && !Array.isArray(wire)
      ? (wire as Record<string, unknown>).f
      : null;
  if (
    !recordWithKeys(
      wire,
      frame === "s"
        ? ["v", "k", "f", "r", "s"]
        : ["v", "k", "f", "b", "r", frame === "p" ? "p" : "t"],
    )
  )
    throw new TypeError("Invalid compact semantic envelope");
  const qualifiedWire = wire as Record<string, unknown>;
  if (qualifiedWire.v !== COMPACT_SEMANTIC_VERSION || qualifiedWire.k !== COMPACT_SEMANTIC_KIND)
    throw new TypeError("Unsupported compact semantic version");
  const revision = compactInteger(qualifiedWire.r, 0, Number.MAX_SAFE_INTEGER, "revision");
  const budget = compactDecodeBudget(bytes.byteLength);
  // Cooperative validation never serializes a whole row to form an interning
  // key; that would recreate an unbounded synchronous phase.
  budget.rowCache = undefined;
  budget.runEncodingCache = new TerminalReplicaRunEncodingCache();
  budget.decodedCellCache = new Map();
  const control = {
    yieldControl: options.yieldControl,
    rowsPerSlice: Math.min(Math.max(options.rowsPerSlice ?? 64, 1), 64),
    rowsSinceYield: 0,
  };
  if (baseline) {
    budget.rowReuseIndex = await compactBaselineRowReuseIndex(baseline, control);
    let rawRows: ValidatedCompactRawRowIndex | undefined;
    for (const rows of [baseline.grid, baseline.history])
      for (const row of rows) {
        rawRows = VALIDATED_COMPACT_RAW_ROW_INDEX.get(row);
        if (rawRows) break;
      }
    if (!rawRows) {
      const nextRawRows = new Map<number, ValidatedCompactRawRowCandidate>();
      let indexedRows = 0;
      for (const rows of [baseline.grid, baseline.history])
        for (const row of rows) {
          const cached = VALIDATED_COMPACT_RAW_ROW.get(row);
          if (cached) {
            const existing = nextRawRows.get(cached.rawHash);
            if (!existing) nextRawRows.set(cached.rawHash, cached);
            else if (
              existing.row !== row &&
              !existing.collisions?.some((entry) => entry.row === row)
            )
              nextRawRows.set(
                cached.rawHash,
                Object.freeze({
                  ...existing,
                  collisions: Object.freeze([...(existing.collisions ?? []), cached]),
                }),
              );
          }
          indexedRows += 1;
          if (indexedRows % control.rowsPerSlice === 0) await control.yieldControl();
        }
      rawRows = nextRawRows;
      let installedRows = 0;
      for (const rows of [baseline.grid, baseline.history])
        for (const row of rows) {
          VALIDATED_COMPACT_RAW_ROW_INDEX.set(row, rawRows);
          installedRows += 1;
          if (installedRows % control.rowsPerSlice === 0) await control.yieldControl();
        }
    }
    budget.rawRowReuseIndex = rawRows;
  }
  let payload: TerminalSemanticDeliveryPayload;
  if (qualifiedWire.f === "s") {
    const encodedSnapshot = qualifiedWire.s;
    qualifiedWire.s = null;
    payload = Object.freeze({
      frame: "seed" as const,
      revision,
      snapshot: await expandSnapshotCooperatively(encodedSnapshot, budget, control),
    });
  } else {
    const baseRevision = compactInteger(
      qualifiedWire.b,
      0,
      Number.MAX_SAFE_INTEGER,
      "base revision",
    );
    if (revision <= baseRevision) throw new TypeError("Compact semantic revision did not advance");
    if (qualifiedWire.f === "p") {
      const encodedPatch = qualifiedWire.p;
      qualifiedWire.p = null;
      payload = Object.freeze({
        frame: "patch" as const,
        baseRevision,
        revision,
        patch: await expandPatchCooperatively(encodedPatch, budget, control),
      });
    } else if (
      qualifiedWire.f === "t" &&
      ["pane-closed", "session-restarted", "runtime-disposed"].includes(String(qualifiedWire.t))
    )
      payload = Object.freeze({
        frame: "tombstone" as const,
        baseRevision,
        revision,
        tombstone: Object.freeze({
          reason: qualifiedWire.t as "pane-closed" | "session-restarted" | "runtime-disposed",
        }),
      });
    else throw new TypeError("Invalid compact semantic frame");
  }
  const snapshot =
    payload.frame === "seed"
      ? payload.snapshot
      : payload.frame === "patch"
        ? baseline
          ? applyDecodedCompactPatch(baseline, payload.patch)
          : (() => {
              throw new TypeError("Semantic delivery baseline gap");
            })()
        : null;
  // Expansion has either adopted immutable baseline rows or constructed the
  // bounded changed rows. Parser/reuse scratch cannot affect canonical hashing
  // or publication, so release it before the longest cooperative phase.
  budget.rowReuseIndex = undefined;
  budget.rawRowReuseIndex = undefined;
  budget.runEncodingCache = undefined;
  budget.decodedCellCache = undefined;
  const hash = snapshot
    ? await hashTerminalReplicaSnapshotCooperatively(snapshot, options.yieldControl)
    : hashTerminalReplicaTombstone(
        payload.frame === "tombstone" ? payload.tombstone.reason : "protocol",
      );
  if (hash !== expectedHash) throw new TypeError("Canonical state hash mismatch");
  if (options.grantReducerAdoption)
    grantCompactReplicaCapability(
      payload.frame === "seed"
        ? payload.snapshot
        : payload.frame === "patch"
          ? payload.patch
          : payload.tombstone,
      baseline,
      snapshot,
      hash,
    );
  if (options.onComplete) {
    try {
      options.onComplete(
        Object.freeze({
          reusedCompactPayload: false,
          expandedRows: budget.rows,
          expandedRuns: budget.runs,
          expandedCells: budget.cells,
          reusedRows: budget.reusedRows,
          allocatedCells: budget.allocatedCells,
          canonicalUtf8Allocations: budget.canonicalUtf8Allocations,
          canonicalUtf8Bytes: budget.canonicalUtf8Bytes,
          validatedCellAllocations: budget.validatedCellAllocations,
          placements: budget.placements,
          schemaTraversals: 1,
          hashTraversals: 1,
          applyTraversals: payload.frame === "patch" ? 1 : 0,
          trustedAdoption: true,
          retainedSnapshots: 0,
        }),
      );
    } catch {
      // Detailed observers never own canonical delivery.
    }
  }
  return Object.freeze({ payload, canonicalSnapshot: snapshot });
}

const COOPERATIVE_JSON_WORK_CHARS = 16 * 1_024;
const COOPERATIVE_JSON_MAX_STRING_CHARS = COMPACT_MAX_STRING_BYTES * 6 + 2;
const COOPERATIVE_CELL_WORK = 256;

async function parseCompactJsonCooperatively(
  bytes: Uint8Array,
  yieldControl: () => Promise<void>,
): Promise<unknown> {
  const parser = new CooperativeJsonParser(new CooperativeJsonSource(bytes), yieldControl, true);
  return parser.parse();
}

const COMPACT_PARSED_ROW_SLICE = Symbol("compact-parsed-row-slice");
interface CompactParsedRowSlice {
  readonly kind: typeof COMPACT_PARSED_ROW_SLICE;
  readonly source: CooperativeJsonSource;
  readonly start: number;
  readonly end: number;
}
const COMPACT_PARSED_ROWS_SLICE = Symbol("compact-parsed-rows-slice");
interface CompactParsedRowsSlice {
  readonly kind: typeof COMPACT_PARSED_ROWS_SLICE;
  readonly source: CooperativeJsonSource;
  readonly start: number;
  readonly end: number;
}

class CooperativeJsonSource {
  readonly #bytes: Uint8Array;
  readonly length: number;

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
    this.length = bytes.byteLength;
  }

  byteAt(index: number): number {
    return this.#bytes[index] ?? -1;
  }

  startsWithAscii(value: string, index: number): boolean {
    for (let offset = 0; offset < value.length; offset += 1)
      if (this.byteAt(index + offset) !== value.charCodeAt(offset)) return false;
    return true;
  }

  slice(start: number, end: number): string {
    return new TextDecoder("utf-8", { fatal: true }).decode(this.#bytes.subarray(start, end));
  }

  bytes(start: number, end: number): Uint8Array {
    return this.#bytes.subarray(start, end);
  }

  hash(start: number, end: number): number {
    let hash = 0x811c9dc5;
    for (let index = start; index < end; index += 1) {
      hash ^= this.#bytes[index]!;
      hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
  }

  equals(start: number, end: number, expected: Uint8Array): boolean {
    if (end - start !== expected.byteLength) return false;
    for (let index = 0; index < expected.byteLength; index += 1)
      if (this.#bytes[start + index] !== expected[index]) return false;
    return true;
  }
}

const compactJsonWhitespaceByte = (byte: number): boolean =>
  byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;

const compactJsonNumberByte = (byte: number): boolean =>
  (byte >= 0x30 && byte <= 0x39) ||
  byte === 0x65 ||
  byte === 0x45 ||
  byte === 0x2b ||
  byte === 0x2d ||
  byte === 0x2e;

class CooperativeJsonParser {
  readonly #source: CooperativeJsonSource;
  readonly #yieldControl: () => Promise<void>;
  #index = 0;
  #work = 0;
  readonly #retainRowsAsSlices: boolean;

  constructor(
    source: CooperativeJsonSource,
    yieldControl: () => Promise<void>,
    retainRowsAsSlices = false,
  ) {
    this.#source = source;
    this.#yieldControl = yieldControl;
    this.#retainRowsAsSlices = retainRowsAsSlices;
  }

  async parse(): Promise<unknown> {
    await this.#space();
    const value = await this.#value(0);
    await this.#space();
    if (this.#index !== this.#source.length) throw new SyntaxError("Trailing compact JSON input");
    return value;
  }

  #checkpoint(amount = 1): Promise<void> | null {
    this.#work += amount;
    if (this.#work < COOPERATIVE_JSON_WORK_CHARS) return null;
    this.#work = 0;
    return this.#yieldControl();
  }

  async #space(): Promise<void> {
    while (compactJsonWhitespaceByte(this.#source.byteAt(this.#index))) {
      this.#index += 1;
      const checkpoint = this.#checkpoint();
      if (checkpoint) await checkpoint;
    }
  }

  async #value(depth: number): Promise<unknown> {
    if (depth > 64) throw new SyntaxError("Compact JSON nesting exceeded");
    await this.#space();
    const head = this.#source.byteAt(this.#index);
    if (head === 0x22) return this.#string();
    if (head === 0x5b) return this.#array(depth + 1);
    if (head === 0x7b) return this.#object(depth + 1);
    if (head === 0x74 && this.#source.startsWithAscii("true", this.#index)) {
      this.#index += 4;
      const checkpoint = this.#checkpoint(4);
      if (checkpoint) await checkpoint;
      return true;
    }
    if (head === 0x66 && this.#source.startsWithAscii("false", this.#index)) {
      this.#index += 5;
      const checkpoint = this.#checkpoint(5);
      if (checkpoint) await checkpoint;
      return false;
    }
    if (head === 0x6e && this.#source.startsWithAscii("null", this.#index)) {
      this.#index += 4;
      const checkpoint = this.#checkpoint(4);
      if (checkpoint) await checkpoint;
      return null;
    }
    return this.#number();
  }

  async #string(): Promise<string> {
    const start = this.#index;
    this.#index += 1;
    let checkpoint = this.#checkpoint();
    if (checkpoint) await checkpoint;
    let escaped = false;
    while (this.#index < this.#source.length) {
      const character = this.#source.byteAt(this.#index);
      this.#index += 1;
      checkpoint = this.#checkpoint();
      if (checkpoint) await checkpoint;
      if (!escaped && character === 0x22) {
        const token = this.#source.slice(start, this.#index);
        return JSON.parse(token) as string;
      }
      escaped = !escaped && character === 0x5c;
      if (character !== 0x5c) escaped = false;
      if (this.#index - start > COOPERATIVE_JSON_MAX_STRING_CHARS)
        throw new SyntaxError("Compact JSON string exceeded");
    }
    throw new SyntaxError("Unterminated compact JSON string");
  }

  async #number(): Promise<number> {
    const start = this.#index;
    while (compactJsonNumberByte(this.#source.byteAt(this.#index))) {
      this.#index += 1;
      const checkpoint = this.#checkpoint();
      if (checkpoint) await checkpoint;
      if (this.#index - start > 64) throw new SyntaxError("Compact JSON number exceeded");
    }
    if (this.#index === start) throw new SyntaxError("Invalid compact JSON value");
    const token = this.#source.slice(start, this.#index);
    const value = Number(token);
    if (!Number.isFinite(value) || JSON.parse(token) !== value)
      throw new SyntaxError("Invalid compact JSON number");
    return value;
  }

  async #array(depth: number): Promise<unknown> {
    const start = this.#index;
    if (
      this.#retainRowsAsSlices &&
      (this.#source.startsWithAscii("[[0,[[", start) ||
        this.#source.startsWithAscii("[[1,[[", start))
    )
      return this.#rowsSlice(start);
    if (this.#retainRowsAsSlices && this.#looksLikeCompactRow(start)) return this.#rowSlice(start);
    this.#index += 1;
    let checkpoint = this.#checkpoint();
    if (checkpoint) await checkpoint;
    const values: unknown[] = [];
    await this.#space();
    if (this.#source.byteAt(this.#index) === 0x5d) {
      this.#index += 1;
      checkpoint = this.#checkpoint();
      if (checkpoint) await checkpoint;
      return values;
    }
    while (true) {
      values.push(await this.#value(depth));
      await this.#space();
      const separator = this.#source.byteAt(this.#index);
      this.#index += 1;
      checkpoint = this.#checkpoint();
      if (checkpoint) await checkpoint;
      if (separator === 0x5d) {
        if (
          this.#retainRowsAsSlices &&
          values.length === 2 &&
          (values[0] === 0 || values[0] === 1) &&
          Array.isArray(values[1]) &&
          values[1].every(
            (run) =>
              Array.isArray(run) &&
              run.length === 6 &&
              typeof run[0] === "number" &&
              typeof run[1] === "string",
          )
        )
          return Object.freeze({
            kind: COMPACT_PARSED_ROW_SLICE,
            source: this.#source,
            start,
            end: this.#index,
          }) satisfies CompactParsedRowSlice;
        return values;
      }
      if (separator !== 0x2c) throw new SyntaxError("Invalid compact JSON array");
    }
  }

  #looksLikeCompactRow(start: number): boolean {
    if (
      !this.#source.startsWithAscii("[0,[[", start) &&
      !this.#source.startsWithAscii("[1,[[", start)
    )
      return false;
    let index = start + 5;
    const countStart = index;
    while (this.#source.byteAt(index) >= 0x30 && this.#source.byteAt(index) <= 0x39) index += 1;
    return (
      index > countStart &&
      this.#source.byteAt(index) === 0x2c &&
      this.#source.byteAt(index + 1) === 0x22
    );
  }

  async #rowSlice(start: number): Promise<CompactParsedRowSlice> {
    const slice = await this.#balancedArraySlice(start);
    return Object.freeze({ kind: COMPACT_PARSED_ROW_SLICE, ...slice });
  }

  async #rowsSlice(start: number): Promise<CompactParsedRowsSlice> {
    const slice = await this.#balancedArraySlice(start);
    return Object.freeze({ kind: COMPACT_PARSED_ROWS_SLICE, ...slice });
  }

  async #balancedArraySlice(
    start: number,
  ): Promise<{ source: CooperativeJsonSource; start: number; end: number }> {
    let arrayDepth = 0;
    let inString = false;
    let escaped = false;
    while (this.#index < this.#source.length) {
      const character = this.#source.byteAt(this.#index);
      this.#index += 1;
      const checkpoint = this.#checkpoint();
      if (checkpoint) await checkpoint;
      if (inString) {
        if (!escaped && character === 0x22) inString = false;
        escaped = !escaped && character === 0x5c;
        if (character !== 0x5c) escaped = false;
        continue;
      }
      if (character === 0x22) {
        inString = true;
        continue;
      }
      if (character === 0x5b) arrayDepth += 1;
      else if (character === 0x5d) {
        arrayDepth -= 1;
        if (arrayDepth === 0) return { source: this.#source, start, end: this.#index };
      }
    }
    throw new SyntaxError("Unterminated compact JSON array");
  }

  async #object(depth: number): Promise<Record<string, unknown>> {
    this.#index += 1;
    let checkpoint = this.#checkpoint();
    if (checkpoint) await checkpoint;
    const value: Record<string, unknown> = {};
    await this.#space();
    if (this.#source.byteAt(this.#index) === 0x7d) {
      this.#index += 1;
      checkpoint = this.#checkpoint();
      if (checkpoint) await checkpoint;
      return value;
    }
    while (true) {
      if (this.#source.byteAt(this.#index) !== 0x22)
        throw new SyntaxError("Invalid compact JSON key");
      const key = await this.#string();
      await this.#space();
      if (this.#source.byteAt(this.#index) !== 0x3a)
        throw new SyntaxError("Invalid compact JSON object");
      this.#index += 1;
      checkpoint = this.#checkpoint();
      if (checkpoint) await checkpoint;
      Object.defineProperty(value, key, {
        configurable: true,
        enumerable: true,
        value: await this.#value(depth),
        writable: true,
      });
      await this.#space();
      const separator = this.#source.byteAt(this.#index);
      this.#index += 1;
      checkpoint = this.#checkpoint();
      if (checkpoint) await checkpoint;
      if (separator === 0x7d) return value;
      if (separator !== 0x2c) throw new SyntaxError("Invalid compact JSON object");
      await this.#space();
    }
  }
}

interface CompactCooperativeControl {
  readonly yieldControl: () => Promise<void>;
  readonly rowsPerSlice: number;
  rowsSinceYield: number;
}

type ValidatedCompactRun = readonly [number, TerminalReplicaCell];

const compactDecodedColorKey = (color: TerminalReplicaColor): number =>
  color.kind === "default" ? -1 : color.kind === "indexed" ? color.index : 256 + color.value;

function compactInternDecodedCell(
  budget: CompactDecodeBudget,
  grapheme: string,
  width: 0 | 1 | 2,
  foreground: TerminalReplicaColor,
  background: TerminalReplicaColor,
  attributesValue: number,
): TerminalReplicaCell {
  const cache = budget.decodedCellCache;
  if (!cache)
    return Object.freeze({ grapheme, width, foreground, background, attributes: attributesValue });
  const widths = cache.get(grapheme) ?? new Map();
  cache.set(grapheme, widths);
  const foregroundKey = compactDecodedColorKey(foreground);
  const foregrounds = widths.get(width) ?? new Map();
  widths.set(width, foregrounds);
  const backgroundKey = compactDecodedColorKey(background);
  const backgrounds = foregrounds.get(foregroundKey) ?? new Map();
  foregrounds.set(foregroundKey, backgrounds);
  const attributes = backgrounds.get(backgroundKey) ?? new Map();
  backgrounds.set(backgroundKey, attributes);
  const cached = attributes.get(attributesValue);
  if (cached) return cached;
  const cell = Object.freeze({
    grapheme,
    width,
    foreground,
    background,
    attributes: attributesValue,
  });
  attributes.set(attributesValue, cell);
  budget.validatedCellAllocations += 1;
  return cell;
}

function compactRowReuseCollision(
  value: TerminalReplicaRow | readonly TerminalReplicaRow[],
): value is readonly TerminalReplicaRow[] {
  return Array.isArray(value);
}

async function compactBaselineRowReuseIndex(
  baseline: TerminalReplicaSnapshot,
  control: CompactCooperativeControl,
): Promise<ReadonlyMap<string, TerminalReplicaRow | readonly TerminalReplicaRow[]>> {
  const index = new Map<string, TerminalReplicaRow | readonly TerminalReplicaRow[]>();
  let rowsSinceYield = 0;
  for (const rows of [baseline.grid, baseline.history]) {
    for (const row of rows) {
      if (VALIDATED_COMPACT_RAW_ROW.has(row)) continue;
      if (!isTerminalReplicaRowDeeplyFrozen(row)) continue;
      const digest = await hashTerminalReplicaRowCooperatively(row, control.yieldControl);
      const existing = index.get(digest);
      if (!existing) index.set(digest, row);
      else if (compactRowReuseCollision(existing)) {
        if (!existing.includes(row)) index.set(digest, Object.freeze([...existing, row]));
      } else if (existing !== row) index.set(digest, Object.freeze([existing, row]));
      rowsSinceYield += 1;
      if (rowsSinceYield >= control.rowsPerSlice) {
        rowsSinceYield = 0;
        await control.yieldControl();
      }
    }
  }
  return index;
}

function compactColorsEqual(left: TerminalReplicaColor, right: TerminalReplicaColor): boolean {
  return (
    left.kind === right.kind &&
    (left.kind === "default" ||
      (left.kind === "indexed" && right.kind === "indexed" && left.index === right.index) ||
      (left.kind === "rgb" && right.kind === "rgb" && left.value === right.value))
  );
}

async function compactRowMatchesRuns(
  row: TerminalReplicaRow,
  wrapped: boolean,
  runs: readonly ValidatedCompactRun[],
  cellCount: number,
  control: CompactCooperativeControl,
): Promise<boolean> {
  if (row.wrapped !== wrapped || row.cells.length !== cellCount) return false;
  let offset = 0;
  let work = 0;
  for (const [count, cell] of runs) {
    for (let index = 0; index < count; index += 1) {
      const candidate = row.cells[offset++];
      if (
        !candidate ||
        candidate.grapheme !== cell.grapheme ||
        candidate.width !== cell.width ||
        candidate.attributes !== cell.attributes ||
        !compactColorsEqual(candidate.foreground, cell.foreground) ||
        !compactColorsEqual(candidate.background, cell.background)
      )
        return false;
      work += 1;
      if (work >= COOPERATIVE_CELL_WORK) {
        work = 0;
        await control.yieldControl();
      }
    }
  }
  return offset === cellCount;
}

async function expandRowsCooperatively(
  value: unknown,
  budget: CompactDecodeBudget,
  cols: number | null,
  maximum: number,
  label: string,
  control: CompactCooperativeControl,
): Promise<TerminalReplicaRow[]> {
  if (
    value !== null &&
    typeof value === "object" &&
    (value as Partial<CompactParsedRowsSlice>).kind === COMPACT_PARSED_ROWS_SLICE
  )
    return expandRowsSliceCooperatively(
      value as CompactParsedRowsSlice,
      budget,
      cols,
      maximum,
      label,
      control,
    );
  const inputs = compactArrayAtMost(value, maximum, label);
  if (label === "grid" && cols !== null && inputs.length !== maximum)
    throw new TypeError("Compact grid cardinality mismatch");
  const rows: TerminalReplicaRow[] = [];
  for (let index = 0; index < inputs.length; index += 1) {
    const input = inputs[index];
    const row = await expandRowCooperatively(input, budget, cols, control);
    // Prime only immutable, structurally validated rows. A failed envelope
    // cannot expose these WeakMap keys or mint a reducer capability.
    rows.push(row);
    // Release the parsed run/container graph as soon as its immutable row has
    // either been reused or constructed. The wire tree is never published.
    inputs[index] = null;
    control.rowsSinceYield += 1;
    if (control.rowsSinceYield >= control.rowsPerSlice) {
      control.rowsSinceYield = 0;
      await control.yieldControl();
    }
  }
  return Object.freeze(rows) as TerminalReplicaRow[];
}

async function expandRowsSliceCooperatively(
  slice: CompactParsedRowsSlice,
  budget: CompactDecodeBudget,
  cols: number | null,
  maximum: number,
  label: string,
  control: CompactCooperativeControl,
): Promise<TerminalReplicaRow[]> {
  const rows: TerminalReplicaRow[] = [];
  let index = slice.start + 1;
  const rowSlice = {
    kind: COMPACT_PARSED_ROW_SLICE,
    source: slice.source,
    start: index,
    end: index,
  };
  while (index < slice.end - 1) {
    if (rows.length >= maximum) throw new TypeError(`Invalid compact ${label}`);
    const start = index;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let work = 0;
    while (index < slice.end) {
      const character = slice.source.byteAt(index++);
      work += 1;
      if (work >= COOPERATIVE_JSON_WORK_CHARS) {
        work = 0;
        await control.yieldControl();
      }
      if (inString) {
        if (!escaped && character === 0x22) inString = false;
        escaped = !escaped && character === 0x5c;
        if (character !== 0x5c) escaped = false;
        continue;
      }
      if (character === 0x22) inString = true;
      else if (character === 0x5b) depth += 1;
      else if (character === 0x5d) {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    if (depth !== 0) throw new SyntaxError("Unterminated compact JSON row");
    rowSlice.start = start;
    rowSlice.end = index;
    rows.push(await expandRowCooperatively(rowSlice, budget, cols, control));
    const separator = slice.source.byteAt(index++);
    if (separator === 0x5d) break;
    if (separator !== 0x2c) throw new SyntaxError("Invalid compact JSON rows");
  }
  if (label === "grid" && cols !== null && rows.length !== maximum)
    throw new TypeError("Compact grid cardinality mismatch");
  return Object.freeze(rows) as TerminalReplicaRow[];
}

async function expandRowCooperatively(
  value: unknown,
  budget: CompactDecodeBudget,
  cols: number | null,
  control: CompactCooperativeControl,
): Promise<TerminalReplicaRow> {
  if (++budget.rows > COMPACT_MAX_ROWS) throw new TypeError("Compact semantic row budget exceeded");
  const parsedSlice =
    value !== null &&
    typeof value === "object" &&
    (value as Partial<CompactParsedRowSlice>).kind === COMPACT_PARSED_ROW_SLICE
      ? (value as CompactParsedRowSlice)
      : null;
  const rawHash = parsedSlice ? parsedSlice.source.hash(parsedSlice.start, parsedSlice.end) : null;
  const rawIndexed = rawHash === null ? undefined : budget.rawRowReuseIndex?.get(rawHash);
  const rawReuse = !rawIndexed
    ? undefined
    : parsedSlice!.source.equals(parsedSlice!.start, parsedSlice!.end, rawIndexed.raw)
      ? rawIndexed
      : rawIndexed.collisions?.find((candidate) =>
          parsedSlice!.source.equals(parsedSlice!.start, parsedSlice!.end, candidate.raw),
        );
  if (rawReuse) {
    if (cols !== null && rawReuse.cells !== cols) throw new TypeError("Compact row width mismatch");
    budget.runs += rawReuse.runs;
    budget.cells += rawReuse.cells;
    if (budget.runs > COMPACT_MAX_RUNS) throw new TypeError("Compact semantic run budget exceeded");
    if (budget.cells > budget.maxCells)
      throw new TypeError("Compact semantic expanded cell budget exceeded");
    budget.reusedRows += 1;
    return rawReuse.row;
  }
  const parsedValue = await expandParsedRowSlice(value, control);
  const input = compactArray(parsedValue, 2, "row");
  const wrapped = compactBit(input[0], "wrapped");
  const runs = compactArrayAtMost(input[1], COMPACT_MAX_RUNS, "cell runs");
  const validatedRuns: ValidatedCompactRun[] = [];
  let cellCount = 0;
  let cellWork = 0;
  for (const valueRun of runs) {
    if (++budget.runs > COMPACT_MAX_RUNS)
      throw new TypeError("Compact semantic run budget exceeded");
    const run = compactArray(valueRun, 6, "cell run");
    const count = compactInteger(run[0], 1, COMPACT_MAX_DIMENSION, "cell run count");
    budget.cells += count;
    cellCount += count;
    if (budget.cells > budget.maxCells)
      throw new TypeError("Compact semantic expanded cell budget exceeded");
    const cell = compactInternDecodedCell(
      budget,
      compactString(run[1], "grapheme"),
      compactInteger(run[2], 0, 2, "cell width") as 0 | 1 | 2,
      expandColor(run[3]),
      expandColor(run[4]),
      compactInteger(run[5], 0, 0xff, "cell attributes"),
    );
    run.length = 2;
    run[0] = count;
    run[1] = cell;
    validatedRuns.push(run as unknown as ValidatedCompactRun);
    for (let index = 0; index < count; index += 1) {
      cellWork += 1;
      if (cellWork >= COOPERATIVE_CELL_WORK) {
        cellWork = 0;
        await control.yieldControl();
      }
    }
  }
  if (cols !== null && cellCount !== cols) throw new TypeError("Compact row width mismatch");
  if (cellCount < 1 || cellCount > COMPACT_MAX_DIMENSION)
    throw new TypeError("Compact row width is out of bounds");
  let previousWidth: 0 | 1 | 2 | null = null;
  let validatedCells = 0;
  for (const [count, cell] of validatedRuns) {
    for (let index = 0; index < count; index += 1) {
      if (previousWidth === 2 && cell.width !== 0)
        throw new TypeError("Malformed compact wide cell");
      if (cell.width === 0 && previousWidth !== 2)
        throw new TypeError("Malformed compact continuation cell");
      previousWidth = cell.width;
      validatedCells += 1;
      if (validatedCells % COOPERATIVE_CELL_WORK === 0) await control.yieldControl();
    }
  }
  if (previousWidth === 2) throw new TypeError("Malformed compact wide cell");
  const digest = await hashTerminalReplicaRowRunsCooperatively(
    wrapped,
    cellCount,
    validatedRuns,
    control.yieldControl,
    64,
    (bytes) => {
      budget.canonicalUtf8Allocations += 1;
      budget.canonicalUtf8Bytes += bytes;
    },
    budget.runEncodingCache,
  );
  const indexed = budget.rowReuseIndex?.get(digest);
  if (
    indexed &&
    !compactRowReuseCollision(indexed) &&
    (await compactRowMatchesRuns(indexed, wrapped, validatedRuns, cellCount, control))
  ) {
    budget.reusedRows += 1;
    if (parsedSlice !== null && rawHash !== null)
      VALIDATED_COMPACT_RAW_ROW.set(
        indexed,
        Object.freeze({
          row: indexed,
          raw: parsedSlice.source.bytes(parsedSlice.start, parsedSlice.end).slice(),
          rawHash,
          runs: validatedRuns.length,
          cells: cellCount,
        }),
      );
    return indexed;
  }
  if (indexed && compactRowReuseCollision(indexed)) {
    for (const candidate of indexed) {
      if (!(await compactRowMatchesRuns(candidate, wrapped, validatedRuns, cellCount, control)))
        continue;
      budget.reusedRows += 1;
      if (parsedSlice !== null && rawHash !== null)
        VALIDATED_COMPACT_RAW_ROW.set(
          candidate,
          Object.freeze({
            row: candidate,
            raw: parsedSlice.source.bytes(parsedSlice.start, parsedSlice.end).slice(),
            rawHash,
            runs: validatedRuns.length,
            cells: cellCount,
          }),
        );
      return candidate;
    }
  }
  const cells: TerminalReplicaCell[] = [];
  let allocatedWork = 0;
  for (const [count, cell] of validatedRuns) {
    for (let index = 0; index < count; index += 1) {
      cells.push(cell);
      allocatedWork += 1;
      if (allocatedWork >= COOPERATIVE_CELL_WORK) {
        allocatedWork = 0;
        await control.yieldControl();
      }
    }
  }
  const row = Object.freeze({
    cells: Object.freeze(cells),
    wrapped,
  }) as unknown as TerminalReplicaRow;
  budget.allocatedCells += cells.length;
  primeTerminalReplicaRowHash(row, digest);
  if (parsedSlice !== null && rawHash !== null)
    VALIDATED_COMPACT_RAW_ROW.set(
      row,
      Object.freeze({
        row,
        raw: parsedSlice.source.bytes(parsedSlice.start, parsedSlice.end).slice(),
        rawHash,
        runs: validatedRuns.length,
        cells: cellCount,
      }),
    );
  return row;
}

async function expandParsedRowSlice(
  value: unknown,
  control: CompactCooperativeControl,
): Promise<unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    (value as Partial<CompactParsedRowSlice>).kind !== COMPACT_PARSED_ROW_SLICE
  )
    return value;
  const slice = value as CompactParsedRowSlice;
  const rowSource = new CooperativeJsonSource(slice.source.bytes(slice.start, slice.end));
  return new CooperativeJsonParser(rowSource, control.yieldControl).parse();
}

async function expandSnapshotCooperatively(
  value: unknown,
  budget: CompactDecodeBudget,
  control: CompactCooperativeControl,
): Promise<TerminalReplicaSnapshot> {
  const input = compactArray(value, 8, "snapshot");
  const cols = compactInteger(input[0], 1, COMPACT_MAX_DIMENSION, "columns");
  const rows = compactInteger(input[1], 1, COMPACT_MAX_DIMENSION, "rows");
  const grid = await expandRowsCooperatively(input[2], budget, cols, rows, "grid", control);
  input[2] = null;
  const history = await expandRowsCooperatively(
    input[3],
    budget,
    cols,
    COMPACT_MAX_ROWS,
    "history",
    control,
  );
  input[3] = null;
  const snapshot = Object.freeze({
    cols,
    rows,
    grid,
    history,
    cursor: expandCursor(input[4], cols, rows),
    modes: expandModes(input[5]),
    placements: await expandPlacementsCooperatively(input[6], budget, control),
    bootstrap: expandBootstrap(input[7]),
  });
  if (
    snapshot.placements.some(
      (placement) =>
        placement.row + placement.rows > rows || placement.column + placement.columns > cols,
    )
  )
    throw new TypeError("Compact placement is outside the viewport");
  return snapshot as unknown as TerminalReplicaSnapshot;
}

async function expandPatchCooperatively(
  value: unknown,
  budget: CompactDecodeBudget,
  control: CompactCooperativeControl,
): Promise<TerminalReplicaPatchPayload> {
  const input = compactArray(value, 8, "patch");
  const dimensions =
    input[0] === null
      ? undefined
      : (() => {
          const pair = compactArray(input[0], 2, "dimensions");
          return Object.freeze({
            cols: compactInteger(pair[0], 1, COMPACT_MAX_DIMENSION, "columns"),
            rows: compactInteger(pair[1], 1, COMPACT_MAX_DIMENSION, "rows"),
          });
        })();
  const rowInputs = compactArrayAtMost(input[1], COMPACT_MAX_DIMENSION, "dirty rows");
  const rows = [];
  for (let index = 0; index < rowInputs.length; index += 1) {
    const entry = rowInputs[index];
    const pair = compactArray(entry, 2, "dirty row");
    const row = await expandRowCooperatively(pair[1], budget, dimensions?.cols ?? null, control);
    rows.push(
      Object.freeze({
        index: compactInteger(pair[0], 0, COMPACT_MAX_DIMENSION - 1, "row index"),
        row,
      }),
    );
    rowInputs[index] = null;
    control.rowsSinceYield += 1;
    if (control.rowsSinceYield >= control.rowsPerSlice) {
      control.rowsSinceYield = 0;
      await control.yieldControl();
    }
  }
  const history =
    input[2] === null
      ? undefined
      : await expandRowsCooperatively(input[2], budget, null, COMPACT_MAX_ROWS, "history", control);
  const historyDelta =
    input[3] === null
      ? undefined
      : await (async () => {
          const pair = compactArray(input[3], 2, "history delta");
          return Object.freeze({
            trim: compactInteger(pair[0], 0, COMPACT_MAX_ROWS, "history trim"),
            append: await expandRowsCooperatively(
              pair[1],
              budget,
              null,
              COMPACT_MAX_ROWS,
              "history append",
              control,
            ),
          });
        })();
  if (history && historyDelta) throw new TypeError("Compact patch has two history representations");
  return Object.freeze({
    ...(dimensions ? { dimensions } : {}),
    rows: Object.freeze(rows),
    ...(history ? { history } : {}),
    ...(historyDelta ? { historyDelta } : {}),
    ...(input[4] === null
      ? {}
      : { cursor: expandCursor(input[4], dimensions?.cols ?? null, dimensions?.rows ?? null) }),
    ...(input[5] === null ? {} : { modes: expandModes(input[5]) }),
    ...(input[6] === null
      ? {}
      : { placements: await expandPlacementsCooperatively(input[6], budget, control) }),
    ...(input[7] === null ? {} : { bootstrap: expandBootstrap(input[7]) }),
  }) as unknown as TerminalReplicaPatchPayload;
}

/**
 * OpenTUI fallback seam. Legacy JSON still pays its full Zod decode, deep
 * freeze/apply, and canonical hash verification before receiving a one-shot
 * reducer grant; the reducer never trusts an ordinary legacy object.
 */
export function decodeVerifiedLegacySemanticTerminalUpdate(
  bytes: Uint8Array,
  baseline: TerminalReplicaSnapshot | null,
  expectedHash: string,
): Readonly<{
  payload: TerminalSemanticDeliveryPayload;
  canonicalSnapshot: TerminalReplicaSnapshot | null;
}> {
  const payload = decodeSemanticTerminalUpdate(bytes);
  const snapshot =
    payload.frame === "seed"
      ? freezeTerminalReplicaSnapshot(payload.snapshot)
      : payload.frame === "patch"
        ? baseline
          ? applyTerminalReplicaPatch(baseline, payload.patch)
          : (() => {
              throw new TypeError("Semantic delivery baseline gap");
            })()
        : null;
  const hash = snapshot
    ? hashTerminalReplicaSnapshot(snapshot)
    : hashTerminalReplicaTombstone(
        payload.frame === "tombstone" ? payload.tombstone.reason : "protocol",
      );
  if (hash !== expectedHash) throw new TypeError("Canonical state hash mismatch");
  grantCompactReplicaCapability(
    payload.frame === "seed"
      ? snapshot!
      : payload.frame === "patch"
        ? payload.patch
        : payload.tombstone,
    baseline,
    snapshot,
    hash,
  );
  return Object.freeze({ payload, canonicalSnapshot: snapshot });
}

function recordWithKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0")
  );
}

export function splitTerminalDeliveryChunks(
  transactionId: string,
  bytes: Uint8Array,
): TerminalDeliveryChunk[] {
  assertRepresentationSize(bytes);
  const chunks: TerminalDeliveryChunk[] = [];
  const count = Math.max(1, Math.ceil(bytes.byteLength / TERMINAL_DELIVERY_CHUNK_BYTES));
  for (let index = 0; index < count; index += 1) {
    chunks.push({
      type: "terminal.delivery.chunk",
      transactionId,
      index,
      bytes: bytes.slice(
        index * TERMINAL_DELIVERY_CHUNK_BYTES,
        Math.min(bytes.byteLength, (index + 1) * TERMINAL_DELIVERY_CHUNK_BYTES),
      ),
    });
  }
  return chunks;
}

class TerminalDeliveryRepresentationHasher {
  // Two independent 32-bit lanes avoid BigInt's per-byte allocation cost while
  // retaining a deterministic 64-bit wire fingerprint in browser and daemon.
  #high = 0x811c9dc5;
  #low = 0x9e3779b9;

  write(bytes: Uint8Array): void {
    for (const byte of bytes) {
      this.#high = Math.imul(this.#high ^ byte, 0x01000193) >>> 0;
      this.#low = Math.imul(this.#low ^ byte, 0x85ebca6b) >>> 0;
    }
  }

  digest(): string {
    return this.#high.toString(16).padStart(8, "0") + this.#low.toString(16).padStart(8, "0");
  }
}

export function hashTerminalDeliveryRepresentation(bytes: Uint8Array): string {
  const hasher = new TerminalDeliveryRepresentationHasher();
  hasher.write(bytes);
  return hasher.digest();
}

export function diffTerminalReplicaSnapshots(
  baseline: TerminalReplicaSnapshot,
  target: TerminalReplicaSnapshot,
): TerminalReplicaPatchPayload {
  const dimensionsChanged = baseline.cols !== target.cols || baseline.rows !== target.rows;
  const rows = target.grid.flatMap((row, index) =>
    dimensionsChanged || !terminalReplicaRowsEqual(baseline.grid[index], row)
      ? [{ index, row }]
      : [],
  );
  return {
    ...(dimensionsChanged ? { dimensions: { cols: target.cols, rows: target.rows } } : {}),
    rows,
    ...(historyEqual(baseline.history, target.history) ? {} : { history: target.history }),
    cursor: target.cursor,
    modes: target.modes,
    placements: target.placements,
    bootstrap: target.bootstrap,
  };
}

export function encodeAnsiTerminalRepresentation(
  baseline: TerminalReplicaSnapshot | null,
  target: TerminalReplicaSnapshot,
): Uint8Array {
  let output = "";
  // A seed replaces an unknown renderer, which may still be sitting in either
  // DEC buffer. Emit the target buffer explicitly in both directions before
  // clearing/repainting so reconnecting while alternate is active cannot paint
  // alternate cells into normal (and a normal reseed cannot remain in 1049).
  const alternateScreenChanged =
    baseline === null || baseline.modes.alternateScreen !== target.modes.alternateScreen;
  if (alternateScreenChanged)
    output += target.modes.alternateScreen ? "\u001b[?1049h" : "\u001b[?1049l";
  if (
    !baseline ||
    baseline.cols !== target.cols ||
    baseline.rows !== target.rows ||
    alternateScreenChanged ||
    !historyEqual(baseline.history, target.history)
  ) {
    output += "\u001b[0m\u001b[2J\u001b[3J\u001b[H";
    if (target.history.length > 0) output += renderAnsiSeedRows(target);
    else {
      output += prepareAnsiTopWrappedRow(target);
      output += renderAnsiRowChains(
        target,
        target.grid.map((_, index) => index),
        false,
      );
    }
  } else {
    const changedRows = new Map<number, TerminalReplicaRow>();
    for (let row = 0; row < target.rows; row += 1) {
      if (terminalReplicaRowsEqual(baseline.grid[row], target.grid[row]!)) continue;
      changedRows.set(row, target.grid[row]!);
    }
    if (
      [...changedRows].some(([index, row]) => row.wrapped || baseline.grid[index]?.wrapped === true)
    )
      return encodeAnsiTerminalRepresentation(null, target);
    output += renderAnsiPatchRows(target, changedRows);
    if (changedRows.size === 0 && baseline.modes.wraparound !== target.modes.wraparound)
      output += ansiWraparoundPresentation(target);
  }
  output += ansiInputModesPresentation(target, baseline);
  output += ansiCursorPresentation(target);
  const bytes = new TextEncoder().encode(output);
  assertRepresentationSize(bytes);
  return bytes;
}

/**
 * Reconstruct an unknown emulator from canonical scrollback plus viewport.
 * Writing the rows in wire order lets xterm itself create scrollback and soft
 * wraps; repainting only addressable viewport rows would silently discard the
 * selection/search identity carried by `snapshot.history`.
 */
function renderAnsiSeedRows(target: TerminalReplicaSnapshot): string {
  const rows = [...target.history, ...target.grid];
  let output = "\u001b[?7h";
  rows.forEach((row, index) => {
    if (index > 0 && !row.wrapped) output += "\r\n";
    output += renderAnsiRow(row);
  });
  output += ansiWraparoundPresentation(target);
  return output;
}

/**
 * Encode an admitted semantic patch from its explicit dirty rows.
 *
 * The patch is the canonical change set; comparing every immutable grid row
 * again in the renderer turns a one-line terminal update into O(screen rows)
 * work. Dimension changes remain a full repaint, while ordinary deltas touch
 * only `patch.rows` plus the cursor.
 */
export function encodeAnsiTerminalPatchRepresentation(
  patch: TerminalReplicaPatchPayload,
  target: TerminalReplicaSnapshot,
  baseline: TerminalReplicaSnapshot,
): Uint8Array {
  if (patch.dimensions || baseline.modes.alternateScreen !== target.modes.alternateScreen)
    return encodeAnsiTerminalRepresentation(baseline, target);
  const patchedRows = new Map(patch.rows.map(({ index, row }) => [index, row] as const));
  // xterm's `isWrapped` is line topology, not cell content. Clearing/repainting
  // a line is not a portable way to change that bit after an unrelated prior
  // frame (notably workload -> baseline -> rich). Whenever a dirty row touches
  // either side of a soft-wrap transition, rebuild the exact buffer so stale
  // topology cannot survive or be manufactured by a partial repaint.
  if (
    [...patchedRows].some(([index, row]) => row.wrapped || baseline.grid[index]?.wrapped === true)
  )
    return encodeAnsiTerminalRepresentation(null, target);
  let output = "";
  const historyDelta = patch.historyDelta;
  const appendedRows = historyDelta?.append.length ?? 0;
  const incrementalScroll =
    historyDelta &&
    historyDelta.trim === 0 &&
    appendedRows > 0 &&
    appendedRows <= baseline.rows &&
    patchedRows.size === patch.rows.length &&
    [...patchedRows].every(
      ([index, row]) =>
        index >= 0 && index < target.rows && terminalReplicaRowsEqual(row, target.grid[index]!),
    ) &&
    historyDelta.append.every((row, index) =>
      terminalReplicaRowsEqual(row, baseline.grid[index]!),
    ) &&
    target.grid.every((row, index) => {
      const shiftedIndex = index + appendedRows;
      if (shiftedIndex < baseline.rows) {
        return (
          terminalReplicaRowsEqual(row, baseline.grid[shiftedIndex]!) || patchedRows.has(index)
        );
      }
      // LF creates emulator-owned blank bottom rows. Requiring an exact dirty
      // replacement avoids depending on an implicit blank-row representation.
      return patchedRows.has(index);
    });
  if (incrementalScroll) {
    // A line-feed at the viewport bottom asks xterm to perform the same scroll
    // that moved these canonical rows into history. This preserves existing
    // selection/viewport state and lets xterm enforce its own scrollback cap;
    // replaying all 5k history rows on every append would be destructive and
    // quadratic over a sustained terminal stream.
    output += `\u001b[${target.rows};1H`;
    output += "\n".repeat(appendedRows);
  } else if (
    (patch.history !== undefined || patch.historyDelta !== undefined) &&
    !historyEqual(baseline.history, target.history)
  ) {
    // Full history replacement has no incremental authority. It is rare and
    // must remain exact rather than synthesizing an unsafe delta.
    return encodeAnsiTerminalRepresentation(null, target);
  }
  output += renderAnsiPatchRows(target, patchedRows);
  if (patchedRows.size === 0 && baseline.modes.wraparound !== target.modes.wraparound)
    output += ansiWraparoundPresentation(target);
  output += ansiInputModesPresentation(target, baseline);
  output += ansiCursorPresentation(target);
  const bytes = new TextEncoder().encode(output);
  assertRepresentationSize(bytes);
  return bytes;
}

function renderAnsiPatchRows(
  target: TerminalReplicaSnapshot,
  patchedRows: ReadonlyMap<number, TerminalReplicaRow>,
): string {
  const affectedRows = new Set(patchedRows.keys());
  for (const index of patchedRows.keys()) {
    let dependency = index;
    while (dependency > 0 && (patchedRows.get(dependency) ?? target.grid[dependency])?.wrapped) {
      dependency -= 1;
      affectedRows.add(dependency);
    }
  }
  return renderAnsiRowChains(
    target,
    [...affectedRows].sort((left, right) => left - right),
    true,
    patchedRows,
  );
}

function ansiCursorPresentation(target: TerminalReplicaSnapshot): string {
  const cursorShape =
    target.cursor.style === "underline"
      ? target.cursor.blink
        ? 3
        : 4
      : target.cursor.style === "bar"
        ? target.cursor.blink
          ? 5
          : 6
        : target.cursor.blink
          ? 1
          : 2;
  return (
    `\u001b[${target.cursor.y + 1};${target.cursor.x + 1}H` +
    `\u001b[${cursorShape} q` +
    (target.cursor.hidden ? "\u001b[?25l" : "\u001b[?25h")
  );
}

function ansiWraparoundPresentation(target: TerminalReplicaSnapshot): string {
  return target.modes.wraparound ? "\u001b[?7h" : "\u001b[?7l";
}

/**
 * Restore the emulator modes that affect subsequent input and parsing. These
 * are deliberately emitted after painting/cursor placement: origin, insert,
 * and synchronized-output modes must describe the resulting terminal without
 * changing how the reconstruction itself is interpreted.
 */
function ansiInputModesPresentation(
  target: TerminalReplicaSnapshot,
  baseline: TerminalReplicaSnapshot | null,
): string {
  const prior = baseline?.modes;
  const modes = target.modes;
  let output = "";
  const decMode = (code: number, enabled: boolean): string =>
    `\u001b[?${code}${enabled ? "h" : "l"}`;
  const ansiMode = (code: number, enabled: boolean): string =>
    `\u001b[${code}${enabled ? "h" : "l"}`;
  if (!prior || prior.applicationCursor !== modes.applicationCursor)
    output += decMode(1, modes.applicationCursor);
  if (!prior || prior.applicationKeypad !== modes.applicationKeypad)
    output += modes.applicationKeypad ? "\u001b=" : "\u001b>";
  if (!prior || prior.bracketedPaste !== modes.bracketedPaste)
    output += decMode(2004, modes.bracketedPaste);
  if (!prior || prior.insert !== modes.insert) output += ansiMode(4, modes.insert);
  if (!prior || prior.origin !== modes.origin) output += decMode(6, modes.origin);
  const mouseChanged =
    !prior ||
    prior.mouseTracking !== modes.mouseTracking ||
    prior.mouseProtocol !== modes.mouseProtocol ||
    prior.mouseEncoding !== modes.mouseEncoding;
  if (mouseChanged) {
    output += decMode(9, false);
    output += decMode(1000, false);
    output += decMode(1002, false);
    output += decMode(1003, false);
    output += decMode(1005, false);
    output += decMode(1006, false);
    output += decMode(1016, false);
    if (modes.mouseTracking) {
      const protocol = modes.mouseProtocol ?? "vt200";
      if (protocol === "x10") output += decMode(9, true);
      else if (protocol === "drag") output += decMode(1002, true);
      else if (protocol === "any") output += decMode(1003, true);
      else if (protocol !== "none") output += decMode(1000, true);
    }
    if (modes.mouseEncoding === "utf8") output += decMode(1005, true);
    else if (modes.mouseEncoding === "sgr") output += decMode(1006, true);
    else if (modes.mouseEncoding === "sgr-pixels") output += decMode(1016, true);
  }
  if (!prior || prior.synchronizedOutput !== modes.synchronizedOutput)
    output += decMode(2026, modes.synchronizedOutput);
  return output;
}

export interface TerminalDeliveryClientState {
  readonly negotiated: TerminalDeliveryNegotiated;
  readonly workspaceName: string;
  readonly semanticPaneId: string;
  readonly incarnation: string | null;
  readonly appliedRevision: number;
  readonly appliedHash: string | null;
  readonly canonicalSnapshot: TerminalReplicaSnapshot | null;
  readonly inFlight: TerminalDeliveryEnvelope | null;
  readonly nextChunk: number;
  readonly receivedBytes: number;
  readonly reseedRequired: boolean;
  readonly failed: boolean;
  readonly tombstoned: boolean;
}

export function createTerminalDeliveryClientState(
  negotiated: TerminalDeliveryNegotiated,
  workspaceName: string,
  semanticPaneId: string,
): TerminalDeliveryClientState {
  return Object.freeze({
    negotiated: Object.freeze(TerminalDeliveryNegotiatedSchemaZ.parse(negotiated)),
    workspaceName,
    semanticPaneId,
    incarnation: null,
    appliedRevision: -1,
    appliedHash: null,
    canonicalSnapshot: null,
    inFlight: null,
    nextChunk: 0,
    receivedBytes: 0,
    reseedRequired: false,
    failed: false,
    tombstoned: false,
  });
}

export function admitTerminalDeliveryEnvelope(
  state: TerminalDeliveryClientState,
  envelope: TerminalDeliveryEnvelope,
): TerminalDeliveryClientState {
  envelope = Object.freeze(TerminalDeliveryEnvelopeSchemaZ.parse(envelope));
  if (
    state.failed ||
    state.inFlight ||
    !terminalDeliveryEncodingAccepted(state.negotiated, envelope.encoding) ||
    envelope.generation !== state.negotiated.generation ||
    envelope.deliveryNonce !== state.negotiated.deliveryNonce ||
    envelope.protocolVersion !== state.negotiated.protocolVersion ||
    envelope.richPlacements !== state.negotiated.richPlacements ||
    state.workspaceName !== envelope.workspaceName ||
    state.semanticPaneId !== envelope.semanticPaneId
  )
    return failClient(state);
  if (envelope.frame === "seed") {
    if (state.tombstoned && state.incarnation === envelope.incarnation) return failClient(state);
    if (
      state.incarnation === envelope.incarnation &&
      state.appliedRevision >= 0 &&
      envelope.canonicalRevision <= state.appliedRevision
    )
      return failClient(state);
    if (
      state.incarnation !== null &&
      state.incarnation !== envelope.incarnation &&
      (!isNewerIncarnation(state.incarnation, envelope.incarnation) ||
        envelope.canonicalRevision <= state.appliedRevision)
    )
      return failClient(state);
  } else if (
    state.incarnation !== envelope.incarnation ||
    envelope.baseRevision !== state.appliedRevision ||
    state.reseedRequired
  ) {
    return failClient(state);
  }
  if (envelope.frame !== "seed" && state.appliedRevision < 0) return failClient(state);
  return Object.freeze({ ...state, inFlight: envelope, nextChunk: 0, receivedBytes: 0 });
}

export function terminalDeliveryEncodingAccepted(
  negotiated: TerminalDeliveryNegotiated,
  encoding: TerminalDeliveryEnvelope["encoding"],
): boolean {
  return (
    encoding === negotiated.encoding ||
    (negotiated.encoding === "semantic-compact-v1" &&
      negotiated.fallbackEncoding === "semantic-v1" &&
      encoding === "semantic-v1")
  );
}

export function admitTerminalDeliveryChunk(
  state: TerminalDeliveryClientState,
  chunk: TerminalDeliveryChunk,
): TerminalDeliveryClientState {
  chunk = TerminalDeliveryChunkSchemaZ.parse(chunk);
  const envelope = state.inFlight;
  const expectedBytes = envelope
    ? Math.min(
        TERMINAL_DELIVERY_CHUNK_BYTES,
        Math.max(0, envelope.representationBytes - chunk.index * TERMINAL_DELIVERY_CHUNK_BYTES),
      )
    : -1;
  if (
    state.failed ||
    !state.inFlight ||
    chunk.transactionId !== state.inFlight.transactionId ||
    chunk.index !== state.nextChunk ||
    chunk.index >= state.inFlight.chunkCount ||
    chunk.bytes.byteLength !== expectedBytes ||
    state.receivedBytes + chunk.bytes.byteLength > state.inFlight.representationBytes
  )
    return failClient(state);
  return Object.freeze({
    ...state,
    nextChunk: state.nextChunk + 1,
    receivedBytes: state.receivedBytes + chunk.bytes.byteLength,
  });
}

export class TerminalDeliveryAssembler {
  readonly #storage: Uint8Array;
  readonly #buffer: Uint8Array;
  readonly #representationHasher = new TerminalDeliveryRepresentationHasher();
  readonly envelope: TerminalDeliveryEnvelope;
  #nextChunk = 0;
  #offset = 0;
  constructor(envelope: TerminalDeliveryEnvelope, reusableStorage?: Uint8Array) {
    this.envelope = Object.freeze(TerminalDeliveryEnvelopeSchemaZ.parse(envelope));
    this.#storage =
      reusableStorage && reusableStorage.byteLength >= this.envelope.representationBytes
        ? reusableStorage
        : new Uint8Array(this.envelope.representationBytes);
    this.#buffer = this.#storage.subarray(0, this.envelope.representationBytes);
  }
  write(chunk: TerminalDeliveryChunk): void {
    chunk = TerminalDeliveryChunkSchemaZ.parse(chunk);
    const expected = Math.min(
      TERMINAL_DELIVERY_CHUNK_BYTES,
      this.envelope.representationBytes - this.#offset,
    );
    if (
      chunk.transactionId !== this.envelope.transactionId ||
      chunk.index !== this.#nextChunk ||
      chunk.bytes.byteLength !== expected
    )
      throw new TypeError("Invalid terminal delivery chunk");
    this.#buffer.set(chunk.bytes, this.#offset);
    this.#representationHasher.write(chunk.bytes);
    this.#offset += chunk.bytes.byteLength;
    this.#nextChunk += 1;
  }
  complete(): Uint8Array {
    if (
      this.#offset !== this.envelope.representationBytes ||
      this.#nextChunk !== this.envelope.chunkCount
    )
      throw new TypeError("Terminal delivery transaction is incomplete");
    if (this.#representationHasher.digest() !== this.envelope.representationHash)
      throw new TypeError("Terminal delivery representation hash mismatch");
    return this.#buffer;
  }

  releaseStorage(): Uint8Array {
    if (
      this.#offset !== this.envelope.representationBytes ||
      this.#nextChunk !== this.envelope.chunkCount
    )
      throw new TypeError("Terminal delivery transaction is incomplete");
    return this.#storage;
  }
}

export interface StagedTerminalDelivery {
  readonly envelope: TerminalDeliveryEnvelope;
  readonly bytes: Uint8Array;
}

export function completeTerminalDelivery(
  state: TerminalDeliveryClientState,
  assembler: TerminalDeliveryAssembler,
): StagedTerminalDelivery {
  const envelope = state.inFlight;
  if (
    !envelope ||
    state.failed ||
    !sameEnvelope(assembler.envelope, envelope) ||
    state.nextChunk !== envelope.chunkCount ||
    state.receivedBytes !== envelope.representationBytes
  )
    throw new TypeError("Terminal delivery transaction is incomplete");
  return { envelope, bytes: assembler.complete() };
}

export function commitTerminalDelivery(
  state: TerminalDeliveryClientState,
  staged: StagedTerminalDelivery,
  options: { readonly presentationApplied?: boolean } = {},
): {
  readonly state: TerminalDeliveryClientState;
  readonly ack: TerminalDeliveryAck;
  /** The one authenticated semantic decode used to produce `state`. */
  readonly semanticUpdate: TerminalSemanticDeliveryPayload | null;
} {
  const envelope = state.inFlight;
  if (!envelope || !sameEnvelope(envelope, staged.envelope))
    throw new TypeError("Delivery was not staged from this state");
  if (hashTerminalDeliveryRepresentation(staged.bytes) !== envelope.representationHash)
    throw new TypeError("Terminal delivery representation hash mismatch");
  let canonicalSnapshot = state.canonicalSnapshot;
  let semanticUpdate: TerminalSemanticDeliveryPayload | null = null;
  if (envelope.encoding === "semantic-v1" || envelope.encoding === "semantic-compact-v1") {
    const payload =
      envelope.encoding === "semantic-compact-v1"
        ? decodeVerifiedCompactSemanticTerminalUpdate(
            staged.bytes,
            canonicalSnapshot,
            envelope.canonicalStateHash,
          ).payload
        : decodeSemanticTerminalUpdate(staged.bytes);
    semanticUpdate = payload;
    if (payload.frame !== envelope.frame || payload.revision !== envelope.canonicalRevision)
      throw new TypeError("Semantic frame or revision mismatch");
    if (
      payload.frame !== "seed" &&
      (payload.baseRevision !== envelope.baseRevision ||
        payload.baseRevision !== state.appliedRevision)
    )
      throw new TypeError("Semantic delivery baseline gap");
    const compactCapability = compactCommitCapabilities.get(payload);
    if (envelope.encoding === "semantic-compact-v1") {
      if (!compactCapability || compactCapability.hash !== envelope.canonicalStateHash)
        throw new TypeError("Compact semantic capability was unavailable");
      canonicalSnapshot = compactCapability.snapshot;
      compactCommitCapabilities.delete(payload);
    } else {
      if (payload.frame === "seed")
        canonicalSnapshot = freezeTerminalReplicaSnapshot(payload.snapshot);
      else if (payload.frame === "patch") {
        if (!canonicalSnapshot) throw new TypeError("Semantic delivery baseline gap");
        canonicalSnapshot = applyTerminalReplicaPatch(canonicalSnapshot, payload.patch);
      } else canonicalSnapshot = null;
      const hash = canonicalSnapshot
        ? hashTerminalReplicaSnapshot(canonicalSnapshot)
        : hashTerminalReplicaTombstone(
            payload.frame === "tombstone" ? payload.tombstone.reason : "protocol",
          );
      if (hash !== envelope.canonicalStateHash)
        throw new TypeError("Canonical state hash mismatch");
    }
  } else if (!options.presentationApplied) {
    throw new TypeError("ANSI presentation must be applied before ACK");
  }
  const next = Object.freeze({
    ...state,
    workspaceName: envelope.workspaceName,
    semanticPaneId: envelope.semanticPaneId,
    incarnation: envelope.incarnation,
    appliedRevision: envelope.canonicalRevision,
    appliedHash: envelope.canonicalStateHash,
    canonicalSnapshot,
    tombstoned: envelope.frame === "tombstone",
    inFlight: null,
    nextChunk: 0,
    receivedBytes: 0,
    reseedRequired: false,
  });
  return {
    state: next,
    semanticUpdate,
    ack: {
      type: "terminal.delivery.ack",
      workspaceName: envelope.workspaceName,
      semanticPaneId: envelope.semanticPaneId,
      generation: envelope.generation,
      incarnation: envelope.incarnation,
      deliveryNonce: envelope.deliveryNonce,
      transactionId: envelope.transactionId,
      canonicalRevision: envelope.canonicalRevision,
      canonicalStateHash: envelope.canonicalStateHash,
      representationHash: envelope.representationHash,
    },
  };
}

export function nackTerminalDelivery(
  state: TerminalDeliveryClientState,
  nack: TerminalDeliveryNack,
): TerminalDeliveryClientState {
  nack = TerminalDeliveryNackSchemaZ.parse(nack);
  if (
    nack.generation !== state.negotiated.generation ||
    nack.deliveryNonce !== state.negotiated.deliveryNonce ||
    nack.workspaceName !== state.workspaceName ||
    nack.semanticPaneId !== state.semanticPaneId
  )
    return failClient(state);
  if (state.inFlight && nack.transactionId !== state.inFlight.transactionId)
    return failClient(state);
  return Object.freeze({
    ...state,
    inFlight: null,
    nextChunk: 0,
    receivedBytes: 0,
    reseedRequired: true,
    failed: false,
  });
}

function failClient(state: TerminalDeliveryClientState): TerminalDeliveryClientState {
  return Object.freeze({ ...state, failed: true, inFlight: null, receivedBytes: 0 });
}

function sameEnvelope(left: TerminalDeliveryEnvelope, right: TerminalDeliveryEnvelope): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function historyEqual(
  left: readonly TerminalReplicaRow[],
  right: readonly TerminalReplicaRow[],
): boolean {
  return (
    left === right ||
    (left.length === right.length &&
      left.every((row, index) => terminalReplicaRowsEqual(row, right[index]!)))
  );
}

function renderAnsiRow(row: TerminalReplicaRow): string {
  let output = "\u001b[0m";
  for (const cell of row.cells) {
    if (cell.width === 0) continue;
    output += ansiCellStyle(cell);
    output += cell.grapheme;
  }
  return `${output}\u001b[0m`;
}

/**
 * Repaint rows while preserving the emulator's soft-wrap topology. A wrapped
 * row can only be created by letting a printable cell cross the preceding
 * row's right margin; CUP/CRLF reconstruction loses that bit even when every
 * cell is otherwise exact. Patch callers therefore include the unchanged
 * predecessor of a dirty wrapped row and repaint the whole wrapped chain.
 */
function renderAnsiRowChains(
  target: TerminalReplicaSnapshot,
  indices: readonly number[],
  clearRows: boolean,
  patchedRows: ReadonlyMap<number, TerminalReplicaRow> = new Map(),
): string {
  if (indices.length === 0) return "";
  const rowAt = (index: number): TerminalReplicaRow =>
    patchedRows.get(index) ?? target.grid[index]!;
  let output = "\u001b[?7h";
  if (clearRows) {
    for (const index of indices) output += `\u001b[${index + 1};1H\u001b[2K`;
  }
  let previous = -2;
  for (const index of indices) {
    const row = rowAt(index);
    const continuesPrevious = index === previous + 1 && row.wrapped;
    if (!continuesPrevious) output += `\u001b[${index + 1};1H`;
    output += renderAnsiRow(row);
    previous = index;
  }
  output += ansiWraparoundPresentation(target);
  return output;
}

/**
 * CUP cannot manufacture a wrapped first viewport row because its predecessor
 * lives above the addressable viewport. Build that bit once through a bounded
 * bottom-row wrap, move the line to the top, and discard the synthetic
 * scrollback before the ordinary exact repaint. Patch callers fall back to
 * this seed whenever row zero itself must be repainted as wrapped.
 */
function prepareAnsiTopWrappedRow(target: TerminalReplicaSnapshot): string {
  const first = target.grid[0];
  if (!first?.wrapped) return "";
  let output = `\u001b[?7h\u001b[${target.rows};1H\u001b[2K`;
  output += renderAnsiRow(first);
  output += renderAnsiRow(first);
  if (target.rows > 1) output += `\u001b[${target.rows - 1}S`;
  return `${output}\u001b[3J`;
}

function ansiCellStyle(cell: TerminalReplicaRow["cells"][number]): string {
  const codes: number[] = [0];
  if (cell.attributes & 1) codes.push(1);
  if (cell.attributes & 2) codes.push(2);
  if (cell.attributes & 4) codes.push(3);
  if (cell.attributes & 8) codes.push(4);
  if (cell.attributes & 32) codes.push(7);
  if (cell.attributes & 128) codes.push(9);
  if (cell.foreground.kind === "indexed") codes.push(38, 5, cell.foreground.index);
  if (cell.foreground.kind === "rgb")
    codes.push(
      38,
      2,
      (cell.foreground.value >> 16) & 255,
      (cell.foreground.value >> 8) & 255,
      cell.foreground.value & 255,
    );
  if (cell.background.kind === "indexed") codes.push(48, 5, cell.background.index);
  if (cell.background.kind === "rgb")
    codes.push(
      48,
      2,
      (cell.background.value >> 16) & 255,
      (cell.background.value >> 8) & 255,
      cell.background.value & 255,
    );
  return `\u001b[${codes.join(";")}m`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function assertRepresentationSize(bytes: Uint8Array): void {
  if (bytes.byteLength > TERMINAL_DELIVERY_MAX_REPRESENTATION_BYTES)
    throw new TerminalDeliveryStateTooLargeError(bytes.byteLength);
}

function isNewerIncarnation(current: string, candidate: string): boolean {
  const currentEpoch = /:([0-9]+)$/u.exec(current)?.[1];
  const candidateEpoch = /:([0-9]+)$/u.exec(candidate)?.[1];
  return (
    currentEpoch !== undefined &&
    candidateEpoch !== undefined &&
    Number(candidateEpoch) > Number(currentEpoch)
  );
}
