import {
  WorkspaceCatalogResourceV3SchemaZ,
  type CanonicalDaemonInfo,
  type WorkspaceCatalogResourceV3,
} from "@tmux-ide/contracts";
import {
  createPushResourceSession,
  type PushResourceSessionAdapter,
  type PushResourceSessionOptions,
} from "@tmux-ide/daemon-client/push-resource-session";
import {
  createWorkspaceEventSupervisor,
  type WorkspaceEventSocket,
} from "@tmux-ide/daemon-client/workspace-event-supervisor";
import WebSocket from "ws";

import { canonicalDaemonUrl, readCanonicalDaemonInfo } from "../../../lib/canonical-daemon.ts";

export type ApplicationHomeCatalogResourceKey = "live-catalog";
export type ApplicationHomeCatalogResource = {
  readonly kind: "live-catalog";
  readonly value: WorkspaceCatalogResourceV3;
};
export interface ApplicationHomeCatalogTarget {
  readonly daemon: CanonicalDaemonInfo;
  readonly workspaceName: string;
  readonly scopeKey?: string;
}
export interface ApplicationHomeCatalogFailure {
  readonly code: "target-invalid" | "network" | "http" | "schema" | "unavailable";
  readonly message: string;
  readonly retryable: boolean;
}

export interface ApplicationHomeCatalogSession {
  readonly id: string;
  readonly name: string;
  readonly paneCount: number;
}

export interface ApplicationHomeCatalogSnapshot {
  readonly phase: "loading" | "live" | "unavailable";
  readonly daemonInstanceId: string | null;
  readonly sessions: readonly ApplicationHomeCatalogSession[];
  readonly note: string | null;
}

export interface ApplicationHomeCatalog {
  getSnapshot(): ApplicationHomeCatalogSnapshot;
  subscribe(listener: (snapshot: ApplicationHomeCatalogSnapshot) => void): () => void;
  start(): void;
  retry(): void;
  dispose(): void;
}

type HomeCatalogAdapter = PushResourceSessionAdapter<
  ApplicationHomeCatalogTarget,
  ApplicationHomeCatalogResourceKey,
  ApplicationHomeCatalogResource,
  ApplicationHomeCatalogFailure
>;

