import { basename, dirname } from "node:path";
import { watch as watchFileSystem } from "node:fs";
import type {
  ActionInput,
  ActionName,
  ApplicationShellProjectionInputV1,
  TerminalReplicaPatchPayload,
  TerminalReplicaSnapshot,
  TerminalReplicaTombstonePayload,
} from "@tmux-ide/contracts";
import { dispatchOwnerAction } from "@tmux-ide/daemon-client/owner-action-client";
import { createWorkspaceClient } from "@tmux-ide/daemon-client/workspace-client";
import type {
  WorkspaceClient,
  WorkspaceClientOwnerActionPort,
} from "@tmux-ide/daemon-client/workspace-client-types";

import {
  canonicalDaemonUrl,
  getCanonicalDaemonInfoPath,
  readCanonicalDaemonInfo,
} from "../../../lib/canonical-daemon.ts";
import { ensureOpenTuiSessionWorkspace } from "../configless-session-bootstrap.ts";
import {
  OPEN_TUI_HOST_CLIENT_ID,
  connectOpenTuiWorkspaceRuntimePort,
  type ConnectOpenTuiWorkspaceRuntimePortOptions,
  type OpenTuiWorkspaceRuntimePort,
} from "../open-tui-workspace-runtime-port.ts";
import {
  resolveOpenTuiApplicationShellConnection,
  type OpenTuiApplicationShellConnection,
} from "../application-shell-daemon-connection.ts";
import { DaemonAuthorityRebindCoordinator } from "./daemon-authority-rebind.ts";
import type { OpenTuiRuntimeLayoutPresentation } from "./runtime-layout-presentation.ts";
import { TerminalFastLaneRendererAdapter } from "./terminal-fast-lane-renderer-adapter.ts";
import {
  createOpenTuiWorkspaceTerminalFastLane,
  type OpenTuiWorkspaceTerminalFastLane,
} from "./workspace-terminal-fast-lane.ts";

export type OpenTuiProductionWorkspaceClient = WorkspaceClient<
  ApplicationShellProjectionInputV1,
  TerminalReplicaSnapshot,
  TerminalReplicaPatchPayload,
  TerminalReplicaTombstonePayload
>;

export interface OpenTuiGenerationBundle {
  readonly connection: OpenTuiApplicationShellConnection;
  readonly client: OpenTuiProductionWorkspaceClient;
  readonly fastLane: OpenTuiWorkspaceTerminalFastLane;
  readonly adapter: TerminalFastLaneRendererAdapter;
  /** Revoke input, geometry and daemon routing while retaining the painted frame. */
  revoke(): void;
  dispose(): Promise<void>;
}

export type OpenTuiGenerationHostStatus =
  | "connecting"
  | "live"
  | "rebinding"
  | "empty"
  | "unavailable"
  | "disposed";

export interface OpenTuiGenerationHostSnapshot {
  readonly status: OpenTuiGenerationHostStatus;
  /** Monotonic paint identity; forces resident pane surfaces across a bundle swap. */
  readonly rendererEpoch: number;
  readonly daemonGeneration: string | null;
  readonly connection: OpenTuiApplicationShellConnection | null;
  readonly client: OpenTuiProductionWorkspaceClient | null;
  readonly fastLane: OpenTuiWorkspaceTerminalFastLane | null;
  readonly adapter: TerminalFastLaneRendererAdapter | null;
}

interface BundleCallbacks {
  readonly didActivateRuntime: (runtime: OpenTuiWorkspaceRuntimePort) => void;
  readonly didRetireRuntime: () => void;
  readonly didFaultRuntime: (error: Error) => void;
  readonly didRuntimeDiagnostic: (
    phase: Parameters<NonNullable<ConnectOpenTuiWorkspaceRuntimePortOptions["onDiagnostic"]>>[0],
    details: Readonly<Record<string, unknown>>,
  ) => void;
}

export interface OpenTuiGenerationHostDependencies {
  readonly resolveConnection: (
    sessionName: string,
  ) => Promise<OpenTuiApplicationShellConnection | null>;
  readonly buildBundle: (
    connection: OpenTuiApplicationShellConnection,
    callbacks: BundleCallbacks,
  ) => OpenTuiGenerationBundle;
  readonly createRebindCoordinator: () => DaemonAuthorityRebindCoordinator;
  readonly observeCanonicalGeneration: (
    listener: (daemonGeneration: string) => void,
  ) => Promise<() => void | Promise<void>>;
  readonly onDiagnostic: (
    phase: "connection-resolved" | "shell-lifecycle" | "runtime-progress" | "runtime-fault",
    details: Readonly<Record<string, unknown>>,
  ) => void;
}

