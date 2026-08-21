/**
 * Renderer-neutral connection supervision shared by the browser and OpenTUI.
 *
 * A client supplies one transport-specific `connect` function. The supervisor
 * owns the lifecycle around it: single-flight startup, reconnect backoff,
 * cancellation, and preservation of the last known value while the transport
 * is down. DOM, OpenTUI, tmux and HTTP types intentionally do not cross this
 * boundary.
 */
import { acquireRuntimeResource } from "./runtime-resource-ledger.ts";

export type RuntimeConnectionPhase =
  | "idle"
  | "connecting"
  | "live"
  | "reconnecting"
  | "failed"
  | "stopped";

export interface RuntimeConnectionState<Value> {
  readonly phase: RuntimeConnectionPhase;
  /** One for the first retry, two for the second; zero while live/cold. */
  readonly attempt: number;
  /** Last successfully connected value. Retained through reconnecting. */
  readonly value: Value | null;
  readonly error: unknown | null;
}

export interface RuntimeConnection<Value> {
  readonly value: Value;
  /** Settles when this transport is no longer usable. */
  readonly closed: Promise<unknown>;
  /** Idempotent, best-effort transport cleanup. */
  dispose(): void | Promise<void>;
}

export interface RuntimeConnectionContext<Value> {
  readonly signal: AbortSignal;
  readonly attempt: number;
  readonly previousValue: Value | null;
}

export interface RuntimeConnectionSupervisorOptions<Value> {
  connect(context: RuntimeConnectionContext<Value>): Promise<RuntimeConnection<Value>>;
  /** Defaults to retrying every failure until stop(). */
  retryable?: (error: unknown) => boolean;
  /** Defaults to exponential 1s, 2s, 4s … capped at 30s. */
  backoffMs?: (attempt: number) => number;
  /** Injectable wait seam for deterministic clients and tests. */
  wait?: (delayMs: number, signal: AbortSignal) => Promise<void>;
}

export interface RuntimeConnectionSupervisor<Value> {
  readonly state: RuntimeConnectionState<Value>;
  start(): void;
  stop(): Promise<void>;
  subscribe(listener: (state: RuntimeConnectionState<Value>) => void): () => void;
}

const CLOSED = new Error("The runtime connection closed.");
const ABORTED = Symbol("runtime-connection-aborted");

export function exponentialReconnectBackoff(attempt: number): number {
  const exponent = Math.max(0, Math.min(30, Math.trunc(attempt) - 1));
  return Math.min(30_000, 1_000 * 2 ** exponent);
}

function raceWithAbort<Value>(
  promise: Promise<Value>,
  signal: AbortSignal,
): Promise<Value | typeof ABORTED> {
  if (signal.aborted) return Promise.resolve(ABORTED);
  return new Promise((resolve, reject) => {
    const aborted = () => {
      signal.removeEventListener("abort", aborted);
      resolve(ABORTED);
    };
    signal.addEventListener("abort", aborted, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", aborted);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", aborted);
        reject(error);
      },
    );
  });
}

function wait(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || delayMs <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, delayMs);
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
    signal.addEventListener("abort", finish, { once: true });
  });
}

async function safelyDispose<Value>(connection: RuntimeConnection<Value>): Promise<void> {
  try {
    await connection.dispose();
  } catch {
    // Authority has already been retired locally. Cleanup is best-effort.
  }
}

/** Create one reusable lifecycle owner. Calling start() repeatedly is safe. */
export function createRuntimeConnectionSupervisor<Value>(
  options: RuntimeConnectionSupervisorOptions<Value>,
): RuntimeConnectionSupervisor<Value> {
  const listeners = new Set<(state: RuntimeConnectionState<Value>) => void>();
  let current: RuntimeConnectionState<Value> = {
    phase: "idle",
    attempt: 0,
    value: null,
    error: null,
  };
  let controller: AbortController | null = null;
  let run: Promise<void> | null = null;
  let releaseSupervisor: (() => void) | null = null;

  const publish = (next: RuntimeConnectionState<Value>): void => {
    current = next;
    for (const listener of [...listeners]) listener(next);
  };

  const drive = async (signal: AbortSignal): Promise<void> => {
    let attempt = 0;
    publish({ phase: "connecting", attempt, value: current.value, error: null });
    while (!signal.aborted) {
      let connection: RuntimeConnection<Value> | null = null;
      try {
        const connecting = options.connect({
          signal,
          attempt,
          previousValue: current.value,
        });
        const connected = await raceWithAbort(connecting, signal);
        if (connected === ABORTED) {
          // A host adapter may ignore AbortSignal. Stop must still settle
          // immediately, and any transport that resolves late must be retired.
          void connecting.then(safelyDispose).catch(() => undefined);
          break;
        }
        connection = connected;
        attempt = 0;
        publish({ phase: "live", attempt, value: connection.value, error: null });
        const ended = await raceWithAbort(connection.closed, signal);
        if (ended === ABORTED) break;
        throw ended ?? CLOSED;
      } catch (error) {
        if (signal.aborted) break;
        if (options.retryable?.(error) === false) {
          publish({ phase: "failed", attempt, value: current.value, error });
          return;
        }
        attempt += 1;
        publish({ phase: "reconnecting", attempt, value: current.value, error });
        const releaseTimer = acquireRuntimeResource("runtime-timer");
        try {
          await (options.wait ?? wait)(
            (options.backoffMs ?? exponentialReconnectBackoff)(attempt),
            signal,
          );
        } finally {
          releaseTimer();
        }
      } finally {
        if (connection) await safelyDispose(connection);
      }
    }
  };

  return {
    get state() {
      return current;
    },
    start() {
      if (run) return;
      releaseSupervisor = acquireRuntimeResource("runtime-supervisor");
      controller = new AbortController();
      const activeController = controller;
      run = drive(activeController.signal).finally(() => {
        if (controller === activeController) controller = null;
        run = null;
        if (current.phase !== "failed") {
          publish({ phase: "stopped", attempt: 0, value: current.value, error: null });
        }
        releaseSupervisor?.();
        releaseSupervisor = null;
      });
    },
    async stop() {
      controller?.abort();
      await run;
    },
    subscribe(listener) {
      const releaseSubscription = acquireRuntimeResource("runtime-subscription");
      listeners.add(listener);
      listener(current);
      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        listeners.delete(listener);
        releaseSubscription();
      };
    },
  };
}