interface RetryClock {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface ApplicationHomeCatalogDependencies {
  readonly readCanonicalDaemonInfo: () => CanonicalDaemonInfo | null;
  readonly createAdapter: (onTransportRetired: () => void) => HomeCatalogAdapter;
  readonly clock: RetryClock;
  readonly sessionOptions?: PushResourceSessionOptions;
}

function sameDaemon(
  left: CanonicalDaemonInfo | null,
  right: Pick<
    CanonicalDaemonInfo,
    "protocolVersion" | "productVersion" | "instanceId" | "startedAt"
  >,
): boolean {
  return (
    left?.protocolVersion === right.protocolVersion &&
    left.productVersion === right.productVersion &&
    left.instanceId === right.instanceId &&
    left.startedAt === right.startedAt
  );
}

function sameCanonicalDaemon(
  left: CanonicalDaemonInfo | null,
  right: CanonicalDaemonInfo,
): boolean {
  return (
    sameDaemon(left, right) &&
    left!.port === right.port &&
    left!.bindHostname === right.bindHostname
  );
}

function catalogFailure(
  code: ApplicationHomeCatalogFailure["code"],
  message: string,
  retryable: boolean,
): ApplicationHomeCatalogFailure {
  return { code, message, retryable };
}

export function closeApplicationHomeCatalogTransport(
  subscription: { close(): void },
  supervisor: { dispose(): void },
): void {
  subscription.close();
  supervisor.dispose();
}

function createApplicationHomeCatalogAdapter(onTransportRetired: () => void): HomeCatalogAdapter {
  return {
    validateTarget(value) {
      if (
        !value ||
        typeof value !== "object" ||
        !("daemon" in value) ||
        !("workspaceName" in value) ||
        typeof (value as ApplicationHomeCatalogTarget).workspaceName !== "string"
      )
        return {
          ok: false,
          failure: catalogFailure("target-invalid", "A live daemon is required.", false),
        };
      const target = value as ApplicationHomeCatalogTarget;
      return {
        ok: true,
        target,
        key: `${target.daemon.instanceId}\u0000${target.scopeKey ?? target.workspaceName}`,
      };
    },
    async fetch(target, _key, signal) {
      const url = canonicalDaemonUrl(
        "http",
        target.daemon.bindHostname,
        target.daemon.port,
        "/api/resources/workspace-catalog?version=3",
      );
      let response: Response;
      try {
        response = await fetch(url, {
          headers: {
            accept: "application/json",
            ...(target.daemon.authToken
              ? { Authorization: `Bearer ${target.daemon.authToken}` }
              : {}),
          },
          credentials: "omit",
          cache: "no-store",
          redirect: "error",
          signal,
        });
      } catch {
        return {
          status: "failed",
          failure: catalogFailure("network", "Live session discovery failed.", true),
        };
      }
      if (!response.ok)
        return {
          status: "failed",
          failure: catalogFailure(
            "http",
            `Live session discovery returned HTTP ${response.status}.`,
            response.status >= 500,
          ),
        };
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return {
          status: "failed",
          failure: catalogFailure("schema", "Live session discovery returned invalid JSON.", false),
        };
      }
      const parsed = WorkspaceCatalogResourceV3SchemaZ.safeParse(body);
      if (!parsed.success || !sameDaemon(target.daemon, parsed.data.daemon))
        return {
          status: "failed",
          failure: catalogFailure(
            "schema",
            "Live session discovery failed daemon identity validation.",
            false,
          ),
        };
      return { status: "ok", resource: { kind: "live-catalog", value: parsed.data } };
    },
    async connect(target, _interests, handlers, signal) {
      const socketUrl = canonicalDaemonUrl(
        "ws",
        target.daemon.bindHostname,
        target.daemon.port,
        "/ws/events?mode=semantic",
      );
      const socket = new WebSocket(socketUrl, {
        headers: target.daemon.authToken
          ? { Authorization: `Bearer ${target.daemon.authToken}` }
          : undefined,
      }) as unknown as WorkspaceEventSocket;
      const supervisor = createWorkspaceEventSupervisor({
        socket,
        daemon: target.daemon,
        workspaceName: target.workspaceName,
        sessionName: target.workspaceName,
        fetchTerminalRuntimeInventory: () =>
          Promise.reject(new Error("Home catalog owns no terminal inventory.")),
        onRetired: onTransportRetired,
      });
      const subscription = supervisor.connectWorkspaceCatalog(
        () => handlers.invalidate(["live-catalog"]),
        { terminalFirst: false },
      );
      let closed = false;
      const close = (): void => {
        if (closed) return;
        closed = true;
        signal.removeEventListener("abort", close);
        // Release the logical observer before retiring its physical transport.
        closeApplicationHomeCatalogTransport(subscription, supervisor);
      };
      signal.addEventListener("abort", close, { once: true });
      try {
        await subscription.ready;
      } catch (error) {
        close();
        throw error;
      }
      if (signal.aborted) {
        close();
        throw signal.reason;
      }
      return { status: "connected", close };
    },
    rejectionFailure: () =>
      catalogFailure("unavailable", "Live session discovery was rejected.", true),
    retryable: (failure) => failure.retryable,
    interestKey: () => "workspace-catalog",
  };
}

const DEFAULT_DEPENDENCIES: ApplicationHomeCatalogDependencies = {
  readCanonicalDaemonInfo,
  createAdapter: createApplicationHomeCatalogAdapter,
  clock: {
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  },
};

const initialSnapshot = (): ApplicationHomeCatalogSnapshot => ({
  phase: "loading",
  daemonInstanceId: null,
  sessions: [],
  note: "Discovering live tmux sessions…",
});

