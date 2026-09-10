import { groupFleetEnvironments } from "@tmux-ide/daemon-client/fleet-environments";
import {
  fleetConnectionMessage,
  type FleetConnectionStatus,
} from "@tmux-ide/daemon-client/fleet-connection-status";
import { machineResourceKey } from "@tmux-ide/core";
import {
  applicationMachineAuthorityManager,
  type ApplicationMachineAuthorityHandle,
  type ApplicationMachineAuthorityManager,
} from "./application-machine-authority.ts";
import {
  createApplicationHomeCatalog,
  type ApplicationHomeCatalog,
  type ApplicationHomeCatalogSession,
  type ApplicationHomeCatalogSnapshot,
} from "./application-home-catalog.ts";

export interface ApplicationMachineCatalogSession extends ApplicationHomeCatalogSession {
  readonly machineId: string;
  readonly sourceId: string;
  readonly disabled: boolean;
}
export interface ApplicationMachineCatalogGroup {
  readonly id: string;
  readonly label: string;
  readonly state: "ready" | "connecting" | "disconnected";
  readonly sessions: readonly ApplicationMachineCatalogSession[];
  readonly note: string | null;
  readonly diagnostic?: FleetConnectionStatus;
  readonly environmentId?: string | null;
  readonly routeIds?: readonly string[];
  readonly identityConflict?: boolean;
}
export interface ApplicationMachineCatalogSnapshot {
  readonly selectedMachineId: string;
  readonly groups: readonly ApplicationMachineCatalogGroup[];
}
interface Entry {
  handle: ApplicationMachineAuthorityHandle;
  catalog: ApplicationHomeCatalog | null;
  stopCatalog: (() => void) | null;
  stopObserve: (() => void) | null;
  revision: number;
  snapshot: ApplicationHomeCatalogSnapshot;
  lastSessions: readonly ApplicationHomeCatalogSession[];
  binding: string | null;
  environmentId: string | null;
  generation: string | null;
}
const empty = (): ApplicationHomeCatalogSnapshot => ({
  phase: "loading",
  daemonInstanceId: null,
  sessions: [],
  note: null,
});

