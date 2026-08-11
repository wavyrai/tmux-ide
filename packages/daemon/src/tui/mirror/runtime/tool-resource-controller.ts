import {
  DaemonEventClientFrameSchemaZ,
  DaemonEventServerFrameSchemaZ,
  DaemonProjectsResponseSchemaZ,
  DaemonSessionsResponseSchemaZ,
  FleetCatalogResourceV1SchemaZ,
  WorkspaceChangesCatalogEnvelopeV1SchemaZ,
  WorkspaceFilesCatalogEnvelopeV1SchemaZ,
  WorkspaceMissionsEnvelopeV1SchemaZ,
  type CanonicalDaemonInfo,
  type DaemonProjectsResponse,
  type DaemonSessionsResponse,
  type FleetCatalogResourceV1,
  type WorkspaceChangesCatalogEnvelopeV1,
  type WorkspaceFilesCatalogEnvelopeV1,
  type WorkspaceMissionsEnvelopeV1,
} from "@tmux-ide/contracts";
import {
  createPushResourceSession,
  type PushResourceSession,
  type PushResourceSessionAdapter,
  type PushResourceSessionOptions,
  type PushResourceSessionState,
} from "@tmux-ide/daemon-client/push-resource-session";
import { createRuntimeConnectionSupervisor } from "@tmux-ide/daemon-client/connection-supervisor";
import WebSocket from "ws";

import { canonicalDaemonUrl } from "../../../lib/canonical-daemon.ts";

export type TuiToolResourceKey =
  | "fleet"
  | "sessions"
  | "projects"
  | "files"
  | "changes"
  | "missions";
export type TuiDockResourceKey = "files" | "changes" | "missions";

export type TuiToolResource =
  | { readonly kind: "fleet"; readonly value: FleetCatalogResourceV1 }
  | { readonly kind: "sessions"; readonly value: DaemonSessionsResponse }
  | { readonly kind: "projects"; readonly value: DaemonProjectsResponse }
  | { readonly kind: "files"; readonly value: WorkspaceFilesCatalogEnvelopeV1 }
  | { readonly kind: "changes"; readonly value: WorkspaceChangesCatalogEnvelopeV1 }
  | { readonly kind: "missions"; readonly value: WorkspaceMissionsEnvelopeV1 };

export interface TuiToolResourceTarget {
  readonly daemon: CanonicalDaemonInfo;
  readonly workspaceName: string;
}

export interface TuiToolResourceFailure {
  readonly code: "target-invalid" | "network" | "http" | "schema" | "unavailable";
  readonly message: string;
  readonly retryable: boolean;
}

export interface TuiToolResourceMetrics {
  readonly toolFetches: number;
  readonly invalidations: number;
  readonly statePublications: number;
  readonly dirtyUpdates: number;
  readonly subprocessLaunches: 0;
  readonly idleWakeups: 0;
  readonly renderPasses: number;
  readonly activeInterests: number;
}

type ToolEventListener = (event: { readonly data?: unknown }) => void;

