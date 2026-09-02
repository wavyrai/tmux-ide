import type {
  CausalCellFailureReasonV1,
  CausalCellProbeRequestV1,
  CausalCellProofV1,
  CausalCellStructuralDiffV1,
  TerminalReplicaSnapshot,
} from "@tmux-ide/contracts";

export interface CausalCellPaintEvidenceV1 {
  readonly semanticPaneId: string;
  readonly generation: string;
  readonly incarnation: string;
  readonly revision: number;
  readonly stateHash: string;
  readonly snapshot: TerminalReplicaSnapshot;
  readonly viewport: { readonly cols: number; readonly rows: number };
  readonly activePaneRect: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly writtenRows: ReadonlySet<number>;
  readonly scrollOffset: number;
  readonly atMicros: number;
}

export interface FinalizedCausalCellEvidenceV1 {
  readonly proof: CausalCellProofV1;
  readonly inputAtMicros: number;
  readonly deliveredAtMicros: number;
  readonly paintedAtMicros: number;
}

interface ArmedProbe {
  readonly request: CausalCellProbeRequestV1;
  readonly inputAtMicros: number;
  readonly cancelTimeout: () => void;
  readonly deliveries: Map<string, CompactDeliveryEvidence>;
  readonly paints: Map<string, CompactPaintEvidence>;
}

interface DeliveryEvidence {
  readonly semanticPaneId: string;
  readonly generation: string;
  readonly incarnation: string;
  readonly revision: number;
  readonly stateHash: string;
  readonly snapshot: TerminalReplicaSnapshot;
  readonly atMicros: number;
}

interface CompactDeliveryEvidence {
  readonly semanticPaneId: string;
  readonly generation: string;
  readonly incarnation: string;
  readonly revision: number;
  readonly stateHash: string;
  readonly cols: number;
  readonly rows: number;
  readonly targetCell: CausalCellProbeRequestV1["after"] | null;
  readonly atMicros: number;
}

interface CompactPaintEvidence extends CompactDeliveryEvidence {
  readonly viewport: { readonly cols: number; readonly rows: number };
  readonly activePaneRect: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly targetRowWritten: boolean;
  readonly scrollOffset: number;
}

const MAX_DIAGNOSTIC_RECORDS = 16;

function stateKey(input: {
  readonly semanticPaneId?: string;
  readonly generation: string;
  readonly incarnation: string;
  readonly revision: number;
  readonly stateHash: string;
}): string {
  return `${input.semanticPaneId ?? ""}\0${input.generation}\0${input.incarnation}\0${input.revision}\0${input.stateHash}`;
}

function proofStateKey(proof: CausalCellProofV1): string {
  return stateKey({
    semanticPaneId: proof.semanticPaneId,
    generation: proof.generation,
    incarnation: proof.incarnation,
    revision: proof.committedRevision,
    stateHash: proof.committedStateHash,
  });
}

/**
 * Renderer-neutral, diagnostics-only join. It is never allocated by ordinary
 * clients and accepts proof, delivery and paint in any order.
 */
