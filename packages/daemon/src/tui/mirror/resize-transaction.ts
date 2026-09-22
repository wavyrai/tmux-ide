import type { SessionRuntimeSemanticIntent } from "@tmux-ide/contracts";
import {
  createOptimisticProjection,
  deriveOptimisticProjection,
  enqueueOptimisticOperation,
  reconcileOptimisticOperation,
  replaceCommittedProjection,
  type OptimisticProjectionState,
} from "@tmux-ide/core";

export type ResizeTransactionAxis = "cols" | "rows";

export interface ResizeTransactionTarget {
  readonly authorityGeneration: string;
  readonly workspaceName: string;
  readonly semanticPaneId: string;
  readonly axis: ResizeTransactionAxis;
}

export interface ResizeTransactionBegin extends ResizeTransactionTarget {
  /** Last daemon-observed size before this gesture began. */
  readonly canonicalCells: number;
}

export interface ResizeTransactionSubmission {
  readonly operationId: string;
  readonly intent: Extract<SessionRuntimeSemanticIntent, { verb: "workspace.pane.resize" }>;
}

export type ResizeTransactionOutcome =
  | {
      readonly kind: "settled";
      readonly operationId: string;
      readonly source: "layout";
      readonly cells: number;
    }
  | {
      readonly kind: "reverted";
      readonly operationId: string;
      readonly reason:
        | { readonly kind: "rejected"; readonly code: string; readonly message: string }
        | { readonly kind: "timed-out"; readonly timeoutMs: number }
        | { readonly kind: "submit-failed"; readonly message: string };
    };

export type ResizeTransactionState =
  | {
      readonly phase: "idle";
      readonly canonicalCells: number | null;
      readonly outcome: ResizeTransactionOutcome | null;
    }
  | (ResizeTransactionTarget & {
      readonly phase: "dragging";
      readonly canonicalCells: number;
      readonly previewCells: number;
      readonly startedAt: number;
    })
  | (ResizeTransactionTarget & {
      readonly phase: "pending";
      readonly operationId: string;
      readonly canonicalCells: number;
      readonly previewCells: number;
      readonly startedAt: number;
      readonly submittedAt: number;
    });

export interface ResizeTransactionObservation extends ResizeTransactionTarget {
  readonly operationId: string;
  /** Actual daemon-observed size. It may differ from the requested size after tmux clamps. */
  readonly cells: number;
}

export interface ResizeTransactionRejection {
  readonly operationId: string;
  readonly code: string;
  readonly message: string;
}

export interface ResizeTransactionControllerOptions {
  readonly timeoutMs: number;
  readonly operationId: () => string;
  readonly now: () => number;
  /** Return a cancellation function. The callback must not run synchronously. */
  readonly schedule: (callback: () => void, delayMs: number) => () => void;
  readonly submit: (submission: ResizeTransactionSubmission) => void;
  readonly onState: (state: ResizeTransactionState) => void;
}