export interface OpenTuiGenerationHost {
  getSnapshot(): OpenTuiGenerationHostSnapshot;
  subscribe(listener: (snapshot: OpenTuiGenerationHostSnapshot) => void): () => void;
  start(): Promise<boolean>;
  dispose(): Promise<void>;
}

function productionOwnerActions(): WorkspaceClientOwnerActionPort {
  return {
    async dispatch<Name extends ActionName>(request: {
      readonly target: { readonly daemon: { readonly instanceId: string } };
      readonly name: Name;
      readonly input: ActionInput<Name>;
      readonly operationId: string;
    }) {
      const daemon = readCanonicalDaemonInfo();
      if (!daemon || daemon.instanceId !== request.target.daemon.instanceId) return null;
      return dispatchOwnerAction({
        baseUrl: canonicalDaemonUrl("http", daemon.bindHostname, daemon.port),
        ownerToken: daemon.authToken ?? "",
        hostClientId: OPEN_TUI_HOST_CLIENT_ID,
        name: request.name,
        input: request.input,
        operationId: request.operationId,
      });
    },
  };
}

function buildProductionBundle(
  connection: OpenTuiApplicationShellConnection,
  callbacks: BundleCallbacks,
): OpenTuiGenerationBundle {
  if (!connection.routing) throw new Error("OpenTUI generation requires verified runtime routing");
  let fastLane: OpenTuiWorkspaceTerminalFastLane | null = null;
  const candidateStages = new WeakMap<OpenTuiWorkspaceRuntimePort, () => void>();
  let client!: OpenTuiProductionWorkspaceClient;
  client = createWorkspaceClient({
    target: connection.target,
    ports: {
      shell: connection.transport,
      connectRuntime: async (_target, inventory, signal, prepare) => {
        if (!fastLane) throw new Error("OpenTUI terminal fast lane is not initialized");
        // Candidate interests must exist before WorkspaceClient asks the
        // runtime to prepare. Staging is additive: the incumbent inventory and
        // its exact retained frame remain intact until atomic activation.
        const releaseStage = fastLane.lane.stagePanes(inventory.semanticPaneIds);
        try {
          const runtime = await connectOpenTuiWorkspaceRuntimePort({
            inventory,
            routing: connection.routing!,
            signal,
            prepareRuntime: prepare,
            onFault: callbacks.didFaultRuntime,
            onDiagnostic: callbacks.didRuntimeDiagnostic,
          });
          candidateStages.set(runtime, releaseStage);
          void runtime.closed
            .finally(() => {
              if (candidateStages.get(runtime) !== releaseStage) return;
              candidateStages.delete(runtime);
              releaseStage();
            })
            .catch(() => undefined);
          return runtime;
        } catch (error) {
          releaseStage();
          throw error;
        }
      },
      didActivateRuntime: (runtime, inventory) => {
        // Commit before releasing the additive candidate stage. This is the
        // sole point at which removed incumbent panes may be trimmed.
        fastLane?.lane.retainPanes(inventory.semanticPaneIds);
        const candidate = runtime as OpenTuiWorkspaceRuntimePort;
        const releaseStage = candidateStages.get(candidate);
        candidateStages.delete(candidate);
        releaseStage?.();
        callbacks.didActivateRuntime(runtime as OpenTuiWorkspaceRuntimePort);
      },
      didRetireRuntime: callbacks.didRetireRuntime,
      actions: productionOwnerActions(),
    },
  });
  fastLane = createOpenTuiWorkspaceTerminalFastLane(client, OPEN_TUI_HOST_CLIENT_ID);
  const activeFastLane = fastLane;
  const adapter = new TerminalFastLaneRendererAdapter(activeFastLane.lane);
  let revoked = false;
  let disposed = false;
  let revokePromise: Promise<void> | null = null;
  const revoke = (): void => {
    if (revoked) return;
    revoked = true;
    activeFastLane.dispose();
    revokePromise = client.dispose();
    connection.dispose();
  };
  return {
    connection,
    client,
    fastLane: activeFastLane,
    adapter,
    revoke,
    async dispose() {
      if (disposed) {
        await revokePromise;
        return;
      }
      disposed = true;
      // Renderer observers release before their source and authority.
      adapter.dispose();
      revoke();
      await revokePromise;
    },
  };
}

