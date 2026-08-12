import type { DesktopDaemonTransportState } from "@tmux-ide/contracts";

/**
 * The ONE generation-bound resource engine behind the fleet catalog, the
 * workspace catalog, and the application-shell resource.
 *
 * All three read a single daemon-stamped resource, pin it to one daemon
 * generation, keep an event subscription that invalidates it, and retire every
 * response that resolves against a superseded generation. This module owns that
 * policy exactly once:
 *
 * - generation pinning by an opaque target key; any late result whose
 *   generation or key moved on is dropped rather than trusted;
 * - a bounded request retry ladder and a bounded event retry ladder;
 * - deference to the host transport supervisor. Once the host pushes a
 *   supervisor-derived {@link DesktopDaemonTransportState}, that supervisor is
 *   the ONE retry owner: this engine never tears down and re-subscribes, and
 *   never schedules a socket retry of its own. Its status derives from the
 *   pushes instead. (The two catalog stores each ran their own event loop
 *   regardless of the pushes before this engine existed.)
 * - stale retention — a transient failure keeps the last good snapshot rather
 *   than blanking it;
 * - resync after recovery — a verified reconnect always refetches, so a missed
 *   invalidation cannot hide in the gap;
 * - observer-fault isolation on every notification, including disposal;
 * - disposal that notifies the observers it retires.
 *
 * The engine holds no vocabulary of its own. A caller supplies a
 * {@link GenerationBoundAdapter}: how to validate a target, how to fetch, how
 * to connect events, how a failure moves the machine, and how the neutral
 * {@link GenerationBoundView} projects onto that store's public state. The
 * daemon endpoint, owner credential, and physical socket never reach here.
 */

export interface GenerationBoundClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const defaultGenerationBoundClock: GenerationBoundClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface GenerationBoundRetryPolicy {
  readonly initialDelayMs: number;
  readonly maximumDelayMs: number;
  readonly maximumAttempts: number;
  /**
   * Symmetric fraction around the exponential delay, from 0 through 1. Zero is
   * a deterministic ladder; the application-shell resource uses 0.2.
   */
  readonly jitterRatio: number;
  /**
   * A verified connection must survive this long before the retry budget
   * resets. Zero resets the budget the moment the stream verifies.
   */
  readonly stabilityWindowMs: number;
}

export const DEFAULT_GENERATION_BOUND_RETRY: GenerationBoundRetryPolicy = {
  initialDelayMs: 250,
  maximumDelayMs: 4_000,
  maximumAttempts: 4,
  jitterRatio: 0,
  stabilityWindowMs: 0,
};

const RETRY_LIMITS = {
  delayMinMs: 10,
  delayMaxMs: 300_000,
  attemptsMin: 0,
  attemptsMax: 20,
  stabilityMinMs: 0,
  stabilityMaxMs: 300_000,
} as const;

/** Which half of the machine produced a failure. */
export type GenerationBoundFailureSource = "request" | "event" | "target";

/**
 * How a failure moves the machine.
 *
 * - `retry` — transient; run the bounded ladder for its source.
 * - `degrade` — publish it, but do not retry automatically.
 * - `fatal` — this generation's event authority is poisoned: the subscription
 *   is retired and no ladder runs, because a mismatched or malformed daemon
 *   response cannot be repaired by asking the same generation again on a timer.
 *   An explicit `refresh()` still reads and re-subscribes — a user-pressed
 *   retry is the one escape hatch, and the response is re-validated anyway.
 */
export type GenerationBoundDisposition = "retry" | "degrade" | "fatal";

/**
 * What re-asserting the CURRENT target means.
 *
 * - `refresh` — the call site pushes the target on every transport or
 *   capability change, so re-asserting it is the reconnect-driven refetch path
 *   (both catalog stores are driven this way).
 * - `ignore` — the call site pushes the target from render props, where an
 *   equal-but-new object carries no news; `refresh()` is the refetch path.
 */
export type GenerationBoundReassertPolicy = "refresh" | "ignore";

export interface GenerationBoundSnapshot<TResource> {
  readonly resource: TResource;
  readonly updatedAt: number;
}

