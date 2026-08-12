import type {
  CanonicalTerminalReplicaUpdate,
  SessionRuntimeGeneration,
  TerminalReplicaAddress,
  TerminalReplicaColor,
  TerminalReplicaPatchPayload,
  TerminalReplicaRow,
  TerminalReplicaSnapshot,
  TerminalReplicaTombstonePayload,
} from "@tmux-ide/contracts";

const DEFAULT_COLOR = Object.freeze({ kind: "default" } as const);
const ROW_HASH_CACHE = new WeakMap<object, string>();
const ROW_ARRAY_HASH_CACHE = new WeakMap<
  object,
  { readonly hash: bigint; readonly length: number }
>();
const ROW_SEQUENCE_BASE = 0x100000001b3n;

export interface TerminalReplicaState extends TerminalReplicaAddress {
  readonly generation: SessionRuntimeGeneration;
  readonly revision: number;
  readonly incarnation: string;
  readonly snapshot: TerminalReplicaSnapshot | null;
  readonly tombstone: TerminalReplicaTombstonePayload | null;
  readonly hash: string;
  /** Digest of the exact last accepted wire frame, for strict replay identity. */
  readonly frameHash: string;
}

export type TerminalReplicaApplyResult =
  | { readonly status: "applied"; readonly state: TerminalReplicaState }
  | { readonly status: "idempotent" | "stale"; readonly state: TerminalReplicaState }
  | {
      readonly status: "gap" | "conflict";
      readonly state: TerminalReplicaState | null;
      readonly expectedRevision: number;
      readonly receivedRevision: number;
    };

export function blankTerminalReplicaSnapshot(cols: number, rows: number): TerminalReplicaSnapshot {
  const row = blankRow(cols);
  return freezeSnapshot({
    cols,
    rows,
    grid: Array.from({ length: rows }, () => row),
    cursor: { x: 0, y: 0, hidden: false, style: "block", blink: false },
    modes: {
      alternateScreen: false,
      applicationCursor: false,
      applicationKeypad: false,
      bracketedPaste: false,
      insert: false,
      origin: false,
      wraparound: true,
      mouseTracking: false,
      synchronizedOutput: false,
    },
    history: [],
    placements: [],
    bootstrap: { kind: "painted-capture", hiddenState: "unknown" },
  });
}

