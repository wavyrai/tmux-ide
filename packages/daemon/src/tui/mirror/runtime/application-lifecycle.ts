import {
  TuiCleanupRegistry,
  createTuiLifecycleExecutor,
  type TuiLifecycleCommand,
  type TuiLifecycleExecutor,
} from "../input-lifecycle.ts";
import { acquireRuntimeResource } from "@tmux-ide/daemon-client/runtime-resource-ledger";

export type TuiShutdownReason = TuiLifecycleCommand["source"] | "bootstrap-error" | "host";

export interface TuiShutdownFailure {
  readonly name: string;
  readonly phase: "cancel" | "cleanup" | "close" | "settle" | "renderer";
  readonly error: unknown;
}

export interface TuiShutdownReport {
  readonly reason: TuiShutdownReason;
  readonly failures: readonly TuiShutdownFailure[];
  readonly timedOut: readonly string[];
}

export interface TuiPendingWork {
  /** Synchronous cancellation boundary. Child processes should be killed here. */
  readonly cancel: () => void;
  /** Resolves only after the operation can no longer call renderer-owned code. */
  readonly settled: Promise<unknown>;
}

export type TuiAsyncCloser = () => void | Promise<void>;

export interface TuiApplicationLifecycleOptions {
  readonly destroyRenderer: () => void | Promise<void>;
  readonly cleanupRegistry?: TuiCleanupRegistry;
  readonly shutdownTimeoutMs?: number;
  readonly setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

type PendingEntry = { readonly name: string; readonly work: TuiPendingWork };
interface AwaitedEntry {
  readonly name: string;
  readonly phase: "close" | "settle";
  readonly promise: Promise<void>;
}

const asError = (error: unknown): unknown => error;

/**
 * One owner for the OpenTUI process lifetime.
 *
 * `shutdown()` deliberately is not `async`: every caller receives the exact
 * same Promise object, while admission closes and cancellation begins before
 * the first call returns. Renderer destruction is the final operation even
 * when cleanup throws or pending work misses the bounded drain deadline.
 */
export class TuiApplicationLifecycle {
  readonly #destroyRenderer: TuiApplicationLifecycleOptions["destroyRenderer"];
  readonly #cleanupRegistry: TuiCleanupRegistry;
  readonly #shutdownTimeoutMs: number;
  readonly #setTimer: NonNullable<TuiApplicationLifecycleOptions["setTimer"]>;
  readonly #clearTimer: NonNullable<TuiApplicationLifecycleOptions["clearTimer"]>;
  readonly #abortController = new AbortController();
  readonly #pending = new Map<string, TuiPendingWork>();
  readonly #retiring = new Set<PendingEntry>();
  readonly #closers = new Map<string, TuiAsyncCloser>();
  readonly #retiringClosers = new Set<AwaitedEntry>();
  #accepting = true;
  #shutdownPromise: Promise<TuiShutdownReport> | null = null;

  constructor(options: TuiApplicationLifecycleOptions) {
    this.#destroyRenderer = options.destroyRenderer;
    this.#cleanupRegistry = options.cleanupRegistry ?? new TuiCleanupRegistry();
    this.#shutdownTimeoutMs = options.shutdownTimeoutMs ?? 2_000;
    this.#setTimer = options.setTimer ?? setTimeout;
    this.#clearTimer = options.clearTimer ?? clearTimeout;
  }

  get signal(): AbortSignal {
    return this.#abortController.signal;
  }

  get accepting(): boolean {
    return this.#accepting;
  }