export type GenerationBoundPhase<TFailure> =
  | { readonly kind: "loading" }
  | { readonly kind: "live" }
  | { readonly kind: "stale"; readonly reason: string }
  | {
      readonly kind: "failed";
      readonly source: GenerationBoundFailureSource;
      readonly failure: TFailure;
      /** The bounded ladder for this source ran out of attempts. */
      readonly exhausted: boolean;
      /** The failure poisoned this generation; nothing will retry it. */
      readonly fatal: boolean;
    };

/** The neutral state a projector turns into a store's public state. */
export interface GenerationBoundView<TTarget, TResource, TFailure> {
  readonly generation: number;
  readonly target: TTarget | null;
  /** The last good read, retained across transient failures. */
  readonly snapshot: GenerationBoundSnapshot<TResource> | null;
  /** The supervisor-derived transport state, once the host pushes one. */
  readonly transport: DesktopDaemonTransportState | null;
  readonly phase: GenerationBoundPhase<TFailure>;
  readonly disposed: boolean;
}

/** What an event source reports back into the engine. */
export interface GenerationBoundEventHandlers<TFailure> {
  /** The resource changed; refetch it. */
  invalidate(): void;
  /** The stream is verified open. */
  live(): void;
  /** A supervisor-derived transport state arrived. */
  transportChanged(transport: DesktopDaemonTransportState): void;
  /** The stream failed; {@link GenerationBoundAdapter.disposition} decides. */
  failed(failure: TFailure): void;
}

export type GenerationBoundTargetValidation<TTarget, TFailure> =
  | { readonly ok: true; readonly target: TTarget; readonly key: string }
  | { readonly ok: false; readonly failure: TFailure };

export type GenerationBoundFetchResult<TResource, TFailure> =
  | { readonly status: "ok"; readonly resource: TResource }
  | { readonly status: "failed"; readonly failure: TFailure };

export type GenerationBoundConnectResult<TFailure> =
  | { readonly status: "connected"; readonly close: () => void }
  | { readonly status: "failed"; readonly failure: TFailure };

export interface GenerationBoundAdapter<TTarget, TResource, TFailure, TState> {
  /** Strictly validate an untrusted target before it can reach a request. */
  validateTarget(value: unknown): GenerationBoundTargetValidation<TTarget, TFailure>;
  /**
   * Read the resource. The signal is aborted when the request is retired; a
   * facade that cannot forward it may ignore it — the engine's request
   * ordering is the correctness bound, the signal is the cancellation bonus.
   */
  fetch(
    target: TTarget,
    signal: AbortSignal,
  ): Promise<GenerationBoundFetchResult<TResource, TFailure>>;
  /**
   * Open the invalidation stream for this generation. A transport that
   * connects synchronously must return the result directly rather than a
   * resolved promise: a pending window the caller cannot observe would swallow
   * failures its own callbacks raise before the microtask lands.
   */
  connect(
    target: TTarget,
    handlers: GenerationBoundEventHandlers<TFailure>,
  ): GenerationBoundConnectResult<TFailure> | PromiseLike<GenerationBoundConnectResult<TFailure>>;
  disposition(failure: TFailure, source: GenerationBoundFailureSource): GenerationBoundDisposition;
  /** The failure published when a fetch or a connect rejects outright. */
  rejectionFailure(source: GenerationBoundFailureSource): TFailure;
  /** The failure published when the supervisor reports a non-connected socket. */
  transportFailure(transport: DesktopDaemonTransportState): TFailure;
  /** The failure published when the event ladder runs out of attempts. */
  eventExhaustedFailure(): TFailure;
  project(view: GenerationBoundView<TTarget, TResource, TFailure>): TState;
  readonly reassert?: GenerationBoundReassertPolicy;
}

export interface GenerationBoundStoreOptions {
  readonly clock?: GenerationBoundClock;
  readonly random?: () => number;
  readonly retry?: Partial<GenerationBoundRetryPolicy>;
}

export interface GenerationBoundStoreMetrics {
  readonly idleWakeups: 0;
  readonly activeInterests: number;
  readonly fetchesStarted: number;
  readonly fetchesSettled: number;
  readonly fetchesAborted: number;
  readonly lateResultsIgnored: number;
  readonly invalidationsObserved: number;
  readonly invalidationsCoalesced: number;
  readonly subscriptionsOpened: number;
  readonly subscriptionsClosed: number;
  readonly publications: number;
}