export function applyTerminalReplicaUpdate(
  current: TerminalReplicaState | null,
  update: CanonicalTerminalReplicaUpdate,
): TerminalReplicaApplyResult {
  const receivedFrameHash = hashStable(update);
  if (update.type === "terminal.seed") {
    if (update.hashAlgorithm !== "fnv1a64-v1" || !terminalReplicaSnapshotIsValid(update.snapshot)) {
      return current
        ? protocolConflict(current, update.revision)
        : {
            status: "conflict",
            state: null,
            expectedRevision: 0,
            receivedRevision: update.revision,
          };
    }
    const hash = hashTerminalReplicaSnapshot(update.snapshot);
    if (
      current &&
      (current.workspaceName !== update.workspaceName ||
        current.semanticPaneId !== update.semanticPaneId)
    ) {
      return protocolConflict(current, update.revision);
    }
    // Generations are opaque UUIDs, not sortable epochs. A live reducer is
    // generation-pinned; callers must discard it and bootstrap a new reducer
    // from a seed during an authenticated daemon-generation transition.
    if (current && current.generation !== update.generation) {
      return protocolConflict(current, update.revision);
    }
    if (
      current &&
      current.incarnation !== update.incarnation &&
      (!isNewerIncarnation(current.incarnation, update.incarnation) ||
        update.revision <= current.revision)
    ) {
      return protocolConflict(current, update.revision);
    }
    if (
      current?.generation === update.generation &&
      current.revision === update.revision &&
      current.hash === hash &&
      update.stateHash === hash &&
      current.incarnation === update.incarnation &&
      current.frameHash === receivedFrameHash
    ) {
      return { status: "idempotent", state: current };
    }
    if (
      current?.generation === update.generation &&
      current.revision === update.revision &&
      current.hash !== update.stateHash
    ) {
      return {
        status: "conflict",
        state: current,
        expectedRevision: current.revision,
        receivedRevision: update.revision,
      };
    }
    if (
      hash !== update.stateHash ||
      update.cols !== update.snapshot.cols ||
      update.rows !== update.snapshot.rows
    ) {
      return {
        status: "conflict",
        state: current,
        expectedRevision: current?.revision ?? 0,
        receivedRevision: update.revision,
      };
    }
    if (
      current?.generation === update.generation &&
      current.incarnation === update.incarnation &&
      update.revision < current.revision
    ) {
      return { status: "stale", state: current };
    }
    const state = Object.freeze({
      workspaceName: update.workspaceName,
      semanticPaneId: update.semanticPaneId,
      generation: update.generation,
      revision: update.revision,
      incarnation: update.incarnation,
      snapshot: freezeSnapshot(update.snapshot),
      tombstone: null,
      hash,
      frameHash: receivedFrameHash,
    });
    return { status: "applied", state };
  }

  if (current === null || current.generation !== update.generation) {
    return {
      status: "gap",
      state: current,
      expectedRevision: current === null ? 0 : current.revision + 1,
      receivedRevision: update.revision,
    };
  }
  if (update.hashAlgorithm !== "fnv1a64-v1") return protocolConflict(current, update.revision);
  if (
    current.workspaceName !== update.workspaceName ||
    current.semanticPaneId !== update.semanticPaneId
  ) {
    return protocolConflict(current, update.revision);
  }
  if (current.incarnation !== update.incarnation) {
    return {
      status: "gap",
      state: current,
      expectedRevision: current.revision + 1,
      receivedRevision: update.revision,
    };
  }
  if (update.revision <= current.revision) {
    if (update.type === "terminal.tombstone") {
      return update.revision === current.revision &&
        update.baseRevision === current.revision - 1 &&
        update.stateHash === current.hash &&
        current.tombstone?.reason === update.tombstone.reason &&
        current.frameHash === receivedFrameHash
        ? { status: "idempotent", state: current }
        : update.revision === current.revision
          ? protocolConflict(current, update.revision)
          : { status: "stale", state: current };
    }
    return update.revision === current.revision &&
      update.baseRevision === current.revision - 1 &&
      update.stateHash === current.hash &&
      update.cols === current.snapshot?.cols &&
      update.rows === current.snapshot?.rows &&
      current.frameHash === receivedFrameHash
      ? { status: "idempotent", state: current }
      : update.revision === current.revision
        ? protocolConflict(current, update.revision)
        : { status: "stale", state: current };
  }
  if (update.baseRevision !== current.revision || update.revision !== current.revision + 1) {
    return {
      status: "gap",
      state: current,
      expectedRevision: current.revision + 1,
      receivedRevision: update.revision,
    };
  }
  if (update.type === "terminal.tombstone") {
    if (
      current.snapshot &&
      (update.cols !== current.snapshot.cols || update.rows !== current.snapshot.rows)
    ) {
      return protocolConflict(current, update.revision);
    }
    const hash = hashStable(["tombstone", update.tombstone.reason]);
    if (hash !== update.stateHash) {
      return {
        status: "conflict",
        state: current,
        expectedRevision: current.revision + 1,
        receivedRevision: update.revision,
      };
    }
    const state = Object.freeze({
      ...current,
      revision: update.revision,
      snapshot: null,
      tombstone: Object.freeze({ ...update.tombstone }),
      hash,
      frameHash: receivedFrameHash,
    });
    return { status: "applied", state };
  }
  if (current.snapshot === null) {
    return {
      status: "conflict",
      state: current,
      expectedRevision: current.revision + 1,
      receivedRevision: update.revision,
    };
  }
  let snapshot: TerminalReplicaSnapshot;
  try {
    snapshot = applyTerminalReplicaPatch(current.snapshot, update.patch);
  } catch {
    return protocolConflict(current, update.revision);
  }
  const hash = hashTerminalReplicaSnapshot(snapshot);
  if (hash !== update.stateHash || snapshot.cols !== update.cols || snapshot.rows !== update.rows) {
    return {
      status: "conflict",
      state: current,
      expectedRevision: current.revision + 1,
      receivedRevision: update.revision,
    };
  }
  const state = Object.freeze({
    ...current,
    revision: update.revision,
    snapshot,
    tombstone: null,
    hash,
    frameHash: receivedFrameHash,
  });
  return { status: "applied", state };
}

