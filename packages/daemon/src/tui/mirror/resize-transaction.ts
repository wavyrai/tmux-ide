import type { SessionRuntimeSemanticIntent } from "@tmux-ide/contracts";

export type ResizeTransactionAxis = "cols" | "rows";

export interface ResizeTransactionTarget {
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
    state.workspaceName === observation.workspaceName &&
    state.semanticPaneId === observation.semanticPaneId &&
    state.axis === observation.axis
  );
}

/**
 * Renderer-local pane-resize transaction.
 *
 * Pointer motion only changes the preview state. Release authors exactly one
 * semantic intent and keeps that preview visible until the matching observed
 * operation settles or rejects. The controller owns no timers, transport, or
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
    if (this.#state.phase !== "idle") return false;
    this.#clearTimeout();
    this.#emit({
      phase: "dragging",
      workspaceName: nonEmpty(input.workspaceName, "workspaceName"),
      semanticPaneId: nonEmpty(input.semanticPaneId, "semanticPaneId"),
      axis: input.axis,
      canonicalCells: positiveCells(input.canonicalCells, "canonicalCells"),
      previewCells: input.canonicalCells,
      startedAt: this.#options.now(),
    });
    return true;
  }

  /** Purely local preview update. It never calls submit or schedules work. */
  move(previewCells: number): boolean {
    if (this.#state.phase !== "dragging") return false;
    const next = positiveCells(previewCells, "previewCells");
    if (next === this.#state.previewCells) return false;
    this.#emit({ ...this.#state, previewCells: next });
    return true;
  }

  /**
   * Submit once. Duplicate physical release/up/drop events return the existing
   * operation id without authoring another mutation.
   */
  release(): string | null {
    if (this.#state.phase === "pending") return this.#state.operationId;
    if (this.#state.phase !== "dragging") return null;
    const dragging = this.#state;
    if (dragging.previewCells === dragging.canonicalCells) {
      this.#emit({ phase: "idle", canonicalCells: dragging.canonicalCells, outcome: null });
      return null;
    }

    const operationId = nonEmpty(this.#options.operationId(), "operationId");
    const pending: Extract<ResizeTransactionState, { phase: "pending" }> = {
      ...dragging,
      phase: "pending",
      operationId,
      submittedAt: this.#options.now(),
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

  /** Escape/cancel is only meaningful before release. */
  cancelDrag(): boolean {
    if (this.#state.phase !== "dragging") return false;
    const canonicalCells = this.#state.canonicalCells;
    this.#emit({ phase: "idle", canonicalCells, outcome: null });
    return true;
  }

  dispose(): void {
    this.#clearTimeout();
  }

  #settle(observation: ResizeTransactionObservation, source: "layout"): boolean {
    if (this.#state.phase !== "pending" || !sameTarget(this.#state, observation)) return false;
    const cells = positiveCells(observation.cells, "observed cells");
    const operationId = this.#state.operationId;
    this.#clearTimeout();
    this.#emit({
      phase: "idle",
      canonicalCells: cells,
      outcome: { kind: "settled", operationId, source, cells },
    });
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
    if (this.#state.phase !== "pending" || this.#state.operationId !== operationId) return false;
    const canonicalCells = this.#state.canonicalCells;
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