export interface GenerationBoundStore<TState> {
  getState(): TState;
  subscribe(listener: (state: TState) => void): () => void;
  setTarget(target: unknown): void;
  refresh(): void;
  getMetrics(): GenerationBoundStoreMetrics;
  /**
   * Re-project and re-publish the current phase. A wrapper that owns policy on
   * top of the resource (the workspace catalog's selection) uses this when its
   * own state changes without the resource changing.
   */
  republish(): void;
  dispose(): void;
}

function finiteClamped(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, value));
}

export function normalizedGenerationBoundRetry(
  overrides: Partial<GenerationBoundRetryPolicy> | undefined,
  defaults: GenerationBoundRetryPolicy = DEFAULT_GENERATION_BOUND_RETRY,
): GenerationBoundRetryPolicy {
  const initialDelayMs = Math.round(
    finiteClamped(
      overrides?.initialDelayMs,
      defaults.initialDelayMs,
      RETRY_LIMITS.delayMinMs,
      RETRY_LIMITS.delayMaxMs,
    ),
  );
  return {
    initialDelayMs,
    maximumDelayMs: Math.max(
      initialDelayMs,
      Math.round(
        finiteClamped(
          overrides?.maximumDelayMs,
          defaults.maximumDelayMs,
          RETRY_LIMITS.delayMinMs,
          RETRY_LIMITS.delayMaxMs,
        ),
      ),
    ),
    maximumAttempts: Math.trunc(
      finiteClamped(
        overrides?.maximumAttempts,
        defaults.maximumAttempts,
        RETRY_LIMITS.attemptsMin,
        RETRY_LIMITS.attemptsMax,
      ),
    ),
    jitterRatio: finiteClamped(overrides?.jitterRatio, defaults.jitterRatio, 0, 1),
    stabilityWindowMs: Math.round(
      finiteClamped(
        overrides?.stabilityWindowMs,
        defaults.stabilityWindowMs,
        RETRY_LIMITS.stabilityMinMs,
        RETRY_LIMITS.stabilityMaxMs,
      ),
    ),
  };
}

export function boundedRetryDelay(
  attempt: number,
  policy: GenerationBoundRetryPolicy,
  random: () => number,
): number {
  const exponential = Math.min(
    policy.maximumDelayMs,
    policy.initialDelayMs * 2 ** Math.max(0, attempt),
  );
  if (policy.jitterRatio === 0) return exponential;
  let rawSample = 0.5;
  try {
    rawSample = random();
  } catch {
    // A test- or host-provided entropy source cannot break retry accounting.
  }
  const sample = Number.isFinite(rawSample) ? Math.max(0, Math.min(1, rawSample)) : 0.5;
  const jitter = 1 - policy.jitterRatio + sample * policy.jitterRatio * 2;
  return Math.min(policy.maximumDelayMs, Math.max(0, Math.round(exponential * jitter)));
}