export function applyTerminalReplicaPatch(
  current: TerminalReplicaSnapshot,
  patch: TerminalReplicaPatchPayload,
): TerminalReplicaSnapshot {
  const cols = patch.dimensions?.cols ?? current.cols;
  const rows = patch.dimensions?.rows ?? current.rows;
  const seen = new Set<number>();
  for (const change of patch.rows) {
    if (
      change.index >= rows ||
      change.row.cells.length !== cols ||
      !terminalReplicaRowIsValid(change.row) ||
      seen.has(change.index)
    ) {
      throw new TypeError("Malformed terminal replica row patch");
    }
    seen.add(change.index);
  }
  const cursor = patch.cursor ?? current.cursor;
  if (cursor.x >= cols || cursor.y >= rows) throw new TypeError("Terminal cursor is out of bounds");
  if (patch.history?.some((row) => row.cells.length !== cols || !terminalReplicaRowIsValid(row)))
    throw new TypeError("Malformed terminal replica history");
  if (
    (patch.history !== undefined && patch.historyDelta !== undefined) ||
    (patch.historyDelta?.trim ?? 0) > current.history.length ||
    patch.historyDelta?.append.some(
      (row) => row.cells.length !== cols || !terminalReplicaRowIsValid(row),
    )
  )
    throw new TypeError("Malformed terminal replica history delta");
  if (
    patch.placements?.some(
      (placement) =>
        placement.row + placement.rows > rows || placement.column + placement.columns > cols,
    )
  )
    throw new TypeError("Terminal placement is out of bounds");
  if (cols !== current.cols) {
    const retainedHistory =
      patch.history ??
      (patch.historyDelta
        ? [...current.history.slice(patch.historyDelta.trim), ...patch.historyDelta.append]
        : current.history);
    if (retainedHistory.some((row) => row.cells.length !== cols))
      throw new TypeError("A dimension patch retained old-width terminal history");
  }
  if (
    (cols !== current.cols || rows !== current.rows) &&
    patch.placements === undefined &&
    current.placements.some(
      (placement) =>
        placement.row + placement.rows > rows || placement.column + placement.columns > cols,
    )
  )
    throw new TypeError("A dimension patch retained an out-of-bounds terminal placement");
  let grid: readonly TerminalReplicaRow[];
  if (cols !== current.cols || rows !== current.rows) {
    const empty = blankRow(cols);
    grid = Array.from({ length: rows }, (_, index) => {
      const prior = current.grid[index];
      return prior && prior.cells.length === cols ? prior : empty;
    });
  } else {
    grid = current.grid;
  }
  if (patch.rows.length > 0) {
    const next = [...grid];
    let changed = false;
    for (const change of patch.rows) {
      const row = freezeRow(change.row);
      if (!terminalReplicaRowsEqual(next[change.index], row)) {
        next[change.index] = row;
        changed = true;
      }
    }
    if (changed) grid = next;
  }
  const unchanged =
    cols === current.cols &&
    rows === current.rows &&
    grid === current.grid &&
    patch.cursor === undefined &&
    patch.modes === undefined &&
    patch.history === undefined &&
    patch.historyDelta === undefined &&
    patch.placements === undefined &&
    patch.bootstrap === undefined;
  if (unchanged) return current;
  let history: readonly TerminalReplicaRow[];
  if (patch.history) {
    history = Object.freeze(patch.history.map(freezeRow));
  } else if (patch.historyDelta) {
    const appended = patch.historyDelta.append.map(freezeRow);
    history = Object.freeze([...current.history.slice(patch.historyDelta.trim), ...appended]);
    registerRowsDeltaHash(current.history, history, patch.historyDelta.trim, appended);
  } else {
    history = current.history;
  }
  const candidate = {
    cols,
    rows,
    grid: Object.freeze(grid) as unknown as TerminalReplicaRow[],
    history: history as TerminalReplicaRow[],
    cursor: Object.freeze(patch.cursor ? { ...patch.cursor } : current.cursor),
    modes: Object.freeze(patch.modes ? { ...patch.modes } : current.modes),
    placements: patch.placements
      ? (Object.freeze(
          patch.placements.map((placement) => Object.freeze({ ...placement })),
        ) as unknown as TerminalReplicaSnapshot["placements"])
      : current.placements,
    bootstrap: patch.bootstrap ? Object.freeze({ ...patch.bootstrap }) : current.bootstrap,
  };
  return Object.freeze(candidate) as TerminalReplicaSnapshot;
}