  /** Guard any watcher/socket callback that can arrive after root disposal. */
  guard<Args extends readonly unknown[]>(
    callback: (...args: Args) => void,
  ): (...args: Args) => void {
    return (...args) => {
      if (!this.#accepting) return;
      callback(...args);
    };
  }

  /**
   * Track cancellable work such as `team --json`, an in-flight watcher open,
   * or a mirror supervisor transition. Reusing a name retires the prior owner.
   */
  trackPending(name: string, work: TuiPendingWork): () => void {
    if (!this.#accepting) {
      this.#retireLatePending(name, work);
      return () => {};
    }
    const previous = this.#pending.get(name);
    if (previous && previous !== work) {
      this.#pending.delete(name);
      this.#retirePending(name, previous);
    }
    this.#pending.set(name, work);
    void work.settled.then(
      () => this.#deletePending(name, work),
      () => this.#deletePending(name, work),
    );
    return () => this.#deletePending(name, work);
  }

  /** Register a subscription/session/root closer. Late owners retire at once. */
  registerCloser(name: string, closer: TuiAsyncCloser): () => void {
    if (!this.#accepting) {
      this.#startCloser(name, closer);
      return () => {};
    }
    const previous = this.#closers.get(name);
    if (previous && previous !== closer) this.#startCloser(name, previous);
    this.#closers.set(name, closer);
    return () => {
      if (this.#closers.get(name) === closer) this.#closers.delete(name);
    };
  }

  /** Existing synchronous app cleanups compose into the same shutdown owner. */
  registerCleanup(name: string, cleanup: () => void): void {
    if (!this.#accepting) {
      try {
        cleanup();
      } catch {
        // The active shutdown report has already taken its cleanup snapshot.
      }
      return;
    }
    this.#cleanupRegistry.set(name, cleanup);
  }

  shutdown(reason: TuiShutdownReason): Promise<TuiShutdownReport> {
    if (this.#shutdownPromise) return this.#shutdownPromise;

    let resolveShutdown!: (report: TuiShutdownReport) => void;
    let rejectShutdown!: (error: unknown) => void;
    const shared = new Promise<TuiShutdownReport>((resolve, reject) => {
      resolveShutdown = resolve;
      rejectShutdown = reject;
    });
    // Publish the owner Promise before invoking any user cleanup. A cleanup
    // may synchronously request shutdown again and must observe this identity.
    this.#shutdownPromise = shared;

    // These mutations and cancellation calls intentionally happen before the
    // Promise is created/returned, closing every renderer callback admission
    // point in the same turn as Ctrl-Q or a bootstrap failure.
    this.#accepting = false;
    this.#abortController.abort(reason);
    const failures: TuiShutdownFailure[] = [];
    const currentPending: PendingEntry[] = [...this.#pending].map(([name, work]) => ({
      name,
      work,
    }));
    const pending: PendingEntry[] = [...currentPending, ...this.#retiring];
    this.#pending.clear();
    this.#retiring.clear();
    for (const { name, work } of currentPending) {
      try {
        work.cancel();
      } catch (error) {
        failures.push({ name, phase: "cancel", error: asError(error) });
      }
    }

    const cleanup = this.#cleanupRegistry.runAll();
    for (const failure of cleanup.failures) {
      failures.push({ ...failure, phase: "cleanup" });
    }

    const awaited: AwaitedEntry[] = pending.map(({ name, work }) => ({
      name,
      phase: "settle",
      promise: Promise.resolve(work.settled).then(() => undefined),
    }));
    for (const [name, closer] of this.#closers) this.#startCloser(name, closer, failures);
    this.#closers.clear();

    void this.#finishShutdown(reason, awaited, failures).then(resolveShutdown, rejectShutdown);
    return shared;
  }

  #deletePending(name: string, work: TuiPendingWork): void {
    if (this.#pending.get(name) === work) this.#pending.delete(name);
  }

  #retireLatePending(name: string, work: TuiPendingWork): void {
    try {
      work.cancel();
    } catch {
      // Cancellation is synchronous admission control. The settling boundary
      // still joins the active shutdown drain even when cancellation throws.
    }
    const entry: AwaitedEntry = {
      name,
      phase: "settle",
      promise: Promise.resolve(work.settled).then(() => undefined),
    };
    this.#retiringClosers.add(entry);
  }

  #retirePending(name: string, work: TuiPendingWork): void {
    const entry = { name, work };
    this.#retiring.add(entry);
    try {
      work.cancel();
    } catch {
      // Replacement cancellation is best-effort; shutdown still awaits it.
    }
    void work.settled.then(
      () => this.#retiring.delete(entry),
      () => this.#retiring.delete(entry),
    );
  }

  #startCloser(name: string, closer: TuiAsyncCloser, failures?: TuiShutdownFailure[]): void {
    let promise: Promise<void>;
    try {
      promise = Promise.resolve(closer());
    } catch (error) {
      failures?.push({ name, phase: "close", error: asError(error) });
      return;
    }
    const entry: AwaitedEntry = { name, phase: "close", promise };
    this.#retiringClosers.add(entry);
    void promise.then(
      () => {
        if (this.#accepting) this.#retiringClosers.delete(entry);
      },
      () => {
        if (this.#accepting) this.#retiringClosers.delete(entry);
      },
    );
  }

  async #finishShutdown(
    reason: TuiShutdownReason,
    awaited: readonly AwaitedEntry[],
    failures: TuiShutdownFailure[],
  ): Promise<TuiShutdownReport> {
    const outstanding = new Set(awaited);
    let timer: ReturnType<typeof setTimeout> | null = null;
    // The root's post-close snapshot occurs while this enclosing guard still
    // owns the closer; it retires before the shared shutdown promise resolves.
    const releaseTimer = acquireRuntimeResource("host-shutdown-timer");
    const deadline = new Promise<"timeout">((resolve) => {
      timer = this.#setTimer(() => {
        releaseTimer();
        resolve("timeout");
      }, this.#shutdownTimeoutMs);
    });

    // Drain to quiescence. A pending creator is allowed to finish by handing
    // back a late disposer; that disposer joins the next pass rather than
    // escaping between a one-shot snapshot and renderer destruction.
    while (true) {
      for (const entry of this.#retiringClosers) outstanding.add(entry);
      if (outstanding.size === 0) {
        await Promise.resolve();
        for (const entry of this.#retiringClosers) outstanding.add(entry);
        if (outstanding.size === 0) break;
      }
      const batch = [...outstanding];
      const result = await Promise.race([
        ...batch.map(async (entry) => {
          try {
            await entry.promise;
            return { entry } as const;
          } catch (error) {
            return { entry, error } as const;
          }
        }),
        deadline,
      ]);
      if (result === "timeout") break;
      outstanding.delete(result.entry);
      this.#retiringClosers.delete(result.entry);
      if ("error" in result) {
        failures.push({
          name: result.entry.name,
          phase: result.entry.phase,
          error: asError(result.error),
        });
      }
    }
    if (timer !== null) this.#clearTimer(timer);
    releaseTimer();

    for (const entry of this.#retiringClosers) outstanding.add(entry);
    const timedOut = [...outstanding].map((entry) => entry.name);
    try {
      await this.#destroyRenderer();
    } catch (error) {
      failures.push({ name: "renderer", phase: "renderer", error: asError(error) });
    }
    return { reason, failures: [...failures], timedOut };
  }
}

/** Bridge the existing input-layer semantics into the one async owner. */
export function createApplicationLifecycleInputExecutor(
  lifecycle: TuiApplicationLifecycle,
  hosted: {
    readonly putAway: () => void | Promise<void>;
  },
): TuiLifecycleExecutor {
  let destroyReason: TuiShutdownReason = "keyboard";
  const executor = createTuiLifecycleExecutor({
    destroyRenderer: () => {
      void lifecycle.shutdown(destroyReason);
    },
    putAway: () => {
      void hosted.putAway();
    },
  });
  return {
    run(command) {
      if (command.kind === "destroy-renderer") destroyReason = command.source;
      executor.run(command);
    },
  };
}
