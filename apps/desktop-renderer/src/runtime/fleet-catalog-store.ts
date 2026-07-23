import { createSignal, onCleanup, type Accessor } from "solid-js";
import {
  DesktopDaemonCapabilityStateSchemaZ,
  DesktopDaemonFetchFleetCatalogResultSchemaZ,
  isDaemonWireProtocolCompatible,
  type DaemonInstanceIdentity,
  type DesktopDaemonCapabilityError,
  type DesktopDaemonEvent,
  type FleetCatalogResourceV1,
  type HostCapabilities,
} from "@tmux-ide/contracts";

/**
 * Generation-bound renderer store for the read-only fleet catalog.
 *
 * It is the sibling of {@link ./workspace-catalog-store.ts}: pinned to a single
 * daemon generation, it fetches the whole adopted fleet through the reviewed
 * {@link HostCapabilities} facade, re-validates every response through the
 * contract schema at the boundary, and drops any response that resolves against
 * a superseded generation. It subscribes with an empty workspace set — the only
 * subscription that receives the workspace-agnostic `fleet.changed` invalidation
 * — and re-fetches on `fleet.changed` and on `workspaces.changed` (a promotion
 * added a workspace-backed session). `fleet.changed` reaches this store for BOTH
 * kinds of change: fleet COMPOSITION (the daemon's adopted-session poller) AND a
 * ground-truth agent-status transition — the latter arrives at the daemon as a
 * session-scoped `agent-status.changed` frame that the desktop broker folds into
 * a fleet-wide `fleet.changed` (see the daemon-resource-broker `#projectServerFrame`
 * fold; the daemon itself never emits `fleet.changed` on a status flip). So a
 * pane `@agent_state` flip refreshes this store's status glyphs without opening
 * the session and without a manual refetch. The daemon endpoint, owner
 * credential, and physical socket never reach here.
 */

export interface DesktopFleetCatalogSnapshot {
  readonly daemon: DaemonInstanceIdentity;
  readonly catalog: FleetCatalogResourceV1;
  readonly updatedAt: number;
}

interface DesktopFleetCatalogStateBase {
  readonly generation: number;
  readonly daemon: DaemonInstanceIdentity | null;
}

export type DesktopFleetCatalogState =
  | (DesktopFleetCatalogStateBase & { readonly status: "loading"; readonly snapshot: null })
  | (DesktopFleetCatalogStateBase & {
      readonly status: "live";
      readonly snapshot: DesktopFleetCatalogSnapshot;
    })
  | (DesktopFleetCatalogStateBase & {
      readonly status: "stale";
      readonly snapshot: DesktopFleetCatalogSnapshot;
      readonly reason: string;
    })
  | (DesktopFleetCatalogStateBase & {
      readonly status: "degraded";
      readonly snapshot: DesktopFleetCatalogSnapshot | null;
      readonly code:
        | "daemon-unavailable"
        | "daemon-degraded"
        | "daemon-identity-mismatch"
        | "invalid-response"
        | "event-unavailable";
      readonly reason: string;
    })
  | (DesktopFleetCatalogStateBase & {
      readonly status: "error";
      readonly snapshot: DesktopFleetCatalogSnapshot | null;
      readonly code: "request-failed" | "retry-exhausted";
      readonly reason: string;
    })
  | (DesktopFleetCatalogStateBase & {
      readonly status: "disposed";
      readonly daemon: null;
      readonly snapshot: null;
    });

export interface DesktopFleetCatalogClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface DesktopFleetCatalogRetryPolicy {
  readonly initialDelayMs: number;
  readonly maximumDelayMs: number;
  readonly maximumAttempts: number;
}

export interface DesktopFleetCatalogStoreOptions {
  readonly host: Pick<HostCapabilities, "daemon">;
  readonly daemon: unknown;
  readonly clock?: DesktopFleetCatalogClock;
  readonly retry?: Partial<DesktopFleetCatalogRetryPolicy>;
}