export function terminalReplicaRowsEqual(
  left: TerminalReplicaRow | undefined,
  right: TerminalReplicaRow,
): boolean {
  if (
    !left ||
    left === right ||
    left.wrapped !== right.wrapped ||
    left.cells.length !== right.cells.length
  )
    return left === right;
  for (let index = 0; index < left.cells.length; index += 1) {
    const a = left.cells[index]!;
    const b = right.cells[index]!;
    if (
      a.grapheme !== b.grapheme ||
      a.width !== b.width ||
      a.attributes !== b.attributes ||
      !colorsEqual(a.foreground, b.foreground) ||
      !colorsEqual(a.background, b.background)
    )
      return false;
  }
  return true;
}

export function hashTerminalReplicaSnapshot(snapshot: TerminalReplicaSnapshot): string {
  // Cross-language Merkle stream: each immutable row is FNV-1a over the
  // type-tagged UTF-8 cell stream, then the snapshot hashes fixed-order row
  // digests + metadata. WeakMap caching makes dirty-row patches O(rows), not
  // O(scrollback*cols), without placing host-private hashes on the wire.
  return hashStable([
    "terminal-replica-v1",
    snapshot.cols,
    snapshot.rows,
    hashTerminalReplicaRows(snapshot.grid),
    hashTerminalReplicaRows(snapshot.history),
    snapshot.cursor,
    snapshot.modes,
    snapshot.placements,
    snapshot.bootstrap,
  ]);
}

export function hashTerminalReplicaTombstone(reason: string): string {
  return hashStable(["tombstone", reason]);
}

/** Canonical digest authenticated by a terminal rich-placement descriptor. */
export function hashTerminalWidgetContent(id: string, args: unknown): string {
  return hashTerminalReplicaTombstone(`${id}:${JSON.stringify(args)}`);
}

export function resolveTerminalReplicaColor(
  color: TerminalReplicaColor,
  defaults: { readonly foreground: number; readonly background: number },
  channel: "foreground" | "background",
  indexedPalette: readonly number[],
): number {
  if (color.kind === "default") return defaults[channel];
  if (color.kind === "rgb") return color.value;
  return indexedPalette[color.index] ?? defaults[channel];
}

function blankRow(cols: number): TerminalReplicaRow {
  return Object.freeze({
    cells: Object.freeze(
      Array.from({ length: cols }, () =>
        Object.freeze({
          grapheme: " ",
          width: 1 as const,
          foreground: DEFAULT_COLOR,
          background: DEFAULT_COLOR,
          attributes: 0,
        }),
      ),
    ),
    wrapped: false,
  }) as unknown as TerminalReplicaRow;
}

