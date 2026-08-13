export interface ViewportFitRequest {
  readonly key: string;
  readonly execute: () => Promise<void>;
  readonly onSuccess: () => void;
  readonly onFailure: (error: unknown) => void;
}

/**
 * Keep viewport fitting responsive during a resize burst without allowing
 * intermediate Yoga sizes to queue unbounded tmux mutations. The first fit is
 * allowed to finish and only the latest distinct size is retained behind it.
 * Retiring the coordinator generation fences every late completion.
 */
export class ViewportFitCoordinator {
  #generation = 0;
  #activeKey: string | null = null;
  #pending: ViewportFitRequest | null = null;

  request(request: ViewportFitRequest): void {
    if (this.#activeKey === null) {
      this.#start(request, this.#generation);
      return;
    }
    if (request.key === this.#activeKey) {
      // The active request is already the final desired size. Any older queued
      // intermediate target must not run after it.
      this.#pending = null;
      return;
    }
    this.#pending = request;
  }

  retire(): void {
    this.#generation += 1;
    this.#activeKey = null;
    this.#pending = null;
  }

  snapshot(): { activeKey: string | null; pendingKey: string | null } {
    return { activeKey: this.#activeKey, pendingKey: this.#pending?.key ?? null };
  }

  #start(request: ViewportFitRequest, generation: number): void {
    this.#activeKey = request.key;
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

  #settle(generation: number, request: ViewportFitRequest, error: unknown): void {
    if (generation !== this.#generation || this.#activeKey !== request.key) return;
    if (error === null) request.onSuccess();
    else request.onFailure(error);
    this.#activeKey = null;
    const pending = this.#pending;
    this.#pending = null;
    if (pending) this.#start(pending, generation);
  }
}
