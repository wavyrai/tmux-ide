import {
  boundedRetryDelay,
  defaultGenerationBoundClock,
  normalizedGenerationBoundRetry,
  type GenerationBoundClock,
  type GenerationBoundRetryPolicy,
} from "./generation-bound-store.ts";

/**
 * A renderer-neutral, generation-pinned set of push-invalidated resources.
 *
 * The session is deliberately transport agnostic. A host adapter supplies one
 * initial read per active interest and one invalidation subscription for the
 * target. Synchronous invalidation bursts are collapsed onto one microtask;
 * an invalidation that arrives during a read becomes exactly one trailing
 * read. There is no idle poll or maintenance timer.
 */

export interface PushResourceSnapshot<TResource> {
  readonly resource: TResource;
  readonly updatedAt: number;
}

export type PushResourceSlot<TResource, TFailure> =
  | { readonly status: "loading" }
  | {
      readonly status: "loaded";
      readonly resource: TResource;
      readonly updatedAt: number;
      readonly refreshing: boolean;
    }
  | {
      readonly status: "error";
      readonly failure: TFailure;
      readonly stale: PushResourceSnapshot<TResource> | null;
    };

export interface PushResourceSessionState<TTarget, TKey extends string, TResource, TFailure> {
  readonly generation: number;
  readonly target: TTarget | null;
  readonly slots: ReadonlyMap<TKey, PushResourceSlot<TResource, TFailure>>;
  readonly targetFailure: TFailure | null;
  readonly eventPhase: "idle" | "connecting" | "live" | "degraded";
  readonly disposed: boolean;
}

