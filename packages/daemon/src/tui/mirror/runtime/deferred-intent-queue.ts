/** A lazy request whose rejected Promise is never retained. */
export class RetryableAsyncRequest<Value> {
  #request: Promise<Value> | null = null;

  get(load: () => Promise<Value>): Promise<Value> {
    if (this.#request) return this.#request;
    const request = load();
    this.#request = request;
    void request.catch(() => {
      if (this.#request === request) this.#request = null;
    });
    return request;
  }

  clear(): void {
    this.#request = null;
  }
}

/** FIFO async admission lane. Enqueue is synchronous; tasks run one at a time. */
export class OrderedAsyncIntentQueue {
  #tail: Promise<void> = Promise.resolve();
  #pendingCount = 0;

  get pendingCount(): number {
    return this.#pendingCount;
  }

  enqueue<Result>(task: () => Promise<Result>): Promise<Result> {
    this.#pendingCount += 1;
    const run = async () => {
      try {
        return await task();
      } finally {
        this.#pendingCount -= 1;
      }
    };
    const result = this.#tail.then(run, run);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
