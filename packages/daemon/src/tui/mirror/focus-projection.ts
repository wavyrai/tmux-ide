import {
  createOptimisticProjection,
  deriveOptimisticProjection,
  enqueueOptimisticOperation,
  expireOptimisticOperations,
  reconcileOptimisticOperation,
  replaceCommittedProjection,
  type OptimisticProjectionState,
} from "@tmux-ide/core";

export interface FocusProjectionControllerOptions {
  readonly generation: string;
  readonly initialPaneId: string | null;
  readonly timeoutMs: number;
  readonly now: () => number;
  readonly operationId: () => string;
  readonly schedule: (callback: () => void, delayMs: number) => () => void;
  readonly submit: (paneId: string, operationId: string) => Promise<unknown>;
  readonly onFocus: (paneId: string | null) => void;
  readonly onRejected: (reason: string) => void;
}

/** One renderer-neutral optimistic projection around OpenTUI focus authority. */
export class FocusProjectionController {
  readonly #options: FocusProjectionControllerOptions;
  #state: OptimisticProjectionState<string | null, string>;
  #revision = 0;
  #timeouts = new Map<string, () => void>();
  #disposed = false;

  constructor(options: FocusProjectionControllerOptions) {
    this.#options = options;
    this.#state = createOptimisticProjection({
      generation: options.generation,
      revision: 0,
      value: options.initialPaneId,
    });
  }

  focus(): string | null {
    return deriveOptimisticProjection(this.#state, { predict: (_committed, paneId) => paneId });
  }

  select(paneId: string): string | null {
    if (this.#disposed || paneId.length === 0) return null;
    if (this.focus() === paneId) return null;
    const operationId = this.#options.operationId();
    const now = this.#options.now();
    this.#state = enqueueOptimisticOperation(this.#state, {
      operationId,
      intent: paneId,
      acceptedAtMs: now,
      deadlineAtMs: now + this.#options.timeoutMs,
    });
    this.#options.onFocus(this.focus());
    this.#timeouts.set(
      operationId,
      this.#options.schedule(() => this.#timeout(operationId), this.#options.timeoutMs),
    );
    void this.#options.submit(paneId, operationId).then(
      // Transport acceptance is not committed focus. The prediction remains
      // pending until `observe` receives daemon-owned focus truth.
      () => undefined,
      (error: unknown) =>
        this.#reject(operationId, error instanceof Error ? error.message : "pane focus rejected"),
    );
    return operationId;
  }

  observe(paneId: string | null): void {
    if (this.#disposed) return;
    this.#revision += 1;
    const observed = this.#state.pending
      .filter((operation) => operation.intent === paneId)
      .map((operation) => operation.operationId);
    for (const operationId of observed) this.#clearTimeout(operationId);
    this.#state = replaceCommittedProjection(
      this.#state,
      { generation: this.#state.committed.generation, revision: this.#revision, value: paneId },
      { observedOperationIds: observed, nowMs: this.#options.now() },
    );
    this.#options.onFocus(this.focus());
  }

  dispose(): void {
    this.#disposed = true;
    for (const cancel of this.#timeouts.values()) cancel();
    this.#timeouts.clear();
  }

  #reject(operationId: string, reason: string): void {
    if (this.#disposed || !this.#state.pending.some((entry) => entry.operationId === operationId))
      return;
    this.#clearTimeout(operationId);
    this.#state = reconcileOptimisticOperation(this.#state, operationId, "rejected");
    this.#options.onFocus(this.focus());
    this.#options.onRejected(reason);
  }

  #timeout(operationId: string): void {
    this.#timeouts.delete(operationId);
    const next = expireOptimisticOperations(this.#state, this.#options.now());
    if (next === this.#state) return;
    this.#state = next;
    this.#options.onFocus(this.focus());
    this.#options.onRejected("pane focus timed out");
  }

  #clearTimeout(operationId: string): void {
    this.#timeouts.get(operationId)?.();
    this.#timeouts.delete(operationId);
  }
}
