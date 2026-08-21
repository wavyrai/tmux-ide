import type {
  CausalCellFailureReasonV1,
  CausalCellProbeV1,
  CausalCellProofV1,
  CausalCellStructuralDiffV1,
  TerminalReplicaSnapshot,
} from "@tmux-ide/contracts";
import { terminalReplicaRowsEqual } from "@tmux-ide/core";
import type { SessionRuntimeScheduler, SessionRuntimeTimer } from "./runtime-scheduler.ts";

export const CAUSAL_CELL_OSC = 6973;
export const CAUSAL_CELL_OSC_PREFIX = "tmux-ide-causal-cell-v1";
const MAX_CAUSAL_CELL_COMMITS = 64;
const MAX_CAUSAL_CELL_REVISION_ADVANCE = 64;
const MAX_CAUSAL_CELL_MARKER_BYTES = 128;

export type CausalCellLedgerResult =
  | { readonly status: "proved"; readonly proof: CausalCellProofV1 }
  | {
      readonly status: "failed";
      readonly traceId: string;
      readonly reason: CausalCellFailureReasonV1;
      readonly diagnostic?: CausalCellStructuralDiffV1;
    };

function expectedSnapshot(
  baseline: TerminalReplicaSnapshot,
  probe: CausalCellProbeV1,
): TerminalReplicaSnapshot {
  const { row, column } = probe.geometry;
  return {
    ...baseline,
    grid: baseline.grid.map((entry, rowIndex) =>
      rowIndex === row
        ? {
            ...entry,
            cells: entry.cells.map((cell, columnIndex) =>
              columnIndex === column ? probe.after : cell,
            ),
          }
        : entry,
    ),
  };
}

function recordEquals(
  left: Readonly<Record<string, unknown>>,
  right: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): boolean {
  return keys.every((key) => left[key] === right[key]);
}

function colorsEqual(
  left: TerminalReplicaSnapshot["grid"][number]["cells"][number]["foreground"],
  right: TerminalReplicaSnapshot["grid"][number]["cells"][number]["foreground"],
): boolean {
  return (
    left.kind === right.kind &&
    (left.kind === "default" ||
      (left.kind === "indexed" && right.kind === "indexed" && left.index === right.index) ||
      (left.kind === "rgb" && right.kind === "rgb" && left.value === right.value))
  );
}

function cellsEqual(
  left: TerminalReplicaSnapshot["grid"][number]["cells"][number] | undefined,
  right: TerminalReplicaSnapshot["grid"][number]["cells"][number] | undefined,
): boolean {
  return (
    left === right ||
    (left !== undefined &&
      right !== undefined &&
      left.grapheme === right.grapheme &&
      left.width === right.width &&
      left.attributes === right.attributes &&
      colorsEqual(left.foreground, right.foreground) &&
      colorsEqual(left.background, right.background))
  );
}

function snapshotsSemanticallyEqual(
  left: TerminalReplicaSnapshot,
  right: TerminalReplicaSnapshot,
): boolean {
  if (
    left.cols !== right.cols ||
    left.rows !== right.rows ||
    left.grid.length !== right.grid.length ||
    left.history.length !== right.history.length ||
    !left.grid.every((row, index) => terminalReplicaRowsEqual(row, right.grid[index]!)) ||
    !left.history.every((row, index) => terminalReplicaRowsEqual(row, right.history[index]!)) ||
    !recordEquals(left.cursor, right.cursor, ["x", "y", "hidden", "style", "blink"]) ||
    !recordEquals(left.modes, right.modes, [
      "alternateScreen",
      "applicationCursor",
      "applicationKeypad",
      "bracketedPaste",
      "insert",
      "origin",
      "wraparound",
      "mouseTracking",
      "mouseProtocol",
      "mouseEncoding",
      "synchronizedOutput",
    ]) ||
    left.placements.length !== right.placements.length ||
    !left.placements.every((placement, index) =>
      recordEquals(placement, right.placements[index]!, [
        "id",
        "kind",
        "row",
        "column",
        "columns",
        "rows",
        "contentDigest",
      ]),
    ) ||
    !recordEquals(left.bootstrap, right.bootstrap, ["kind", "hiddenState"])
  )
    return false;
  return true;
}

