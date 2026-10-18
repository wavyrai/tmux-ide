import { projectFleetDiagnostic, type NativeFleetDiagnostic } from "./fleet-diagnostic.ts";
import {
  createFleetPreferencePublication,
  type FleetPreferenceOwner,
} from "./fleet-preference-publication.ts";
import { createFleetServerRoutes } from "./fleet-server-routes.ts";
import type { NativeFleetServer } from "./fleet-server-publication.ts";
import type { HomeAgentSnapshot } from "../../../packages/presentation/src/home-agent-roster.ts";
import { createSharedAgentObservation } from "./shared-agent-observation.ts";
import { createMachineAgents } from "../../../packages/daemon/src/lib/machine-agents.ts";
import { createFleetAgentRoster } from "./fleet-agents.ts";
import { randomUUID } from "node:crypto";
import type {
  MachineConnectionHandle,
  MachineConnectionManager,
} from "../../../packages/daemon/src/lib/machine-connection-manager.ts";
import {
  createMachineCatalog,
  type MachineCatalogSession,
} from "../../../packages/daemon/src/lib/machine-catalog.ts";

type Catalog = ReturnType<typeof createMachineCatalog>;
export interface NativeFleetPublication {
  preferences?: ReturnType<ReturnType<typeof createFleetPreferencePublication>["metadata"]>;
  groups: {
    id: string;
    label: string;
    state: "ready" | "connecting" | "disconnected";
    diagnostic?: NativeFleetDiagnostic;
    conflict: boolean;
    retry: string | null;
    disconnect: string | null;
    collapsed: boolean;
    collapseAction: string | null;
    omittedSessions: number;
    servers: NativeFleetServer[];
    omittedServers: number;
    sessions: {
      favorite: boolean;
      favoriteAction: string | null;
      active: boolean;
      id: string;
      name: string;
      paneCount: number;
      sessionId: string | null;
      serverId: string | null;
      selection: string | null;
    }[];
  }[];
  omittedGroups: number;
}
interface Route {
  handle: MachineConnectionHandle;
  epoch: number;
  instance: string;
  session: MachineCatalogSession;
  key: string;
}

/** A stale displayed row must never resolve against a replacement daemon or SSH route. */
export class FleetSelectionError extends Error {
  constructor() {
    super("Machine or session changed. Refresh the fleet and select the session again.");
    this.name = "FleetSelectionError";
  }
}

/**
 * Metadata-only native projection over the TUI's shared fleet owner. The caller
 * supplies the manager explicitly so a private demo cannot discover a personal
 * daemon by accident. This owner disposes its catalog, never the borrowed manager.
 */