const DEFAULT_DEPENDENCIES: OpenTuiGenerationHostDependencies = {
  resolveConnection: async (sessionName) => {
    const routed = await resolveOpenTuiApplicationShellConnection(sessionName);
    if (routed) return routed;
    // A fresh daemon generation does not retain the previous ephemeral
    // promotion. Re-establish the ordinary-session workspace through the
    // typed owner action before minting a new generation-bound connection.
    if (!(await ensureOpenTuiSessionWorkspace(sessionName))) return null;
    return resolveOpenTuiApplicationShellConnection(sessionName);
  },
  buildBundle: buildProductionBundle,
  createRebindCoordinator: () => new DaemonAuthorityRebindCoordinator(),
  observeCanonicalGeneration: async (listener) => {
    const recordPath = getCanonicalDaemonInfoPath();
    const recordName = basename(recordPath);
    let stopped = false;
    let queued = false;
    const observe = (): void => {
      if (stopped || queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        if (stopped) return;
        const generation = readCanonicalDaemonInfo()?.instanceId;
        if (generation) listener(generation);
      });
    };
    const watcher = watchFileSystem(dirname(recordPath), (_event, filename) => {
      // Some platforms omit the filename for directory watches. Treat that as
      // an unknown directory mutation and re-read the one validated record.
      if (filename === null || filename.toString() === recordName) observe();
    });
    // A filesystem watcher error must never crash the renderer. The active
    // generation remains usable; a later app launch installs a fresh watcher.
    watcher.on("error", () => watcher.close());
    return () => {
      if (stopped) return;
      stopped = true;
      watcher.close();
    };
  },
  onDiagnostic: () => undefined,
};

interface Candidate {
  readonly epoch: number;
  readonly bundle: OpenTuiGenerationBundle;
  stopLifecycle: () => void;
  stopPresentation: (() => void) | null;
  readonly ready: Promise<boolean>;
  readonly settleReady: (usable: boolean) => void;
  revoked: boolean;
  settled: boolean;
}

const EMPTY_SNAPSHOT: OpenTuiGenerationHostSnapshot = Object.freeze({
  status: "unavailable",
  rendererEpoch: 0,
  daemonGeneration: null,
  connection: null,
  client: null,
  fastLane: null,
  adapter: null,
});

/**
 * Owns the one production client/fast-lane/paint bundle for a fixed tmux
 * session. A daemon mismatch prepares a clean generation off-screen; the
 * retained frame and published bundle swap together only after the new
 * WorkspaceClient activates its coherent runtime.
 */
