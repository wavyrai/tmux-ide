import WebSocket from "ws";
import {
  createWorkspaceEventSupervisor,
  type WorkspaceEventSocket,
} from "@tmux-ide/daemon-client/workspace-event-supervisor";
import { readApplicationDaemonInfo as readCanonicalDaemonInfo } from "./application-daemon-authority.ts";
import {
  TmuxServersResourceSchemaZ,
  TmuxServerSessionsResourceSchemaZ,
  type TmuxServerScope,
  type TmuxServerDescriptor,
  type CanonicalDaemonInfo,
  type WorkspaceCatalogResourceV3,
} from "@tmux-ide/contracts";
import {
  createPushResourceSession,
  type PushResourceSessionAdapter,
  type PushResourceSessionOptions,
} from "@tmux-ide/daemon-client/push-resource-session";

import { canonicalDaemonUrl } from "../../../lib/canonical-daemon.ts";

export type ApplicationHomeCatalogResourceKey = "live-catalog";
export type ApplicationHomeCatalogResource = {
  readonly kind: "live-catalog";
  readonly value?: WorkspaceCatalogResourceV3;
  readonly daemonInstanceId?: string;
  readonly servers?: readonly TmuxServerDescriptor[];
  readonly scopedSessions?: readonly ApplicationHomeCatalogSession[];
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
  readonly server?: TmuxServerScope;
  readonly serverLabel?: string;
  readonly liveSessionId?: string;
  readonly workspaceName?: string;
  readonly name: string;
  readonly paneCount: number;
}