export interface PushResourceSessionMetrics {
  /** Structurally zero: this event-driven store owns no maintenance/idle timer. */
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

export type PushResourceTargetValidation<TTarget, TFailure> =
  | { readonly ok: true; readonly target: TTarget; readonly key: string }
  | { readonly ok: false; readonly failure: TFailure };

export type PushResourceFetchResult<TResource, TFailure> =
  | { readonly status: "ok"; readonly resource: TResource }
  | { readonly status: "failed"; readonly failure: TFailure };

export interface PushResourceEventHandlers<TKey extends string> {
  /** Omit keys to invalidate every active interest. */
  invalidate(keys?: readonly TKey[]): void;
  /** The installed event source retired and reads must temporarily carry freshness. */
  unavailable(): void;
}

export type PushResourceConnectResult =
  | {
      readonly status: "connected";
      readonly close: () => void;
      /**
       * Update logical interests without replacing the host's shared physical
       * connection. When absent, the session replaces only this logical
       * subscription and then resynchronizes the surviving interests.
       */
      readonly updateInterests?: (keys: ReadonlySet<string>) => void | PromiseLike<void>;
    }
  | { readonly status: "unavailable" };

export interface PushResourceSessionAdapter<TTarget, TKey extends string, TResource, TFailure> {
  validateTarget(value: unknown): PushResourceTargetValidation<TTarget, TFailure>;
  fetch(
    target: TTarget,
    key: TKey,
    signal: AbortSignal,
  ): Promise<PushResourceFetchResult<TResource, TFailure>>;
  connect(
    target: TTarget,
    /** Distinct daemon resource interests, not necessarily one per local slot. */
    interests: ReadonlySet<string>,
    handlers: PushResourceEventHandlers<TKey>,
    signal: AbortSignal,
  ): PushResourceConnectResult | PromiseLike<PushResourceConnectResult>;
  /** Translate an unexpected request rejection without leaking host errors. */
  rejectionFailure(): TFailure;
  /** Only transient failures receive the bounded retry ladder. */
  retryable(failure: TFailure): boolean;
  /** Many local keys (e.g. directories) may share one daemon watcher. */
  interestKey?(key: TKey): string;
}

export interface PushResourceSessionOptions {
  readonly clock?: GenerationBoundClock;
  readonly random?: () => number;
  readonly retry?: Partial<GenerationBoundRetryPolicy>;
  /** Injectable solely for deterministic tests; this is never an idle timer. */
  readonly queueMicrotask?: (callback: () => void) => void;
}

export interface PushResourceSession<TTarget, TKey extends string, TResource, TFailure> {
  getState(): PushResourceSessionState<TTarget, TKey, TResource, TFailure>;
  getMetrics(): PushResourceSessionMetrics;
  subscribe(
    listener: (state: PushResourceSessionState<TTarget, TKey, TResource, TFailure>) => void,
  ): () => void;
  setTarget(target: unknown): void;
  /** Acquire an interest. The returned release is idempotent. */
  activate(key: TKey): () => void;
  /** Release one interest acquired for this key. */
  deactivate(key: TKey): void;
  refresh(key?: TKey): void;
  dispose(): void;
}

const DEFAULT_RETRY: GenerationBoundRetryPolicy = {
  initialDelayMs: 250,
  maximumDelayMs: 4_000,
  maximumAttempts: 3,
  jitterRatio: 0,
  stabilityWindowMs: 0,
};

interface RequestState {
  readonly generation: number;
  readonly controller: AbortController;
  /** One invalidation arrived after this request began. */
  dirty: boolean;
}

function retained<TResource, TFailure>(
  slot: PushResourceSlot<TResource, TFailure> | undefined,
): PushResourceSnapshot<TResource> | null {
  if (slot?.status === "loaded") {
    return { resource: slot.resource, updatedAt: slot.updatedAt };
  }
  return slot?.status === "error" ? slot.stale : null;
}

export function createPushResourceSession<TTarget, TKey extends string, TResource, TFailure>(
  adapter: PushResourceSessionAdapter<TTarget, TKey, TResource, TFailure>,
  initialTarget: unknown,
  options: PushResourceSessionOptions = {},
): PushResourceSession<TTarget, TKey, TResource, TFailure> {
  const clock = options.clock ?? defaultGenerationBoundClock;
  const random = options.random ?? Math.random;
  const retry = normalizedGenerationBoundRetry(options.retry, DEFAULT_RETRY);
  const enqueue = options.queueMicrotask ?? globalThis.queueMicrotask;
  const listeners = new Set<
    (state: PushResourceSessionState<TTarget, TKey, TResource, TFailure>) => void
  >();
  const slots = new Map<TKey, PushResourceSlot<TResource, TFailure>>();
  const interests = new Map<TKey, number>();
  const requests = new Map<TKey, RequestState>();
  const retryAttempts = new Map<TKey, number>();
  const retryTimers = new Map<TKey, unknown>();

  let disposed = false;
  let generation = 0;
  let target: TTarget | null = null;
  let targetKey = "";
  let targetFailure: TFailure | null = null;
  let subscriptionEpoch = 0;
  let pendingSubscriptionEpoch: number | null = null;
  let closeSubscription: (() => void) | null = null;
  let subscriptionController: AbortController | null = null;
  let installedInterestRevision = -1;
  let interestRevision = 0;
  let eventPhase: PushResourceSessionState<TTarget, TKey, TResource, TFailure>["eventPhase"] =
    "idle";
  let subscriptionRetryAttempt = 0;
  let subscriptionRetryTimer: unknown | null = null;
  let state: PushResourceSessionState<TTarget, TKey, TResource, TFailure>;
  const metric = {
    fetchesStarted: 0,
    fetchesSettled: 0,
    fetchesAborted: 0,
    lateResultsIgnored: 0,
    invalidationsObserved: 0,
    invalidationsCoalesced: 0,
    subscriptionsOpened: 0,
    subscriptionsClosed: 0,
    publications: 0,
  };

  const snapshotState = (): PushResourceSessionState<TTarget, TKey, TResource, TFailure> => ({
    generation,
    target,
    slots: new Map(slots),
    targetFailure,
    eventPhase,
    disposed,
  });

  const notify = (
    listener: (next: PushResourceSessionState<TTarget, TKey, TResource, TFailure>) => void,
    next: PushResourceSessionState<TTarget, TKey, TResource, TFailure>,
  ): void => {
    try {
      listener(next);
    } catch {
      // A renderer observer cannot interrupt authority retirement or peers.
    }
  };

  const publish = (): void => {
    metric.publications += 1;
    state = snapshotState();
    for (const listener of [...listeners]) notify(listener, state);
  };

  const isActive = (key: TKey): boolean => (interests.get(key) ?? 0) > 0;
  const eventInterests = (): Set<string> =>
    new Set([...interests.keys()].map((key) => adapter.interestKey?.(key) ?? key));
  const interestSignature = (values: ReadonlySet<string>): string =>
    [...values].sort().join("\u0000");

  const clearRetry = (key: TKey): void => {
    const handle = retryTimers.get(key);
    if (handle === undefined) return;
    retryTimers.delete(key);
    try {
      clock.clearTimeout(handle);
    } catch {
      // Logical retirement does not depend on a host clock cooperating.
    }
  };

  const abortRequest = (key: TKey): void => {
    const request = requests.get(key);
    if (!request) return;
    requests.delete(key);
    metric.fetchesAborted += 1;
    try {
      request.controller.abort();
    } catch {
      // Generation and request identity still fence the late result.
    }
  };

  let updateSubscriptionInterests:
    | ((keys: ReadonlySet<string>) => void | PromiseLike<void>)
    | null = null;
  let installedInterestSignature = "";
  let interestConvergenceRunning = false;

  const closeEvents = (resetRetry = true): void => {
    subscriptionEpoch += 1;
    pendingSubscriptionEpoch = null;
    const close = closeSubscription;
    closeSubscription = null;
    const controller = subscriptionController;
    subscriptionController = null;
    try {
      controller?.abort();
    } catch {
      // Epoch fencing still retires a host that ignores abort.
    }
    updateSubscriptionInterests = null;
    installedInterestRevision = -1;
    installedInterestSignature = "";
    if (subscriptionRetryTimer !== null) {
      try {
        clock.clearTimeout(subscriptionRetryTimer);
      } catch {
        // Retirement is still fenced by generation and interest revision.
      }
      subscriptionRetryTimer = null;
    }
    if (resetRetry) subscriptionRetryAttempt = 0;
    eventPhase = "idle";
    if (!close) return;
    metric.subscriptionsClosed += 1;
    try {
      close();
    } catch {
      // Logical subscription retirement is already complete.
    }
  };

  const current = (expectedGeneration: number): boolean =>
    !disposed && expectedGeneration === generation && target !== null;

  function request(key: TKey, expectedGeneration: number): void {
    if (!current(expectedGeneration) || !isActive(key) || target === null) return;
    const inflight = requests.get(key);
    if (inflight) {
      inflight.dirty = true;
      return;
    }
    clearRetry(key);
    const requestTarget = target;
    const previousSlot = slots.get(key);
    const previous = retained(previousSlot);
    const controller = new AbortController();
    const active: RequestState = { generation: expectedGeneration, controller, dirty: false };
    requests.set(key, active);
    metric.fetchesStarted += 1;
    slots.set(
      key,
      previous
        ? {
            status: "loaded",
            resource: previous.resource,
            updatedAt: previous.updatedAt,
            refreshing: true,
          }
        : previousSlot?.status === "error"
          ? previousSlot
          : { status: "loading" },
    );
    publish();

    const settle = (result: PushResourceFetchResult<TResource, TFailure>): void => {
      if (
        controller.signal.aborted ||
        requests.get(key) !== active ||
        !current(expectedGeneration) ||
        !isActive(key)
      ) {
        metric.lateResultsIgnored += 1;
        return;
      }
      requests.delete(key);
      metric.fetchesSettled += 1;
      if (result.status === "ok") {
        retryAttempts.delete(key);
        slots.set(key, {
          status: "loaded",
          resource: result.resource,
          updatedAt: clock.now(),
          refreshing: false,
        });
      } else {
        slots.set(key, { status: "error", failure: result.failure, stale: previous });
      }
      publish();

      if (active.dirty) {
        request(key, expectedGeneration);
        return;
      }
      if (result.status === "ok" || !adapter.retryable(result.failure)) return;
      const attempt = retryAttempts.get(key) ?? 0;
      if (attempt >= retry.maximumAttempts || retryTimers.has(key)) return;
      retryAttempts.set(key, attempt + 1);
      retryTimers.set(
        key,
        clock.setTimeout(
          () => {
            retryTimers.delete(key);
            request(key, expectedGeneration);
          },
          boundedRetryDelay(attempt, retry, random),
        ),
      );
    };

    void adapter
      .fetch(requestTarget, key, controller.signal)
      .then(settle)
      .catch(() => settle({ status: "failed", failure: adapter.rejectionFailure() }));
  }

  const flushInvalidations = (expectedGeneration: number, keys: ReadonlySet<TKey>): void => {
    if (!current(expectedGeneration) || installedInterestRevision !== interestRevision) return;
    for (const key of keys) request(key, expectedGeneration);
  };

  let queuedInvalidation: {
    readonly generation: number;
    readonly keys: Set<TKey>;
    queued: boolean;
  } | null = null;

  const invalidate = (keys: readonly TKey[] | undefined, expectedGeneration: number): void => {
    if (!current(expectedGeneration)) return;
    metric.invalidationsObserved += 1;
    const selected = keys ?? [...interests.keys()];
    let batch = queuedInvalidation;
    let created = false;
    if (batch === null || batch.generation !== expectedGeneration || !batch.queued) {
      batch = { generation: expectedGeneration, keys: new Set<TKey>(), queued: true };
      queuedInvalidation = batch;
      created = true;
    }
    for (const key of selected) {
      if (isActive(key)) batch.keys.add(key);
    }
    if (batch.keys.size === 0) return;
    if (!created) {
      metric.invalidationsCoalesced += 1;
      return;
    }
    // `queued` belongs to this generation's batch. A stale microtask never
    // clears or mutates a newer generation's pending invalidation.
    enqueue(() => {
      batch!.queued = false;
      if (queuedInvalidation === batch) queuedInvalidation = null;
      flushInvalidations(expectedGeneration, batch!.keys);
    });
  };

  const synchronizeAfterInterestInstall = (
    expectedGeneration: number,
    expectedInterestRevision: number,
  ): void => {
    if (!current(expectedGeneration) || expectedInterestRevision !== interestRevision) return;
    for (const key of interests.keys()) request(key, expectedGeneration);
  };

  const connectEvents = (expectedGeneration: number, expectedInterestRevision: number): void => {
    if (
      !current(expectedGeneration) ||
      interests.size === 0 ||
      closeSubscription !== null ||
      pendingSubscriptionEpoch !== null ||
      target === null
    ) {
      return;
    }
    const connectTarget = target;
    const connectKeys = eventInterests();
    const epoch = ++subscriptionEpoch;
    const controller = new AbortController();
    subscriptionController = controller;
    pendingSubscriptionEpoch = epoch;
    eventPhase = "connecting";
    publish();
    const settle = (result: PushResourceConnectResult): void => {
      if (pendingSubscriptionEpoch === epoch) pendingSubscriptionEpoch = null;
      if (
        !current(expectedGeneration) ||
        epoch !== subscriptionEpoch ||
        expectedInterestRevision !== interestRevision ||
        interests.size === 0
      ) {
        if (subscriptionController === controller) subscriptionController = null;
        if (result.status === "connected") {
          try {
            result.close();
          } catch {
            // Superseded before installation.
          }
        }
        return;
      }
      if (result.status === "connected") {
        closeSubscription = result.close;
        updateSubscriptionInterests = result.updateInterests ?? null;
        metric.subscriptionsOpened += 1;
        subscriptionRetryAttempt = 0;
        subscriptionRetryTimer = null;
        eventPhase = "live";
        installedInterestSignature = interestSignature(connectKeys);
      } else if (subscriptionController === controller) {
        subscriptionController = null;
        eventPhase = "degraded";
      }
      if (result.status === "connected") installedInterestRevision = expectedInterestRevision;
      // The read starts only after the logical subscription is installed. A
      // mutation in the connect window is therefore replayed or followed by
      // this read, rather than falling between snapshot and subscription.
      synchronizeAfterInterestInstall(expectedGeneration, expectedInterestRevision);
      publish();
      if (result.status === "unavailable" && subscriptionRetryAttempt < retry.maximumAttempts) {
        const attempt = subscriptionRetryAttempt++;
        subscriptionRetryTimer = clock.setTimeout(
          () => {
            subscriptionRetryTimer = null;
            connectEvents(expectedGeneration, expectedInterestRevision);
          },
          boundedRetryDelay(attempt, retry, random),
        );
      }
    };
    let operation: PushResourceConnectResult | PromiseLike<PushResourceConnectResult>;
    try {
      operation = adapter.connect(
        connectTarget,
        connectKeys,
        {
          invalidate: (keys) => invalidate(keys, expectedGeneration),
          unavailable: () => {
            if (
              !current(expectedGeneration) ||
              epoch !== subscriptionEpoch ||
              expectedInterestRevision !== interestRevision ||
              closeSubscription === null
            ) {
              return;
            }
            closeEvents(false);
            eventPhase = "degraded";
            synchronizeAfterInterestInstall(expectedGeneration, expectedInterestRevision);
            publish();
            if (subscriptionRetryAttempt >= retry.maximumAttempts) return;
            const attempt = subscriptionRetryAttempt++;
            subscriptionRetryTimer = clock.setTimeout(
              () => {
                subscriptionRetryTimer = null;
                connectEvents(expectedGeneration, expectedInterestRevision);
              },
              boundedRetryDelay(attempt, retry, random),
            );
          },
        },
        controller.signal,
      );
    } catch {
      settle({ status: "unavailable" });
      return;
    }
    if (typeof (operation as PromiseLike<unknown>)?.then !== "function") {
      settle(operation as PushResourceConnectResult);
      return;
    }
    void Promise.resolve(operation)
      .then(settle)
      .catch(() => {
        settle({ status: "unavailable" });
      });
  };

  /**
   * Serialize physical interest mutations. Each pass owns an immutable target
   * snapshot; mutations arriving during its ACK are observed only by the next
   * pass. Reads and invalidations are admitted after the physically installed
   * signature exactly matches the latest desired signature.
   */
  const convergeInstalledInterests = (expectedGeneration: number): void => {
    if (interestConvergenceRunning) return;
    interestConvergenceRunning = true;
    void (async () => {
      try {
        while (
          current(expectedGeneration) &&
          closeSubscription !== null &&
          updateSubscriptionInterests !== null
        ) {
          const updater = updateSubscriptionInterests;
          const subscription = closeSubscription;
          const targetSnapshot = new Set(eventInterests());
          const targetSignature = interestSignature(targetSnapshot);
          if (targetSignature === installedInterestSignature) {
            installedInterestRevision = interestRevision;
            synchronizeAfterInterestInstall(expectedGeneration, interestRevision);
            return;
          }
          installedInterestRevision = -1;
          try {
            await updater(targetSnapshot);
          } catch {
            if (
              current(expectedGeneration) &&
              updater === updateSubscriptionInterests &&
              subscription === closeSubscription
            ) {
              closeEvents();
              connectEvents(expectedGeneration, interestRevision);
            }
            return;
          }
          if (
            !current(expectedGeneration) ||
            updater !== updateSubscriptionInterests ||
            subscription !== closeSubscription
          )
            return;
          installedInterestSignature = targetSignature;
          if (targetSignature === interestSignature(eventInterests())) {
            installedInterestRevision = interestRevision;
            synchronizeAfterInterestInstall(expectedGeneration, interestRevision);
            return;
          }
        }
      } finally {
        interestConvergenceRunning = false;
        if (
          !disposed &&
          target !== null &&
          closeSubscription !== null &&
          updateSubscriptionInterests !== null &&
          installedInterestSignature !== interestSignature(eventInterests())
        ) {
          convergeInstalledInterests(generation);
        }
      }
    })();
  };

  const reconcileInterests = (expectedGeneration: number): void => {
    if (!current(expectedGeneration)) return;
    interestRevision += 1;
    const revision = interestRevision;
    if (interests.size === 0) {
      closeEvents();
      publish();
      return;
    }
    if (closeSubscription !== null && updateSubscriptionInterests !== null) {
      convergeInstalledInterests(expectedGeneration);
      return;
    }
    closeEvents();
    connectEvents(expectedGeneration, revision);
  };

  const retireGeneration = (): void => {
    queuedInvalidation = null;
    interestRevision += 1;
    for (const key of [...requests.keys()]) abortRequest(key);
    for (const key of [...retryTimers.keys()]) clearRetry(key);
    retryAttempts.clear();
    slots.clear();
    closeEvents();
  };

  const startTarget = (untrusted: unknown): void => {
    const validation = adapter.validateTarget(untrusted);
    if (validation.ok && target !== null && validation.key === targetKey) return;
    generation += 1;
    retireGeneration();
    if (!validation.ok) {
      target = null;
      targetKey = `invalid:${generation}`;
      targetFailure = validation.failure;
      publish();
      return;
    }
    target = validation.target;
    targetKey = validation.key;
    targetFailure = null;
    publish();
    if (interests.size === 0) return;
    reconcileInterests(generation);
  };

  const deactivateOne = (key: TKey): void => {
    const count = interests.get(key) ?? 0;
    if (count <= 0) return;
    if (count > 1) {
      interests.set(key, count - 1);
      return;
    }
    const before = interestSignature(eventInterests());
    interests.delete(key);
    clearRetry(key);
    retryAttempts.delete(key);
    abortRequest(key);
    if (slots.delete(key)) publish();
    if (before !== interestSignature(eventInterests())) reconcileInterests(generation);
  };

  const session: PushResourceSession<TTarget, TKey, TResource, TFailure> = {
    getState: () => state,
    getMetrics: () => ({ idleWakeups: 0, activeInterests: interests.size, ...metric }),
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
      if (!disposed) startTarget(next);
    },
    activate(key) {
      if (disposed || typeof key !== "string" || key.length === 0) return () => undefined;
      const count = interests.get(key) ?? 0;
      const before = interestSignature(eventInterests());
      interests.set(key, count + 1);
      if (count === 0 && target !== null) {
        if (!slots.has(key)) {
          slots.set(key, { status: "loading" });
          publish();
        }
        if (before === interestSignature(eventInterests())) {
          // A sibling key can share the subscription that is already installed
          // or pending. The install settlement reads every active key.
          if (installedInterestRevision >= 0 || eventPhase === "degraded") {
            request(key, generation);
          }
        } else {
          reconcileInterests(generation);
        }
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        deactivateOne(key);
      };
    },
    deactivate: deactivateOne,
    refresh(key) {
      if (disposed || target === null) return;
      if (key !== undefined) {
        clearRetry(key);
        retryAttempts.delete(key);
        request(key, generation);
        return;
      }
      for (const activeKey of interests.keys()) {
        clearRetry(activeKey);
        retryAttempts.delete(activeKey);
        request(activeKey, generation);
      }
    },
    dispose() {
      if (disposed) return;
      const retired = [...listeners];
      generation += 1;
      retireGeneration();
      interests.clear();
      target = null;
      targetKey = `disposed:${generation}`;
      targetFailure = null;
      disposed = true;
      state = snapshotState();
      listeners.clear();
      for (const listener of retired) notify(listener, state);
    },
  };

  state = snapshotState();
  startTarget(initialTarget);
  return session;
}
