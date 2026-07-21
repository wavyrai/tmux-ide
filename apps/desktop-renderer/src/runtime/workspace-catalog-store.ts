import { createSignal, onCleanup, type Accessor } from "solid-js";
import {
  DesktopDaemonCapabilityStateSchemaZ,
  DesktopDaemonListWorkspacesResultSchemaZ,
  DesktopWorkspaceNameSchemaZ,
  isDaemonWireProtocolCompatible,
  type DaemonInstanceIdentity,
  type DesktopDaemonCapabilityError,
  type DesktopDaemonEvent,
  type DesktopDaemonWorkspaceSummary,
  type HostCapabilities,
} from "@tmux-ide/contracts";

export type DesktopWorkspaceSelectionSeedSource = "startup" | "persisted";

export interface DesktopWorkspaceSelectionSeed {
  readonly source: DesktopWorkspaceSelectionSeedSource;
  readonly workspaceName: unknown;
}

export type DesktopWorkspaceSelectedReason =
  | DesktopWorkspaceSelectionSeedSource
  | "explicit"
  | "only-live-workspace";

export type DesktopWorkspaceUnselectedReason =
  | "loading"
  | "no-live-workspaces"
  | "multiple-live-workspaces"
  | "startup-selection-invalid"
  | "startup-selection-not-found"
  | "persisted-selection-invalid"
  | "persisted-selection-not-found"
  | "selected-workspace-removed"
  | "explicit-selection-cleared";

export type DesktopWorkspaceSelection =
  | {
      readonly view: "workspace";
      readonly workspaceName: string;
      readonly reason: DesktopWorkspaceSelectedReason;
    }
  | {
      readonly view: "onboarding" | "chooser";
      readonly workspaceName: null;
      readonly reason: DesktopWorkspaceUnselectedReason;
    };

export interface DesktopWorkspaceCatalogSnapshot {
  readonly daemon: DaemonInstanceIdentity;
  readonly workspaces: readonly DesktopDaemonWorkspaceSummary[];
  readonly selection: DesktopWorkspaceSelection;
  readonly updatedAt: number;
}

interface DesktopWorkspaceCatalogStateBase {
  readonly generation: number;
  readonly daemon: DaemonInstanceIdentity | null;
}

export type DesktopWorkspaceCatalogState =
  | (DesktopWorkspaceCatalogStateBase & {
      readonly status: "loading";
      readonly snapshot: null;
    })
  | (DesktopWorkspaceCatalogStateBase & {
      readonly status: "live";
      readonly snapshot: DesktopWorkspaceCatalogSnapshot;
    })
  | (DesktopWorkspaceCatalogStateBase & {
      readonly status: "stale";
      readonly snapshot: DesktopWorkspaceCatalogSnapshot;
      readonly reason: string;
    })
  | (DesktopWorkspaceCatalogStateBase & {
      readonly status: "degraded";
      readonly snapshot: DesktopWorkspaceCatalogSnapshot | null;
      readonly code:
        | "daemon-unavailable"
        | "daemon-degraded"
        | "daemon-identity-mismatch"
        | "invalid-response"
        | "event-unavailable";
      readonly reason: string;
    })
  | (DesktopWorkspaceCatalogStateBase & {
      readonly status: "error";
      readonly snapshot: DesktopWorkspaceCatalogSnapshot | null;
      readonly code: "request-failed" | "retry-exhausted";
      readonly reason: string;
    })
  | (DesktopWorkspaceCatalogStateBase & {
      readonly status: "disposed";
      readonly daemon: null;
      readonly snapshot: null;
    });

export interface DesktopWorkspaceCatalogClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface DesktopWorkspaceCatalogRetryPolicy {
  readonly initialDelayMs: number;
  readonly maximumDelayMs: number;
  readonly maximumAttempts: number;
}

export interface DesktopWorkspaceCatalogStoreOptions {
  readonly host: Pick<HostCapabilities, "daemon">;
  readonly daemon: unknown;
  readonly initialSelection?: DesktopWorkspaceSelectionSeed;
  readonly clock?: DesktopWorkspaceCatalogClock;
  readonly retry?: Partial<DesktopWorkspaceCatalogRetryPolicy>;
}

export type DesktopWorkspaceCatalogStateListener = (state: DesktopWorkspaceCatalogState) => void;