export function createGenerationBoundStore<TTarget, TResource, TFailure, TState>(
  adapter: GenerationBoundAdapter<TTarget, TResource, TFailure, TState>,
  initialTarget: unknown,
  options: GenerationBoundStoreOptions = {},
): GenerationBoundStore<TState> {
  const clock = options.clock ?? defaultGenerationBoundClock;
  const random = options.random ?? Math.random;
  const retry = normalizedGenerationBoundRetry(options.retry);
  const reassert = adapter.reassert ?? "ignore";
  const listeners = new Set<(state: TState) => void>();
  const metrics = {
    fetchesStarted: 0,
    fetchesSettled: 0,
    fetchesAborted: 0,
    lateResultsIgnored: 0,
    invalidationsObserved: 0,
    subscriptionsOpened: 0,
    subscriptionsClosed: 0,
    publications: 0,
  };

  let disposed = false;
  let generation = 0;
  let target: TTarget | null = null;
  let targetKey = "";
  /** False once a fatal failure poisons this generation. */
  let targetIsValid = false;
  let snapshot: GenerationBoundSnapshot<TResource> | null = null;
  let phase: GenerationBoundPhase<TFailure> = { kind: "loading" };
  let transport: DesktopDaemonTransportState | null = null;
  let state: TState;

  let requestId = 0;
  let requestController: AbortController | null = null;
  let requestRetryTimer: unknown | null = null;
  let requestRetryAttempts = 0;

  let subscriptionId = 0;
  let pendingSubscriptionId: number | null = null;
  let closeSubscription: (() => void) | null = null;
  let eventRetryTimer: unknown | null = null;
  let eventRetryAttempts = 0;
  let eventRetryRequested = false;
  let eventLive = false;
  let stabilityTimer: unknown | null = null;
  /** A verified reconnect must refetch so a missed invalidation cannot hide. */
  let resyncNeeded = false;

  const view = (): GenerationBoundView<TTarget, TResource, TFailure> => ({
    generation,
    target,
    snapshot,
    transport,
    phase,
    disposed,
  });

  const notify = (listener: (next: TState) => void, next: TState): void => {
    try {
      listener(next);
    } catch {
      // Store observers are untrusted application code. One observer must not
      // interrupt state retirement, another observer, or host cleanup.
    }
  };

  const publish = (): void => {
    metrics.publications += 1;
    state = adapter.project(view());
    const next = state;
    for (const listener of [...listeners]) {
      if (disposed) break;
      notify(listener, next);
    }
  };

  const emitPhase = (next: GenerationBoundPhase<TFailure>): void => {
    if (disposed) return;
    phase = next;
    publish();
  };

  const current = (expectedGeneration: number, expectedKey: string): boolean =>
    !disposed && generation === expectedGeneration && targetKey === expectedKey && target !== null;

  const clearTimer = (handle: unknown | null): void => {
    if (handle === null) return;
    try {
      clock.clearTimeout(handle);
    } catch {
      // A host clock must not prevent retirement or disposal.
    }
  };

  const clearRequestRetry = (): void => {
    clearTimer(requestRetryTimer);
    requestRetryTimer = null;
  };

  const clearEventRetry = (): void => {
    clearTimer(eventRetryTimer);
    eventRetryTimer = null;
  };

  const clearStability = (): void => {
    clearTimer(stabilityTimer);
    stabilityTimer = null;
  };

  const retireRequest = (): void => {
    requestId += 1;
    const controller = requestController;
    requestController = null;
    if (controller && !controller.signal.aborted) metrics.fetchesAborted += 1;
    try {
      controller?.abort();
    } catch {
      // Abort is best-effort; request ordering already retired the result.
    }
  };

  const retireSubscription = (forgetPending = false): void => {
    const hadSubscription = pendingSubscriptionId !== null || closeSubscription !== null;
    subscriptionId += 1;
    if (forgetPending) pendingSubscriptionId = null;
    eventLive = false;
    transport = null;
    clearStability();
    const close = closeSubscription;
    closeSubscription = null;
    if (hadSubscription) metrics.subscriptionsClosed += 1;
    try {
      close?.();
    } catch {
      // Host teardown is best-effort; the logical generation is already retired.
    }
  };

  /** A failure that keeps a good snapshot publishes as stale, not as a blank. */
  const failWith = (
    failure: TFailure,
    source: GenerationBoundFailureSource,
    exhausted: boolean,
    fatal: boolean,
  ): void => {
    emitPhase({ kind: "failed", source, failure, exhausted, fatal });
  };

  const scheduleRequestRetry = (expectedGeneration: number, expectedKey: string): void => {
    if (
      requestRetryTimer !== null ||
      requestRetryAttempts >= retry.maximumAttempts ||
      !targetIsValid ||
      !current(expectedGeneration, expectedKey)
    ) {
      return;
    }
    const delay = boundedRetryDelay(requestRetryAttempts, retry, random);
    requestRetryAttempts += 1;
    requestRetryTimer = clock.setTimeout(() => {
      requestRetryTimer = null;
      fetchResource(expectedGeneration, expectedKey);
    }, delay);
  };

  const scheduleEventRetry = (expectedGeneration: number, expectedKey: string): void => {
    if (
      eventRetryTimer !== null ||
      closeSubscription !== null ||
      !targetIsValid ||
      // The supervisor is the ONE retry owner once it pushes a transport state.
      transport !== null ||
      !current(expectedGeneration, expectedKey)
    ) {
      return;
    }
    if (pendingSubscriptionId !== null) {
      eventRetryRequested = true;
      return;
    }
    if (eventRetryAttempts >= retry.maximumAttempts) {
      eventLive = false;
      failWith(adapter.eventExhaustedFailure(), "event", true, false);
      return;
    }
    const delay = boundedRetryDelay(eventRetryAttempts, retry, random);
    eventRetryAttempts += 1;
    eventRetryRequested = false;
    eventRetryTimer = clock.setTimeout(() => {
      eventRetryTimer = null;
      connectEvents(expectedGeneration, expectedKey);
    }, delay);
  };

  const handleEventFailure = (
    failure: TFailure,
    expectedGeneration: number,
    expectedKey: string,
    exhausted = false,
  ): void => {
    if (!current(expectedGeneration, expectedKey)) return;
    eventLive = false;
    // A read in flight across a lost stream can land after the recovery
    // refetch and publish data older than it; retire it with the stream.
    retireRequest();
    const disposition = adapter.disposition(failure, "event");
    if (disposition === "fatal") {
      clearRequestRetry();
      clearEventRetry();
      eventRetryRequested = false;
      retireRequest();
      retireSubscription();
      failWith(failure, "event", false, true);
      return;
    }
    if (transport !== null) {
      // Supervisor-owned transport: derive the status, keep the logical
      // subscription, and let the ONE retry owner recover the socket.
      resyncNeeded = true;
      failWith(failure, "event", exhausted, false);
      return;
    }
    if (disposition === "degrade") {
      retireSubscription();
      failWith(failure, "event", exhausted, false);
      return;
    }
    resyncNeeded = true;
    retireSubscription();
    failWith(failure, "event", exhausted, false);
    scheduleEventRetry(expectedGeneration, expectedKey);
  };

  function fetchResource(expectedGeneration: number, expectedKey: string): void {
    if (!current(expectedGeneration, expectedKey) || !targetIsValid || target === null) return;
    const requestTarget = target;
    retireRequest();
    const activeRequestId = requestId;
    const controller = new AbortController();
    let accepted = false;
    requestController = controller;
    metrics.fetchesStarted += 1;
    void adapter
      .fetch(requestTarget, controller.signal)
      .then((result) => {
        if (
          controller.signal.aborted ||
          activeRequestId !== requestId ||
          !targetIsValid ||
          !current(expectedGeneration, expectedKey)
        ) {
          return;
        }
        accepted = true;
        requestController = null;
        if (result.status === "ok") {
          clearRequestRetry();
          requestRetryAttempts = 0;
          snapshot = { resource: result.resource, updatedAt: clock.now() };
          emitPhase(
            eventLive
              ? { kind: "live" }
              : { kind: "stale", reason: "The daemon event stream is not connected." },
          );
          return;
        }
        const disposition = adapter.disposition(result.failure, "request");
        if (disposition === "fatal") {
          clearRequestRetry();
          clearEventRetry();
          eventRetryRequested = false;
          retireSubscription();
          failWith(result.failure, "request", false, true);
          return;
        }
        const shouldRetry = disposition === "retry";
        const exhausted = shouldRetry && requestRetryAttempts >= retry.maximumAttempts;
        failWith(result.failure, "request", exhausted, false);
        if (shouldRetry && !exhausted) scheduleRequestRetry(expectedGeneration, expectedKey);
      })
      .catch(() => {
        if (
          controller.signal.aborted ||
          activeRequestId !== requestId ||
          !targetIsValid ||
          !current(expectedGeneration, expectedKey)
        ) {
          return;
        }
        accepted = true;
        requestController = null;
        const failure = adapter.rejectionFailure("request");
        const exhausted = requestRetryAttempts >= retry.maximumAttempts;
        failWith(failure, "request", exhausted, false);
        if (!exhausted) scheduleRequestRetry(expectedGeneration, expectedKey);
      })
      .finally(() => {
        metrics.fetchesSettled += 1;
        if (!accepted) {
          metrics.lateResultsIgnored += 1;
        }
      });
  }

  function connectEvents(expectedGeneration: number, expectedKey: string): void {
    if (
      !current(expectedGeneration, expectedKey) ||
      !targetIsValid ||
      target === null ||
      pendingSubscriptionId !== null ||
      closeSubscription !== null ||
      eventLive
    ) {
      return;
    }
    eventRetryRequested = false;
    const connectTarget = target;
    const activeSubscriptionId = ++subscriptionId;
    pendingSubscriptionId = activeSubscriptionId;
    metrics.subscriptionsOpened += 1;
    const live = (): void => {
      if (
        activeSubscriptionId !== subscriptionId ||
        !current(expectedGeneration, expectedKey) ||
        !targetIsValid
      ) {
        return;
      }
      eventLive = true;
      clearEventRetry();
      clearStability();
      if (retry.stabilityWindowMs > 0 && eventRetryAttempts > 0) {
        stabilityTimer = clock.setTimeout(() => {
          stabilityTimer = null;
          if (
            activeSubscriptionId === subscriptionId &&
            eventLive &&
            current(expectedGeneration, expectedKey)
          ) {
            eventRetryAttempts = 0;
          }
        }, retry.stabilityWindowMs);
      } else {
        eventRetryAttempts = 0;
      }
      eventRetryRequested = false;
      // A retained snapshot becomes live the moment the stream verifies; the
      // resync then refreshes it, so recovery is never gated on a round trip.
      if (snapshot !== null) emitPhase({ kind: "live" });
      if (resyncNeeded) {
        resyncNeeded = false;
        fetchResource(expectedGeneration, expectedKey);
      }
    };
    const handlers: GenerationBoundEventHandlers<TFailure> = {
      invalidate: () => {
        if (
          activeSubscriptionId !== subscriptionId ||
          !current(expectedGeneration, expectedKey) ||
          !targetIsValid
        ) {
          return;
        }
        metrics.invalidationsObserved += 1;
        fetchResource(expectedGeneration, expectedKey);
      },
      live,
      transportChanged: (nextTransport) => {
        if (activeSubscriptionId !== subscriptionId || !current(expectedGeneration, expectedKey)) {
          return;
        }
        const previous = transport;
        transport = nextTransport;
        if (nextTransport.phase === "connected") {
          // A verified recovery refetches before the retained snapshot is
          // trusted as live, so a missed invalidation cannot hide in the gap.
          // The refetch runs when the stream verifies (`live`), which is the
          // one signal that says the subscription is carrying invalidations
          // again; recording the need here keeps the two pushes from racing
          // into two fetches for one recovery.
          if (
            previous !== null &&
            (previous.phase === "reconnecting" ||
              previous.phase === "stopped" ||
              previous.phase === "degraded")
          ) {
            resyncNeeded = true;
            if (eventLive) {
              resyncNeeded = false;
              fetchResource(expectedGeneration, expectedKey);
            }
          }
          return;
        }
        if (nextTransport.phase === "reconnecting" || nextTransport.phase === "stopped") {
          eventLive = false;
          resyncNeeded = true;
          retireRequest();
          handleEventFailure(
            adapter.transportFailure(nextTransport),
            expectedGeneration,
            expectedKey,
            nextTransport.phase === "stopped",
          );
        }
        // `degraded` is transient and immediately followed by a reconnecting or
        // stopped push; publishing it would flap the surface for nothing.
      },
      failed: (failure) => {
        if (activeSubscriptionId !== subscriptionId || !current(expectedGeneration, expectedKey)) {
          return;
        }
        handleEventFailure(failure, expectedGeneration, expectedKey);
      },
    };

    const settle = (result: GenerationBoundConnectResult<TFailure>): void => {
      const wasPending = pendingSubscriptionId === activeSubscriptionId;
      if (wasPending) pendingSubscriptionId = null;
      if (activeSubscriptionId !== subscriptionId || !current(expectedGeneration, expectedKey)) {
        if (result.status === "connected") {
          try {
            result.close();
          } catch {
            // This logical subscription was already retired.
          }
        }
        if (wasPending && eventRetryRequested) {
          scheduleEventRetry(expectedGeneration, expectedKey);
        }
        return;
      }
      if (result.status === "connected") {
        closeSubscription = result.close;
        return;
      }
      metrics.subscriptionsClosed += 1;
      handleEventFailure(result.failure, expectedGeneration, expectedKey);
    };

    let operation:
      | GenerationBoundConnectResult<TFailure>
      | PromiseLike<GenerationBoundConnectResult<TFailure>>;
    try {
      operation = adapter.connect(connectTarget, handlers);
    } catch {
      if (pendingSubscriptionId === activeSubscriptionId) pendingSubscriptionId = null;
      handleEventFailure(adapter.rejectionFailure("event"), expectedGeneration, expectedKey);
      return;
    }
    if (typeof (operation as PromiseLike<unknown>)?.then !== "function") {
      // A synchronous transport is settled before any callback can fire.
      settle(operation as GenerationBoundConnectResult<TFailure>);
      return;
    }
    void Promise.resolve(operation)
      .then(settle)
      .catch(() => {
        const wasPending = pendingSubscriptionId === activeSubscriptionId;
        if (wasPending) pendingSubscriptionId = null;
        if (activeSubscriptionId !== subscriptionId || !current(expectedGeneration, expectedKey)) {
          if (wasPending && eventRetryRequested) {
            scheduleEventRetry(expectedGeneration, expectedKey);
          }
          return;
        }
        handleEventFailure(adapter.rejectionFailure("event"), expectedGeneration, expectedKey);
      });
  }

  const refreshCurrent = (): void => {
    if (disposed || !targetIsValid || target === null) return;
    clearRequestRetry();
    requestRetryAttempts = 0;
    fetchResource(generation, targetKey);
    if (eventLive) return;
    // Deference: with a supervisor-owned transport the socket has ONE retry
    // owner, so a refresh reads the resource and leaves the stream alone.
    if (transport !== null) return;
    clearEventRetry();
    eventRetryAttempts = 0;
    eventRetryRequested = true;
    retireSubscription();
    if (pendingSubscriptionId === null) connectEvents(generation, targetKey);
  };

  const startTarget = (untrusted: unknown): void => {
    const validation = adapter.validateTarget(untrusted);
    if (validation.ok && target !== null && targetIsValid && validation.key === targetKey) {
      if (reassert === "refresh") refreshCurrent();
      return;
    }
    clearRequestRetry();
    clearEventRetry();
    clearStability();
    retireRequest();
    retireSubscription(true);
    generation += 1;
    requestRetryAttempts = 0;
    eventRetryAttempts = 0;
    eventRetryRequested = false;
    resyncNeeded = false;
    snapshot = null;
    if (!validation.ok) {
      target = null;
      targetKey = `invalid:${generation}`;
      targetIsValid = false;
      failWith(validation.failure, "target", false, true);
      return;
    }
    target = validation.target;
    targetKey = validation.key;
    targetIsValid = true;
    emitPhase({ kind: "loading" });
    const expectedGeneration = generation;
    const expectedKey = targetKey;
    fetchResource(expectedGeneration, expectedKey);
    connectEvents(expectedGeneration, expectedKey);
  };

  const store: GenerationBoundStore<TState> = {
    getState: () => state,
    subscribe(listener) {
      if (disposed) {
        notify(listener, state);
        return () => undefined;
      }
      listeners.add(listener);
      notify(listener, state);
      return () => listeners.delete(listener);
    },
    setTarget(next) {
      if (disposed) return;
      startTarget(next);
    },
    refresh() {
      refreshCurrent();
    },
    getMetrics: () => ({
      idleWakeups: 0,
      activeInterests: targetIsValid && !disposed ? 1 : 0,
      invalidationsCoalesced: 0,
      ...metrics,
    }),
    republish() {
      if (disposed) return;
      publish();
    },
    dispose() {
      if (disposed) return;
      const retired = [...listeners];
      clearRequestRetry();
      clearEventRetry();
      clearStability();
      retireRequest();
      eventRetryRequested = false;
      retireSubscription(true);
      generation += 1;
      target = null;
      targetKey = `disposed:${generation}`;
      targetIsValid = false;
      snapshot = null;
      disposed = true;
      state = adapter.project(view());
      listeners.clear();
      for (const listener of retired) notify(listener, state);
    },
  };

  state = adapter.project(view());
  startTarget(initialTarget);
  return store;
}
