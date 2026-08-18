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
  readonly #deliveries = new Map<string, DeliveryEvidence>();
  readonly #paints = new Map<string, CausalCellPaintEvidenceV1>();
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
    this.#armed.set(request.traceId, { request, inputAtMicros, cancelTimeout });
    this.#tryFinalize(request.traceId);
    return true;
  }

  noteProof(proof: CausalCellProofV1): void {
    if (this.#disposed) return;
    const previous = this.#proofs.get(proof.traceId);
    if (previous && JSON.stringify(previous) !== JSON.stringify(proof))
      return this.fail(proof.traceId, "marker-mismatch");
    this.#proofs.set(proof.traceId, proof);
    this.#trim(this.#proofs, (evicted) => this.fail(evicted, "capacity-exhausted"));
    this.#tryFinalize(proof.traceId);
  }

  noteDelivery(input: DeliveryEvidence): void {
    if (this.#disposed) return;
    this.#deliveries.set(stateKey(input), input);
    this.#trim(this.#deliveries, (evicted) => this.#failProofForState(evicted));
    for (const [traceId, proof] of this.#proofs)
      if (proofStateKey(proof) === stateKey(input)) this.#tryFinalize(traceId);
  }

  notePaint(input: CausalCellPaintEvidenceV1): void {
    if (this.#disposed) return;
    this.#paints.set(stateKey(input), input);
    this.#trim(this.#paints, (evicted) => this.#failProofForState(evicted));
    for (const [traceId, proof] of this.#proofs)
      if (proofStateKey(proof) === stateKey(input)) this.#tryFinalize(traceId);
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
    this.#deliveries.clear();
    this.#paints.clear();
  }

  #tryFinalize(traceId: string): void {
    const armed = this.#armed.get(traceId);
    const proof = this.#proofs.get(traceId);
    if (!armed || !proof) return;
    if (
      proof.semanticPaneId !== armed.request.semanticPaneId ||
      proof.generation !== armed.request.generation ||
      proof.incarnation !== armed.request.incarnation ||
      proof.baselineRevision !== armed.request.baselineRevision ||
      proof.baselineStateHash !== armed.request.baselineStateHash ||
      JSON.stringify(proof.geometry) !== JSON.stringify(armed.request.geometry) ||
      JSON.stringify(proof.before) !== JSON.stringify(armed.request.before) ||
      JSON.stringify(proof.after) !== JSON.stringify(armed.request.after)
    )
      return this.fail(traceId, "marker-mismatch");
    const key = proofStateKey(proof);
    const delivery = this.#deliveries.get(key);
    const paint = this.#paints.get(key);
    if (!delivery || !paint) return;
    const { row, column, cols, rows } = proof.geometry;
    if (
      delivery.snapshot.cols !== cols ||
      delivery.snapshot.rows !== rows ||
      JSON.stringify(delivery.snapshot.grid[row]?.cells[column]) !== JSON.stringify(proof.after)
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
      !paint.writtenRows.has(visibleRow) ||
      JSON.stringify(paint.snapshot.grid[row]?.cells[column]) !== JSON.stringify(proof.after)
    )
      return this.fail(traceId, "geometry-drift");
    this.#armed.delete(traceId);
    armed.cancelTimeout();
    this.#proofs.delete(traceId);
    this.#deliveries.delete(key);
    this.#paints.delete(key);
    this.#onFinalized({
      proof,
      inputAtMicros: armed.inputAtMicros,
      deliveredAtMicros: delivery.atMicros,
      paintedAtMicros: paint.atMicros,
    });
  }

  #failProofForState(key: string): void {
    for (const [traceId, proof] of this.#proofs)
      if (proofStateKey(proof) === key) this.fail(traceId, "capacity-exhausted");
  }

  #trim<T>(map: Map<string, T>, onEvict: (key: string) => void): void {
    while (map.size > MAX_DIAGNOSTIC_RECORDS) {
      const key = map.keys().next().value as string;
      map.delete(key);
      onEvict(key);
    }
  }
}