interface ToolEventSocket {
  addEventListener(type: "open" | "message" | "close" | "error", listener: ToolEventListener): void;
  removeEventListener(
    type: "open" | "message" | "close" | "error",
    listener: ToolEventListener,
  ): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

const MAX_EVENT_FRAME_BYTES = 1024 * 1024;

function boundedEventText(value: unknown): string | null {
  if (typeof value === "string") {
    return Buffer.byteLength(value, "utf8") <= MAX_EVENT_FRAME_BYTES ? value : null;
  }
  let bytes: Uint8Array | null = null;
  if (Buffer.isBuffer(value)) bytes = value;
  else if (value instanceof ArrayBuffer) bytes = new Uint8Array(value);
  else if (ArrayBuffer.isView(value)) {
    bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (!bytes || bytes.byteLength > MAX_EVENT_FRAME_BYTES) return null;
  return Buffer.from(bytes).toString("utf8");
}

export interface TuiToolResourceAdapterDependencies {
  readonly fetch?: typeof globalThis.fetch;
  readonly createSocket?: (url: string, ownerToken: string | null) => ToolEventSocket;
}

const INTEREST_BY_KEY = {
  fleet: "fleet-catalog",
  sessions: "workspace-catalog",
  projects: "workspace-catalog",
  files: "workspace-files",
  changes: "workspace-changes",
  missions: "workspace-missions",
} as const;

const keysForInterest = (interest: string): readonly TuiToolResourceKey[] => {
  if (interest === "workspace-catalog") return ["sessions", "projects"];
  const match = Object.entries(INTEREST_BY_KEY).find(([, value]) => value === interest);
  return match ? [match[0] as TuiToolResourceKey] : [];
};

function failure(
  code: TuiToolResourceFailure["code"],
  message: string,
  retryable: boolean,
): TuiToolResourceFailure {
  return { code, message, retryable };
}

function sameDaemon(left: CanonicalDaemonInfo, right: FleetCatalogResourceV1["daemon"]): boolean {
  return (
    left.protocolVersion === right.protocolVersion &&
    left.instanceId === right.instanceId &&
    left.startedAt === right.startedAt
  );
}

function resourceUrl(target: TuiToolResourceTarget, key: TuiToolResourceKey): string {
  const base = canonicalDaemonUrl("http", target.daemon.bindHostname, target.daemon.port);
  if (key === "fleet") return `${base}/api/resources/fleet-catalog`;
  if (key === "sessions") return `${base}/api/sessions`;
  if (key === "projects") return `${base}/api/projects`;
  const workspace = encodeURIComponent(target.workspaceName);
  const suffix = key === "files" ? "files" : key === "changes" ? "changes" : "missions";
  return `${base}/api/project/${workspace}/${suffix}`;
}

function socketUrl(target: TuiToolResourceTarget): string {
  return canonicalDaemonUrl(
    "ws",
    target.daemon.bindHostname,
    target.daemon.port,
    "/ws/events?mode=semantic",
  );
}

function interestFrames(target: TuiToolResourceTarget, interests: ReadonlySet<string>) {
  return [...interests].map((resource) =>
    resource === "fleet-catalog" || resource === "workspace-catalog"
      ? { resource, workspaceName: null }
      : { resource, workspaceName: target.workspaceName },
  );
}

function defaultSocket(url: string, ownerToken: string | null): ToolEventSocket {
  return new WebSocket(url, {
    headers: ownerToken ? { Authorization: `Bearer ${ownerToken}` } : undefined,
  }) as unknown as ToolEventSocket;
}

/**
 * TUI-only host adapter. It has no filesystem, git, repository, or subprocess
 * escape hatch: every tool projection comes from the canonical daemon and is
 * invalidated only by its explicitly subscribed semantic resource.
 */
export function createTuiToolResourceAdapter(
  dependencies: TuiToolResourceAdapterDependencies = {},
): PushResourceSessionAdapter<
  TuiToolResourceTarget,
  TuiToolResourceKey,
  TuiToolResource,
  TuiToolResourceFailure
> {
  const fetchImpl = dependencies.fetch ?? globalThis.fetch;
  const createSocket = dependencies.createSocket ?? defaultSocket;

  return {
    validateTarget(value) {
      if (
        !value ||
        typeof value !== "object" ||
        !("daemon" in value) ||
        !("workspaceName" in value) ||
        typeof (value as TuiToolResourceTarget).workspaceName !== "string" ||
        (value as TuiToolResourceTarget).workspaceName.trim().length === 0
      ) {
        return {
          ok: false,
          failure: failure("target-invalid", "A live daemon workspace is required.", false),
        };
      }
      const target = value as TuiToolResourceTarget;
      return {
        ok: true,
        target: { ...target, workspaceName: target.workspaceName.trim() },
        key: `${target.daemon.instanceId}\u0000${target.workspaceName.trim()}`,
      };
    },

    async fetch(target, key, signal) {
      let response: Response;
      try {
        response = await fetchImpl(resourceUrl(target, key), {
          method: "GET",
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
          failure: failure("network", "The daemon resource request failed.", true),
        };
      }
      if (!response.ok) {
        return {
          status: "failed",
          failure: failure(
            "http",
            `The daemon resource request returned HTTP ${response.status}.`,
            response.status >= 500,
          ),
        };
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return {
          status: "failed",
          failure: failure("schema", "The daemon resource was not valid JSON.", false),
        };
      }
      const parsed =
        key === "fleet"
          ? FleetCatalogResourceV1SchemaZ.safeParse(body)
          : key === "sessions"
            ? DaemonSessionsResponseSchemaZ.safeParse(body)
            : key === "projects"
              ? DaemonProjectsResponseSchemaZ.safeParse(body)
              : key === "files"
                ? WorkspaceFilesCatalogEnvelopeV1SchemaZ.safeParse(body)
                : key === "changes"
                  ? WorkspaceChangesCatalogEnvelopeV1SchemaZ.safeParse(body)
                  : WorkspaceMissionsEnvelopeV1SchemaZ.safeParse(body);
      if (
        !parsed.success ||
        ((key === "fleet" || key === "files" || key === "changes" || key === "missions") &&
          !sameDaemon(
            target.daemon,
            (parsed.data as { readonly daemon: FleetCatalogResourceV1["daemon"] }).daemon,
          ))
      ) {
        return {
          status: "failed",
          failure: failure("schema", "The daemon resource failed identity validation.", false),
        };
      }
      return {
        status: "ok",
        resource: { kind: key, value: parsed.data } as TuiToolResource,
      };
    },

    async connect(target, interests, handlers, signal) {
      let disposed = false;
      let desired = new Set(interests);
      let installed = new Set<string>();
      let activeSocket: ToolEventSocket | null = null;
      let verifiedSocket: ToolEventSocket | null = null;
      let cursor = 0;
      let everVerified = false;
      let nextInterestRevision = 1;
      const pendingAcks = new Map<
        number,
        { readonly resolve: () => void; readonly reject: (error: Error) => void }
      >();
      const offlineInterestWaiters = new Set<{
        readonly signature: string;
        readonly socket: ToolEventSocket | null;
        readonly resolve: () => void;
        readonly reject: (error: Error) => void;
      }>();
      let mutationTail = Promise.resolve();

      const interestSignature = (values: ReadonlySet<string>): string =>
        [...values].sort().join("\u0000");
      const rejectPendingAcks = (reason: string): void => {
        for (const pending of pendingAcks.values()) pending.reject(new Error(reason));
        pendingAcks.clear();
      };
      const rejectOfflineInterestWaiters = (reason: string): void => {
        for (const pending of offlineInterestWaiters) pending.reject(new Error(reason));
        offlineInterestWaiters.clear();
      };
      const retireSupersededInterestWaiters = (signature: string): void => {
        for (const pending of [...offlineInterestWaiters]) {
          if (pending.signature === signature) continue;
          offlineInterestWaiters.delete(pending);
          pending.reject(new Error("Daemon resource interests were superseded."));
        }
      };
      const rejectSocketInterestWaiters = (socket: ToolEventSocket, reason: string): void => {
        for (const pending of [...offlineInterestWaiters]) {
          if (pending.socket !== socket) continue;
          offlineInterestWaiters.delete(pending);
          pending.reject(new Error(reason));
        }
      };
      const settleOfflineInterestWaiters = (): void => {
        const signature = interestSignature(installed);
        for (const pending of [...offlineInterestWaiters]) {
          if (pending.signature !== signature) continue;
          offlineInterestWaiters.delete(pending);
          pending.resolve();
        }
      };

      const sendInterestMutation = (
        socket: ToolEventSocket,
        type: "subscribe" | "unsubscribe",
        values: ReadonlySet<string>,
      ): Promise<void> => {
        if (values.size === 0) return Promise.resolve();
        const interestRevision = nextInterestRevision++;
        return new Promise<void>((resolve, reject) => {
          pendingAcks.set(interestRevision, { resolve, reject });
          try {
            socket.send(
              JSON.stringify(
                DaemonEventClientFrameSchemaZ.parse({
                  type,
                  sessions: [],
                  interests: interestFrames(target, values),
                  legacyEvents: false,
                  interestRevision,
                  ...(type === "subscribe" ? { afterSequence: cursor } : {}),
                }),
              ),
            );
          } catch {
            pendingAcks.delete(interestRevision);
            reject(new Error("Daemon interest mutation could not be sent."));
          }
        });
      };

      const sendDelta = async (socket: ToolEventSocket): Promise<void> => {
        if (disposed) throw new Error("TUI resource session stopped.");
        if (socket !== verifiedSocket) throw new Error("Daemon event generation retired.");
        const added = new Set([...desired].filter((value) => !installed.has(value)));
        const removed = new Set([...installed].filter((value) => !desired.has(value)));
        await sendInterestMutation(socket, "unsubscribe", removed);
        await sendInterestMutation(socket, "subscribe", added);
        if (disposed || socket !== verifiedSocket)
          throw new Error("Daemon event generation retired.");
        installed = new Set(desired);
        settleOfflineInterestWaiters();
      };

      const installDesired = (socket: ToolEventSocket): Promise<void> => {
        const signature = interestSignature(desired);
        retireSupersededInterestWaiters(signature);
        const settled = new Promise<void>((resolve, reject) => {
          offlineInterestWaiters.add({ signature, socket, resolve, reject });
        });
        // One ordered mutation lane per adapter generation. Every queued pass
        // reads the latest desired set, so rapid dock switches collapse without
        // allowing subscribe/unsubscribe pairs to interleave.
        mutationTail = mutationTail
          .catch(() => undefined)
          .then(() => sendDelta(socket))
          .catch((error: unknown) => {
            if (socket === verifiedSocket) rejectOfflineInterestWaiters(String(error));
          });
        return settled;
      };

      // This supervisor is the sole transport retry owner. `connect()` stays
      // pending through pre-live failures, so PushResourceSession never starts
      // a second subscription retry ladder around WebSocket generations.
      const supervisor = createRuntimeConnectionSupervisor<null>({
        backoffMs: (attempt) => Math.min(4_000, 250 * 2 ** Math.max(0, attempt - 1)),
        async connect({ signal }) {
          if (signal.aborted || disposed) throw new Error("TUI resource session stopped.");
          const socket = createSocket(socketUrl(target), target.daemon.authToken);
          activeSocket = socket;
          verifiedSocket = null;
          installed = new Set();
          let verified = false;
          let live = false;
          let ended = false;
          let settleOpen!: () => void;
          let rejectOpen!: (error: unknown) => void;
          let settleClosed!: () => void;
          const opened = new Promise<void>((resolve, reject) => {
            settleOpen = resolve;
            rejectOpen = reject;
          });
          const closed = new Promise<void>((resolve) => {
            settleClosed = resolve;
          });
          const cleanupTransport = (): void => {
            signal.removeEventListener("abort", onAbort);
            socket.removeEventListener("open", onOpen);
            socket.removeEventListener("message", onMessage);
            socket.removeEventListener("close", onClose);
            socket.removeEventListener("error", onError);
            if (activeSocket === socket) activeSocket = null;
            if (verifiedSocket === socket) verifiedSocket = null;
          };
          const endTransport = (reason: string): void => {
            if (ended) return;
            ended = true;
            rejectPendingAcks(reason);
            rejectSocketInterestWaiters(socket, reason);
            cleanupTransport();
            if (!live) rejectOpen(new Error(reason));
            settleClosed();
          };
          const failClosed = (reason: string): void => {
            endTransport(reason);
            socket.close(1008, reason.slice(0, 120));
          };
          const onMessage = (event: { data?: unknown }): void => {
            const text = boundedEventText(event.data);
            if (text === null) {
              failClosed("Daemon event frame was oversized or non-text.");
              return;
            }
            let raw: unknown;
            try {
              raw = JSON.parse(text);
            } catch {
              failClosed("Daemon event frame was malformed.");
              return;
            }
            const parsed = DaemonEventServerFrameSchemaZ.safeParse(raw);
            if (!parsed.success) {
              failClosed("Daemon event frame failed validation.");
              return;
            }
            const frame = parsed.data;
            if (!verified) {
              if (frame.type !== "hello" || !sameDaemon(target.daemon, frame.daemon)) {
                failClosed("Daemon event hello failed identity validation.");
                return;
              }
              try {
                if (!everVerified) cursor = frame.eventSequence ?? 0;
                everVerified = true;
                verified = true;
                verifiedSocket = socket;
                void installDesired(socket).then(
                  () => {
                    live = true;
                    settleOpen();
                  },
                  () => {
                    verified = false;
                    failClosed("Daemon event subscription failed.");
                  },
                );
              } catch {
                verified = false;
                failClosed("Daemon event subscription failed.");
              }
              return;
            }
            if (frame.type === "hello") {
              failClosed("Daemon event socket sent a duplicate hello.");
              return;
            }
            if (frame.type === "resource.interests-ack") {
              cursor = Math.max(cursor, frame.sequence);
              const pending = pendingAcks.get(frame.interestRevision);
              if (!pending) return;
              pendingAcks.delete(frame.interestRevision);
              if (frame.unavailableInterests.length > 0) {
                pending.reject(new Error("A daemon resource observer was unavailable."));
              } else {
                pending.resolve();
              }
              return;
            }
            if (frame.type === "resource.observed") {
              cursor = Math.max(cursor, frame.sequence);
              return;
            }
            if (frame.type === "snapshot-required") {
              cursor = frame.currentSequence;
              handlers.invalidate();
              return;
            }
            if (frame.type !== "resource.changed") return;
            cursor = Math.max(cursor, frame.sequence);
            if (frame.workspaceName !== null && frame.workspaceName !== target.workspaceName)
              return;
            const keys = keysForInterest(frame.resource).filter((key) =>
              desired.has(INTEREST_BY_KEY[key]),
            );
            if (keys.length > 0) handlers.invalidate(keys);
          };
          const onClose = (): void => {
            endTransport(
              verified ? "Daemon event socket closed." : "Daemon event socket closed before hello.",
            );
          };
          const onError = (): void => {
            endTransport(
              verified ? "Daemon event socket failed." : "Daemon event socket failed before hello.",
            );
          };
          const onOpen = (): void => undefined;
          const onAbort = (): void => socket.close(1000, "TUI resource session stopped");
          signal.addEventListener("abort", onAbort, { once: true });
          socket.addEventListener("open", onOpen);
          socket.addEventListener("message", onMessage);
          socket.addEventListener("close", onClose);
          socket.addEventListener("error", onError);
          try {
            await opened;
          } catch (error) {
            cleanupTransport();
            socket.close(1000, "TUI event handshake retired");
            throw error;
          }
          return {
            value: null,
            closed,
            dispose() {
              endTransport("Daemon event generation retired.");
              socket.close(1000, "TUI event generation retired");
            },
          };
        },
      });
      let resolveFirstLive!: () => void;
      let rejectFirstLive!: (error: unknown) => void;
      const firstLive = new Promise<void>((resolve, reject) => {
        resolveFirstLive = resolve;
        rejectFirstLive = reject;
      });
      const unsubscribe = supervisor.subscribe((state) => {
        if (state.phase === "live") resolveFirstLive();
        if (state.phase === "failed") rejectFirstLive(state.error);
      });
      const onSessionAbort = (): void => {
        disposed = true;
        rejectFirstLive(new Error("TUI resource session aborted."));
        rejectPendingAcks("TUI resource session aborted.");
        rejectOfflineInterestWaiters("TUI resource session aborted.");
        void supervisor.stop();
      };
      signal.addEventListener("abort", onSessionAbort, { once: true });
      supervisor.start();
      if (signal.aborted) onSessionAbort();
      try {
        await firstLive;
      } catch (error) {
        signal.removeEventListener("abort", onSessionAbort);
        unsubscribe();
        throw error;
      }

      return {
        status: "connected",
        updateInterests(next) {
          desired = new Set(next);
          const signature = interestSignature(desired);
          retireSupersededInterestWaiters(signature);
          if (verifiedSocket) return installDesired(verifiedSocket);
          return new Promise<void>((resolve, reject) => {
            offlineInterestWaiters.add({ signature, socket: null, resolve, reject });
          });
        },
        close() {
          if (disposed) return;
          disposed = true;
          signal.removeEventListener("abort", onSessionAbort);
          unsubscribe();
          rejectPendingAcks("TUI resource session stopped.");
          rejectOfflineInterestWaiters("TUI resource session stopped.");
          void supervisor.stop();
        },
      };
    },

    rejectionFailure() {
      return failure("unavailable", "The daemon resource adapter rejected a request.", true);
    },
    retryable(value) {
      return value.retryable;
    },
    interestKey(key) {
      return INTEREST_BY_KEY[key];
    },
  };
}

export interface TuiToolResourceController {
  readonly session: PushResourceSession<
    TuiToolResourceTarget,
    TuiToolResourceKey,
    TuiToolResource,
    TuiToolResourceFailure
  >;
  markCatalogReady(): void;
  markTerminalReady(): void;
  setTarget(target: TuiToolResourceTarget | null): void;
  setOpenDock(resource: TuiDockResourceKey | null): void;
  subscribe(
    listener: (
      state: PushResourceSessionState<
        TuiToolResourceTarget,
        TuiToolResourceKey,
        TuiToolResource,
        TuiToolResourceFailure
      >,
    ) => void,
  ): () => void;
  getMetrics(): TuiToolResourceMetrics;
  noteRenderPass(): void;
  dispose(): void;
}

/** Terminal readiness is the hard demand gate; an idle TUI owns zero tool work. */
export function createTuiToolResourceController(
  adapter: ReturnType<typeof createTuiToolResourceAdapter>,
  options: PushResourceSessionOptions = {},
): TuiToolResourceController {
  const session = createPushResourceSession(adapter, null, options);
  let catalogReady = false;
  let terminalReady = false;
  let openDock: TuiDockResourceKey | null = null;
  let releaseFleet: (() => void) | null = null;
  let releaseSessions: (() => void) | null = null;
  let releaseProjects: (() => void) | null = null;
  let releaseDock: (() => void) | null = null;
  let publications = 0;
  let dirtyUpdates = 0;
  let previousState = session.getState();
  let renderPasses = 0;

  const reconcile = (): void => {
    if (catalogReady) {
      releaseFleet ??= session.activate("fleet");
      releaseSessions ??= session.activate("sessions");
      releaseProjects ??= session.activate("projects");
    }
    releaseDock?.();
    releaseDock = terminalReady && openDock ? session.activate(openDock) : null;
  };

  return {
    session,
    markCatalogReady() {
      if (catalogReady) return;
      catalogReady = true;
      reconcile();
    },
    markTerminalReady() {
      if (terminalReady) return;
      catalogReady = true;
      terminalReady = true;
      reconcile();
    },
    setTarget(target) {
      session.setTarget(target);
    },
    setOpenDock(resource) {
      if (openDock === resource) return;
      openDock = resource;
      if (terminalReady) reconcile();
    },
    subscribe(listener) {
      return session.subscribe((state) => {
        publications += 1;
        if (
          state.generation !== previousState.generation ||
          state.slots.size !== previousState.slots.size ||
          [...state.slots].some(([key, slot]) => previousState.slots.get(key) !== slot)
        )
          dirtyUpdates += 1;
        previousState = state;
        listener(state);
      });
    },
    getMetrics() {
      const metrics = session.getMetrics();
      return {
        toolFetches: metrics.fetchesStarted,
        invalidations: metrics.invalidationsObserved,
        statePublications: publications,
        dirtyUpdates,
        subprocessLaunches: 0,
        idleWakeups: 0,
        renderPasses,
        activeInterests: metrics.activeInterests,
      };
    },
    noteRenderPass() {
      renderPasses += 1;
    },
    dispose() {
      releaseDock?.();
      releaseFleet?.();
      releaseSessions?.();
      releaseProjects?.();
      releaseDock = null;
      releaseFleet = null;
      releaseSessions = null;
      releaseProjects = null;
      session.dispose();
    },
  };
}