function freezeRow(row: TerminalReplicaRow): TerminalReplicaRow {
  return Object.freeze({
    wrapped: row.wrapped,
    cells: Object.freeze(
      row.cells.map((cell) =>
        Object.freeze({
          ...cell,
          foreground: Object.freeze({ ...cell.foreground }),
          background: Object.freeze({ ...cell.background }),
        }),
      ),
    ),
  }) as unknown as TerminalReplicaRow;
}

export function freezeTerminalReplicaRow(row: TerminalReplicaRow): TerminalReplicaRow {
  if (!terminalReplicaRowIsValid(row)) throw new TypeError("Malformed terminal replica row");
  return freezeRow(row);
}

function freezeSnapshot(snapshot: TerminalReplicaSnapshot): TerminalReplicaSnapshot {
  return Object.freeze({
    ...snapshot,
    grid: Object.freeze(snapshot.grid.map(freezeRow)),
    history: Object.freeze(snapshot.history.map(freezeRow)),
    cursor: Object.freeze({ ...snapshot.cursor }),
    modes: Object.freeze({ ...snapshot.modes }),
    placements: Object.freeze(snapshot.placements.map((value) => Object.freeze({ ...value }))),
    bootstrap: Object.freeze({ ...snapshot.bootstrap }),
  }) as unknown as TerminalReplicaSnapshot;
}

export function freezeTerminalReplicaSnapshot(
  snapshot: TerminalReplicaSnapshot,
): TerminalReplicaSnapshot {
  if (!terminalReplicaSnapshotIsValid(snapshot)) {
    throw new TypeError("Malformed terminal replica snapshot");
  }
  return freezeSnapshot(snapshot);
}

/** Daemon parser seam: rows are already canonical/frozen, so avoid deep cloning the grid. */
export function assembleTerminalReplicaSnapshot(
  snapshot: TerminalReplicaSnapshot,
): TerminalReplicaSnapshot {
  if (
    snapshot.grid.length !== snapshot.rows ||
    snapshot.cursor.x >= snapshot.cols ||
    snapshot.cursor.y >= snapshot.rows ||
    snapshot.grid.some((row) => row.cells.length !== snapshot.cols)
  ) {
    throw new TypeError("Malformed trusted terminal replica snapshot");
  }
  return Object.freeze({
    ...snapshot,
    grid: Object.freeze(snapshot.grid),
    history: Object.freeze(snapshot.history),
    cursor: Object.freeze(snapshot.cursor),
    modes: Object.freeze(snapshot.modes),
    placements: Object.freeze(snapshot.placements.map((placement) => Object.freeze(placement))),
    bootstrap: Object.freeze(snapshot.bootstrap),
  }) as TerminalReplicaSnapshot;
}

function colorsEqual(left: TerminalReplicaColor, right: TerminalReplicaColor): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "default") return true;
  if (left.kind === "indexed" && right.kind === "indexed") return left.index === right.index;
  return left.kind === "rgb" && right.kind === "rgb" && left.value === right.value;
}