export type DesktopFleetCatalogStateListener = (state: DesktopFleetCatalogState) => void;

export interface DesktopFleetCatalogStore {
  getState(): DesktopFleetCatalogState;
  subscribe(listener: DesktopFleetCatalogStateListener): () => void;
  refresh(): void;
  setDaemon(daemon: unknown): void;
  dispose(): void;
}

export interface SolidDesktopFleetCatalogStore {
  readonly state: Accessor<DesktopFleetCatalogState>;
  refresh(): void;
  setDaemon(daemon: unknown): void;
  dispose(): void;
}

const DEFAULT_RETRY: DesktopFleetCatalogRetryPolicy = {
  initialDelayMs: 250,
  maximumDelayMs: 4_000,
  maximumAttempts: 4,
};

const defaultClock: DesktopFleetCatalogClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || !Number.isInteger(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, value));
}

function retryPolicy(
  overrides: Partial<DesktopFleetCatalogRetryPolicy> | undefined,
): DesktopFleetCatalogRetryPolicy {
  const initialDelayMs = boundedInteger(
    overrides?.initialDelayMs,
    DEFAULT_RETRY.initialDelayMs,
    10,
    60_000,
  );
  return {
    initialDelayMs,
    maximumDelayMs: Math.max(
      initialDelayMs,
      boundedInteger(overrides?.maximumDelayMs, DEFAULT_RETRY.maximumDelayMs, 10, 60_000),
    ),
    maximumAttempts: boundedInteger(
      overrides?.maximumAttempts,
      DEFAULT_RETRY.maximumAttempts,
      0,
      10,
    ),
  };
}

function sameDaemon(
  left: DaemonInstanceIdentity | null,
  right: DaemonInstanceIdentity | null,
): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.protocolVersion === right.protocolVersion &&
    left.productVersion === right.productVersion &&
    left.instanceId === right.instanceId &&
    left.startedAt === right.startedAt
  );
}

function daemonKey(daemon: DaemonInstanceIdentity): string {
  return [daemon.protocolVersion, daemon.productVersion, daemon.instanceId, daemon.startedAt].join(
    "\u0000",
  );
}

function safeReason(error: DesktopDaemonCapabilityError): string {
  return error.reason;
}

function connectedIdentity(
  value: unknown,
):
  | { readonly status: "connected"; readonly identity: DaemonInstanceIdentity }
  | { readonly status: "unavailable" | "degraded" | "invalid"; readonly reason: string } {
  const parsed = DesktopDaemonCapabilityStateSchemaZ.safeParse(value);
  if (!parsed.success) {
    return { status: "invalid", reason: "Desktop daemon capability state is invalid." };
  }
  if (parsed.data.status !== "connected") {
    return { status: parsed.data.status, reason: parsed.data.reason };
  }
  if (!isDaemonWireProtocolCompatible(parsed.data.identity.protocolVersion)) {
    return { status: "invalid", reason: "Desktop daemon protocol is incompatible." };
  }
  return { status: "connected", identity: parsed.data.identity };
}

function snapshotFromState(state: DesktopFleetCatalogState): DesktopFleetCatalogSnapshot | null {
  return "snapshot" in state ? state.snapshot : null;
}

/**
 * Parse a raw fetch result against the contract schema and verify the returned
 * catalog was stamped by the generation the store is pinned to.
 */
function parseFleetResult(
  value: unknown,
  expectedDaemon: DaemonInstanceIdentity,
):
  | { readonly status: "ok"; readonly catalog: FleetCatalogResourceV1 }
  | { readonly status: "error"; readonly error: DesktopDaemonCapabilityError }
  | { readonly status: "invalid-response" | "daemon-identity-mismatch" } {
  const parsed = DesktopDaemonFetchFleetCatalogResultSchemaZ.safeParse(value);
  if (!parsed.success) return { status: "invalid-response" };
  if (parsed.data.status === "error") return parsed.data;
  if (!sameDaemon(parsed.data.envelope.daemon, expectedDaemon)) {
    return { status: "daemon-identity-mismatch" };
  }
  return { status: "ok", catalog: parsed.data.envelope };
}

