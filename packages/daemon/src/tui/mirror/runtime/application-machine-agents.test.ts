import { describe, expect, it, vi } from "vitest";
import type { CanonicalDaemonInfo } from "@tmux-ide/contracts";
import { createApplicationMachineAgents } from "./application-machine-agents.ts";
import type { ApplicationMachineAuthorityHandle } from "./application-machine-authority.ts";
import type { ApplicationMachineCatalogSnapshot } from "./application-machine-catalog.ts";
import type { ApplicationHomeAgentObserver } from "./application-home-agent-observer.ts";
import type { HomeAgentRow, HomeAgentSnapshot } from "./application-home-agents.ts";

const remote = "11111111-1111-4111-8111-111111111111";
const row: HomeAgentRow = {
  key: "session\u0000agent",
  sessionKey: "session",
  sessionName: "shared",
  liveSessionId: "session",
  daemonInstanceId: "generation",
  agentId: "agent",
  paneId: "%1",
  name: "Agent",
  harness: "test",
  activity: "running",
  attention: false,
  projectName: "project",
};
const value = (rows: readonly HomeAgentRow[]): HomeAgentSnapshot => ({
  phase: "live",
  rows,
  observedSessions: 1,
  totalSessions: 1,
  loadingSessions: 0,
  unavailableSessions: 0,
  truncatedSessions: 0,
  refreshingSessionKeys: [],
  unavailableSessionKeys: [],
  note: null,
});
function fixture() {
  let snapshot: ApplicationMachineCatalogSnapshot = {
    selectedMachineId: "local",
    groups: ["local", remote].map((id) => ({
      id,
      label: id,
      state: "ready",
      note: null,
      sessions: [
        {
          id: id + "scoped",
          sourceId: "session",
          machineId: id,
          disabled: false,
          name: "shared",
          paneCount: 1,
        },
      ],
    })),
  };
  const listeners = new Set<(snapshot: ApplicationMachineCatalogSnapshot) => void>();
  const epochs = new Map([
    ["local", 1],
    [remote, 1],
  ]);
  const handles = new Map(
    ["local", remote].map((id) => [
      id,
      {
        id,
        label: id,
        kind: id === "local" ? "local" : "ssh",
        ready: Promise.resolve(true),
        read: () =>
          ({
            instanceId: "generation",
            startedAt: "now",
            port: 1234,
            bindHostname: "127.0.0.1",
          }) as CanonicalDaemonInfo,
        endpoint: () => ({ kind: "local", epoch: epochs.get(id)! }),
        observe: async () => () => {},
        isAlive: async () => true,
      } as ApplicationMachineAuthorityHandle,
    ]),
  );
  const observers: Array<{
    machineId: string;
    observer: ApplicationHomeAgentObserver;
    emit(rows: readonly HomeAgentRow[]): void;
  }> = [];
  const owner = createApplicationMachineAgents({
    catalog: {
      getSnapshot: () => snapshot,
      subscribe: (listener) => {
        listeners.add(listener);
        listener(snapshot);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    manager: { getMachine: (id) => handles.get(id) ?? null },
    createObserver(handle) {
      let current: readonly HomeAgentRow[] = [];
      let disposed = false;
      const callbacks: Array<(snapshot: HomeAgentSnapshot) => void> = [];
      const observer: ApplicationHomeAgentObserver = {
        adoptCatalog: vi.fn(),
        setActive: vi.fn(),
        invalidate: vi.fn(),
        retry: vi.fn(),
        loadMore: vi.fn(),
        getSnapshot: () => value(current),
        isCurrentTarget: (target) => !disposed && current.includes(target as HomeAgentRow),
        subscribe: (listener) => {
          callbacks.push(listener);
          return () => {};
        },
        dispose: vi.fn(() => {
          disposed = true;
        }),
      };
      observers.push({
        machineId: handle.id,
        observer,
        emit(rows) {
          current = rows;
          for (const cb of callbacks) cb(value(rows));
        },
      });
      return observer;
    },
  });
  const emit = (next: ApplicationMachineCatalogSnapshot) => {
    snapshot = next;
    for (const cb of listeners) cb(snapshot);
  };
  owner.start();
  return { owner, observers, emit, epochs, snapshot: () => snapshot };
}

describe("machine agent metadata", () => {
  it("observes local and remote simultaneously with raw session identities and scoped immutable rows", () => {
    const f = fixture();
    expect(f.observers).toHaveLength(2);
    for (const observer of f.observers) {
      expect(observer.observer.adoptCatalog).toHaveBeenCalledWith(
        expect.objectContaining({ sessions: [expect.objectContaining({ id: "session" })] }),
      );
      observer.emit([row]);
    }
    const [local, ssh] = f.owner.getSnapshot();
    expect(local!.agents[0]!.id).not.toBe(ssh!.agents[0]!.id);
    expect(local!.agents[0]!.disabled).toBe(false);
    expect(Object.isFrozen(ssh!.agents[0])).toBe(true);
    f.emit({ ...f.snapshot(), selectedMachineId: remote });
    expect(f.observers).toHaveLength(2);
    f.owner.dispose();
  });
  it("keeps disconnected rows disabled and fences callbacks from the retired generation", () => {
    const f = fixture();
    f.observers[1]!.emit([row]);
    f.emit({
      ...f.snapshot(),
      groups: f
        .snapshot()
        .groups.map((g) => (g.id === remote ? { ...g, state: "disconnected" } : g)),
    });
    expect(f.owner.getSnapshot()[1]!.agents[0]!.disabled).toBe(true);
    expect(f.owner.isCurrentTarget(remote, row)).toBe(false);
    f.observers[1]!.emit([{ ...row, name: "late" }]);
    expect(f.owner.getSnapshot()[1]!.agents[0]!.name).toBe("Agent");
    f.epochs.set(remote, 2);
    f.emit({ ...f.snapshot(), groups: f.snapshot().groups.map((g) => ({ ...g, state: "ready" })) });
    expect(f.observers).toHaveLength(3);
    expect(f.owner.getSnapshot()[1]!.agents[0]!.disabled).toBe(true);
    f.observers[2]!.emit([{ ...row, name: "fresh" }]);
    expect(f.owner.getSnapshot()[1]!.agents[0]).toMatchObject({ name: "fresh", disabled: false });
    f.owner.dispose();
  });
  it("retires replaced endpoints and removed machines, and ignores all callbacks after disposal", () => {
    const f = fixture();
    f.observers[0]!.emit([row]);
    f.epochs.set("local", 2);
    expect(f.owner.isCurrentTarget("local", row)).toBe(false);
    f.emit(f.snapshot());
    expect(f.observers[0]!.observer.dispose).toHaveBeenCalledTimes(1);
    f.observers[0]!.emit([{ ...row, name: "stale" }]);
    expect(f.owner.getSnapshot()[0]!.agents[0]!.name).toBe("Agent");
    f.emit({ ...f.snapshot(), groups: f.snapshot().groups.slice(0, 1) });
    expect(f.observers[1]!.observer.dispose).toHaveBeenCalledTimes(1);
    f.owner.dispose();
    const last = f.owner.getSnapshot();
    f.observers[2]!.emit([]);
    expect(f.owner.getSnapshot()).toBe(last);
  });
});