function positiveCells(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function nonEmpty(value: string, label: string): string {
  if (value.length === 0) throw new TypeError(`${label} must not be empty`);
  return value;
}

function sameTarget(
  state: Extract<ResizeTransactionState, { phase: "pending" }>,
  observation: ResizeTransactionObservation,
): boolean {
  return (
    state.operationId === observation.operationId &&
    state.authorityGeneration === observation.authorityGeneration &&
    state.workspaceName === observation.workspaceName &&
    state.semanticPaneId === observation.semanticPaneId &&
    state.axis === observation.axis
  );
}

/**
 * Renderer-local pane-resize transaction.
 *
 * Pointer motion submits the first target immediately, then retains only the
 * latest desired size while receipt and canonical layout settle the pending
 * operation. Release closes the gesture and flushes that latest target. The controller owns no timers, transport, or
 * rendering effects beyond the functions supplied by its caller.
 */
export class ResizeTransactionController {
  readonly #options: ResizeTransactionControllerOptions;
  #state: ResizeTransactionState = Object.freeze({
    phase: "idle",
    canonicalCells: null,
    outcome: null,
  });
  #cancelTimeout: (() => void) | null = null;
  #projection: OptimisticProjectionState<number, number> | null = null;
  #revision = 0;
  #disposed = false;
  #dragOpen = false;
  #submittedCells: number | null = null;

  constructor(options: ResizeTransactionControllerOptions) {
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
      throw new RangeError("resize transaction timeout must be positive");
    }
    this.#options = options;
  }

  state(): ResizeTransactionState {
    return this.#state;
  }

  begin(input: ResizeTransactionBegin): boolean {
    // A second pointer-down must not silently retire an already-submitted
    // operation (or replace a gesture whose pointer is still captured).
    if (this.#disposed || this.#state.phase !== "idle") return false;
    this.#clearTimeout();
    const authorityGeneration = nonEmpty(input.authorityGeneration, "authorityGeneration");
    const workspaceName = nonEmpty(input.workspaceName, "workspaceName");
    const semanticPaneId = nonEmpty(input.semanticPaneId, "semanticPaneId");
    const canonicalCells = positiveCells(input.canonicalCells, "canonicalCells");
    this.#dragOpen = true;
    this.#submittedCells = null;
    this.#projection = createOptimisticProjection<number, number>({
      generation: authorityGeneration,
      revision: this.#revision,
      value: canonicalCells,
    });
    this.#emit({
      phase: "dragging",
      authorityGeneration,
      workspaceName,
      semanticPaneId,
      axis: input.axis,
      canonicalCells,
      previewCells: canonicalCells,
      startedAt: this.#options.now(),
    });
    return true;
  }

  /** First/latest coalescing: at most one mutation awaits canonical settlement. */
  move(previewCells: number): boolean {
    if (!this.#dragOpen || this.#state.phase === "idle") return false;
    const next = positiveCells(previewCells, "previewCells");
    if (next === this.#state.previewCells) return false;
    this.#emit({ ...this.#state, previewCells: next });
    if (this.#state.phase === "dragging") this.#submit();
    return true;
  }

  /** Duplicate releases never author another mutation. */
  release(): string | null {
    this.#dragOpen = false;
    if (this.#state.phase === "pending") return this.#state.operationId;
    if (this.#state.phase !== "dragging") return null;
    const canonicalCells = this.#state.canonicalCells;
    this.#emit({ phase: "idle", canonicalCells, outcome: null });
    return null;
  }

  #submit(): string | null {
    if (this.#state.phase !== "dragging") return null;
    const dragging = this.#state;
    if (dragging.previewCells === dragging.canonicalCells) return null;
    this.#submittedCells = dragging.previewCells;
    const operationId = nonEmpty(this.#options.operationId(), "operationId");
    const submittedAt = this.#options.now();
    if (!this.#projection) throw new Error("resize projection is unavailable");
    this.#projection = enqueueOptimisticOperation(this.#projection, {
      operationId,
      intent: dragging.previewCells,
      acceptedAtMs: submittedAt,
      deadlineAtMs: submittedAt + this.#options.timeoutMs,
    });
    const pending: Extract<ResizeTransactionState, { phase: "pending" }> = {
      ...dragging,
      phase: "pending",
      operationId,
      previewCells: deriveOptimisticProjection(this.#projection, {
        predict: (_committed, cells) => cells,
      }),
      submittedAt,
    };
    this.#emit(pending);
    this.#cancelTimeout = this.#options.schedule(
      () => this.#revertTimedOut(operationId),
      this.#options.timeoutMs,
    );
    try {
      this.#options.submit({
        operationId,
        intent: {
          verb: "workspace.pane.resize",
          workspaceName: pending.workspaceName,
          semanticPaneId: pending.semanticPaneId,
          axis: pending.axis,
          cells: pending.previewCells,
        },
      });
    } catch (error) {
      this.#revert(operationId, {
        kind: "submit-failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return operationId;
  }

  observeLayout(observation: ResizeTransactionObservation): boolean {
    return this.#settle(observation, "layout");
  }

  reject(rejection: ResizeTransactionRejection): boolean {
    return this.#revert(rejection.operationId, {
      kind: "rejected",
      code: rejection.code,
      message: rejection.message,
    });
  }

  /** Discard queued motion; an already dispatched mutation cannot be undone. */
  cancelDrag(): boolean {
    if (!this.#dragOpen || this.#state.phase === "idle") return false;
    this.#dragOpen = false;
    if (this.#state.phase === "pending") {
      this.#emit({ ...this.#state, previewCells: this.#submittedCells! });
      return true;
    }
    const canonicalCells = this.#state.canonicalCells;
    this.#emit({ phase: "idle", canonicalCells, outcome: null });
    return true;
  }

  dispose(): void {
    this.#disposed = true;
    this.retire();
  }

  /** Retire one runtime lane without permanently disposing the controller. */
  retire(): void {
    this.#dragOpen = false;
    this.#submittedCells = null;
    this.#clearTimeout();
    this.#projection = null;
    if (this.#state.phase !== "idle" || this.#state.canonicalCells !== null) {
      this.#emit({ phase: "idle", canonicalCells: null, outcome: null });
    }
  }

  #settle(observation: ResizeTransactionObservation, source: "layout"): boolean {
    if (
      this.#state.phase !== "pending" ||
      !sameTarget(this.#state, observation) ||
      !this.#projection?.pending.some(
        (operation) => operation.operationId === observation.operationId,
      )
    )
      return false;
    const cells = positiveCells(observation.cells, "observed cells");
    const pending = this.#state;
    const operationId = pending.operationId;
    if (!this.#projection) return false;
    this.#revision += 1;
    this.#projection = replaceCommittedProjection(
      this.#projection,
      {
        generation: this.#projection.committed.generation,
        revision: this.#revision,
        value: cells,
      },
      { observedOperationIds: [operationId], nowMs: this.#options.now() },
    );
    this.#clearTimeout();
    const hasLatest =
      pending.previewCells !== this.#submittedCells && pending.previewCells !== cells;
    if (this.#dragOpen || hasLatest) {
      this.#emit({ ...pending, phase: "dragging", canonicalCells: cells });
      if (hasLatest) this.#submit();
    } else {
      this.#emit({
        phase: "idle",
        canonicalCells: cells,
        outcome: { kind: "settled", operationId, source, cells },
      });
    }
    return true;
  }

  #revertTimedOut(operationId: string): void {
    this.#cancelTimeout = null;
    this.#revert(operationId, { kind: "timed-out", timeoutMs: this.#options.timeoutMs });
  }

  #revert(
    operationId: string,
    reason: Extract<ResizeTransactionOutcome, { kind: "reverted" }>["reason"],
  ): boolean {
    if (
      this.#state.phase !== "pending" ||
      this.#state.operationId !== operationId ||
      !this.#projection?.pending.some((operation) => operation.operationId === operationId)
    )
      return false;
    if (this.#projection) {
      this.#projection = reconcileOptimisticOperation(
        this.#projection,
        operationId,
        reason.kind === "timed-out" ? "timed-out" : "rejected",
      );
    }
    const canonicalCells = this.#state.canonicalCells;
    this.#dragOpen = false;
    this.#clearTimeout();
    this.#emit({
      phase: "idle",
      canonicalCells,
      outcome: { kind: "reverted", operationId, reason },
    });
    return true;
  }

  #clearTimeout(): void {
    this.#cancelTimeout?.();
    this.#cancelTimeout = null;
  }

  #emit(state: ResizeTransactionState): void {
    this.#state = Object.freeze(state);
    this.#options.onState(this.#state);
  }
}