function hashStable(value: unknown): string {
  const bytes = new TextEncoder().encode(canonicalEncode(value));
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

function canonicalEncode(value: unknown): string {
  if (value === null) return "n;";
  if (typeof value === "boolean") return value ? "b1;" : "b0;";
  if (typeof value === "number") return `d${String(value).length}:${String(value)};`;
  if (typeof value === "string") {
    const length = new TextEncoder().encode(value).length;
    return `s${length}:${value};`;
  }
  if (Array.isArray(value)) return `a${value.length}:${value.map(canonicalEncode).join("")};`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `o${keys.length}:${keys
    .map((key) => `${canonicalEncode(key)}${canonicalEncode(record[key])}`)
    .join("")};`;
}

function protocolConflict(
  current: TerminalReplicaState,
  receivedRevision: number,
): TerminalReplicaApplyResult {
  return {
    status: "conflict",
    state: current,
    expectedRevision: current.revision + 1,
    receivedRevision,
  };
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

function hashTerminalReplicaRow(row: TerminalReplicaRow): string {
  const cached = ROW_HASH_CACHE.get(row);
  if (cached) return cached;
  const hash = hashStable([
    row.wrapped,
    row.cells.map((cell) => [
      cell.grapheme,
      cell.width,
      cell.foreground,
      cell.background,
      cell.attributes,
    ]),
  ]);
  if (Object.isFrozen(row)) ROW_HASH_CACHE.set(row, hash);
  return hash;
}

function hashTerminalReplicaRows(rows: readonly TerminalReplicaRow[]): string {
  const cached = ROW_ARRAY_HASH_CACHE.get(rows);
  if (cached) return cached.hash.toString(16).padStart(16, "0");
  let hash = 0n;
  for (const row of rows)
    hash = BigInt.asUintN(
      64,
      hash * ROW_SEQUENCE_BASE + BigInt(`0x${hashTerminalReplicaRow(row)}`),
    );
  if (Object.isFrozen(rows)) ROW_ARRAY_HASH_CACHE.set(rows, { hash, length: rows.length });
  return hash.toString(16).padStart(16, "0");
}

function registerRowsDeltaHash(
  previous: readonly TerminalReplicaRow[],
  next: readonly TerminalReplicaRow[],
  trim: number,
  append: readonly TerminalReplicaRow[],
): void {
  hashTerminalReplicaRows(previous);
  const prior = ROW_ARRAY_HASH_CACHE.get(previous);
  if (!prior) return;
  let hash = prior.hash;
  for (let index = 0; index < trim; index += 1) {
    const exponent = prior.length - 1 - index;
    const contribution = BigInt.asUintN(
      64,
      BigInt(`0x${hashTerminalReplicaRow(previous[index]!)}`) * pow64(ROW_SEQUENCE_BASE, exponent),
    );
    hash = BigInt.asUintN(64, hash - contribution);
  }
  for (const row of append)
    hash = BigInt.asUintN(
      64,
      hash * ROW_SEQUENCE_BASE + BigInt(`0x${hashTerminalReplicaRow(row)}`),
    );
  ROW_ARRAY_HASH_CACHE.set(next, { hash, length: next.length });
}

function pow64(base: bigint, exponent: number): bigint {
  let result = 1n;
  let factor = base;
  let power = exponent;
  while (power > 0) {
    if (power % 2 === 1) result = BigInt.asUintN(64, result * factor);
    factor = BigInt.asUintN(64, factor * factor);
    power = Math.floor(power / 2);
  }
  return result;
}

function terminalReplicaSnapshotIsValid(snapshot: TerminalReplicaSnapshot): boolean {
  if (
    snapshot.grid.length !== snapshot.rows ||
    snapshot.cursor.x >= snapshot.cols ||
    snapshot.cursor.y >= snapshot.rows
  )
    return false;
  for (const row of [...snapshot.history, ...snapshot.grid]) {
    if (row.cells.length !== snapshot.cols || !terminalReplicaRowIsValid(row)) return false;
  }
  return snapshot.placements.every(
    (placement) =>
      placement.row < snapshot.rows &&
      placement.column < snapshot.cols &&
      placement.row + placement.rows <= snapshot.rows &&
      placement.column + placement.columns <= snapshot.cols,
  );
}

function terminalReplicaRowIsValid(row: TerminalReplicaRow): boolean {
  for (let index = 0; index < row.cells.length; index += 1) {
    const width = row.cells[index]!.width;
    if (width === 2 && row.cells[index + 1]?.width !== 0) return false;
    if (width === 0 && (index === 0 || row.cells[index - 1]?.width !== 2)) return false;
  }
  return true;
}
