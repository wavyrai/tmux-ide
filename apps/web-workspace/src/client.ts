import type { Workspace, Settings, Pane, Layout } from "@superlogical/shared/model";
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
let routes = new Map<string, string>();
let daemonInstanceId: string | null = null;
const shells = new Map<string, ApplicationShellProjectionInputV1>();
export function observeWorkspaceShell(
  instanceId: string,
  workspaceName: string,
  shell: ApplicationShellProjectionInputV1,
  sessionId?: string,
) {
  if (instanceId !== daemonInstanceId) return;
  if (sessionId) routes.set(sessionId, workspaceName);
  if (JSON.stringify(shells.get(workspaceName)) === JSON.stringify(shell)) return;
  shells.set(workspaceName, shell);
  const snapshot = store?.getState().snapshot;
  if (snapshot) publish({ ...current, state: projectFleet(snapshot.catalog) });
}
export function getHost() {
  const host = (window as unknown as { tmuxIdeHost?: HostCapabilities }).tmuxIdeHost;
  if (!host) throw Error("The daemon gateway is unavailable.");
  return host;
}
let current: LiveSnapshot = {
  state: { version: 1, revision: 0, panes: {}, tabs: [], settings },
  machine: { home: "", name: "Local", platform: navigator.platform },
  connection: "connecting",
};
const listeners = new Set<(snapshot: LiveSnapshot) => void>();
let store: ReturnType<typeof createDesktopFleetCatalogStore> | null = null;
let stopStore: (() => void) | null = null;
let epoch = 0;
function publish(snapshot: LiveSnapshot) {
  current = snapshot;
  for (const listener of listeners) listener(snapshot);
}
/** Fleet IDs are display-only. They never become a terminal attachment target. */
export function projectFleet(catalog: FleetCatalogResourceV1): Workspace {
  const panes: Record<string, Pane> = {};
  const tabs = catalog.sessions.map((session) => {
    const shell = shells.get(routes.get(session.sessionId) ?? "");
    const agents =
      shell?.workspace.sidebar.agents.map((agent) => ({ ...agent, agentId: agent.paneId })) ??
      session.agents;
    const ids = agents.map((agent) => {
      const id = `${catalog.daemon.instanceId}:${agent.agentId}`;
      panes[id] = {
        id,
        createdAt: 0,
        cwd: session.projectLabel,
        command: agent.harness,
        status: "running",
        viewOnly: true,
        agent: { name: agent.name, activity: agent.activity },
      };
      return id;
    });
    if (!ids.length) {
      const id = `${catalog.daemon.instanceId}:${session.sessionId}:catalog`;
      panes[id] = {
        id,
        createdAt: 0,
        cwd: session.projectLabel,
        command: session.label,
        status: "running",
        viewOnly: true,
      };
      ids.push(id);
    }
    const layout = ids
      .map((id) => ({ type: "leaf" as const, id }))
      .reduce<Layout | null>(
        (tree, leaf) =>
          tree
            ? {
                type: "split",
                id: `catalog:${leaf.id}`,
                direction: "horizontal",
                ratio: 0.5,
                first: tree,
                second: leaf,
              }
            : leaf,
        null,
      )!;
    return {
      id: `${catalog.daemon.instanceId}:${session.sessionId}`,
      createdAt: 0,
      customName: true,
      hidden: false,
      name: session.label,
      machine: "Local",
      machineId: catalog.daemon.environmentId ?? catalog.daemon.instanceId,
      layout,
      paneCount: session.paneCount,
      workspaceName: routes.get(session.sessionId),
      fleetSessionId: session.sessionId,
      daemonInstanceId: catalog.daemon.instanceId,
    };
  });
  return { version: 1, revision: ++revision, panes, tabs, settings };
}
async function start() {
  const generation = ++epoch;
  const host = (window as unknown as { tmuxIdeHost?: HostCapabilities }).tmuxIdeHost;
  if (!host) {
    publish({
      ...current,
      connection: "offline",
      reason: "Start this frontend through the tmux-ide web gateway.",
    });
    return;
  }
  try {
    const boot = await host.bootstrap();
    if (generation !== epoch) return;
    if (boot.daemon.status !== "connected") throw Error(boot.daemon.reason);
    const catalog = await host.daemon.fetchWorkspaceCatalog();
    if (generation !== epoch) return;
    routes = new Map();
    daemonInstanceId = boot.daemon.identity.instanceId;
    shells.clear();
    if (
      catalog.status === "ok" &&
      catalog.envelope.daemon.instanceId === boot.daemon.identity.instanceId
    ) {
      for (const session of catalog.envelope.liveSessions) {
        const intent = catalog.envelope.intents.find(
          (intent) => intent.sessionName === session.sessionName && intent.availability === "live",
        );
        if (intent) routes.set(session.fleetSessionId, intent.workspaceName);
      }
    }
    store = createDesktopFleetCatalogStore({ host, daemon: boot.daemon });
    const update = () => {
      if (!store || generation !== epoch) return;
      const value = store.getState();
      publish({
        state: value.snapshot
          ? projectFleet(value.snapshot.catalog)
          : { ...current.state, revision: ++revision, panes: {}, tabs: [] },
        machine: { home: "", name: "Local", platform: boot.platform },
        connection:
          value.status === "live"
            ? "paired"
            : value.status === "loading"
              ? "connecting"
              : "offline",
        reason: "reason" in value ? value.reason : undefined,
      });
    };
    stopStore = store.subscribe(update);
    update();
    // Read semantic names/harnesses without opening terminal streams on Home.
    const pendingRoutes = [...new Set(routes.values())];
    await Promise.all(
      Array.from({ length: Math.min(4, pendingRoutes.length) }, async () => {
        while (pendingRoutes.length && generation === epoch) {
          const workspaceName = pendingRoutes.shift()!;
          const result = await host.daemon.fetchApplicationShell({ workspaceName });
          if (generation !== epoch) return;
          if (result.status === "ok")
            observeWorkspaceShell(
              result.envelope.daemon.instanceId,
              workspaceName,
              result.envelope.resource,
            );
        }
      }),
    );
  } catch (error) {
    if (generation === epoch)
      publish({
        ...current,
        connection: "offline",
        reason: error instanceof Error ? error.message : "Cannot connect to daemon",
      });
  }
}
export function subscribeWorkspace(listener: (snapshot: LiveSnapshot) => void) {
  listeners.add(listener);
  listener(current);
  if (listeners.size === 1) void start();
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      epoch++;
      stopStore?.();
      store?.dispose();
      stopStore = null;
      store = null;
    }
  };
}
export function retryConnection() {
  epoch++;
  stopStore?.();
  store?.dispose();
  store = null;
  void start();
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
