import {
  projectMachineFleet,
  mergeMachineCatalogs,
  updateMachineCatalogs,
  type MachineCatalogs,
} from "./machine-catalog";
import type { Workspace, Settings } from "@superlogical/shared/model";
import type { ActionInput } from "@superlogical/shared/protocol";
import type {
  HostCapabilities,
  FleetCatalogResourceV1,
  ApplicationShellProjectionInputV1,
} from "@tmux-ide/contracts";
import { createDesktopFleetCatalogStore } from "../../desktop-renderer/src/runtime/fleet-catalog-store";
export interface Machine {
  home: string;
  name: string;
  platform: string;
}
export const bootstrap = null;
export interface LiveSnapshot {
  state: Workspace;
  machine: Machine;
  connection: "connecting" | "paired" | "offline";
  reason?: string;
  machines?: ReturnType<typeof mergeMachineCatalogs>["machines"];
}
const settingsKey = "tmux-ide.web.settings.v1";
let settings: Settings = { darkTheme: "dark", lightTheme: "light", mode: "system", fontSize: 13 };
try {
  const saved = JSON.parse(localStorage.getItem(settingsKey) || "null");
  if (saved) settings = { ...settings, ...saved };
} catch {
  // Unavailable or invalid local preferences fall back to the defaults.
}
let revision = 0;
type ScopedHost = import("@tmux-ide/contracts").DesktopEnvironmentConnection;
type FleetHost = HostCapabilities;
interface Connection {
  id: string;
  label: string;
  epoch: number;
  host: HostCapabilities | null;
  scoped?: ScopedHost;
  store?: ReturnType<typeof createDesktopFleetCatalogStore>;
  stop?: () => void;
  routes: Map<string, string>;
  shells: Map<string, ApplicationShellProjectionInputV1>;
  instance: string;
  identity: string;
  disposed: boolean;
}
const connections = new Map<string, Connection>();
let catalogs: MachineCatalogs = new Map();
let lifetime = 0;
let nextConnectionEpoch = 0;
const localId = "local";
let stopEnvironments: (() => void) | undefined;
let listing = false;
let listAgain = false;
const lastSummaries = new Map<string, string>();
let running = false;
/** Own functions survive Electron contextBridge; AbortSignal prototype methods do not. */
export function bridgeAbortSignal(signal: AbortSignal) {
  return {
    aborted: signal.aborted,
    subscribeAbort: (callback: () => void) => {
      if (signal.aborted) callback();
      else signal.addEventListener("abort", callback, { once: true });
      return () => signal.removeEventListener("abort", callback);
    },
  };
}
function bridgeDaemon(daemon: HostCapabilities["daemon"]): HostCapabilities["daemon"] {
  return Object.fromEntries(
    Object.entries(daemon).map(([name, method]) => [
      name,
      typeof method !== "function"
        ? method
        : (...args: unknown[]) => {
            const forwarded = args.map((value) =>
              value &&
              typeof value === "object" &&
              "aborted" in value &&
              "addEventListener" in value
                ? bridgeAbortSignal(value as AbortSignal)
                : value,
            );
            return Reflect.apply(method, daemon, forwarded);
          },
    ]),
  ) as HostCapabilities["daemon"];
}
export function getHost(connectionId?: string): HostCapabilities {
  if (connectionId !== undefined) {
    const connection = connections.get(connectionId);
    if (!connection?.host || connection.disposed)
      throw Error("This machine is disconnected. Reconnect it first.");
    return connection.host;
  }
  const host = window.tmuxIdeHost;
  if (!host) throw Error("The daemon gateway is unavailable.");
  return host;
}
let current: LiveSnapshot = {
  state: { version: 1, revision: 0, panes: {}, tabs: [], settings },
  machine: { home: "", name: "Local", platform: navigator.platform },
  connection: "connecting",
};
const listeners = new Set<(snapshot: LiveSnapshot) => void>();
function publish(snapshot: LiveSnapshot) {
  current = snapshot;
  for (const listener of listeners) listener(snapshot);
}
function updateMerged() {
  const merged = mergeMachineCatalogs(catalogs, settings, ++revision);
  const statuses = [...catalogs.values()];
  publish({
    ...current,
    state: merged.workspace,
    machines: merged.machines,
    connection: statuses.some((entry) => entry.status === "paired")
      ? "paired"
      : statuses.some((entry) => entry.status === "connecting")
        ? "connecting"
        : "offline",
  });
}
function status(connection: Connection, value: "connecting" | "offline", reason?: string) {
  catalogs = updateMachineCatalogs(catalogs, {
    type: "status",
    connectionId: connection.id,
    epoch: connection.epoch,
    status: value,
    reason,
  });
  updateMerged();
}
function retire(connection: Connection) {
  connection.disposed = true;
  connection.stop?.();
  connection.store?.dispose();
  connection.scoped?.dispose();
  connection.host = null;
}
export function observeWorkspaceShell(
  instanceId: string,
  workspaceName: string,
  shell: ApplicationShellProjectionInputV1,
  sessionId?: string,
  connectionId = localId,
) {
  const connection = connections.get(connectionId);
  if (!connection || connection.disposed || connection.instance !== instanceId) return;
  if (sessionId) connection.routes.set(sessionId, workspaceName);
  if (JSON.stringify(connection.shells.get(workspaceName)) === JSON.stringify(shell)) return;
  connection.shells.set(workspaceName, shell);
  const snapshot = connection.store?.getState().snapshot;
  if (snapshot) {
    catalogs = updateMachineCatalogs(catalogs, {
      type: "catalog",
      connectionId,
      epoch: connection.epoch,
      catalog: snapshot.catalog,
      routes: connection.routes,
      shells: connection.shells,
    });
    updateMerged();
  }
}
/** Compatibility projection for callers that only need a local fixture. */
export function projectFleet(catalog: FleetCatalogResourceV1): Workspace {
  return projectMachineFleet(catalog, {
    settings,
    revision: ++revision,
    machineId: catalog.daemon.environmentId ?? catalog.daemon.instanceId,
    machineLabel: "Local",
  });
}
async function startConnection(id: string, label: string, root: FleetHost, local: boolean) {
  const previous = connections.get(id);
  if (previous) retire(previous);
  const connection: Connection = {
    id,
    label,
    epoch: ++nextConnectionEpoch,
    host: null,
    routes: new Map(),
    shells: new Map(),
    instance: "",
    identity: "",
    disposed: false,
  };
  connections.set(id, connection);
  catalogs = updateMachineCatalogs(catalogs, {
    type: "bind",
    connectionId: id,
    label,
    epoch: connection.epoch,
    daemonInstanceId: "",
  });
  updateMerged();
  const valid = () => running && connections.get(id) === connection && !connection.disposed;
  try {
    if (local) connection.host = root;
    else {
      const scoped = await root.environments!.open(id);
      if (!valid()) {
        scoped.dispose();
        return;
      }
      connection.scoped = scoped;
      const unavailableProjectAction = async (): Promise<never> => {
        throw Error("Project directory actions are unavailable for remote machines.");
      };
      connection.host = {
        ...root,
        bootstrap: () => scoped.bootstrap(),
        daemon: scoped.daemon,
        workspace: {
          openProjectDirectory: unavailableProjectAction,
          prepareProjectDirectory: unavailableProjectAction,
          commitPreparedOpen: unavailableProjectAction,
          cancelPreparedOpen: unavailableProjectAction,
        },
      };
    }
    const initialHost = { ...connection.host, daemon: bridgeDaemon(connection.host.daemon) };
    const bootPromise = initialHost.bootstrap();
    const host = (connection.host = {
      ...initialHost,
      bootstrap: async () => {
        const boot = await bootPromise;
        if (!valid()) throw Error("This machine connection has been retired.");
        return boot;
      },
    });
    const boot = await host.bootstrap();
    if (!valid()) return;
    if (boot.daemon.status !== "connected") throw Error(boot.daemon.reason);
    connection.instance = boot.daemon.identity.instanceId;
    connection.identity = verifiedIdentityKey(boot.daemon.identity);
    catalogs = updateMachineCatalogs(catalogs, {
      type: "bind",
      connectionId: id,
      label,
      epoch: (connection.epoch = ++nextConnectionEpoch),
      daemonInstanceId: connection.instance,
    });
    const routes = await host.daemon.fetchWorkspaceCatalog();
    if (!valid()) return;
    if (routes.status === "ok" && routes.envelope.daemon.instanceId === connection.instance) {
      for (const session of routes.envelope.liveSessions) {
        const intent = routes.envelope.intents.find(
          (value) => value.sessionName === session.sessionName && value.availability === "live",
        );
        if (intent) connection.routes.set(session.fleetSessionId, intent.workspaceName);
      }
    }
    const store = (connection.store = createDesktopFleetCatalogStore({
      host,
      daemon: boot.daemon,
    }));
    const update = () => {
      if (!valid()) return;
      const value = store.getState();
      if (value.snapshot && value.status === "live") {
        catalogs = updateMachineCatalogs(catalogs, {
          type: "catalog",
          connectionId: id,
          epoch: connection.epoch,
          catalog: value.snapshot.catalog,
          routes: connection.routes,
          shells: connection.shells,
        });
        updateMerged();
      } else
        status(
          connection,
          value.status === "loading" ? "connecting" : "offline",
          "reason" in value ? value.reason : undefined,
        );
    };
    connection.stop = store.subscribe(update);
    update();
    const pending = [...new Set(connection.routes.values())];
    await Promise.all(
      Array.from({ length: Math.min(4, pending.length) }, async () => {
        while (pending.length && valid()) {
          const workspaceName = pending.shift()!;
          const result = await host.daemon.fetchApplicationShell({ workspaceName });
          if (!valid()) return;
          if (result.status === "ok")
            observeWorkspaceShell(
              result.envelope.daemon.instanceId,
              workspaceName,
              result.envelope.resource,
              undefined,
              id,
            );
        }
      }),
    );
  } catch (error) {
    if (valid()) {
      status(
        connection,
        "offline",
        error instanceof Error ? error.message : "Cannot connect to machine",
      );
      retire(connection);
    }
  }
}
function verifiedIdentityKey(
  identity: import("@tmux-ide/contracts").DaemonInstanceIdentity,
): string {
  return JSON.stringify([
    identity.protocolVersion,
    identity.productVersion,
    identity.instanceId,
    identity.startedAt,
    identity.environmentId ?? null,
  ]);
}
async function refreshEnvironments(root: FleetHost) {
  if (!root.environments || !running) return;
  if (listing) {
    listAgain = true;
    return;
  }
  listing = true;
  const epoch = lifetime;
  try {
    const entries = await root.environments.list();
    if (!running || epoch !== lifetime) return;
    for (const entry of entries) {
      const local = entry.kind === "local-canonical";
      const routeId = local ? localId : entry.connectionId;
      const signature = JSON.stringify([entry.phase, entry.daemon]);
      const changed = lastSummaries.get(routeId) !== signature;
      lastSummaries.set(routeId, signature);
      const existing = connections.get(routeId);
      if (
        !existing ||
        (changed &&
          entry.phase === "ready" &&
          (existing.disposed ||
            (existing.instance &&
              entry.daemon?.status === "connected" &&
              verifiedIdentityKey(entry.daemon.identity) !== existing.identity)))
      )
        void startConnection(routeId, local ? "Local" : entry.label, root, local);
      else if (
        existing &&
        (entry.phase === "disconnected" || entry.phase === "needs-attention") &&
        !existing.disposed &&
        existing.instance
      ) {
        status(existing, "offline", entry.failure ?? "Machine disconnected");
        retire(existing);
      }
    }
  } catch {
    /* Local authority remains usable while environment listing is unavailable. */
  } finally {
    listing = false;
    if (listAgain && running && epoch === lifetime) {
      listAgain = false;
      queueMicrotask(() => {
        void refreshEnvironments(root);
      });
    }
  }
}
function start() {
  running = true;
  lifetime++;
  let root: FleetHost;
  try {
    root = getHost() as FleetHost;
  } catch (error) {
    publish({ ...current, connection: "offline", reason: String(error) });
    return;
  }
  void startConnection(localId, "Local", root, true);
  if (root.environments) {
    stopEnvironments = root.environments.onChanged(() => {
      void refreshEnvironments(root);
    });
    void refreshEnvironments(root);
  }
}
export function subscribeWorkspace(listener: (snapshot: LiveSnapshot) => void) {
  listeners.add(listener);
  listener(current);
  if (listeners.size === 1) start();
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      running = false;
      lifetime++;
      stopEnvironments?.();
      for (const connection of connections.values()) retire(connection);
      connections.clear();
    }
  };
}
export function retryConnection(connectionId = localId) {
  const previous = connections.get(connectionId);
  const root = getHost() as FleetHost;
  void startConnection(connectionId, previous?.label ?? "Local", root, connectionId === localId);
}
export async function request<T>(path: string): Promise<T> {
  if (path === "/api/state") return current as T;
  throw Error("Unsupported frontend request");
}
export async function action(
  input: ActionInput,
): Promise<{ state: Workspace; selectedTab?: string; close?: { closed: number; hidden: number } }> {
  if (input.type === "settings") {
    settings = { ...settings, ...input.settings };
    localStorage.setItem(settingsKey, JSON.stringify(settings));
    publish({ ...current, state: { ...current.state, settings, revision: ++revision } });
    return { state: current.state };
  }
  throw Error("This action is not connected yet. Live catalog is read-only.");
}
export const socketUrl = (_path: string): string => {
  throw Error("Legacy mock terminal protocol is disabled.");
};