function snapshotsMatchExceptDeclaredCell(
  baseline: TerminalReplicaSnapshot,
  candidate: TerminalReplicaSnapshot,
  probe: CausalCellProbeV1,
): boolean {
  const { row, column, cols, rows } = probe.geometry;
  if (baseline.cols !== cols || baseline.rows !== rows) return false;
  if (candidate.cols !== cols || candidate.rows !== rows) return false;
  if (!cellsEqual(baseline.grid[row]?.cells[column], probe.before)) return false;
  if (!cellsEqual(candidate.grid[row]?.cells[column], probe.after)) return false;
  return snapshotsSemanticallyEqual(expectedSnapshot(baseline, probe), candidate);
}

function structuralDiff(
  baseline: TerminalReplicaSnapshot,
  candidate: TerminalReplicaSnapshot,
  probe: CausalCellProbeV1,
  revision: number,
  stateHash: string,
): CausalCellStructuralDiffV1 {
  const changedCoordinates: Array<{ row: number; column: number }> = [];
  const changedRows = new Set<number>();
  const changedWrappedRows: number[] = [];
  let changedWrappedRowCount = 0;
  let changedCellCount = 0;
  const rows = Math.max(baseline.grid.length, candidate.grid.length);
  for (let row = 0; row < rows; row += 1) {
    const before = baseline.grid[row]?.cells ?? [];
    const after = candidate.grid[row]?.cells ?? [];
    const columns = Math.max(before.length, after.length);
    if (baseline.grid[row]?.wrapped !== candidate.grid[row]?.wrapped) {
      changedWrappedRowCount += 1;
      if (changedWrappedRows.length < 8) changedWrappedRows.push(row);
    }
    for (let column = 0; column < columns; column += 1) {
      if (cellsEqual(before[column], after[column])) continue;
      changedCellCount += 1;
      changedRows.add(row);
      if (changedCoordinates.length < 8) changedCoordinates.push({ row, column });
    }
  }
  const expected = expectedSnapshot(baseline, probe);
  const semanticSnapshotMatched = snapshotsSemanticallyEqual(expected, candidate);
  return Object.freeze({
    version: 1,
    baselineRevision: probe.baselineRevision,
    baselineStateHash: probe.baselineStateHash,
    candidateRevision: revision,
    candidateStateHash: stateHash,
    dimensionsChanged: baseline.cols !== candidate.cols || baseline.rows !== candidate.rows,
    changedCellCount,
    changedRowCount: changedRows.size,
    changedCoordinates,
    coordinatesTruncated: changedCellCount > changedCoordinates.length,
    changedWrappedRowCount,
    changedWrappedRows,
    wrappedRowsTruncated: changedWrappedRowCount > changedWrappedRows.length,
    targetMatched: cellsEqual(
      candidate.grid[probe.geometry.row]?.cells[probe.geometry.column],
      probe.after,
    ),
    cursorChanged: !recordEquals(baseline.cursor, candidate.cursor, [
      "x",
      "y",
      "hidden",
      "style",
      "blink",
    ]),
    modesChanged: !recordEquals(baseline.modes, candidate.modes, [
      "alternateScreen",
      "applicationCursor",
      "applicationKeypad",
      "bracketedPaste",
      "insert",
      "origin",
      "wraparound",
      "mouseTracking",
      "mouseProtocol",
      "mouseEncoding",
      "synchronizedOutput",
    ]),
    historyChanged:
      baseline.history.length !== candidate.history.length ||
      !baseline.history.every((row, index) =>
        terminalReplicaRowsEqual(row, candidate.history[index]!),
      ),
    placementsChanged:
      baseline.placements.length !== candidate.placements.length ||
      !baseline.placements.every((placement, index) =>
        recordEquals(placement, candidate.placements[index]!, [
          "id",
          "kind",
          "row",
          "column",
          "columns",
          "rows",
          "contentDigest",
        ]),
      ),
    bootstrapChanged: !recordEquals(baseline.bootstrap, candidate.bootstrap, [
      "kind",
      "hiddenState",
    ]),
    semanticSnapshotMatched,
    serializationOrderOnly:
      semanticSnapshotMatched && JSON.stringify(expected) !== JSON.stringify(candidate),
  });
}