export interface ApplicationHomeCatalogSnapshot {
  readonly phase: "loading" | "live" | "unavailable";
  readonly daemonInstanceId: string | null;
  readonly sessions: readonly ApplicationHomeCatalogSession[];
  readonly servers?: readonly TmuxServerDescriptor[];
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

function createApplicationHomeCatalogAdapter(_onTransportRetired: () => void): HomeCatalogAdapter {
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
      const base = canonicalDaemonUrl("http", target.daemon.bindHostname, target.daemon.port);
      const read = async (path: string) => {
        const response = await fetch(base + path, {
          headers: {
            accept: "application/json",
            ...(target.daemon.authToken
              ? { Authorization: `Bearer ${target.daemon.authToken}` }
              : {}),
          },
          credentials: "omit",
          cache: "no-store",
          redirect: "error",
          signal: AbortSignal.any([signal, AbortSignal.timeout(3_000)]),
        });
        if (!response.ok) throw new Error(`Discovery returned HTTP ${response.status}`);
        return response.json();
      };
      try {
        const inventory = TmuxServersResourceSchemaZ.parse(await read("/api/v1/tmux-servers"));
        const sessions = await Promise.allSettled(
          inventory.servers.map(async (descriptor) => {
            if (descriptor.state !== "online") return [];
            const server = { serverId: descriptor.serverId, generation: descriptor.generation };
            const result = TmuxServerSessionsResourceSchemaZ.parse(
              await read(`/api/v1/tmux-servers/${server.serverId}/${server.generation}/sessions`),
            );
            if (
              result.server.serverId !== server.serverId ||
              result.server.generation !== server.generation
            )
              throw new Error("Server discovery identity changed");
            return result.sessions.map((session) => ({
              id: JSON.stringify([server.serverId, server.generation, session.liveSessionId]),
              server,
              serverLabel: descriptor.label,
              liveSessionId: session.liveSessionId,
              name: session.sessionName,
              ...(session.workspaceName ? { workspaceName: session.workspaceName } : {}),
              paneCount: session.paneCount,
            }));
          }),
        );
        return {
          status: "ok",
          resource: {
            kind: "live-catalog",
            daemonInstanceId: target.daemon.instanceId,
            servers: inventory.servers.map((server, index) =>
              sessions[index]?.status === "rejected"
                ? {
                    serverId: server.serverId,
                    label: server.label,
                    state: "offline" as const,
                    generation: null,
                  }
                : server,
            ),
            scopedSessions: sessions.flatMap((result) =>
              result.status === "fulfilled" ? result.value : [],
            ),
          },
        };
      } catch {
        return {
          status: "failed",
          failure: catalogFailure("network", "Server session discovery failed.", true),
        };
      }
    },
    async connect(target, _interests, handlers, signal) {
      // Root push is an advisory invalidation only: every refresh still resolves
      // the full scoped inventory. The timer discovers changes on other owners.
      let closed = false;
      let pending = false;
      let closePush: (() => void) | null = null;
      const invalidate = () => {
        if (!closed) handlers.invalidate(["live-catalog"]);
      };
      const startPush = async () => {
        if (closed || pending || closePush) return;
        pending = true;
        const socket = new WebSocket(
          canonicalDaemonUrl(
            "ws",
            target.daemon.bindHostname,
            target.daemon.port,
            "/ws/events?mode=semantic",
          ),
          {
            headers: target.daemon.authToken
              ? { Authorization: `Bearer ${target.daemon.authToken}` }
              : undefined,
          },
        ) as unknown as WorkspaceEventSocket;
        const supervisor = createWorkspaceEventSupervisor({
          socket,
          daemon: target.daemon,
          workspaceName: target.workspaceName,
          sessionName: target.workspaceName,
          fetchTerminalRuntimeInventory: () =>
            Promise.reject(new Error("Home catalog owns no terminal inventory.")),
          onRetired: () => {
            const cleanup = closePush;
            closePush = null;
            cleanup?.();
          },
        });
        const subscription = supervisor.connectWorkspaceCatalog(invalidate, {
          terminalFirst: false,
        });
        const cleanup = () => closeApplicationHomeCatalogTransport(subscription, supervisor);
        closePush = cleanup;
        try {
          await subscription.ready;
        } catch {
          if (closePush === cleanup) closePush = null;
          cleanup();
        } finally {
          pending = false;
          if (closed) {
            cleanup();
            closePush = null;
          }
        }
      };
      const timer = setInterval(() => {
        invalidate();
        void startPush().catch(() => {
          pending = false;
        });
      }, 5_000);
      const close = () => {
        closed = true;
        clearInterval(timer);
        signal.removeEventListener("abort", close);
        const cleanup = closePush;
        closePush = null;
        cleanup?.();
      };
      signal.addEventListener("abort", close, { once: true });
      if (signal.aborted) close();
      else
        void startPush().catch(() => {
          pending = false;
        });
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

function projectCatalog(
  resource: WorkspaceCatalogResourceV3,
  scopedSessions?: readonly ApplicationHomeCatalogSession[],
): ApplicationHomeCatalogSnapshot {
  return {
    phase: "live",
    daemonInstanceId: resource.daemon.instanceId,
    sessions:
      scopedSessions ??
      resource.liveSessions
        .map(({ liveSessionId, sessionName, paneCount }) => ({
          id: `${resource.daemon.instanceId}:${liveSessionId}`,
          liveSessionId,
          workspaceName: resource.intents.find((intent) => intent.sessionName === sessionName)
            ?.workspaceName,
          name: sessionName,
          paneCount,
        }))
        .sort((left, right) => left.name.localeCompare(right.name)),
    note:
      (scopedSessions?.length ?? resource.liveSessions.length) === 0
        ? "No live tmux sessions yet. This list updates automatically."
        : null,
  };
}

/**
 * Daemon-authoritative fleet metadata. Root push preserves immediate updates,
 * while a five-second refresh discovers independent
 * server owners without opening pane streams. Failed reads use bounded backoff;
 * each failed server is excluded without suppressing healthy siblings.
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
      publish(
        slot.resource.value
          ? projectCatalog(slot.resource.value)
          : {
              phase: "live",
              daemonInstanceId: slot.resource.daemonInstanceId ?? null,
              sessions: slot.resource.scopedSessions ?? [],
              servers: slot.resource.servers,
              note: slot.resource.scopedSessions?.length
                ? null
                : "No live tmux sessions yet. This list updates automatically.",
            },
      );
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
      // A push-invalidated read is not evidence that live sessions vanished.
      // Keep incarnation identities until the replacement read settles; only
      // a different daemon generation must clear the selector immediately.
      if (snapshot.phase === "live" && snapshot.daemonInstanceId === state.target.daemon.instanceId)
        return;
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