function projectCatalog(resource: WorkspaceCatalogResourceV3): ApplicationHomeCatalogSnapshot {
  return {
    phase: "live",
    daemonInstanceId: resource.daemon.instanceId,
    sessions: resource.liveSessions
      .map(({ liveSessionId, sessionName, paneCount }) => ({
        id: `${resource.daemon.instanceId}:${liveSessionId}`,
        name: sessionName,
        paneCount,
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    note:
      resource.liveSessions.length === 0
        ? "No live tmux sessions yet. This list updates automatically."
        : null,
  };
}

/**
 * Daemon-authoritative Home catalog. Reads are push-invalidated while the
 * daemon generation is healthy; the only timer is a bounded failure-recovery
 * probe used when no canonical daemon or event transport is available.
 */
export function createApplicationHomeCatalog(
  overrides: Partial<ApplicationHomeCatalogDependencies> = {},
): ApplicationHomeCatalog {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  let disposed = false;
  let started = false;
  let daemon: CanonicalDaemonInfo | null = null;
  let transportRetired = false;
  let retryAttempt = 0;
  let retryTimer: unknown | null = null;
  let snapshot = initialSnapshot();
  const listeners = new Set<(value: ApplicationHomeCatalogSnapshot) => void>();
  const adapter = dependencies.createAdapter(() => {
    transportRetired = true;
    scheduleRetry("Session updates disconnected.");
  });
  const session = createPushResourceSession(adapter, null, dependencies.sessionOptions);
  const releaseCatalog = session.activate("live-catalog");

  const publish = (next: ApplicationHomeCatalogSnapshot): void => {
    if (disposed) return;
    snapshot = next;
    for (const listener of [...listeners]) {
      try {
        listener(snapshot);
      } catch {
        // UI observers cannot own daemon authority lifecycle.
      }
    }
  };

  const clearRetry = (): void => {
    if (retryTimer === null) return;
    dependencies.clock.clearTimeout(retryTimer);
    retryTimer = null;
  };

  const bindCanonicalDaemon = (): boolean => {
    const next = dependencies.readCanonicalDaemonInfo();
    if (!next) {
      if (daemon !== null) {
        daemon = null;
        session.setTarget(null);
      }
      return false;
    }
    const forceRebind = transportRetired;
    if (!sameCanonicalDaemon(daemon, next) || forceRebind) {
      transportRetired = false;
      daemon = next;
      if (forceRebind) session.setTarget(null);
      session.setTarget({
        daemon: next,
        workspaceName: "__home_catalog__",
        scopeKey: `home-catalog:${next.instanceId}`,
      });
    } else {
      session.refresh("live-catalog");
    }
    return true;
  };

  function scheduleRetry(reason: string): void {
    if (disposed || retryTimer !== null) return;
    publish({
      phase: "unavailable",
      daemonInstanceId: null,
      sessions: [],
      note: `${reason} Retrying automatically…`,
    });
    const delayMs = Math.min(4_000, 250 * 2 ** Math.min(retryAttempt++, 4));
    retryTimer = dependencies.clock.setTimeout(() => {
      retryTimer = null;
      if (!bindCanonicalDaemon()) scheduleRetry("The tmux-ide daemon is unavailable.");
    }, delayMs);
  }

  const unsubscribeSession = session.subscribe((state) => {
    if (!started) return;
    const slot = state.slots.get("live-catalog");
    if (slot?.status === "loaded" && !slot.refreshing && slot.resource.kind === "live-catalog") {
      clearRetry();
      retryAttempt = 0;
      publish(projectCatalog(slot.resource.value));
      return;
    }
    if (slot?.status === "error") {
      scheduleRetry("Live session discovery failed.");
      return;
    }
    if (state.targetFailure) {
      scheduleRetry("The tmux-ide daemon is unavailable.");
      return;
    }
    if (state.target && snapshot.phase !== "unavailable") {
      publish({
        phase: "loading",
        daemonInstanceId: state.target.daemon.instanceId,
        sessions: [],
        note: "Discovering live tmux sessions…",
      });
    }
  });

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      if (disposed) return () => undefined;
      listeners.add(listener);
      listener(snapshot);
      return () => listeners.delete(listener);
    },
    start() {
      if (disposed || started) return;
      started = true;
      if (!bindCanonicalDaemon()) scheduleRetry("The tmux-ide daemon is unavailable.");
    },
    retry() {
      if (disposed) return;
      clearRetry();
      retryAttempt = 0;
      publish(initialSnapshot());
      if (!bindCanonicalDaemon()) scheduleRetry("The tmux-ide daemon is unavailable.");
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearRetry();
      unsubscribeSession();
      releaseCatalog();
      session.dispose();
      listeners.clear();
    },
  };
}

export function selectedHomeCatalogIndex(
  sessions: readonly ApplicationHomeCatalogSession[],
  selectedId: string | null,
): number {
  if (sessions.length === 0) return -1;
  const index = sessions.findIndex(({ id }) => id === selectedId);
  return index < 0 ? 0 : index;
}

export function moveHomeCatalogSelection(
  sessions: readonly ApplicationHomeCatalogSession[],
  selectedId: string | null,
  delta: -1 | 1,
): string | null {
  if (sessions.length === 0) return null;
  const current = selectedHomeCatalogIndex(sessions, selectedId);
  return sessions[(current + delta + sessions.length) % sessions.length]!.id;
}