/** One bounded diagnostic epoch. Ordinary terminal writes never allocate it. */
export class CausalCellLedger {
  readonly #probe: CausalCellProbeV1;
  readonly #baseline: TerminalReplicaSnapshot;
  readonly #onResult: (result: CausalCellLedgerResult) => void;
  readonly #expiry: SessionRuntimeTimer;
  #state: "armed" | "open" | "closed" | "settled" = "armed";
  #controlAccepted: boolean | null = null;
  #candidate: { readonly revision: number; readonly stateHash: string } | null = null;
  #observedCommits = 0;

  constructor(options: {
    readonly probe: CausalCellProbeV1;
    readonly baseline: TerminalReplicaSnapshot;
    readonly scheduler: SessionRuntimeScheduler;
    readonly timeoutMs?: number;
    readonly onResult: (result: CausalCellLedgerResult) => void;
  }) {
    this.#probe = options.probe;
    this.#baseline = options.baseline;
    this.#onResult = options.onResult;
    this.#expiry = options.scheduler.timer(() => this.#fail("timeout"), options.timeoutMs ?? 2_000);
  }

  get traceId(): string {
    return this.#probe.traceId;
  }

  observeControlReply(ok: boolean): void {
    if (this.#state === "settled") return;
    if (this.#controlAccepted !== null) return this.#fail("control-rejected");
    this.#controlAccepted = ok;
    if (!ok) return this.#fail("control-rejected");
    this.#finalize();
  }

  observeOsc(data: string): boolean {
    if (Buffer.byteLength(data, "utf8") > MAX_CAUSAL_CELL_MARKER_BYTES) {
      this.#fail("capacity-exhausted");
      return true;
    }
    const [prefix, phase, traceId, extra] = data.split(";");
    if (prefix !== CAUSAL_CELL_OSC_PREFIX) return false;
    if (extra !== undefined || traceId !== this.#probe.traceId) {
      this.#fail("marker-mismatch");
      return true;
    }
    if (phase === "start" && this.#state === "armed") {
      this.#state = "open";
      return true;
    }
    if (phase === "end" && this.#state === "open") {
      this.#state = "closed";
      this.#finalize();
      return true;
    }
    this.#fail("marker-order");
    return true;
  }

  observeCommit(snapshot: TerminalReplicaSnapshot, revision: number, stateHash: string): void {
    if (this.#state === "settled") return;
    this.#observedCommits += 1;
    if (this.#observedCommits > MAX_CAUSAL_CELL_COMMITS) return this.#fail("capacity-exhausted");
    if (revision - this.#probe.baselineRevision > MAX_CAUSAL_CELL_REVISION_ADVANCE)
      return this.#fail("ambiguous-delta");
    if (this.#state === "armed") {
      if (!snapshotsSemanticallyEqual(snapshot, this.#baseline))
        this.#fail(
          "baseline-drift",
          structuralDiff(this.#baseline, snapshot, this.#probe, revision, stateHash),
        );
      return;
    }
    const unchanged = snapshotsSemanticallyEqual(snapshot, this.#baseline);
    if (unchanged && this.#state === "open") return;
    if (!snapshotsMatchExceptDeclaredCell(this.#baseline, snapshot, this.#probe)) {
      this.#fail(
        unchanged ? "no-op" : "ambiguous-delta",
        structuralDiff(this.#baseline, snapshot, this.#probe, revision, stateHash),
      );
      return;
    }
    if (
      this.#candidate &&
      (this.#candidate.revision !== revision || this.#candidate.stateHash !== stateHash)
    ) {
      this.#fail("ambiguous-delta");
      return;
    }
    this.#candidate = { revision, stateHash };
    this.#finalize();
  }

  fail(reason: CausalCellFailureReasonV1): void {
    this.#fail(reason);
  }

  #finalize(): void {
    if (this.#state !== "closed" || this.#controlAccepted !== true || this.#candidate === null)
      return;
    const candidate = this.#candidate;
    this.#state = "settled";
    this.#expiry.cancel();
    this.#onResult({
      status: "proved",
      proof: {
        ...this.#probe,
        committedRevision: candidate.revision,
        committedStateHash: candidate.stateHash,
      },
    });
  }

  #fail(reason: CausalCellFailureReasonV1, diagnostic?: CausalCellStructuralDiffV1): void {
    if (this.#state === "settled") return;
    this.#state = "settled";
    this.#expiry.cancel();
    this.#onResult({
      status: "failed",
      traceId: this.#probe.traceId,
      reason,
      ...(diagnostic ? { diagnostic } : {}),
    });
  }
}