export class CausalCellClientLedger {
  readonly #armed = new Map<string, ArmedProbe>();
  readonly #proofs = new Map<string, CausalCellProofV1>();
  readonly #onFinalized: (evidence: FinalizedCausalCellEvidenceV1) => void;
  readonly #onFailure: (
    traceId: string,
    reason: CausalCellFailureReasonV1,
    diagnostic?: CausalCellStructuralDiffV1,
  ) => void;
  readonly #scheduleTimeout: (task: () => void, delayMs: number) => () => void;
  #disposed = false;

  constructor(options: {
    readonly onFinalized: (evidence: FinalizedCausalCellEvidenceV1) => void;
    readonly onFailure: (
      traceId: string,
      reason: CausalCellFailureReasonV1,
      diagnostic?: CausalCellStructuralDiffV1,
    ) => void;
    readonly scheduleTimeout?: (task: () => void, delayMs: number) => () => void;
  }) {
    this.#onFinalized = options.onFinalized;
    this.#onFailure = options.onFailure;
    this.#scheduleTimeout =
      options.scheduleTimeout ??
      ((task, delayMs) => {
        const handle = setTimeout(task, delayMs);
        handle.unref?.();
        return () => clearTimeout(handle);
      });
  }

  arm(request: CausalCellProbeRequestV1, inputAtMicros: number): boolean {
    if (this.#disposed) {
      this.#onFailure(request.traceId, "transport-closed");
      return false;
    }
    if (
      this.#armed.has(request.traceId) ||
      [...this.#armed.values()].some(
        (entry) => entry.request.semanticPaneId === request.semanticPaneId,
      )
    ) {
      this.#onFailure(request.traceId, "busy");
      return false;
    }
    if (this.#armed.size >= MAX_DIAGNOSTIC_RECORDS) {
      this.#onFailure(request.traceId, "capacity-exhausted");
      return false;
    }
    const cancelTimeout = this.#scheduleTimeout(() => this.fail(request.traceId, "timeout"), 2_000);
    this.#armed.set(request.traceId, {
      request,
      inputAtMicros,
      cancelTimeout,
      deliveries: new Map(),
      paints: new Map(),
    });
    this.#tryFinalize(request.traceId);
    return true;
  }

  noteProof(proof: CausalCellProofV1): void {
    if (this.#disposed) return;
    const armed = this.#armed.get(proof.traceId);
    if (!armed) return;
    if (!this.#proofMatchesRequest(proof, armed.request))
      return this.fail(proof.traceId, "marker-mismatch");
    const previous = this.#proofs.get(proof.traceId);
    if (previous && JSON.stringify(previous) !== JSON.stringify(proof))
      return this.fail(proof.traceId, "marker-mismatch");
    this.#proofs.set(proof.traceId, proof);
    const selectedKey = proofStateKey(proof);
    for (const key of armed.deliveries.keys())
      if (key !== selectedKey) armed.deliveries.delete(key);
    for (const key of armed.paints.keys()) if (key !== selectedKey) armed.paints.delete(key);
    this.#trim(this.#proofs, (evicted) => this.fail(evicted, "capacity-exhausted"));
    this.#tryFinalize(proof.traceId);
  }

  noteDelivery(input: DeliveryEvidence): void {
    if (this.#disposed) return;
    const matched = this.#armedFor(input);
    if (!matched) return;
    const [traceId, armed] = matched;
    const proof = this.#proofs.get(traceId);
    if (proof && proofStateKey(proof) !== stateKey(input)) return;
    const { row, column } = armed.request.geometry;
    const targetCell = freezeCell(input.snapshot.grid[row]?.cells[column]);
    if (JSON.stringify(targetCell) !== JSON.stringify(armed.request.after)) return;
    const key = stateKey(input);
    if (armed.deliveries.has(key)) return;
    this.#trimCandidateMap(armed.deliveries);
    armed.deliveries.set(
      key,
      Object.freeze({
        semanticPaneId: input.semanticPaneId,
        generation: input.generation,
        incarnation: input.incarnation,
        revision: input.revision,
        stateHash: input.stateHash,
        cols: input.snapshot.cols,
        rows: input.snapshot.rows,
        targetCell,
        atMicros: input.atMicros,
      }),
    );
    this.#tryFinalize(traceId);
  }

  notePaint(input: CausalCellPaintEvidenceV1): void {
    if (this.#disposed) return;
    const matched = this.#armedFor(input);
    if (!matched) return;
    const [traceId, armed] = matched;
    const proof = this.#proofs.get(traceId);
    if (proof && proofStateKey(proof) !== stateKey(input)) return;
    const { row, column } = armed.request.geometry;
    const targetCell = freezeCell(input.snapshot.grid[row]?.cells[column]);
    if (JSON.stringify(targetCell) !== JSON.stringify(armed.request.after)) return;
    const key = stateKey(input);
    if (armed.paints.has(key)) return;
    this.#trimCandidateMap(armed.paints);
    armed.paints.set(
      key,
      Object.freeze({
        semanticPaneId: input.semanticPaneId,
        generation: input.generation,
        incarnation: input.incarnation,
        revision: input.revision,
        stateHash: input.stateHash,
        cols: input.snapshot.cols,
        rows: input.snapshot.rows,
        targetCell,
        viewport: Object.freeze({ ...input.viewport }),
        activePaneRect: Object.freeze({ ...input.activePaneRect }),
        targetRowWritten: input.writtenRows.has(row),
        scrollOffset: input.scrollOffset,
        atMicros: input.atMicros,
      }),
    );
    this.#tryFinalize(traceId);
  }

  /** Bounded diagnostics ownership facts; full canonical snapshots are never retained. */
  resourceOwnership(): {
    readonly activeProbes: number;
    readonly retainedProofs: number;
    readonly retainedDeliveryProjections: number;
    readonly retainedPaintProjections: number;
    readonly retainedSnapshots: 0;
  } {
    let retainedDeliveryProjections = 0;
    let retainedPaintProjections = 0;
    for (const armed of this.#armed.values()) {
      retainedDeliveryProjections += armed.deliveries.size;
      retainedPaintProjections += armed.paints.size;
    }
    return Object.freeze({
      activeProbes: this.#armed.size,
      retainedProofs: this.#proofs.size,
      retainedDeliveryProjections,
      retainedPaintProjections,
      retainedSnapshots: 0,
    });
  }

  fail(
    traceId: string,
    reason: CausalCellFailureReasonV1,
    diagnostic?: CausalCellStructuralDiffV1,
  ): void {
    const armed = this.#armed.get(traceId);
    if (!armed && !this.#proofs.has(traceId)) return;
    armed?.cancelTimeout();
    this.#armed.delete(traceId);
    this.#proofs.delete(traceId);
    if (diagnostic) this.#onFailure(traceId, reason, diagnostic);
    else this.#onFailure(traceId, reason);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const [traceId, armed] of this.#armed) {
      armed.cancelTimeout();
      this.#onFailure(traceId, "transport-closed");
    }
    this.#armed.clear();
    this.#proofs.clear();
  }

  #tryFinalize(traceId: string): void {
    const armed = this.#armed.get(traceId);
    const proof = this.#proofs.get(traceId);
    if (!armed || !proof) return;
    if (!this.#proofMatchesRequest(proof, armed.request))
      return this.fail(traceId, "marker-mismatch");
    const key = proofStateKey(proof);
    const delivery = armed.deliveries.get(key);
    const paint = armed.paints.get(key);
    if (!delivery || !paint) return;
    if (stateKey(delivery) !== key || stateKey(paint) !== key) return;
    const { row, column, cols, rows } = proof.geometry;
    if (
      delivery.cols !== cols ||
      delivery.rows !== rows ||
      JSON.stringify(delivery.targetCell) !== JSON.stringify(proof.after)
    )
      return this.fail(traceId, "baseline-drift");
    const visibleRow = row;
    if (
      paint.scrollOffset !== 0 ||
      paint.activePaneRect.width !== paint.viewport.cols ||
      paint.activePaneRect.height !== paint.viewport.rows ||
      visibleRow < 0 ||
      visibleRow >= paint.viewport.rows ||
      column >= paint.viewport.cols ||
      !paint.targetRowWritten ||
      paint.cols !== cols ||
      paint.rows !== rows ||
      JSON.stringify(paint.targetCell) !== JSON.stringify(proof.after)
    )
      return this.fail(traceId, "geometry-drift");
    this.#armed.delete(traceId);
    armed.cancelTimeout();
    this.#proofs.delete(traceId);
    this.#onFinalized({
      proof,
      inputAtMicros: armed.inputAtMicros,
      deliveredAtMicros: delivery.atMicros,
      paintedAtMicros: paint.atMicros,
    });
  }

  #trim<T>(map: Map<string, T>, onEvict: (key: string) => void): void {
    while (map.size > MAX_DIAGNOSTIC_RECORDS) {
      const key = map.keys().next().value as string;
      map.delete(key);
      onEvict(key);
    }
  }

  #trimCandidateMap<T>(map: Map<string, T>): void {
    while (map.size >= MAX_DIAGNOSTIC_RECORDS) map.delete(map.keys().next().value as string);
  }

  #armedFor(input: {
    readonly semanticPaneId: string;
    readonly generation: string;
    readonly incarnation: string;
    readonly revision: number;
  }): readonly [string, ArmedProbe] | null {
    for (const entry of this.#armed) {
      const request = entry[1].request;
      if (
        request.semanticPaneId === input.semanticPaneId &&
        request.generation === input.generation &&
        request.incarnation === input.incarnation &&
        input.revision > request.baselineRevision
      )
        return entry;
    }
    return null;
  }

  #proofMatchesRequest(proof: CausalCellProofV1, request: CausalCellProbeRequestV1): boolean {
    return (
      proof.semanticPaneId === request.semanticPaneId &&
      proof.generation === request.generation &&
      proof.incarnation === request.incarnation &&
      proof.baselineRevision === request.baselineRevision &&
      proof.baselineStateHash === request.baselineStateHash &&
      proof.committedRevision > request.baselineRevision &&
      JSON.stringify(proof.geometry) === JSON.stringify(request.geometry) &&
      JSON.stringify(proof.before) === JSON.stringify(request.before) &&
      JSON.stringify(proof.after) === JSON.stringify(request.after)
    );
  }
}

function freezeCell(
  cell: CausalCellProbeRequestV1["after"] | undefined,
): CausalCellProbeRequestV1["after"] | null {
  return cell
    ? Object.freeze({
        ...cell,
        foreground: Object.freeze({ ...cell.foreground }),
        background: Object.freeze({ ...cell.background }),
      })
    : null;
}