export interface DesktopWorkspaceCatalogStore {
  getState(): DesktopWorkspaceCatalogState;
  subscribe(listener: DesktopWorkspaceCatalogStateListener): () => void;
  select(workspaceName: unknown): boolean;
  clearSelection(): void;
  refresh(): void;
  setDaemon(daemon: unknown): void;
  dispose(): void;
}

export interface SolidDesktopWorkspaceCatalogStore {
  readonly state: Accessor<DesktopWorkspaceCatalogState>;
  select(workspaceName: unknown): boolean;
  clearSelection(): void;
  refresh(): void;
  setDaemon(daemon: unknown): void;
  dispose(): void;
}

const DEFAULT_RETRY: DesktopWorkspaceCatalogRetryPolicy = {
  initialDelayMs: 250,
  maximumDelayMs: 4_000,
  maximumAttempts: 4,
};

const defaultClock: DesktopWorkspaceCatalogClock = {
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
  overrides: Partial<DesktopWorkspaceCatalogRetryPolicy> | undefined,
): DesktopWorkspaceCatalogRetryPolicy {
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

function exactWorkspaceName(value: unknown): string | null {
  const parsed = DesktopWorkspaceNameSchemaZ.safeParse(value);
  return parsed.success && parsed.data === value ? parsed.data : null;
}

function safeReason(error: DesktopDaemonCapabilityError): string {
  // Host capability errors are already bounded and redacted by the shared
  // contract. Do not incorporate thrown values or schema diagnostics here.
  return error.reason;
}

function invalidSeedReason(
  source: DesktopWorkspaceSelectionSeedSource,
): DesktopWorkspaceUnselectedReason {
  return source === "startup" ? "startup-selection-invalid" : "persisted-selection-invalid";
}

function missingSeedReason(
  source: DesktopWorkspaceSelectionSeedSource,
): DesktopWorkspaceUnselectedReason {
  return source === "startup" ? "startup-selection-not-found" : "persisted-selection-not-found";
}

function selectionWithoutWorkspace(
  workspaceCount: number,
  reason: DesktopWorkspaceUnselectedReason,
): DesktopWorkspaceSelection {
  return {
    view: workspaceCount === 0 ? "onboarding" : "chooser",
    workspaceName: null,
    reason,
  };
}

function sortWorkspaceSummaries(
  workspaces: readonly DesktopDaemonWorkspaceSummary[],
): DesktopDaemonWorkspaceSummary[] {
  return [...workspaces].sort((left, right) =>
    left.workspaceName < right.workspaceName
      ? -1
      : left.workspaceName > right.workspaceName
        ? 1
        : 0,
  );
}

function parseCatalogResult(
  value: unknown,
  expectedDaemon: DaemonInstanceIdentity,
):
  | { readonly status: "ok"; readonly workspaces: DesktopDaemonWorkspaceSummary[] }
  | { readonly status: "error"; readonly error: DesktopDaemonCapabilityError }
  | { readonly status: "invalid-response" | "daemon-identity-mismatch" } {
  const parsed = DesktopDaemonListWorkspacesResultSchemaZ.safeParse(value);
  if (!parsed.success) return { status: "invalid-response" };
  if (parsed.data.status === "error") return parsed.data;
  if (!sameDaemon(parsed.data.daemon, expectedDaemon)) {
    return { status: "daemon-identity-mismatch" };
  }
  const names = new Set<string>();
  for (let index = 0; index < parsed.data.workspaces.length; index += 1) {
    const parsedName = parsed.data.workspaces[index]?.workspaceName;
    const rawName = (value as { workspaces?: Array<{ workspaceName?: unknown }> }).workspaces?.[
      index
    ]?.workspaceName;
    if (parsedName === undefined || parsedName !== rawName || names.has(parsedName)) {
      return { status: "invalid-response" };
    }
    names.add(parsedName);
  }
  return { status: "ok", workspaces: sortWorkspaceSummaries(parsed.data.workspaces) };
}

function connectedIdentity(value: unknown):
  | { readonly status: "connected"; readonly identity: DaemonInstanceIdentity }
  | {
      readonly status: "unavailable" | "degraded" | "invalid";
      readonly reason: string;
    } {
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

function snapshotFromState(
  state: DesktopWorkspaceCatalogState,
): DesktopWorkspaceCatalogSnapshot | null {
  return "snapshot" in state ? state.snapshot : null;
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
  if (error.code === "invalid-response" || error.code === "protocol-error") {
    return "invalid-response";
  }
  return null;
}

export function createDesktopWorkspaceCatalogStore(
  options: DesktopWorkspaceCatalogStoreOptions,
): DesktopWorkspaceCatalogStore {
  const host = options.host;
  const clock = options.clock ?? defaultClock;
  const retry = retryPolicy(options.retry);
  const listeners = new Set<DesktopWorkspaceCatalogStateListener>();

  let disposed = false;
  let generation = 0;
  let daemon: DaemonInstanceIdentity | null = null;
  let daemonGeneration = "";
  let state: DesktopWorkspaceCatalogState = {
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
  let selectedWorkspaceName: string | null = null;
  let selectedReason: DesktopWorkspaceSelectedReason | null = null;
  let pendingSelection: {
    readonly source: DesktopWorkspaceSelectionSeedSource;
    readonly workspaceName: string;
  } | null = null;
  let unselectedReason: DesktopWorkspaceUnselectedReason = "loading";
  let suppressAutomaticSelection = false;

  if (options.initialSelection) {
    const candidate = exactWorkspaceName(options.initialSelection.workspaceName);
    if (candidate === null) {
      unselectedReason = invalidSeedReason(options.initialSelection.source);
      suppressAutomaticSelection = true;
    } else {
      pendingSelection = { source: options.initialSelection.source, workspaceName: candidate };
    }
  }

  const notify = (
    listener: DesktopWorkspaceCatalogStateListener,
    next: DesktopWorkspaceCatalogState,
  ): void => {
    try {
      listener(next);
    } catch {
      // Catalog observers are untrusted application code. One observer must not
      // interrupt state retirement, another observer, or host cleanup.
    }
  };

  const emit = (next: DesktopWorkspaceCatalogState): void => {
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

  const selectionFor = (
    workspaces: readonly DesktopDaemonWorkspaceSummary[],
  ): DesktopWorkspaceSelection => {
    const names = new Set(workspaces.map(({ workspaceName }) => workspaceName));
    if (selectedWorkspaceName !== null) {
      if (names.has(selectedWorkspaceName)) {
        return {
          view: "workspace",
          workspaceName: selectedWorkspaceName,
          reason: selectedReason ?? "explicit",
        };
      }
      selectedWorkspaceName = null;
      selectedReason = null;
      pendingSelection = null;
      unselectedReason = "selected-workspace-removed";
      suppressAutomaticSelection = true;
    }
    if (pendingSelection !== null) {
      if (names.has(pendingSelection.workspaceName)) {
        selectedWorkspaceName = pendingSelection.workspaceName;
        selectedReason = pendingSelection.source;
        pendingSelection = null;
        suppressAutomaticSelection = false;
        return {
          view: "workspace",
          workspaceName: selectedWorkspaceName,
          reason: selectedReason,
        };
      }
      unselectedReason = missingSeedReason(pendingSelection.source);
      pendingSelection = null;
      suppressAutomaticSelection = true;
    }
    if (workspaces.length === 1 && !suppressAutomaticSelection) {
      selectedWorkspaceName = workspaces[0]!.workspaceName;
      selectedReason = "only-live-workspace";
      return {
        view: "workspace",
        workspaceName: selectedWorkspaceName,
        reason: selectedReason,
      };
    }
    if (unselectedReason === "loading") {
      unselectedReason =
        workspaces.length === 0 ? "no-live-workspaces" : "multiple-live-workspaces";
    } else if (
      unselectedReason === "no-live-workspaces" &&
      workspaces.length > 0 &&
      !suppressAutomaticSelection
    ) {
      unselectedReason = "multiple-live-workspaces";
    } else if (unselectedReason === "multiple-live-workspaces" && workspaces.length === 0) {
      unselectedReason = "no-live-workspaces";
    }
    return selectionWithoutWorkspace(workspaces.length, unselectedReason);
  };

  const updateSelectionSnapshot = (): void => {
    const snapshot = snapshotFromState(state);
    if (!snapshot || !daemon) return;
    const nextSnapshot: DesktopWorkspaceCatalogSnapshot = {
      ...snapshot,
      selection: selectionFor(snapshot.workspaces),
    };
    if (state.status === "live") emit({ ...state, snapshot: nextSnapshot });
    else if (state.status === "stale") emit({ ...state, snapshot: nextSnapshot });
    else if (state.status === "degraded") emit({ ...state, snapshot: nextSnapshot });
    else if (state.status === "error") emit({ ...state, snapshot: nextSnapshot });
  };

  const emitCatalog = (workspaces: readonly DesktopDaemonWorkspaceSummary[]): void => {
    if (!daemon) return;
    const snapshot: DesktopWorkspaceCatalogSnapshot = {
      daemon,
      workspaces,
      selection: selectionFor(workspaces),
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
            reason: "Daemon catalog events are not connected.",
          },
    );
  };

  const emitRequestError = (error: DesktopDaemonCapabilityError, exhausted: boolean): void => {
    const snapshot = snapshotFromState(state);
    if (snapshot) {
      emit({
        status: "stale",
        generation,
        daemon,
        snapshot,
        reason: safeReason(error),
      });
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
          ? "Daemon catalog event recovery attempts were exhausted."
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
        ? "Daemon catalog event recovery attempts were exhausted."
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
        {
          code: "event-unavailable",
          reason: "Daemon catalog events are unavailable.",
        },
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
      .listWorkspaces()
      .then((raw) => {
        if (
          activeRequestId !== requestId ||
          !current(expectedGeneration, expectedDaemonGeneration)
        ) {
          return;
        }
        const result = parseCatalogResult(raw, expectedDaemon);
        if (result.status === "ok") {
          clearRequestRetry();
          requestRetryAttempts = 0;
          emitCatalog(result.workspaces);
          return;
        }
        if (result.status !== "error") {
          clearRequestRetry();
          clearEventRetry();
          eventRetryRequested = false;
          // A malformed or differently stamped catalog invalidates the whole
          // event authority for this daemon generation. Keep tracking a
          // pending subscribe promise so an explicit recovery queues behind
          // its eventual teardown instead of creating a parallel logical
          // subscription. With no explicit recovery intent, its late result
          // can only unsubscribe itself and can never publish live.
          retireSubscription();
          emit({
            status: "degraded",
            generation,
            daemon,
            snapshot: snapshotFromState(state),
            code: result.status,
            reason:
              result.status === "daemon-identity-mismatch"
                ? "Workspace catalog came from another daemon generation."
                : "Desktop host returned an invalid workspace catalog.",
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
          reason: "Desktop host workspace catalog request failed.",
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
      if (event.type === "workspaces.changed") {
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
          reason: "Daemon catalog events are unavailable.",
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
        reason: "Desktop host catalog event subscription failed.",
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
          reason: "Desktop host catalog event subscription failed.",
        });
      });
  }

  const startDaemon = (untrustedDaemon: unknown): void => {
    const next = connectedIdentity(untrustedDaemon);
    const nextIdentity = next.status === "connected" ? next.identity : null;
    if (sameDaemon(daemon, nextIdentity) && next.status === "connected") {
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
      return;
    }

    const previousSelection = selectedWorkspaceName;
    const previousReason = selectedReason;
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
    if (previousSelection !== null) {
      pendingSelection = {
        source: previousReason === "startup" ? "startup" : "persisted",
        workspaceName: previousSelection,
      };
      selectedWorkspaceName = null;
      selectedReason = null;
      suppressAutomaticSelection = true;
    }

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

  const store: DesktopWorkspaceCatalogStore = {
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
    select(value) {
      if (disposed) return false;
      const workspaceName = exactWorkspaceName(value);
      const snapshot = snapshotFromState(state);
      if (
        workspaceName === null ||
        snapshot === null ||
        !snapshot.workspaces.some((workspace) => workspace.workspaceName === workspaceName)
      ) {
        return false;
      }
      selectedWorkspaceName = workspaceName;
      selectedReason = "explicit";
      pendingSelection = null;
      suppressAutomaticSelection = false;
      updateSelectionSnapshot();
      return true;
    },
    clearSelection() {
      if (disposed) return;
      selectedWorkspaceName = null;
      selectedReason = null;
      pendingSelection = null;
      suppressAutomaticSelection = true;
      unselectedReason = "explicit-selection-cleared";
      updateSelectionSnapshot();
    },
    refresh() {
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

/** Solid lifecycle adapter; the catalog/selection policy remains framework-independent. */
export function createSolidDesktopWorkspaceCatalogStore(
  options: DesktopWorkspaceCatalogStoreOptions,
): SolidDesktopWorkspaceCatalogStore {
  const store = createDesktopWorkspaceCatalogStore(options);
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
    select: (workspaceName) => store.select(workspaceName),
    clearSelection: () => store.clearSelection(),
    refresh: () => store.refresh(),
    setDaemon: (daemon) => store.setDaemon(daemon),
    dispose,
  };
}
