import { machineResourceKey } from "@tmux-ide/core";
import {
  applicationMachineAuthorityManager,
  type ApplicationMachineAuthorityHandle,
  type ApplicationMachineAuthorityManager,
} from "./application-machine-authority.ts";
import type { ApplicationMachineCatalogSnapshot } from "./application-machine-catalog.ts";
import {
  createApplicationHomeAgentObserver,
  type ApplicationHomeAgentObserver,
} from "./application-home-agent-observer.ts";
import { createApplicationHomeAgentTransport } from "./application-home-agent-transport.ts";
import type { HomeAgentRow } from "./application-home-agents.ts";

export interface ApplicationMachineAgent extends HomeAgentRow {
  readonly id: string;
  readonly machineId: string;
  readonly disabled: boolean;
}
export interface ApplicationMachineAgentGroup {
  readonly machineId: string;
  readonly agents: readonly ApplicationMachineAgent[];
}
interface Entry {
  handle: ApplicationMachineAuthorityHandle;
  binding: string;
  observer: ApplicationHomeAgentObserver | null;
  stop: (() => void) | null;
  rows: readonly HomeAgentRow[];
}

function bindingFor(handle: ApplicationMachineAuthorityHandle): string {
  const daemon = handle.read();
  return daemon
    ? JSON.stringify([
        handle.endpoint().epoch,
        daemon.instanceId,
        daemon.startedAt,
        daemon.bindHostname,
        daemon.port,
      ])
    : "";
}

/** Background semantic metadata only: no terminal client, screen stream or pane capture. */
export function createApplicationMachineAgents(options: {
  catalog: {
    getSnapshot(): ApplicationMachineCatalogSnapshot;
    subscribe(listener: (snapshot: ApplicationMachineCatalogSnapshot) => void): () => void;
  };
  manager?: Pick<ApplicationMachineAuthorityManager, "getMachine">;
  createObserver?: (handle: ApplicationMachineAuthorityHandle) => ApplicationHomeAgentObserver;
}) {
  const manager = options.manager ?? applicationMachineAuthorityManager;
  const createObserver =
    options.createObserver ??
    ((handle) =>
      createApplicationHomeAgentObserver(
        createApplicationHomeAgentTransport({ readDaemon: handle.read }),
      ));
  const entries = new Map<string, Entry>();
  const listeners = new Set<(groups: readonly ApplicationMachineAgentGroup[]) => void>();
  let catalog = options.catalog.getSnapshot();
  let snapshot: readonly ApplicationMachineAgentGroup[] = [];
  let stopCatalog: (() => void) | null = null;
  let disposed = false;
  let started = false;
  const publish = () => {
    if (disposed) return;
    snapshot = Object.freeze(
      catalog.groups.map((group) => {
        const entry = entries.get(group.id);
        const current = !!entry && entry.binding === bindingFor(entry.handle);
        return Object.freeze({
          machineId: group.id,
          agents: Object.freeze(
            (entry?.rows ?? []).map((row) =>
              Object.freeze({
                ...row,
                id: machineResourceKey(group.id, "agent", row.key),
                machineId: group.id,
                disabled:
                  group.state !== "ready" ||
                  !entry ||
                  !current ||
                  !entry.observer?.isCurrentTarget(row),
              }),
            ),
          ),
        });
      }),
    );
    for (const listener of listeners) {
      try {
        listener(snapshot);
      } catch {
        /* Presentation cannot own observation lifetime. */
      }
    }
  };
  const retire = (entry: Entry) => {
    const observer = entry.observer;
    entry.observer = null;
    entry.stop?.();
    entry.stop = null;
    observer?.dispose();
  };
  const reconcile = (next: ApplicationMachineCatalogSnapshot) => {
    if (disposed) return;
    catalog = next;
    const present = new Set(next.groups.map((group) => group.id));
    for (const [id, entry] of entries) {
      if (!present.has(id) || manager.getMachine(id) !== entry.handle) {
        retire(entry);
        entries.delete(id);
      }
    }
    for (const group of next.groups) {
      const handle = manager.getMachine(group.id);
      if (!handle) continue;
      let entry = entries.get(group.id);
      const daemon = handle.read();
      const binding = bindingFor(handle);
      if (!entry) {
        entry = { handle, binding, observer: null, stop: null, rows: [] };
        entries.set(group.id, entry);
      }
      if (group.state !== "ready" || !daemon) {
        retire(entry);
        continue;
      }
      if (entry.binding !== binding) {
        retire(entry);
        entry.binding = binding;
      }
      if (!entry.observer) {
        const owned = entry;
        const observer = createObserver(handle);
        entry.observer = observer;
        entry.stop = observer.subscribe((value) => {
          if (
            disposed ||
            entries.get(group.id) !== owned ||
            owned.observer !== observer ||
            owned.binding !== bindingFor(handle)
          )
            return;
          if (value.phase === "live" || value.observedSessions > 0) owned.rows = value.rows;
          publish();
        });
        observer.setActive(true);
      }
      entry.observer.adoptCatalog({
        phase: "live",
        daemonInstanceId: daemon.instanceId,
        note: group.note,
        sessions: group.sessions
          .filter((session) => !session.disabled)
          .map((session) => ({ ...session, id: session.sourceId })),
      });
    }
    publish();
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: (groups: readonly ApplicationMachineAgentGroup[]) => void) {
      if (disposed) return () => {};
      listeners.add(listener);
      listener(snapshot);
      return () => {
        listeners.delete(listener);
      };
    },
    isCurrentTarget(machineId: string, row: HomeAgentRow) {
      const entry = entries.get(machineId);
      return (
        !disposed &&
        catalog.groups.some((group) => group.id === machineId && group.state === "ready") &&
        !!entry &&
        entry.binding !== "" &&
        entry.binding === bindingFor(entry.handle) &&
        !!entry.observer?.isCurrentTarget(row)
      );
    },
    start() {
      if (started || disposed) return;
      started = true;
      stopCatalog = options.catalog.subscribe(reconcile);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stopCatalog?.();
      for (const entry of entries.values()) retire(entry);
      entries.clear();
      listeners.clear();
    },
  };
}