export function createOpenTuiGenerationHost(
  sessionName: string,
  presentation: OpenTuiRuntimeLayoutPresentation,
  overrides: Partial<OpenTuiGenerationHostDependencies> = {},
): OpenTuiGenerationHost {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  const coordinator = dependencies.createRebindCoordinator();
  const listeners = new Set<(snapshot: OpenTuiGenerationHostSnapshot) => void>();
  let snapshot = EMPTY_SNAPSHOT;
  let active: Candidate | null = null;
  let candidate: Candidate | null = null;
  let disposed = false;
  let epoch = 0;
  let rendererEpoch = 0;
  let connectFlight: Promise<boolean> | null = null;
  let canonicalObserverEpoch = 0;
  let canonicalObserverFlight: Promise<void> | null = null;
  let stopCanonicalObserver: (() => void | Promise<void>) | null = null;
  let requestedCanonicalGeneration: string | null = null;
  const retirementPromises = new Set<Promise<void>>();

  const publish = (next: OpenTuiGenerationHostSnapshot): void => {
    if (disposed) return;
    snapshot = Object.freeze(next);
    for (const listener of [...listeners]) {
      try {
        listener(snapshot);
      } catch {
        // A view observer never owns generation lifecycle.
      }
    }
  };

  const disposeCandidate = (owner: Candidate | null): void => {
    if (!owner || owner.settled) return;
    owner.settled = true;
    owner.settleReady(false);
    owner.stopLifecycle();
    owner.stopPresentation?.();
    const retirement = owner.bundle.dispose().finally(() => retirementPromises.delete(retirement));
    retirementPromises.add(retirement);
  };

  const activate = (owner: Candidate, runtime: OpenTuiWorkspaceRuntimePort | null): void => {
    if (disposed || owner.settled || candidate !== owner) return;
    if (runtime) owner.stopPresentation = presentation.adopt(runtime);
    const previous = active;
    candidate = null;
    active = owner;
    owner.settleReady(true);
    publish({
      status: runtime ? "live" : "empty",
      rendererEpoch: ++rendererEpoch,
      daemonGeneration: owner.bundle.connection.target.daemon.instanceId,
      connection: owner.bundle.connection,
      client: owner.bundle.client,
      fastLane: owner.bundle.fastLane,
      adapter: owner.bundle.adapter,
    });
    // Publication is the atomic cutover boundary. Only now may the retained
    // generation release its socket, reducer and renderer adapter.
    if (previous && previous !== owner) disposeCandidate(previous);
  };

  const revokeRetainedGeneration = (owner: Candidate): void => {
    if (owner.revoked) return;
    owner.revoked = true;
    owner.bundle.revoke();
    publish({ ...snapshot, status: "rebinding" });
  };

  const connectFresh = (): Promise<boolean> => {
    if (disposed) return Promise.resolve(false);
    if (connectFlight) return connectFlight;
    const expectedEpoch = ++epoch;
    connectFlight = dependencies
      .resolveConnection(sessionName)
      .then((connection) => {
        if (disposed || expectedEpoch !== epoch) {
          connection?.dispose();
          return false;
        }
        if (!connection) {
          if (!active) publish({ ...EMPTY_SNAPSHOT, status: "unavailable" });
          return false;
        }
        dependencies.onDiagnostic("connection-resolved", {
          daemonGeneration: connection.target.daemon.instanceId,
          workspaceName: connection.workspaceName,
        });
        let owner: Candidate | null = null;
        let pendingRuntime: OpenTuiWorkspaceRuntimePort | null = null;
        let pendingEmpty = false;
        let resolveReady!: (usable: boolean) => void;
        const ready = new Promise<boolean>((resolve) => {
          resolveReady = resolve;
        });
        let readySettled = false;
        const settleReady = (usable: boolean): void => {
          if (readySettled) return;
          readySettled = true;
          resolveReady(usable);
        };
        let bundle: OpenTuiGenerationBundle;
        try {
          bundle = dependencies.buildBundle(connection, {
            didActivateRuntime(runtime) {
              if (!owner) {
                pendingRuntime = runtime;
                return;
              }
              activate(owner, runtime);
            },
            didRetireRuntime() {
              if (!owner) {
                pendingEmpty = true;
                return;
              }
              if (candidate === owner) activate(owner, null);
              else if (active === owner && !owner.revoked) {
                presentation.clear();
                publish({ ...snapshot, status: "empty" });
              }
            },
            didFaultRuntime(error) {
              dependencies.onDiagnostic("runtime-fault", { message: error.message });
            },
            didRuntimeDiagnostic(phase, details) {
              dependencies.onDiagnostic("runtime-progress", {
                runtimePhase: phase,
                ...details,
              });
            },
          });
        } catch (error) {
          connection.dispose();
          throw error;
        }
        owner = {
          epoch: expectedEpoch,
          bundle,
          stopLifecycle: () => undefined,
          stopPresentation: null,
          ready,
          settleReady,
          revoked: false,
          settled: false,
        };
        const owned = owner;
        const replacedCandidate = candidate;
        candidate = owned;
        if (replacedCandidate && replacedCandidate !== active) disposeCandidate(replacedCandidate);
        owned.stopLifecycle = bundle.client.subscribe("lifecycle", (lifecycle) => {
          if (disposed || owned.settled) return;
          dependencies.onDiagnostic("shell-lifecycle", {
            clientPhase: lifecycle.phase,
            shellStatus: lifecycle.shell.status,
            shellGeneration: lifecycle.shell.generation,
            inventoryResources:
              "data" in lifecycle.shell && lifecycle.shell.data
                ? (lifecycle.shell.data.terminalInventory?.resources.length ?? 0)
                : 0,
            inventoryAttachability:
              "data" in lifecycle.shell && lifecycle.shell.data
                ? (lifecycle.shell.data.terminalInventory?.resources.map((resource) => ({
                    status: resource.attachability.status,
                    semanticPaneId:
                      resource.attachability.status === "available"
                        ? resource.attachability.semanticPaneId
                        : null,
                  })) ?? [])
                : [],
          });
          const requested = coordinator.request(sessionName, lifecycle.shell, {
            // Coordinator requires immediate logical retirement. Physical
            // authority is revoked immediately; only the inert painted frame
            // remains until the replacement activates.
            retire: () => {
              if (active === owned && !owned.revoked) {
                revokeRetainedGeneration(owned);
                return;
              }
              if (candidate === owned) {
                candidate = null;
                disposeCandidate(owned);
              }
            },
            reconnect: connectFresh,
          });
          if (requested || candidate !== owned || active === owned) return;
          const shell = lifecycle.shell;
          if (
            shell.status === "live" &&
            shell.data.terminalInventory !== undefined &&
            shell.data.terminalInventory.resources.every(
              (resource) => resource.attachability.status !== "available",
            )
          ) {
            activate(owned, null);
            return;
          }
          if (
            shell.status === "unavailable" ||
            shell.status === "error" ||
            (shell.status === "degraded" && shell.code !== "daemon-identity-mismatch")
          ) {
            if (candidate === owned) candidate = null;
            disposeCandidate(owned);
            if (!active) publish({ ...EMPTY_SNAPSHOT, status: "unavailable" });
          }
        });
        if (pendingRuntime) activate(owned, pendingRuntime);
        else if (pendingEmpty) activate(owned, null);
        return owned.ready;
      })
      .catch(() => false)
      .finally(() => {
        connectFlight = null;
      });
    return connectFlight;
  };

  const observeCanonicalGeneration = (daemonGeneration: string): void => {
    if (disposed || requestedCanonicalGeneration === daemonGeneration) return;
    const currentGeneration = active?.bundle.connection.target.daemon.instanceId ?? null;
    const candidateGeneration = candidate?.bundle.connection.target.daemon.instanceId ?? null;
    if (currentGeneration === daemonGeneration || candidateGeneration === daemonGeneration) {
      requestedCanonicalGeneration = daemonGeneration;
      return;
    }
    requestedCanonicalGeneration = daemonGeneration;
    if (active) revokeRetainedGeneration(active);
    if (candidate) {
      const staleCandidate = candidate;
      candidate = null;
      disposeCandidate(staleCandidate);
    }
    // Invalidating the current discovery result fences an old daemon record
    // that happened to resolve concurrently with atomic daemon.json replace.
    epoch += 1;
    const flight = connectFlight;
    if (flight) {
      void flight.finally(() => {
        if (disposed || requestedCanonicalGeneration !== daemonGeneration) return;
        void connectFresh();
      });
      return;
    }
    void connectFresh();
  };

  const ensureCanonicalObserver = (): Promise<void> => {
    if (disposed || stopCanonicalObserver) return Promise.resolve();
    if (canonicalObserverFlight) return canonicalObserverFlight;
    const observerEpoch = ++canonicalObserverEpoch;
    canonicalObserverFlight = dependencies
      .observeCanonicalGeneration(observeCanonicalGeneration)
      .then((stop) => {
        if (disposed || observerEpoch !== canonicalObserverEpoch) {
          void Promise.resolve(stop());
          return;
        }
        stopCanonicalObserver = stop;
      })
      .catch(() => undefined)
      .finally(() => {
        canonicalObserverFlight = null;
      });
    return canonicalObserverFlight;
  };

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      if (disposed) return () => undefined;
      listeners.add(listener);
      listener(snapshot);
      return () => listeners.delete(listener);
    },
    async start() {
      if (!active) publish({ ...EMPTY_SNAPSHOT, status: "connecting" });
      await ensureCanonicalObserver();
      return connectFresh();
    },
    async dispose() {
      if (disposed) {
        await Promise.all([...retirementPromises]);
        return;
      }
      disposed = true;
      epoch += 1;
      canonicalObserverEpoch += 1;
      const stopObserver = stopCanonicalObserver;
      stopCanonicalObserver = null;
      const observerStopped = Promise.resolve(stopObserver?.());
      coordinator.dispose();
      const pending = candidate;
      const retained = active;
      candidate = null;
      active = null;
      disposeCandidate(pending);
      if (retained !== pending) disposeCandidate(retained);
      // The application root owns the reusable presentation. A session target
      // replacement may adopt a new host before this fixed-session host
      // retires; disposing the shared presentation here would tear down the
      // newly active session.
      snapshot = Object.freeze({ ...EMPTY_SNAPSHOT, status: "disposed" });
      for (const listener of [...listeners]) {
        try {
          listener(snapshot);
        } catch {
          // Disposal is deterministic even if a view observer fails.
        }
      }
      listeners.clear();
      await observerStopped;
      await Promise.all([...retirementPromises]);
    },
  };
}