function requestShouldRetry(error: DesktopDaemonCapabilityError): boolean {
  return (
    error.code === "request-timeout" ||
    error.code === "request-failed" ||
    error.code === "event-unavailable"
  );
}

function terminalEventFailureCode(
  error: DesktopDaemonCapabilityError,
): "daemon-identity-mismatch" | "invalid-response" | null {
  if (error.code === "daemon-identity-mismatch") return "daemon-identity-mismatch";
  if (error.code === "invalid-response" || error.code === "protocol-error")
    return "invalid-response";
  return null;
}

export function createDesktopFleetCatalogStore(
  options: DesktopFleetCatalogStoreOptions,
): DesktopFleetCatalogStore {
  const host = options.host;
  const clock = options.clock ?? defaultClock;
  const retry = retryPolicy(options.retry);
  const listeners = new Set<DesktopFleetCatalogStateListener>();

  let disposed = false;
  let generation = 0;
  let daemon: DaemonInstanceIdentity | null = null;
  let daemonGeneration = "";
  let state: DesktopFleetCatalogState = {
    status: "loading",
    generation,
    daemon,
    snapshot: null,
  };
  let requestId = 0;
  let subscriptionId = 0;
  let unsubscribeHost: (() => void) | null = null;
  let pendingSubscriptionId: number | null = null;
  let eventRetryRequested = false;
  let requestRetryTimer: unknown | null = null;
  let requestRetryAttempts = 0;
  let eventRetryTimer: unknown | null = null;
  let eventRetryAttempts = 0;
  let eventLive = false;

  const notify = (
    listener: DesktopFleetCatalogStateListener,
    next: DesktopFleetCatalogState,
  ): void => {
    try {
      listener(next);
    } catch {
      // Catalog observers are untrusted application code. One observer must not
      // interrupt state retirement, another observer, or host cleanup.
    }
  };

  const emit = (next: DesktopFleetCatalogState): void => {
    if (disposed) return;
    state = next;
    for (const listener of [...listeners]) {
      if (disposed) break;
      notify(listener, next);
    }
  };

  const current = (expectedGeneration: number, expectedDaemonGeneration: string): boolean =>
    !disposed &&
    generation === expectedGeneration &&
    daemonGeneration === expectedDaemonGeneration &&
    daemon !== null;

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

  const retireRequest = (): void => {
    requestId += 1;
  };

  const retireSubscription = (forgetPending = false): void => {
    subscriptionId += 1;
    if (forgetPending) pendingSubscriptionId = null;
    eventLive = false;
    const active = unsubscribeHost;
    unsubscribeHost = null;
    try {
      active?.();
    } catch {
      // Host teardown is best-effort; the logical generation is already retired.
    }
  };

  const emitCatalog = (catalog: FleetCatalogResourceV1): void => {
    if (!daemon) return;
    const snapshot: DesktopFleetCatalogSnapshot = {
      daemon,
      catalog,
      updatedAt: clock.now(),
    };
    emit(
      eventLive
        ? { status: "live", generation, daemon, snapshot }
        : {
            status: "stale",
            generation,
            daemon,
            snapshot,
            reason: "Daemon fleet events are not connected.",
          },
    );
  };

  const emitRequestError = (error: DesktopDaemonCapabilityError, exhausted: boolean): void => {
    const snapshot = snapshotFromState(state);
    if (snapshot) {
      emit({ status: "stale", generation, daemon, snapshot, reason: safeReason(error) });
      return;
    }
    emit({
      status: "error",
      generation,
      daemon,
      snapshot: null,
      code: exhausted ? "retry-exhausted" : "request-failed",
      reason: safeReason(error),
    });
  };

  const emitEventFailure = (error: DesktopDaemonCapabilityError, exhausted = false): void => {
    eventLive = false;
    const snapshot = snapshotFromState(state);
    const terminalCode = terminalEventFailureCode(error);
    if (terminalCode !== null) {
      emit({
        status: "degraded",
        generation,
        daemon,
        snapshot,
        code: terminalCode,
        reason: safeReason(error),
      });
      return;
    }
    if (snapshot) {
      emit({
        status: "stale",
        generation,
        daemon,
        snapshot,
        reason: exhausted
          ? "Daemon fleet event recovery attempts were exhausted."
          : safeReason(error),
      });
      return;
    }
    emit({
      status: "degraded",
      generation,
      daemon,
      snapshot: null,
      code: "event-unavailable",
      reason: exhausted
        ? "Daemon fleet event recovery attempts were exhausted."
        : safeReason(error),
    });
  };

  const scheduleRequestRetry = (
    expectedGeneration: number,
    expectedDaemonGeneration: string,
  ): void => {
    if (
      requestRetryTimer !== null ||
      requestRetryAttempts >= retry.maximumAttempts ||
      !current(expectedGeneration, expectedDaemonGeneration)
    ) {
      return;
    }
    const delay = Math.min(
      retry.maximumDelayMs,
      retry.initialDelayMs * 2 ** Math.max(0, requestRetryAttempts),
    );
    requestRetryAttempts += 1;
    requestRetryTimer = clock.setTimeout(() => {
      requestRetryTimer = null;
      fetchCatalog(expectedGeneration, expectedDaemonGeneration);
    }, delay);
  };

  const scheduleEventRetry = (
    expectedGeneration: number,
    expectedDaemonGeneration: string,
  ): void => {
    if (
      eventRetryTimer !== null ||
      unsubscribeHost !== null ||
      !current(expectedGeneration, expectedDaemonGeneration)
    ) {
      return;
    }
    if (pendingSubscriptionId !== null) {
      eventRetryRequested = true;
      return;
    }
    if (eventRetryAttempts >= retry.maximumAttempts) {
      emitEventFailure(
        { code: "event-unavailable", reason: "Daemon fleet events are unavailable." },
        true,
      );
      return;
    }
    const delay = Math.min(
      retry.maximumDelayMs,
      retry.initialDelayMs * 2 ** Math.max(0, eventRetryAttempts),
    );
    eventRetryAttempts += 1;
    eventRetryRequested = false;
    eventRetryTimer = clock.setTimeout(() => {
      eventRetryTimer = null;
      connectEvents(expectedGeneration, expectedDaemonGeneration);
    }, delay);
  };

  const recoverEvents = (
    expectedGeneration: number,
    expectedDaemonGeneration: string,
    error: DesktopDaemonCapabilityError,
  ): void => {
    if (!current(expectedGeneration, expectedDaemonGeneration)) return;
    retireSubscription();
    emitEventFailure(error);
    scheduleEventRetry(expectedGeneration, expectedDaemonGeneration);
  };

  function fetchCatalog(expectedGeneration: number, expectedDaemonGeneration: string): void {
    if (!current(expectedGeneration, expectedDaemonGeneration) || daemon === null) return;
    retireRequest();
    const activeRequestId = requestId;
    const expectedDaemon = daemon;
    void host.daemon
      .fetchFleetCatalog()
      .then((raw) => {
        if (
          activeRequestId !== requestId ||
          !current(expectedGeneration, expectedDaemonGeneration)
        ) {
          return;
        }
        const result = parseFleetResult(raw, expectedDaemon);
        if (result.status === "ok") {
          clearRequestRetry();
          requestRetryAttempts = 0;
          emitCatalog(result.catalog);
          return;
        }
        if (result.status !== "error") {
          clearRequestRetry();
          clearEventRetry();
          eventRetryRequested = false;
          // A malformed or differently stamped catalog invalidates this daemon
          // generation's event authority; keep any pending subscribe promise so
          // recovery queues behind its teardown rather than forking a parallel
          // logical subscription.
          retireSubscription();
          emit({
            status: "degraded",
            generation,
            daemon,
            snapshot: snapshotFromState(state),
            code: result.status,
            reason:
              result.status === "daemon-identity-mismatch"
                ? "Fleet catalog came from another daemon generation."
                : "Desktop host returned an invalid fleet catalog.",
          });
          return;
        }
        const shouldRetry = requestShouldRetry(result.error);
        const exhausted = shouldRetry && requestRetryAttempts >= retry.maximumAttempts;
        emitRequestError(result.error, exhausted);
        if (shouldRetry && !exhausted) {
          scheduleRequestRetry(expectedGeneration, expectedDaemonGeneration);
        }
      })
      .catch(() => {
        if (
          activeRequestId !== requestId ||
          !current(expectedGeneration, expectedDaemonGeneration)
        ) {
          return;
        }
        const error: DesktopDaemonCapabilityError = {
          code: "request-failed",
          reason: "Desktop host fleet catalog request failed.",
        };
        const exhausted = requestRetryAttempts >= retry.maximumAttempts;
        emitRequestError(error, exhausted);
        if (!exhausted) scheduleRequestRetry(expectedGeneration, expectedDaemonGeneration);
      });
  }

  function connectEvents(expectedGeneration: number, expectedDaemonGeneration: string): void {
    if (
      !current(expectedGeneration, expectedDaemonGeneration) ||
      pendingSubscriptionId !== null ||
      unsubscribeHost !== null ||
      eventLive
    ) {
      return;
    }
    eventRetryRequested = false;
    const activeSubscriptionId = ++subscriptionId;
    pendingSubscriptionId = activeSubscriptionId;
    const listener = (event: DesktopDaemonEvent): void => {
      if (
        activeSubscriptionId !== subscriptionId ||
        !current(expectedGeneration, expectedDaemonGeneration)
      ) {
        return;
      }
      if (event.type === "fleet.changed" || event.type === "workspaces.changed") {
        fetchCatalog(expectedGeneration, expectedDaemonGeneration);
        return;
      }
      if (event.type !== "connection.changed") return;
      if (event.state === "live") {
        eventLive = true;
        clearEventRetry();
        eventRetryAttempts = 0;
        eventRetryRequested = false;
        const snapshot = snapshotFromState(state);
        if (snapshot && daemon) emit({ status: "live", generation, daemon, snapshot });
        return;
      }
      recoverEvents(
        expectedGeneration,
        expectedDaemonGeneration,
        event.error ?? {
          code: "event-unavailable",
          reason: "Daemon fleet events are unavailable.",
        },
      );
    };
    let operation: ReturnType<HostCapabilities["daemon"]["subscribe"]>;
    try {
      operation = host.daemon.subscribe({ workspaceNames: [] }, listener);
    } catch {
      if (pendingSubscriptionId === activeSubscriptionId) pendingSubscriptionId = null;
      recoverEvents(expectedGeneration, expectedDaemonGeneration, {
        code: "event-unavailable",
        reason: "Desktop host fleet event subscription failed.",
      });
      return;
    }
    void operation
      .then((result) => {
        const wasPending = pendingSubscriptionId === activeSubscriptionId;
        if (wasPending) pendingSubscriptionId = null;
        if (
          activeSubscriptionId !== subscriptionId ||
          !current(expectedGeneration, expectedDaemonGeneration)
        ) {
          if (result.status === "subscribed") {
            try {
              result.unsubscribe();
            } catch {
              // This logical subscription was already retired.
            }
          }
          if (
            wasPending &&
            eventRetryRequested &&
            current(expectedGeneration, expectedDaemonGeneration)
          ) {
            scheduleEventRetry(expectedGeneration, expectedDaemonGeneration);
          }
          return;
        }
        if (result.status === "subscribed") {
          unsubscribeHost = result.unsubscribe;
          return;
        }
        recoverEvents(expectedGeneration, expectedDaemonGeneration, result.error);
      })
      .catch(() => {
        const wasPending = pendingSubscriptionId === activeSubscriptionId;
        if (wasPending) pendingSubscriptionId = null;
        if (
          activeSubscriptionId !== subscriptionId ||
          !current(expectedGeneration, expectedDaemonGeneration)
        ) {
          if (
            wasPending &&
            eventRetryRequested &&
            current(expectedGeneration, expectedDaemonGeneration)
          ) {
            scheduleEventRetry(expectedGeneration, expectedDaemonGeneration);
          }
          return;
        }
        recoverEvents(expectedGeneration, expectedDaemonGeneration, {
          code: "event-unavailable",
          reason: "Desktop host fleet event subscription failed.",
        });
      });
  }

  const refreshCurrentGeneration = (): void => {
    if (disposed || daemon === null) return;
    clearRequestRetry();
    requestRetryAttempts = 0;
    fetchCatalog(generation, daemonGeneration);
    if (!eventLive) {
      clearEventRetry();
      eventRetryAttempts = 0;
      eventRetryRequested = true;
      retireSubscription();
      if (pendingSubscriptionId === null) connectEvents(generation, daemonGeneration);
    }
  };

  const startDaemon = (untrustedDaemon: unknown): void => {
    const next = connectedIdentity(untrustedDaemon);
    const nextIdentity = next.status === "connected" ? next.identity : null;
    if (sameDaemon(daemon, nextIdentity) && next.status === "connected") {
      refreshCurrentGeneration();
      return;
    }

    clearRequestRetry();
    clearEventRetry();
    retireRequest();
    retireSubscription(true);
    generation += 1;
    daemon = nextIdentity;
    daemonGeneration = nextIdentity ? daemonKey(nextIdentity) : `unavailable:${generation}`;
    requestRetryAttempts = 0;
    eventRetryAttempts = 0;
    eventRetryRequested = false;

    if (next.status !== "connected") {
      emit({
        status: "degraded",
        generation,
        daemon: null,
        snapshot: null,
        code: next.status === "degraded" ? "daemon-degraded" : "daemon-unavailable",
        reason: next.reason,
      });
      return;
    }

    emit({ status: "loading", generation, daemon, snapshot: null });
    const expectedGeneration = generation;
    const expectedDaemonGeneration = daemonGeneration;
    fetchCatalog(expectedGeneration, expectedDaemonGeneration);
    connectEvents(expectedGeneration, expectedDaemonGeneration);
  };

  const store: DesktopFleetCatalogStore = {
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
    refresh() {
      refreshCurrentGeneration();
    },
    setDaemon(nextDaemon) {
      if (disposed) return;
      startDaemon(nextDaemon);
    },
    dispose() {
      if (disposed) return;
      const retiredListeners = [...listeners];
      disposed = true;
      generation += 1;
      daemon = null;
      daemonGeneration = `disposed:${generation}`;
      clearRequestRetry();
      clearEventRetry();
      retireRequest();
      eventRetryRequested = false;
      retireSubscription(true);
      state = { status: "disposed", generation, daemon: null, snapshot: null };
      listeners.clear();
      for (const listener of retiredListeners) notify(listener, state);
    },
  };

  startDaemon(options.daemon);
  return store;
}

/** Solid lifecycle adapter; the catalog policy remains framework-independent. */
export function createSolidDesktopFleetCatalogStore(
  options: DesktopFleetCatalogStoreOptions,
): SolidDesktopFleetCatalogStore {
  const store = createDesktopFleetCatalogStore(options);
  const [state, setState] = createSignal(store.getState(), { equals: false });
  const unsubscribe = store.subscribe(setState);
  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    unsubscribe();
    store.dispose();
  };
  onCleanup(dispose);
  return {
    state,
    refresh: () => store.refresh(),
    setDaemon: (daemon) => store.setDaemon(daemon),
    dispose,
  };
}
