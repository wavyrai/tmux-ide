/** One host-neutral, single-flight daemon bootstrap state machine. */

export type DaemonBootstrapPhase =
  | "idle"
  | "probing"
  | "spawning"
  | "control-ready"
  | "inventory-reconciling"
  | "ready"
  | "incompatible"
  | "failed";

export type DaemonBootstrapProbe<Candidate, Reason> =
  | { readonly status: "compatible"; readonly candidate: Candidate }
  | { readonly status: "absent-or-stale" }
  | { readonly status: "incompatible"; readonly reason: Reason };

export type DaemonInventoryReadiness<Inventory, Reason> =
  | { readonly status: "ready"; readonly inventory: Inventory }
  | { readonly status: "empty"; readonly inventory: Inventory }
  | { readonly status: "reconciling" }
  | { readonly status: "unavailable"; readonly reason: Reason };

export interface DaemonBootstrapTimings {
  readonly startedAt: number;
  readonly probedAt: number | null;
  readonly spawnedAt: number | null;
  readonly controlReadyAt: number | null;
  readonly inventoryReadyAt: number | null;
  readonly firstClientReadyAt: number | null;
}

export interface DaemonBootstrapSnapshot<Candidate, Inventory, Reason> {
  readonly phase: DaemonBootstrapPhase;
  readonly attempt: number;
  readonly candidate: Candidate | null;
  readonly inventory: Inventory | null;
  readonly source: "existing" | "started" | null;
  readonly reason: Reason | null;
  readonly timings: DaemonBootstrapTimings;
}

export interface DaemonBootstrapResult<Candidate, Inventory> {
  readonly candidate: Candidate;
  readonly inventory: Inventory | null;
  readonly source: "existing" | "started";
  readonly timings: DaemonBootstrapTimings;
}

export interface DaemonBootstrapCoordinatorOptions<Candidate, Inventory, Reason> {
  /** Proves published identity + protocol + control health. */
  readonly probe: () =>
    | DaemonBootstrapProbe<Candidate, Reason>
    | Promise<DaemonBootstrapProbe<Candidate, Reason>>;
  /** Begin one generation; cross-process election remains daemon-owned. */
  readonly spawn: () => void | Promise<void>;
  /** Optional tmux inventory phase. Absence may honestly resolve as `empty`. */
  readonly reconcileInventory?: (
    candidate: Candidate,
  ) =>
    | DaemonInventoryReadiness<Inventory, Reason>
    | Promise<DaemonInventoryReadiness<Inventory, Reason>>;
  readonly timeoutMs?: number;
  readonly pollMs?: (poll: number) => number;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly onPhaseChanged?: (
    snapshot: DaemonBootstrapSnapshot<Candidate, Inventory, Reason>,
  ) => void;
}

export class DaemonBootstrapError<Reason = unknown> extends Error {
  readonly code: "spawn-failed" | "control-timeout" | "inventory-timeout" | "incompatible";
  readonly reason: Reason | null;
  readonly cause: unknown;

  constructor(
    code: DaemonBootstrapError<Reason>["code"],
    message: string,
    options: { readonly reason?: Reason; readonly cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "DaemonBootstrapError";
    this.code = code;
    this.reason = options.reason ?? null;
    this.cause = options.cause;
  }
}

const defaultSleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
const defaultPollMs = (poll: number): number => Math.min(25 * 2 ** poll, 200);

/**
 * Deduplicates concurrent callers in one host and converges cross-process
 * callers through the daemon's own atomic publication protocol.
 */
export class DaemonBootstrapCoordinator<Candidate, Inventory = never, Reason = string> {
  readonly #options: DaemonBootstrapCoordinatorOptions<Candidate, Inventory, Reason>;
  #flight: Promise<DaemonBootstrapResult<Candidate, Inventory>> | null = null;
  #attempt = 0;
  #snapshot: DaemonBootstrapSnapshot<Candidate, Inventory, Reason>;

