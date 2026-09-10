import type { Workspace, Settings, Pane, Layout } from "@superlogical/shared/model";
import type {
  FleetCatalogResourceV1,
  ApplicationShellProjectionInputV1,
} from "@tmux-ide/contracts";

export interface MachineProjectionOptions {
  settings: Settings;
  revision: number;
  machineId: string;
  machineLabel: string;
  routes?: ReadonlyMap<string, string>;
  shells?: ReadonlyMap<string, ApplicationShellProjectionInputV1>;
  /** A display namespace, never an attachment target. Local defaults remain compatible. */
  identityPrefix?: string;
}

export interface MachineCatalogEntry {
  /** Host-owned connection identity; distinct from daemon-minted environment identity. */
  readonly connectionId: string;
  readonly label: string;
  readonly epoch: number;
  readonly daemonInstanceId: string;
  readonly status: "connecting" | "paired" | "offline";
  readonly reason?: string;
  readonly catalog: FleetCatalogResourceV1 | null;
  readonly routes: ReadonlyMap<string, string>;
  readonly shells: ReadonlyMap<string, ApplicationShellProjectionInputV1>;
}
export type MachineCatalogs = ReadonlyMap<string, MachineCatalogEntry>;
export type MachineCatalogUpdate =
  | {
      readonly type: "bind";
      readonly connectionId: string;
      readonly label: string;
      readonly epoch: number;
      readonly daemonInstanceId: string;
    }
  | {
      readonly type: "catalog";
      readonly connectionId: string;
      readonly epoch: number;
      readonly catalog: FleetCatalogResourceV1;
      readonly routes?: ReadonlyMap<string, string>;
      readonly shells?: ReadonlyMap<string, ApplicationShellProjectionInputV1>;
    }
  | {
      readonly type: "status";
      readonly connectionId: string;
      readonly epoch: number;
      readonly status: "connecting" | "offline";
      readonly reason?: string;
    };

/** Each independently supplied HostCapabilities connection owns its own epoch. */
export function updateMachineCatalogs(
  state: MachineCatalogs,
  update: MachineCatalogUpdate,
): MachineCatalogs {
  const previous = state.get(update.connectionId);
  let next: MachineCatalogEntry;
  if (update.type === "bind") {
    if (previous && update.epoch <= previous.epoch) return state;
    next = {
      connectionId: update.connectionId,
      label: update.label,
      epoch: update.epoch,
      daemonInstanceId: update.daemonInstanceId,
      status: "connecting",
      // Retain last-known display data; merge strips actionable routes while stale.
      catalog: previous?.catalog ?? null,
      routes: previous?.routes ?? new Map(),
      shells: previous?.shells ?? new Map(),
    };
  } else {
    if (!previous || previous.epoch !== update.epoch) return state;
    if (update.type === "catalog") {
      if (update.catalog.daemon.instanceId !== previous.daemonInstanceId) return state;
      next = {
        ...previous,
        status: "paired",
        reason: undefined,
        catalog: update.catalog,
        routes: new Map(update.routes),
        shells: new Map(update.shells),
      };
    } else next = { ...previous, status: update.status, reason: update.reason };
  }
  return new Map([...state, [update.connectionId, next]]);
}

/** Merge display catalogs only. Status/target lookup stays explicit beside the workspace. */
export function mergeMachineCatalogs(state: MachineCatalogs, settings: Settings, revision: number) {
  const workspace: Workspace = { version: 1, revision, settings, tabs: [], panes: {} };
  const tabConnections = new Map<string, string>();
  const machines = [...state.values()].map((entry) => ({
    connectionId: entry.connectionId,
    environmentId: entry.catalog?.daemon.environmentId,
    label: entry.label,
    status: entry.status,
    reason: entry.reason,
    /** A retained catalog may belong to the previous daemon incarnation. */
    stale: entry.status !== "paired" || entry.catalog?.daemon.instanceId !== entry.daemonInstanceId,
  }));
  for (const entry of state.values()) {
    if (!entry.catalog) continue;
    const current =
      entry.status === "paired" && entry.catalog.daemon.instanceId === entry.daemonInstanceId;
    const projected = projectMachineFleet(entry.catalog, {
      settings,
      revision,
      machineId: entry.connectionId,
      machineLabel: entry.label,
      identityPrefix: `${encodeURIComponent(entry.connectionId)}:${entry.catalog.daemon.instanceId}`,
      routes: entry.routes,
      shells: entry.shells,
    });
    if (!current) projected.tabs = projected.tabs.map(({ workspaceName: _route, ...tab }) => tab);
    workspace.tabs.push(
      ...projected.tabs.map((tab) => ({
        ...tab,
        connectionId: entry.connectionId,
        connectionStatus: entry.status,
      })),
    );
    Object.assign(workspace.panes, projected.panes);
    for (const tab of projected.tabs) tabConnections.set(tab.id, entry.connectionId);
  }
  return { workspace, machines, tabConnections };
}

/** Fleet IDs are display-only. They never become a terminal attachment target. */
export function projectMachineFleet(
  catalog: FleetCatalogResourceV1,
  {
    settings,
    revision,
    machineId,
    machineLabel,
    routes = new Map(),
    shells = new Map(),
    identityPrefix = catalog.daemon.instanceId,
  }: MachineProjectionOptions,
): Workspace {
  const panes: Record<string, Pane> = {};
  const tabs = catalog.sessions.map((session) => {
    const shell = shells.get(routes.get(session.sessionId) ?? "");
    const agents =
      shell?.workspace.sidebar.agents.map((agent) => ({ ...agent, agentId: agent.paneId })) ??
      session.agents;
    const ids = agents.map((agent) => {
      const id = `${identityPrefix}:${agent.agentId}`;
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
      const id = `${identityPrefix}:${session.sessionId}:catalog`;
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
      id: `${identityPrefix}:${session.sessionId}`,
      createdAt: 0,
      customName: true,
      hidden: false,
      name: session.label,
      machine: machineLabel,
      machineId,
      layout,
      paneCount: session.paneCount,
      workspaceName: routes.get(session.sessionId),
      fleetSessionId: session.sessionId,
      daemonInstanceId: catalog.daemon.instanceId,
    };
  });
  return { version: 1, revision, panes, tabs, settings };
}
