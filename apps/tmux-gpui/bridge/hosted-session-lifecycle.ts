/** Session ownership only: this module neither imports live.ts nor owns process globals.
 * Async handlers must check the supplied context after awaits before side effects.
 * Cancellation fences admission; JavaScript cannot forcibly stop an uncooperative promise.
 */
export type RetirementReason =
  | "disposed"
  | "aborted"
  | "command-failed"
  | "publication-failed"
  | "callback-failed"
  | "output-failed";
export type Retirement = Readonly<{
  reason: RetirementReason;
  timedOut: boolean;
  failures: readonly string[];
}>;
export type SessionContext = Readonly<{ signal: AbortSignal; checkActive(): void }>;
export class SessionRetiredError extends Error {
  constructor() {
    super("Hosted session retired");
  }
}
export function createHostedSessionLifecycle<Command, Publication>(options: {
  signal?: AbortSignal;
  commandCapacity?: number;
  retirementMs?: number;
  dispatch(command: Command, context: SessionContext): void | Promise<void>;
  emit(publication: Publication, signal: AbortSignal): void | Promise<void>;
  unavailable(reason: RetirementReason): Publication;
  /** Synchronous: revoke input/geometry authority before any final output wait. */
  revoke(): void;
  drain(signal: AbortSignal): void | Promise<void>;
  close(): void | Promise<void>;
  onRetired?(result: Retirement): void | Promise<void>;
}) {
  const capacity = options.commandCapacity ?? 16;
  const retirementMs = options.retirementMs ?? 500;
  if (
    !Number.isSafeInteger(capacity) ||
    capacity < 1 ||
    capacity > 1024 ||
    !Number.isSafeInteger(retirementMs) ||
    retirementMs < 1 ||
    retirementMs > 30000
  )
    throw new Error("Invalid hosted session bounds");
  let state: "running" | "retiring" | "retired" = "running";
  const lifetime = new AbortController();
  const context: SessionContext = Object.freeze({ signal: lifetime.signal, checkActive });
  const resources = new Set<() => void | Promise<void>>();
  type Pending = { command: Command; resolve(): void; reject(error: unknown): void };
  const queue: Pending[] = [];
  let active: Pending | undefined;
  let publishing = false;
  let callbacks = 0;
  let resolveDone!: (result: Retirement) => void;
  const done = new Promise<Retirement>((resolve) => {
    resolveDone = resolve;
  });
  function checkActive() {
    if (state !== "running") throw new SessionRetiredError();
  }
  function dispose(reason: RetirementReason = "disposed") {
    if (state !== "running") return done;
    state = "retiring";
    options.signal?.removeEventListener("abort", abort);
    const failures: string[] = [];
    // Reentrancy is closed before either cancellation callback can run.
    lifetime.abort();
    try {
      options.revoke();
    } catch {
      failures.push("revoke");
    }
    const error = new SessionRetiredError();
    active?.reject(error);
    for (const entry of queue.splice(0)) entry.reject(error);
    void finish(reason, failures);
    return done;
  }
  async function finish(reason: RetirementReason, failures: string[]) {
    const deadline = new AbortController();
    let timedOut = false;
    let expire!: () => void;
    const expired = new Promise<false>((resolve) => {
      expire = () => resolve(false);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      deadline.abort();
      expire();
    }, retirementMs);
    const bounded = async (phase: string, work: () => void | Promise<void>) => {
      let result: void | Promise<void>;
      try {
        result = work();
      } catch {
        failures.push(phase);
        return false;
      }
      const task = Promise.resolve(result).then(
        () => true,
        () => {
          if (state !== "retired") failures.push(phase);
          return false;
        },
      );
      return Promise.race([task, expired]);
    };
    try {
      await bounded("unavailable", () =>
        options.emit(options.unavailable(reason), deadline.signal),
      );
      if (!timedOut) await bounded("drain", () => options.drain(deadline.signal));
      // Invoke every disposer even when the output deadline already expired.
      const closing = [...resources];
      resources.clear();
      await bounded("resources", async () => {
        await Promise.all(
          closing.map(async (close) => {
            try {
              await close();
            } catch {
              if (state !== "retired") failures.push("resource");
            }
          }),
        );
      });
      await bounded("close", () => options.close());
      await bounded("onRetired", () =>
        options.onRetired?.(
          Object.freeze({ reason, timedOut, failures: Object.freeze([...failures]) }),
        ),
      );
    } finally {
      clearTimeout(timer);
      deadline.abort();
      state = "retired";
      resolveDone(Object.freeze({ reason, timedOut, failures: Object.freeze([...failures]) }));
    }
  }
  async function pump() {
    if (active || state !== "running") return;
    while (queue.length && state === "running") {
      const entry = queue.shift()!;
      active = entry;
      try {
        context.checkActive();
        await options.dispatch(entry.command, context);
        context.checkActive();
        entry.resolve();
      } catch (error) {
        entry.reject(error);
        if (state === "running") dispose("command-failed");
      } finally {
        active = undefined;
      }
    }
  }
  const abort = () => {
    dispose("aborted");
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  return {
    context,
    done,
    dispose,
    get state() {
      return state;
    },
    command(command: Command): Promise<void> {
      if (state !== "running") return Promise.reject(new SessionRetiredError());
      if (queue.length + Number(!!active) >= capacity)
        return Promise.reject(new Error("Hosted command capacity exceeded"));
      const admitted = new Promise<void>((resolve, reject) =>
        queue.push({ command, resolve, reject }),
      );
      void pump();
      return admitted;
    },
    /** One publication admission at a time. The caller owns snapshot coalescing and ordered-byte budgets. */
    async publish(publication: Publication) {
      checkActive();
      if (publishing) throw new Error("Concurrent hosted publication admission");
      publishing = true;
      let cancel!: () => void;
      const canceled = new Promise<never>((_, reject) => {
        cancel = () => reject(new SessionRetiredError());
        lifetime.signal.addEventListener("abort", cancel, { once: true });
      });
      try {
        await Promise.race([
          Promise.resolve().then(() => {
            checkActive();
            return options.emit(publication, lifetime.signal);
          }),
          canceled,
        ]);
        checkActive();
      } catch (error) {
        if (state === "running") dispose("publication-failed");
        throw error;
      } finally {
        lifetime.signal.removeEventListener("abort", cancel);
        publishing = false;
      }
    },
    /** Wrap transport/timer callbacks; asynchronous continuations must use context.checkActive(). */
    guard<Args extends unknown[]>(callback: (...args: Args) => void | Promise<void>) {
      return (...args: Args): boolean => {
        if (state !== "running") return false;
        if (callbacks >= capacity) {
          dispose("callback-failed");
          return false;
        }
        callbacks++;
        try {
          Promise.resolve(callback(...args))
            .catch(() => {
              if (state === "running") dispose("callback-failed");
            })
            .finally(() => {
              callbacks--;
            });
          return true;
        } catch {
          callbacks--;
          dispose("callback-failed");
          return false;
        }
      };
    },
    /** Register resource cleanup, returning an unregister function for already completed resources. */
    own(close: () => void | Promise<void>) {
      checkActive();
      if (resources.size >= 256) throw new Error("Hosted resource capacity exceeded");
      resources.add(close);
      return () => {
        resources.delete(close);
      };
    },
  };
}