  constructor(options: DaemonBootstrapCoordinatorOptions<Candidate, Inventory, Reason>) {
    this.#options = options;
    this.#snapshot = Object.freeze({
      phase: "idle",
      attempt: 0,
      candidate: null,
      inventory: null,
      source: null,
      reason: null,
      timings: this.#timings(0),
    });
  }

  snapshot(): DaemonBootstrapSnapshot<Candidate, Inventory, Reason> {
    return this.#snapshot;
  }

  ensure(): Promise<DaemonBootstrapResult<Candidate, Inventory>> {
    if (this.#flight) return this.#flight;
    const attempt = ++this.#attempt;
    const operation = this.#run(attempt);
    this.#flight = operation;
    void operation
      .finally(() => {
        if (this.#flight === operation) this.#flight = null;
      })
      .catch(() => undefined);
    return operation;
  }

  async #run(attempt: number): Promise<DaemonBootstrapResult<Candidate, Inventory>> {
    const timeoutMs = this.#options.timeoutMs ?? 15_000;
    const now = this.#options.now ?? Date.now;
    const sleep = this.#options.sleep ?? defaultSleep;
    const pollMs = this.#options.pollMs ?? defaultPollMs;
    let timings = this.#timings(now());
    this.#publish("probing", attempt, null, null, null, null, timings);
    try {
      let source: "existing" | "started" = "existing";
      let probe = await this.#options.probe();
      timings = { ...timings, probedAt: now() };
      if (probe.status === "incompatible") this.#throwIncompatible(probe.reason);

      if (probe.status === "absent-or-stale") {
        source = "started";
        this.#publish("spawning", attempt, null, null, null, null, timings);
        try {
          await this.#options.spawn();
          timings = { ...timings, spawnedAt: now() };
        } catch (error) {
          // A concurrent starter can make a local spawn failure benign.
          probe = await this.#options.probe();
          if (probe.status === "incompatible") this.#throwIncompatible(probe.reason);
          if (probe.status !== "compatible") {
            throw new DaemonBootstrapError(
              "spawn-failed",
              "The canonical daemon could not start.",
              {
                cause: error,
              },
            );
          }
          source = "existing";
        }
      }

      const controlDeadline = now() + timeoutMs;
      let poll = 0;
      while (probe.status !== "compatible") {
        if (now() >= controlDeadline) {
          throw new DaemonBootstrapError(
            "control-timeout",
            `The canonical daemon control plane did not become ready within ${timeoutMs}ms.`,
          );
        }
        await sleep(Math.max(0, pollMs(poll++)));
        probe = await this.#options.probe();
        if (probe.status === "incompatible") this.#throwIncompatible(probe.reason);
      }

      const candidate = probe.candidate;
      timings = { ...timings, controlReadyAt: now() };
      this.#publish("control-ready", attempt, candidate, null, source, null, timings);
      if (!this.#options.reconcileInventory) {
        timings = { ...timings, inventoryReadyAt: now(), firstClientReadyAt: now() };
        return this.#ready(attempt, candidate, null, source, timings);
      }

      this.#publish("inventory-reconciling", attempt, candidate, null, source, null, timings);
      const inventoryDeadline = now() + timeoutMs;
      poll = 0;
      while (true) {
        const inventory = await this.#options.reconcileInventory(candidate);
        if (inventory.status === "ready" || inventory.status === "empty") {
          timings = { ...timings, inventoryReadyAt: now(), firstClientReadyAt: now() };
          return this.#ready(attempt, candidate, inventory.inventory, source, timings);
        }
        if (inventory.status === "unavailable") {
          throw new DaemonBootstrapError(
            "inventory-timeout",
            "The daemon is ready but tmux inventory is unavailable.",
            { reason: inventory.reason },
          );
        }
        if (now() >= inventoryDeadline) {
          throw new DaemonBootstrapError(
            "inventory-timeout",
            `The tmux inventory did not reconcile within ${timeoutMs}ms.`,
          );
        }
        await sleep(Math.max(0, pollMs(poll++)));
      }
    } catch (error) {
      const incompatible = error instanceof DaemonBootstrapError && error.code === "incompatible";
      const reason = error instanceof DaemonBootstrapError ? (error.reason as Reason | null) : null;
      this.#publish(
        incompatible ? "incompatible" : "failed",
        attempt,
        null,
        null,
        null,
        reason,
        timings,
      );
      throw error;
    }
  }

  #throwIncompatible(reason: Reason): never {
    throw new DaemonBootstrapError("incompatible", "The canonical daemon is incompatible.", {
      reason,
    });
  }

  #ready(
    attempt: number,
    candidate: Candidate,
    inventory: Inventory | null,
    source: "existing" | "started",
    timings: DaemonBootstrapTimings,
  ): DaemonBootstrapResult<Candidate, Inventory> {
    this.#publish("ready", attempt, candidate, inventory, source, null, timings);
    return { candidate, inventory, source, timings };
  }

  #timings(startedAt: number): DaemonBootstrapTimings {
    return {
      startedAt,
      probedAt: null,
      spawnedAt: null,
      controlReadyAt: null,
      inventoryReadyAt: null,
      firstClientReadyAt: null,
    };
  }

  #publish(
    phase: DaemonBootstrapPhase,
    attempt: number,
    candidate: Candidate | null,
    inventory: Inventory | null,
    source: DaemonBootstrapSnapshot<Candidate, Inventory, Reason>["source"],
    reason: Reason | null,
    timings: DaemonBootstrapTimings,
  ): void {
    this.#snapshot = Object.freeze({
      phase,
      attempt,
      candidate,
      inventory,
      source,
      reason,
      timings: Object.freeze(timings),
    });
    try {
      this.#options.onPhaseChanged?.(this.#snapshot);
    } catch {
      // Observation cannot destabilize lifecycle authority.
    }
  }
}
