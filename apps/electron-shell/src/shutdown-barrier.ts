export type ShutdownTask = () => Promise<void> | void;

/** Runs the host teardown sequence once, even when several quit paths race. */
export class ShutdownBarrier {
  #completion: Promise<void> | null = null;

  run(tasks: readonly ShutdownTask[]): Promise<void> {
    if (this.#completion) return this.#completion;
    this.#completion = (async () => {
      const results = await Promise.allSettled(tasks.map(async (task) => task()));
      const failures = results
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason);
      if (failures.length > 0) throw new AggregateError(failures, "desktop shutdown failed");
    })();
    return this.#completion;
  }
}
