import type {
  CausalCellFailureReasonV1,
  CausalCellProbeV1,
  CausalCellProofV1,
  TerminalReplicaSnapshot,
} from "@tmux-ide/contracts";
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
    };

function snapshotsMatchExceptDeclaredCell(
  baseline: TerminalReplicaSnapshot,
  candidate: TerminalReplicaSnapshot,
  probe: CausalCellProbeV1,
): boolean {
  const { row, column, cols, rows } = probe.geometry;
  if (baseline.cols !== cols || baseline.rows !== rows) return false;
  if (candidate.cols !== cols || candidate.rows !== rows) return false;
  if (JSON.stringify(baseline.grid[row]?.cells[column]) !== JSON.stringify(probe.before))
    return false;
  if (JSON.stringify(candidate.grid[row]?.cells[column]) !== JSON.stringify(probe.after))
    return false;
  const expected: TerminalReplicaSnapshot = {
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
  return JSON.stringify(expected) === JSON.stringify(candidate);
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
      if (JSON.stringify(snapshot) !== JSON.stringify(this.#baseline)) this.#fail("baseline-drift");
      return;
    }
    const unchanged = JSON.stringify(snapshot) === JSON.stringify(this.#baseline);
    if (unchanged && this.#state === "open") return;
    if (!snapshotsMatchExceptDeclaredCell(this.#baseline, snapshot, this.#probe)) {
      this.#fail(unchanged ? "no-op" : "ambiguous-delta");
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

  #fail(reason: CausalCellFailureReasonV1): void {
    if (this.#state === "settled") return;
    this.#state = "settled";
    this.#expiry.cancel();
    this.#onResult({ status: "failed", traceId: this.#probe.traceId, reason });
  }
}
