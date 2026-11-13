import { waitForRosterTarget } from "./roster-target-wait.ts";
import { isDeepStrictEqual } from "node:util";
import { machineResourceKey } from "@tmux-ide/core";
import {
  type MachineConnectionHandle,
  type MachineConnectionManager,
} from "./machine-connection-manager.ts";
import type { MachineCatalogSnapshot } from "./machine-catalog.ts";
import { createHomeAgentObserver, type HomeAgentObserver } from "./home-agent-observer.ts";
import { createHomeAgentTransport } from "./home-agent-transport.ts";
import type { HomeAgentRow, HomeAgentSnapshot } from "@tmux-ide/presentation/home-agent-roster";

export interface MachineAgent extends HomeAgentRow {
  readonly id: string;
  readonly machineId: string;
  readonly disabled: boolean;
}
export interface MachineAgentGroup {
  readonly available?: boolean;
  readonly observation?: HomeAgentSnapshot;
  readonly machineId: string;
  readonly agents: readonly MachineAgent[];
}
interface Entry {
  handle: MachineConnectionHandle;
  binding: string;
  observer: HomeAgentObserver | null;
  stop: (() => void) | null;
  rows: readonly HomeAgentRow[];
}

function bindingFor(handle: MachineConnectionHandle): string {
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
export function createMachineAgents(options: {
  catalog: {
    getSnapshot(): MachineCatalogSnapshot;
    subscribe(listener: (snapshot: MachineCatalogSnapshot) => void): () => void;
  };
  manager: Pick<MachineConnectionManager, "getMachine">;
  createObserver?: (handle: MachineConnectionHandle) => HomeAgentObserver;
}) {
  const manager = options.manager;
  const createObserver =
    options.createObserver ??
    ((handle) => createHomeAgentObserver(createHomeAgentTransport({ readDaemon: handle.read })));
  const entries = new Map<string, Entry>();
  const listeners = new Set<(groups: readonly MachineAgentGroup[]) => void>();
  let catalog = options.catalog.getSnapshot();
  let snapshot: readonly MachineAgentGroup[] = [];
  let stopCatalog: (() => void) | null = null;
  let disposed = false;
  let started = false;
  const publish = () => {
    if (disposed) return;
    const next = Object.freeze(
      catalog.groups.map((group) => {
        const entry = entries.get(group.id);
        const current = !!entry && entry.binding === bindingFor(entry.handle);
        return Object.freeze({
          machineId: group.id,
          observation: entry?.observer?.getSnapshot(),
          available:
            group.state === "ready" && current && entry?.observer?.getSnapshot().phase === "live",
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
    // Fresh authority checks above still run on every observation. Identical
    // presentation data must not invalidate the Home/sidebar/tab subscribers.
    if (isDeepStrictEqual(snapshot, next)) return;
    snapshot = next;
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
  const reconcile = (next: MachineCatalogSnapshot) => {
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
    subscribe(listener: (groups: readonly MachineAgentGroup[]) => void) {
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
    /** The machine's roster is re-reading a session right now. */
    isRefreshing(machineId: string): boolean {
      const observed = entries.get(machineId)?.observer?.getSnapshot();
      return (
        !!observed && (observed.refreshingSessionKeys.length > 0 || observed.loadingSessions > 0)
      );
    },
    /**
     * `isCurrentTarget` once the machine's roster has finished re-reading:
     * a row is not current during the read, and a click should wait for it.
     */
    whenCurrentTarget(machineId: string, row: HomeAgentRow, signal: AbortSignal): Promise<boolean> {
      return waitForRosterTarget({
        isCurrent: () => this.isCurrentTarget(machineId, row),
        refreshing: () => this.isRefreshing(machineId),
        subscribe: (listener) =>
          entries.get(machineId)?.observer?.subscribe(() => listener()) ?? (() => undefined),
        signal,
      });
    },
    retry() {
      for (const entry of entries.values()) entry.observer?.retry();
    },
    loadMore() {
      for (const entry of entries.values()) entry.observer?.loadMore();
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
