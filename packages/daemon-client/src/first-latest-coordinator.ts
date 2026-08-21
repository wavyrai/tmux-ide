export interface FirstLatestRequest {
  readonly key: string;
  readonly execute: () => Promise<void>;
  readonly onSuccess: () => void;
  readonly onFailure: (error: unknown) => void;
  readonly onSuperseded?: () => void;
}

export type FirstLatestAdmission = "started" | "queued" | "coalesced-active" | "coalesced-pending";

/**
 * Runs the first request immediately and retains only the latest distinct
 * request behind it. Generation retirement fences every late settlement.
 */
export class FirstLatestCoordinator {
  #generation = 0;
  #active: FirstLatestRequest | null = null;
  #pending: FirstLatestRequest | null = null;

  request(request: FirstLatestRequest): FirstLatestAdmission {
    if (this.#active === null) {
      this.#start(request, this.#generation);
      return "started";
    }
    if (request.key === this.#active.key) {
      const superseded = this.#pending;
      this.#pending = null;
      this.#notify(superseded?.onSuperseded);
      return "coalesced-active";
    }
    if (request.key === this.#pending?.key) return "coalesced-pending";
    const superseded = this.#pending;
    this.#pending = request;
    this.#notify(superseded?.onSuperseded);
    return "queued";
  }

  retire(): void {
    this.#generation += 1;
    this.#active = null;
    this.#pending = null;
  }

  snapshot(): { readonly activeKey: string | null; readonly pendingKey: string | null } {
    return { activeKey: this.#active?.key ?? null, pendingKey: this.#pending?.key ?? null };
  }

  #start(request: FirstLatestRequest, generation: number): void {
    this.#active = request;
    let execution: Promise<void>;
    try {
      execution = request.execute();
    } catch (error) {
      this.#settle(generation, request, error);
      return;
    }
    void execution.then(
      () => this.#settle(generation, request, null),
      (error: unknown) => this.#settle(generation, request, error),
    );
  }

  #settle(generation: number, request: FirstLatestRequest, error: unknown): void {
    if (generation !== this.#generation || this.#active !== request) return;
    this.#active = null;
    const pending = this.#pending;
    this.#pending = null;
    if (pending) this.#start(pending, generation);
    if (error === null) this.#notify(request.onSuccess);
    else this.#notify(request.onFailure, error);
  }

  #notify(callback: (() => void) | undefined): void;
  #notify(callback: ((error: unknown) => void) | undefined, error: unknown): void;
  #notify(callback: ((error?: unknown) => void) | undefined, error?: unknown): void {
    try {
      callback?.(error);
    } catch {
      // Completion observers cannot wedge or reorder coordinator state.
    }
  }
}