export function createNativeFleet(
  manager: MachineConnectionManager,
  changed: () => void,
  makeCatalog: (manager: MachineConnectionManager) => Catalog = (manager) =>
    createMachineCatalog({ manager }),
  makeAgents: typeof createMachineAgents = createMachineAgents,
  preferences?: FleetPreferenceOwner,
) {
  const catalog = makeCatalog(manager);
  const preferencePublication = createFleetPreferencePublication(preferences);
  let activeSession: string | null = null;
  const serverRoutes = createFleetServerRoutes(manager);
  let homeMachineId: string | null = null;
  const homeListeners = new Set<
    (value: { machineId: string | null; snapshot: HomeAgentSnapshot }) => void
  >();
  const publishHome = () => {
    const snapshot = agentRoster?.homeSnapshot();
    if (snapshot)
      for (const listener of [...homeListeners]) listener({ machineId: homeMachineId, snapshot });
  };
  let paletteQuery: string | null = null;
  let workspaceObservers = 0;
  let agentRoster: ReturnType<typeof createFleetAgentRoster> | undefined;
  let stopped = false;
  let started = false;
  let selectionRevision = 0;
  let stop = () => {};
  let routes = new Map<string, Route>();
  let retries = new Map<string, { handle: MachineConnectionHandle; epoch: number }>();
  let disconnects = new Map<string, { handle: MachineConnectionHandle; epoch: number }>();
  const canDisconnect = (entry: { handle: MachineConnectionHandle; epoch: number }) =>
    !stopped &&
    manager.getMachine(entry.handle.id) === entry.handle &&
    entry.handle.kind === "ssh" &&
    entry.handle.endpoint().state !== "disconnected" &&
    entry.handle.endpoint().epoch === entry.epoch;
  const canRetry = (entry: { handle: MachineConnectionHandle; epoch: number }) =>
    !stopped &&
    manager.getMachine(entry.handle.id) === entry.handle &&
    entry.handle.kind === "ssh" &&
    entry.handle.endpoint().state === "disconnected" &&
    entry.handle.endpoint().epoch === entry.epoch;
  let publication: NativeFleetPublication = { groups: [], omittedGroups: 0 };
  const current = (route: Route) => {
    const info = route.handle.read();
    return (
      !stopped &&
      manager.getMachine(route.handle.id) === route.handle &&
      route.handle.endpoint().state === "ready" &&
      route.handle.endpoint().epoch === route.epoch &&
      !!info &&
      JSON.stringify([info.instanceId, info.startedAt]) === route.instance
    );
  };
  const canonicalRoute = (key: string): Route | null => {
    const matches = catalog
      .getSnapshot()
      .groups.flatMap((group) =>
        group.state === "ready" && !group.identityConflict
          ? group.sessions
              .filter((session) => session.id === key && !session.disabled)
              .map((session) => ({ group, session }))
          : [],
      );
    if (matches.length !== 1) return null;
    const { session } = matches[0]!;
    const handle = manager.getMachine(session.machineId),
      info = handle?.read();
    if (!handle || !info || !session.server || !session.liveSessionId) return null;
    const route: Route = {
      handle,
      epoch: handle.endpoint().epoch,
      instance: JSON.stringify([info.instanceId, info.startedAt]),
      session: structuredClone(session),
      key: JSON.stringify([handle.id, session.sourceId, session.server, session.liveSessionId]),
    };
    return current(route) ? route : null;
  };
  const update = (refreshAgents = true) => {
    if (stopped) return;
    const snapshot = catalog.getSnapshot();
    const previous = new Map([...routes].map(([token, route]) => [route.key, { token, route }]));
    const next = new Map<string, Route>();
    const nextRetries = new Map<string, { handle: MachineConnectionHandle; epoch: number }>();
    const nextDisconnects = new Map<string, { handle: MachineConnectionHandle; epoch: number }>();
    serverRoutes.begin();
    const projected = preferencePublication.begin(snapshot.groups, activeSession);
    publication = {
      preferences: preferencePublication.metadata(),
      omittedGroups: Math.max(0, snapshot.groups.length - 64),
      groups: projected.map(({ group, sessions: visible }) => {
        const handle = manager.getMachine(group.id);
        let retry: string | null = null;
        if (handle && group.state === "disconnected" && !group.identityConflict) {
          const entry = { handle, epoch: handle.endpoint().epoch };
          if (canRetry(entry)) {
            retry =
              [...retries].find(([, old]) => old.handle === handle && canRetry(old))?.[0] ??
              randomUUID();
            nextRetries.set(retry, entry);
          }
        }
        let disconnect: string | null = null;
        if (handle) {
          const entry = { handle, epoch: handle.endpoint().epoch };
          if (canDisconnect(entry)) {
            disconnect =
              [...disconnects].find(
                ([, old]) => old.handle === handle && canDisconnect(old),
              )?.[0] ?? randomUUID();
            nextDisconnects.set(disconnect, entry);
          }
        }
        const serverPublication = serverRoutes.project(
          group.id,
          group.label.slice(0, 256),
          group.state === "ready" && !group.identityConflict,
          group.servers,
        );
        return {
          ...serverPublication,
          ...preferencePublication.group(group),
          id: group.id,
          disconnect,
          retry,
          label: group.label.slice(0, 256),
          state: group.state,
          diagnostic: projectFleetDiagnostic(group.diagnostic),
          conflict: !!group.identityConflict,
          omittedSessions: Math.max(0, group.sessions.length - visible.length),
          sessions: visible.map((session) => {
            let selection: string | null = null;
            const handle = manager.getMachine(session.machineId);
            const info = handle?.read();
            if (
              group.state === "ready" &&
              !group.identityConflict &&
              !session.disabled &&
              handle &&
              info &&
              session.server &&
              session.liveSessionId
            ) {
              const route: Route = {
                handle,
                epoch: handle.endpoint().epoch,
                instance: JSON.stringify([info.instanceId, info.startedAt]),
                session: structuredClone(session),
                key: JSON.stringify([
                  handle.id,
                  session.sourceId,
                  session.server,
                  session.liveSessionId,
                ]),
              };
              if (current(route)) {
                const prior = previous.get(route.key);
                selection = prior && current(prior.route) ? prior.token : randomUUID();
                next.set(selection, route);
              }
            }
            return {
              ...preferencePublication.session(session),
              id: session.id,
              name: session.name.slice(0, 512),
              paneCount: session.paneCount,
              sessionId: session.liveSessionId ?? null,
              serverId: serverPublication.servers.some(
                (server) =>
                  server.id === session.server?.serverId &&
                  server.generation === session.server?.generation,
              )
                ? session.server!.serverId
                : null,
              selection,
            };
          }),
        };
      }),
    };
    const filterReset =
      homeMachineId !== null && !publication.groups.some((group) => group.id === homeMachineId);
    if (filterReset) homeMachineId = null;
    serverRoutes.finish();
    routes = next;
    retries = nextRetries;
    disconnects = nextDisconnects;
    if (refreshAgents) agentRoster?.refresh();
    else if (filterReset) {
      agentRoster?.refresh(false);
      publishHome();
    }
    changed();
  };
  const observation = createSharedAgentObservation((publish) => {
    const roster = createFleetAgentRoster(
      makeAgents({ catalog, manager }),
      (machineId, row) =>
        [...routes].find(
          ([, route]) =>
            route.handle.id === machineId &&
            current(route) &&
            route.session.sourceId === row.sessionKey &&
            route.session.liveSessionId === row.liveSessionId &&
            route.session.server?.serverId === row.server?.serverId &&
            route.session.server?.generation === row.server?.generation,
        )?.[0] ?? null,
      (id) => catalog.getSnapshot().groups.find((group) => group.id === id)?.label ?? "Machine",
      publish,
      (id) =>
        catalog.getSnapshot().groups.find((group) => group.id === id)?.state ?? "disconnected",
      () => homeMachineId,
      (id) => catalog.getSnapshot().groups.find((group) => group.id === id)?.sessions.length ?? 0,
      () => paletteQuery,
      () => workspaceObservers > 0,
    );
    agentRoster = roster;
    roster.start();
    return () => {
      if (agentRoster === roster) agentRoster = undefined;
      roster.dispose();
    };
  });
  return {
    refreshPreferences: () => update(false),
    preferenceCommand: preferencePublication.command,
    setActiveSession(id: string | null) {
      if (activeSession !== id) {
        activeSession = id;
        update(false);
      }
    },
    start() {
      if (stopped || started) return;
      started = true;
      stop = catalog.subscribe(() => update());
      catalog.start();
    },
    observeAgents: observation.subscribe,
    observeWorkspaceAgents(listener: (snapshot: HomeAgentSnapshot) => void) {
      workspaceObservers++;
      agentRoster?.refresh();
      const unsubscribe = observation.subscribe(() => {
        const snapshot = agentRoster?.workspaceSnapshot();
        if (snapshot) listener(snapshot);
      });
      let disposed = false;
      return () => {
        if (disposed) return;
        disposed = true;
        workspaceObservers--;
        unsubscribe();
        agentRoster?.refresh();
      };
    },
    observePaletteAgents(query: string, listener: (value: HomeAgentSnapshot) => void) {
      paletteQuery = query;
      agentRoster?.refresh();
      const unsubscribe = observation.subscribe(listener);
      let disposed = false;
      return {
        update(nextQuery: string) {
          if (disposed) return;
          paletteQuery = nextQuery;
          agentRoster?.refresh();
        },
        dispose() {
          if (disposed) return;
          disposed = true;
          unsubscribe();
          paletteQuery = null;
          agentRoster?.refresh();
        },
      };
    },
    observeHomeAgents(
      listener: (value: { machineId: string | null; snapshot: HomeAgentSnapshot }) => void,
    ) {
      homeListeners.add(listener);
      const stop = observation.subscribe(() => {
        const snapshot = agentRoster?.homeSnapshot();
        if (snapshot) listener({ machineId: homeMachineId, snapshot });
      });
      return () => {
        homeListeners.delete(listener);
        stop();
      };
    },
    filterHomeAgents(machineId: string | null) {
      if (
        stopped ||
        (machineId !== null && !publication.groups.some((group) => group.id === machineId))
      )
        return false;
      homeMachineId = machineId;
      agentRoster?.refresh(false);
      publishHome();
      return true;
    },
    recoverAgents: (action: "retry" | "load-more") => agentRoster?.recover(action),
    resolveAgent: (key: string) => agentRoster?.resolve(key) ?? null,
    publication: () => structuredClone(publication),
    selectServer(token: string) {
      const route = serverRoutes.resolve(token);
      if (!manager.select(route.handle.id)) throw new FleetSelectionError();
      const selectedEpoch = manager.endpoint().epoch;
      const revision = ++selectionRevision;
      return {
        ...route,
        assertCurrent() {
          if (
            stopped ||
            selectionRevision !== revision ||
            manager.endpoint().epoch !== selectedEpoch ||
            manager.snapshot().selectedMachineId !== route.handle.id
          )
            throw new FleetSelectionError();
          route.assertCurrent();
        },
      };
    },
    retainedTarget(key: string) {
      const route = canonicalRoute(key);
      if (!route) return null;
      return {
        key,
        identity: route.key,
        label: route.session.name,
        hostLabel: route.handle.label,
        serverLabel: route.session.serverLabel ?? null,
      };
    },
    tabObservation(key: string) {
      const route = canonicalRoute(key);
      if (!route || !agentRoster) return null;
      const group = agentRoster
        .sourceSnapshot()
        .find((group) => group.machineId === route.handle.id);
      const state = group?.observation;
      const expectedSessions = catalog
        .getSnapshot()
        .groups.find((group) => group.id === route.handle.id)
        ?.sessions.filter((session) => !session.disabled).length;
      if (
        !group?.available ||
        !state ||
        state.phase !== "live" ||
        state.totalSessions !== expectedSessions ||
        state.observedSessions !== state.totalSessions ||
        state.unavailableSessionKeys.length > 0 ||
        state.loadingSessions ||
        state.unavailableSessions ||
        state.truncatedSessions ||
        state.refreshingSessionKeys.length
      )
        return null;
      const rows = group.agents.filter(
        (row) =>
          row.sessionKey === route.session.sourceId &&
          row.liveSessionId === route.session.liveSessionId &&
          row.server?.serverId === route.session.server?.serverId &&
          row.server?.generation === route.session.server?.generation,
      );
      if (
        rows.some((row) => row.disabled || !agentRoster?.currentSourceTarget(route.handle.id, row))
      )
        return null;
      return rows.map((row) => ({
        identity: JSON.stringify([
          row.agentId,
          row.paneId,
          row.daemonInstanceId,
          row.server,
          row.nativeIdentity,
          row.interactionEndpoint,
        ]),
        activity: row.activity,
        attention: row.attention,
      }));
    },
    // Retain identity, never a selection token or credentials. A new generation
    // is admitted only through the fresh, conflict-free catalog of this handle.
    recoveryRoute(key: string) {
      const original = canonicalRoute(key);
      if (!original) return null;
      const machine = original.handle;
      const environment = machine.read()?.environmentId;
      const serverId = original.session.server!.serverId;
      const liveSessionId = original.session.liveSessionId;
      return () => {
        if (
          stopped ||
          manager.getMachine(machine.id) !== machine ||
          machine.read()?.environmentId !== environment
        )
          return null;
        const matches = catalog
          .getSnapshot()
          .groups.filter(
            (group) =>
              group.id === machine.id && group.state === "ready" && !group.identityConflict,
          )
          .flatMap((group) => group.sessions)
          .filter(
            (session) =>
              !session.disabled &&
              session.server?.serverId === serverId &&
              session.liveSessionId === liveSessionId,
          );
        return matches.length === 1 && canonicalRoute(matches[0]!.id) ? matches[0]!.id : null;
      };
    },
    resolveCanonical(key: string) {
      return canonicalRoute(key) !== null;
    },
    canonicalKey(machineId: string, serverId: string, generation: string, liveSessionId: string) {
      const matches = catalog
        .getSnapshot()
        .groups.flatMap((group) => group.sessions)
        .filter(
          (session) =>
            session.machineId === machineId &&
            session.server?.serverId === serverId &&
            session.server.generation === generation &&
            session.liveSessionId === liveSessionId &&
            !session.disabled,
        );
      return matches.length === 1 && canonicalRoute(matches[0]!.id) ? matches[0]!.id : null;
    },
    selectCanonical(key: string) {
      const route = canonicalRoute(key);
      if (!route || !manager.select(route.handle.id)) throw new FleetSelectionError();
      const selectedEpoch = manager.endpoint().epoch,
        revision = ++selectionRevision;
      const assertCurrent = () => {
        const fresh = canonicalRoute(key);
        if (
          selectionRevision !== revision ||
          manager.endpoint().epoch !== selectedEpoch ||
          manager.snapshot().selectedMachineId !== route.handle.id ||
          !current(route) ||
          !fresh ||
          fresh.key !== route.key ||
          fresh.handle !== route.handle ||
          fresh.instance !== route.instance
        )
          throw new FleetSelectionError();
      };
      assertCurrent();
      return { handle: route.handle, session: structuredClone(route.session), assertCurrent };
    },
    select(token: string) {
      const route = routes.get(token);
      if (!route || !current(route)) throw new FleetSelectionError();
      if (!manager.select(route.handle.id)) throw new FleetSelectionError();
      const selectedEpoch = manager.endpoint().epoch;
      const revision = ++selectionRevision;
      const assertCurrent = () => {
        if (
          selectionRevision !== revision ||
          manager.endpoint().epoch !== selectedEpoch ||
          manager.snapshot().selectedMachineId !== route.handle.id ||
          routes.get(token)?.key !== route.key ||
          !current(route)
        )
          throw new FleetSelectionError();
      };
      assertCurrent();
      return { handle: route.handle, session: structuredClone(route.session), assertCurrent };
    },
    retry: (token: string) => {
      const entry = retries.get(token);
      if (!entry || !canRetry(entry)) throw new FleetSelectionError();
      retries.delete(token);
      manager.retry(entry.handle.id);
      catalog.retry(entry.handle.id);
      update();
    },
    disconnect: (token: string) => {
      const entry = disconnects.get(token);
      if (!entry || !canDisconnect(entry)) throw new FleetSelectionError();
      disconnects.delete(token);
      manager.disconnect(entry.handle.id);
      update();
    },
    dispose() {
      if (stopped) return;
      stopped = true;
      stop();
      observation.dispose();
      homeListeners.clear();
      catalog.dispose();
      serverRoutes.dispose();
      routes.clear();
      retries.clear();
      disconnects.clear();
      publication = { groups: [], omittedGroups: 0 };
    },
  };
}
