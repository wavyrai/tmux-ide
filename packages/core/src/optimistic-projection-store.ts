import {
  createOptimisticProjection,
  deriveOptimisticProjection,
  enqueueOptimisticOperation,
  expireOptimisticOperations,
  reconcileOptimisticOperation,
  replaceCommittedProjection,
  type CommittedProjection,
  type OperationTerminalPhase,
  type OptimisticProjectionOptions,
  type OptimisticProjectionState,
} from "./optimistic-projection.ts";

export interface OptimisticProjectionStoreSnapshot<TCommitted, TIntent> {
  readonly state: OptimisticProjectionState<TCommitted, TIntent>;
  readonly derived: TCommitted;
}
export type OptimisticProjectionStoreListener<TCommitted, TIntent> = (
  snapshot: OptimisticProjectionStoreSnapshot<TCommitted, TIntent>,
) => void;

/** Framework-free state owner shared by bindings and direct programmatic clients. */
export class OptimisticProjectionStore<TCommitted, TIntent> {
  readonly #options: OptimisticProjectionOptions<TCommitted, TIntent>;
  readonly #listeners = new Set<OptimisticProjectionStoreListener<TCommitted, TIntent>>();
  #state: OptimisticProjectionState<TCommitted, TIntent>;
  constructor(
    committed: CommittedProjection<TCommitted>,
    options: OptimisticProjectionOptions<TCommitted, TIntent>,
  ) {
    this.#options = options;
    this.#state = createOptimisticProjection(committed);
  }
  snapshot(): OptimisticProjectionStoreSnapshot<TCommitted, TIntent> {
    return Object.freeze({
      state: this.#state,
      derived: deriveOptimisticProjection(this.#state, this.#options),
    });
  }
  subscribe(listener: OptimisticProjectionStoreListener<TCommitted, TIntent>): () => void {
    this.#listeners.add(listener);
    listener(this.snapshot());
    return () => this.#listeners.delete(listener);
  }
  enqueue(input: {
    readonly operationId: string;
    readonly intent: TIntent;
    readonly acceptedAtMs: number;
    readonly deadlineAtMs: number;
  }): void {
    this.#update(enqueueOptimisticOperation(this.#state, input));
  }
  receipt(operationId: string, phase: "accepted" | OperationTerminalPhase): void {
    this.#update(reconcileOptimisticOperation(this.#state, operationId, phase, this.#options));
  }
  replaceCommitted(
    committed: CommittedProjection<TCommitted>,
    input: { readonly observedOperationIds?: readonly string[]; readonly nowMs: number },
  ): void {
    this.#update(replaceCommittedProjection(this.#state, committed, input));
  }
  expire(nowMs: number): void {
    this.#update(expireOptimisticOperations(this.#state, nowMs, this.#options));
  }
  #update(next: OptimisticProjectionState<TCommitted, TIntent>): void {
    if (next === this.#state) return;
    this.#state = next;
    const snapshot = this.snapshot();
    for (const listener of this.#listeners) listener(snapshot);
  }
}