/** Per-machine catalog metadata only. This owner never opens pane-screen streams. */
export function createApplicationMachineCatalog(
  options: {
    manager?: Pick<ApplicationMachineAuthorityManager, "snapshot" | "getMachine" | "subscribe">;
    createCatalog?: (handle: ApplicationMachineAuthorityHandle) => ApplicationHomeCatalog;
  } = {},
) {
  const manager = options.manager ?? applicationMachineAuthorityManager;
  const createCatalog =
    options.createCatalog ??
    ((handle) =>
      createApplicationHomeCatalog({
        readCanonicalDaemonInfo: handle.read,
      }));
  const entries = new Map<string, Entry>();
  const preferredRoutes = new Map<string, string>();
  const listeners = new Set<(value: ApplicationMachineCatalogSnapshot) => void>();
  let started = false,
    disposed = false;
  let stopManager: (() => void) | null = null;
  let snapshot: ApplicationMachineCatalogSnapshot = {
    selectedMachineId: manager.snapshot().selectedMachineId,
    groups: [],
  };
  const publish = () => {
    if (disposed) return;
    const current = manager.snapshot();
    snapshot = {
      selectedMachineId: current.selectedMachineId,
      groups: current.machines.map((machine) => {
        const entry = entries.get(machine.id);
        const ready =
          machine.state === "ready" &&
          entry?.snapshot.phase === "live" &&
          entry.handle.read() !== null;
        const state =
          machine.state !== "ready"
            ? machine.state
            : ready
              ? "ready"
              : entry?.snapshot.phase === "unavailable"
                ? "disconnected"
                : "connecting";
        const diagnostic = entry?.handle.endpoint().diagnostic;
        return {
          id: machine.id,
          label: machine.label,
          state,
          diagnostic,
          note:
            diagnostic && diagnostic.phase !== "ready"
              ? fleetConnectionMessage(diagnostic)
              : (entry?.snapshot.note ?? null),
          sessions: (entry?.lastSessions ?? []).map((session) => ({
            ...session,
            sourceId: session.id,
            id: machineResourceKey(machine.id, "session", session.id),
            machineId: machine.id,
            disabled: !ready,
          })),
        };
      }),
    };
    const groups = snapshot.groups;
    snapshot = {
      ...snapshot,
      groups: groupFleetEnvironments(
        groups.map((group) => ({
          id: group.id,
          ready: group.state === "ready",
          environmentId: entries.get(group.id)?.environmentId ?? null,
          generation: entries.get(group.id)?.generation ?? null,
        })),
        current.selectedMachineId,
        preferredRoutes,
      ).map((joined) => {
        const group = groups.find((group) => group.id === joined.primaryRouteId)!;
        if (joined.environmentId && !joined.conflict)
          preferredRoutes.set(joined.environmentId, group.id);
        return {
          ...group,
          environmentId: joined.environmentId,
          routeIds: joined.routeIds,
          identityConflict: joined.conflict,
          note: joined.conflict
            ? "Conflicting environment identities. Verify these routes before combining them."
            : group.note,
          sessions: group.sessions.map((session) => ({
            ...session,
            id:
              session.liveSessionId && joined.environmentId && !joined.conflict
                ? JSON.stringify([joined.environmentId, "session", session.liveSessionId])
                : session.id,
          })),
        };
      }),
    };
    for (const listener of [...listeners]) {
      try {
        listener(snapshot);
      } catch {
        /* View observers never own transport state. */
      }
    }
  };
  const stopCatalog = (entry: Entry) => {
    entry.revision++;
    entry.stopCatalog?.();
    entry.stopCatalog = null;
    entry.catalog?.dispose();
    entry.catalog = null;
    entry.binding = null;
  };
  const bind = (entry: Entry, force = false) => {
    if (disposed) return;
    const daemon = entry.handle.read();
    if (!daemon && entry.handle.kind === "ssh") {
      stopCatalog(entry);
      entry.snapshot = {
        ...empty(),
        phase: "unavailable",
        note: "Machine disconnected. Reconnecting…",
      };
      publish();
      return;
    }
    const binding = daemon
      ? JSON.stringify([daemon.instanceId, daemon.startedAt, daemon.bindHostname, daemon.port])
      : "local-unavailable";
    if (!force && entry.catalog && entry.binding === binding) return;
    stopCatalog(entry);
    entry.binding = binding;
    entry.snapshot = empty();
    const revision = entry.revision;
    const catalog = createCatalog(entry.handle);
    entry.catalog = catalog;
    entry.stopCatalog = catalog.subscribe((value) => {
      if (disposed || entries.get(entry.handle.id) !== entry || entry.revision !== revision) return;
      const current = entry.handle.read();
      if (value.phase === "live" && (!current || value.daemonInstanceId !== current.instanceId))
        return;
      entry.snapshot = value;
      if (value.phase === "live") {
        entry.lastSessions = value.sessions;
        entry.environmentId = current?.environmentId ?? null;
        entry.generation = current ? JSON.stringify([current.instanceId, current.startedAt]) : null;
      }
      publish();
    });
    catalog.start();
  };
  const remove = (entry: Entry) => {
    stopCatalog(entry);
    entry.stopObserve?.();
    entry.stopObserve = null;
  };
  const reconcile = () => {
    if (disposed || !started) return;
    const current = manager.snapshot();
    const present = new Set(current.machines.map(({ id }) => id));
    for (const [id, entry] of entries) {
      if (!present.has(id) || manager.getMachine(id) !== entry.handle) {
        remove(entry);
        entries.delete(id);
      }
    }
    for (const machine of current.machines) {
      const handle = manager.getMachine(machine.id);
      if (!handle) continue;
      let entry = entries.get(machine.id);
      if (!entry) {
        entry = {
          handle,
          catalog: null,
          stopCatalog: null,
          stopObserve: null,
          revision: 0,
          snapshot: empty(),
          lastSessions: [],
          binding: null,
          environmentId: null,
          generation: null,
        };
        entries.set(machine.id, entry);
        const owned = entry;
        void handle
          .observe(() => {
            if (!disposed && entries.get(handle.id) === owned) bind(owned, true);
          })
          .then((stop) => {
            if (disposed || entries.get(handle.id) !== owned) stop();
            else owned.stopObserve = stop;
          })
          .catch(() => {});
      }
      bind(entry);
    }
    publish();
  };
  const getSelectedCatalogSnapshot = (): ApplicationHomeCatalogSnapshot => {
    const entry = entries.get(snapshot.selectedMachineId);
    const group = snapshot.groups.find(({ id }) => id === snapshot.selectedMachineId);
    return {
      phase:
        group?.state === "ready"
          ? "live"
          : group?.state === "connecting"
            ? "loading"
            : "unavailable",
      daemonInstanceId:
        group?.state === "ready" ? (entry?.snapshot.daemonInstanceId ?? null) : null,
      // Existing selected-session controls must not offer stale rows as live targets.
      sessions: group?.state === "ready" ? group.sessions : [],
      note: group?.note ?? null,
    };
  };
  const owner = {
    getSnapshot: () => snapshot,
    getSelectedCatalogSnapshot,
    subscribe(listener: (value: ApplicationMachineCatalogSnapshot) => void) {
      if (disposed) return () => {};
      listeners.add(listener);
      listener(snapshot);
      return () => {
        listeners.delete(listener);
      };
    },
    start() {
      if (disposed || started) return;
      started = true;
      stopManager = manager.subscribe(reconcile);
      reconcile();
    },
    retry(machineId = snapshot.selectedMachineId) {
      const entry = entries.get(machineId);
      if (entry) bind(entry, true);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stopManager?.();
      stopManager = null;
      for (const entry of entries.values()) remove(entry);
      entries.clear();
      listeners.clear();
    },
  };
  const selectedCatalog: ApplicationHomeCatalog = {
    getSnapshot: getSelectedCatalogSnapshot,
    subscribe: (listener) => owner.subscribe(() => listener(getSelectedCatalogSnapshot())),
    start: owner.start,
    retry: () => owner.retry(),
    dispose: owner.dispose,
  };
  return { ...owner, selectedCatalog };
}
