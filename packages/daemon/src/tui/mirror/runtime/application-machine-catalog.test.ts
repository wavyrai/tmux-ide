import { describe, expect, it, vi } from "vitest";
import type { CanonicalDaemonInfo } from "@tmux-ide/contracts";
import { createApplicationMachineCatalog } from "./application-machine-catalog.ts";
import type {
  ApplicationHomeCatalog,
  ApplicationHomeCatalogSnapshot,
} from "./application-home-catalog.ts";
import type {
  ApplicationMachineAuthorityHandle,
  ApplicationMachineAuthoritySnapshot,
} from "./application-machine-authority.ts";

const REMOTE = "11111111-1111-4111-8111-111111111111";
const SECOND = "22222222-2222-4222-8222-222222222222";
const info = (port: number): CanonicalDaemonInfo => ({
  pid: 1,
  port,
  bindHostname: "127.0.0.1",
  protocolVersion: 2,
  productVersion: "test",
  instanceId: "33333333-3333-4333-8333-333333333333",
  startedAt: "2026-09-10T00:00:00.000Z",
  authToken: "fixture",
});
const live = (name = "shared"): ApplicationHomeCatalogSnapshot => ({
  phase: "live",
  daemonInstanceId: info(1).instanceId,
  sessions: [{ id: "same-daemon:same-session", name, paneCount: 2 }],
  note: null,
});
class Catalog implements ApplicationHomeCatalog {
  value: ApplicationHomeCatalogSnapshot = {
    phase: "loading",
    daemonInstanceId: null,
    sessions: [],
    note: null,
  };
  listeners = new Set<(value: ApplicationHomeCatalogSnapshot) => void>();
  allListeners: Array<(value: ApplicationHomeCatalogSnapshot) => void> = [];
  start = vi.fn();
  retry = vi.fn();
  dispose = vi.fn();
  getSnapshot = () => this.value;
  subscribe = (listener: (value: ApplicationHomeCatalogSnapshot) => void) => {
    this.listeners.add(listener);
    this.allListeners.push(listener);
    listener(this.value);
    return () => {
      this.listeners.delete(listener);
    };
  };
  emit(value: ApplicationHomeCatalogSnapshot) {
    this.value = value;
    for (const listener of this.listeners) listener(value);
  }
  emitLate(value: ApplicationHomeCatalogSnapshot) {
    for (const listener of this.allListeners) listener(value);
  }
}
function fixture(
  options: Pick<
    Parameters<typeof createApplicationMachineCatalog>[0] & {},
    "cachedRoutes" | "onCache"
  > = {},
) {
  const notifications = new Set<() => void>();
  let selected = "local";
  const machines = new Map<
    string,
    {
      handle: ApplicationMachineAuthorityHandle;
      daemon: CanonicalDaemonInfo | null;
      state: "ready" | "connecting" | "disconnected";
      observers: Set<(generation: string | null) => void>;
    }
  >();
  for (const [id, port] of [
    ["local", 1001],
    [REMOTE, 1002],
    [SECOND, 1003],
  ] as const) {
    const machine = {
      daemon: id === SECOND ? null : info(port),
      state: id === SECOND ? ("connecting" as const) : ("ready" as const),
      observers: new Set<(generation: string | null) => void>(),
      handle: null as unknown as ApplicationMachineAuthorityHandle,
    };
    machine.handle = {
      id,
      label: id === "local" ? "Local" : "Machine " + port,
      kind: id === "local" ? "local" : "ssh",
      ready: Promise.resolve(id !== SECOND),
      read: () => machine.daemon,
      isAlive: async () => machine.daemon !== null,
      endpoint: () => ({
        kind: id === "local" ? "local" : "ssh",
        remote: machine.daemon,
        localBaseUrl: null,
        epoch: 1,
        state: machine.state,
        label: id,
      }),
      observe: async (listener) => {
        machine.observers.add(listener);
        return () => {
          machine.observers.delete(listener);
        };
      },
    };
    machines.set(id, machine);
  }
  const manager = {
    snapshot: (): ApplicationMachineAuthoritySnapshot => ({
      selectedMachineId: selected,
      machines: [...machines.values()].map(({ handle, state }) => ({
        id: handle.id,
        label: handle.label,
        kind: handle.kind,
        state,
      })),
    }),
    getMachine: (id: string) => machines.get(id)?.handle ?? null,
    subscribe: (listener: () => void) => {
      notifications.add(listener);
      return () => {
        notifications.delete(listener);
      };
    },
  };
  const catalogs = new Map<string, Catalog[]>();
  const createCatalog = vi.fn((handle: ApplicationMachineAuthorityHandle) => {
    const catalog = new Catalog();
    catalogs.set(handle.id, [...(catalogs.get(handle.id) ?? []), catalog]);
    return catalog;
  });
  const owner = createApplicationMachineCatalog({ manager, createCatalog, ...options });
  const notify = () => {
    for (const listener of notifications) listener();
  };
  return {
    owner,
    manager,
    machines,
    catalogs,
    createCatalog,
    notify,
    select(id: string) {
      selected = id;
      notify();
    },
  };
}

describe("per-machine metadata catalogs", () => {
  it("keeps Local responsive and scopes duplicate session names without selection churn", () => {
    const f = fixture();
    f.owner.start();
    expect(f.createCatalog).toHaveBeenCalledTimes(2); // The connecting third host cannot block Local.
    f.catalogs.get("local")![0]!.emit(live());
    f.catalogs.get(REMOTE)![0]!.emit(live());
    const groups = f.owner.getSnapshot().groups;
    expect(groups.map((group) => group.state)).toEqual(["ready", "ready", "connecting"]);
    expect(groups[0]!.sessions[0]!.id).not.toBe(groups[1]!.sessions[0]!.id);
    expect(groups[0]!.sessions[0]!.sourceId).toBe(groups[1]!.sessions[0]!.sourceId);
    f.select(REMOTE);
    expect(f.owner.getSelectedCatalogSnapshot().sessions[0]!.id).toBe(groups[1]!.sessions[0]!.id);
    expect(f.createCatalog).toHaveBeenCalledTimes(2);
    expect(f.catalogs.get("local")![0]!.dispose).not.toHaveBeenCalled();
    f.catalogs.get("local")![0]!.emit(live("local-updated"));
    expect(f.owner.getSnapshot().groups[0]!.sessions[0]!.name).toBe("local-updated");
    f.owner.dispose();
  });
  it("retains disabled offline rows and rejects callbacks from a retired same-generation tunnel", async () => {
    const f = fixture();
    f.owner.start();
    await Promise.resolve();
    const remote = f.machines.get(REMOTE)!;
    const first = f.catalogs.get(REMOTE)![0]!;
    first.emit(live());
    f.select(REMOTE);
    remote.daemon = null;
    remote.state = "disconnected";
    f.notify();
    const stale = f.owner.getSnapshot().groups.find((group) => group.id === REMOTE)!;
    expect(stale.state).toBe("disconnected");
    expect(stale.sessions[0]!.disabled).toBe(true);
    expect(f.owner.selectedCatalog.getSnapshot().sessions).toEqual([]);
    first.emitLate(live("must-not-return"));
    expect(
      f.owner.getSnapshot().groups.find((group) => group.id === REMOTE)!.sessions[0]!.name,
    ).toBe("shared");
    remote.daemon = info(2002);
    remote.state = "ready";
    f.notify();
    const next = f.catalogs.get(REMOTE)!.at(-1)!;
    expect(next).not.toBe(first);
    next.emit(live("new-tunnel"));
    first.emitLate(live("stale-after-reconnect"));
    expect(f.owner.selectedCatalog.getSnapshot().sessions[0]!.name).toBe("new-tunnel");
    for (const observer of remote.observers) observer(remote.daemon.instanceId);
    expect(f.catalogs.get(REMOTE)).toHaveLength(3);
    expect(next.dispose).toHaveBeenCalledOnce();
    f.owner.dispose();
    expect(remote.observers.size).toBe(0);
  });
  it("disables a ready SSH host when its catalog fails and disposes removed machine subscriptions", async () => {
    const f = fixture();
    f.owner.start();
    await Promise.resolve();
    const remote = f.machines.get(REMOTE)!;
    const catalog = f.catalogs.get(REMOTE)![0]!;
    catalog.emit(live());
    catalog.emit({
      phase: "unavailable",
      daemonInstanceId: null,
      sessions: [],
      note: "metadata unavailable",
    });
    const group = f.owner.getSnapshot().groups.find((group) => group.id === REMOTE)!;
    expect(group.state).toBe("disconnected");
    expect(group.sessions[0]!.disabled).toBe(true);
    f.machines.delete(REMOTE);
    f.notify();
    expect(catalog.dispose).toHaveBeenCalledOnce();
    expect(remote.observers.size).toBe(0);
    catalog.emitLate(live("removed"));
    expect(f.owner.getSnapshot().groups.some((item) => item.id === REMOTE)).toBe(false);
    f.owner.dispose();
  });
  it("releases a generation observer whose subscription settles after disposal", async () => {
    const f = fixture();
    const remote = f.machines.get(REMOTE)!;
    const release = vi.fn();
    let settle!: (stop: () => void) => void;
    remote.handle = {
      ...remote.handle,
      observe: () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    };
    f.owner.start();
    f.owner.dispose();
    settle(release);
    await Promise.resolve();
    expect(release).toHaveBeenCalledOnce();
    expect(f.catalogs.get(REMOTE)![0]!.dispose).toHaveBeenCalledOnce();
  });
});

it("joins verified routes and preserves session keys over rename without redirecting selection", () => {
  const f = fixture();
  const environmentId = "44444444-4444-4444-8444-444444444444";
  for (const id of [REMOTE, SECOND]) {
    const machine = f.machines.get(id)!;
    machine.daemon = { ...info(id === REMOTE ? 1002 : 1003), environmentId };
    machine.state = "ready";
  }
  f.owner.start();
  const emit = (id: string, name: string, incarnation: string) => {
    f.catalogs
      .get(id)!
      .at(-1)!
      .emit({
        ...live(name),
        sessions: [{ id: `source:${incarnation}`, liveSessionId: incarnation, name, paneCount: 2 }],
      });
  };
  emit(REMOTE, "before", "live-session.aaaaaaaaaaaaaaaaaaaa");
  emit(SECOND, "before", "live-session.aaaaaaaaaaaaaaaaaaaa");
  const groups = f.owner.getSnapshot().groups;
  expect(groups).toHaveLength(2);
  expect(groups[1]!.routeIds).toEqual([REMOTE, SECOND]);
  const stable = groups[1]!.sessions[0]!.id;
  emit(REMOTE, "renamed", "live-session.aaaaaaaaaaaaaaaaaaaa");
  expect(f.owner.getSnapshot().groups[1]!.sessions[0]!.id).toBe(stable);
  emit(REMOTE, "renamed", "live-session.bbbbbbbbbbbbbbbbbbbb");
  expect(f.owner.getSnapshot().groups[1]!.sessions[0]!.id).not.toBe(stable);
  f.select(REMOTE);
  f.machines.get(REMOTE)!.daemon = null;
  f.machines.get(REMOTE)!.state = "disconnected";
  f.notify();
  expect(f.owner.getSnapshot().groups[1]!.id).toBe(SECOND);
  expect(f.manager.snapshot().selectedMachineId).toBe(REMOTE);
  expect(f.owner.getSelectedCatalogSnapshot().sessions).toEqual([]);
  f.owner.dispose();
});

it("shows cold-start cache as unavailable and isolates cache writer failure from live state", () => {
  const f = fixture({
    cachedRoutes: [
      {
        routeId: SECOND,
        environmentId: null,
        generation: null,
        seenAt: 1234,
        sessions: [{ id: "cached", name: "offline-session", paneCount: 1 }],
      },
    ],
    onCache: () => {
      throw new Error("disk unavailable");
    },
  });
  f.owner.start();
  const cached = f.owner.getSnapshot().groups.find((group) => group.id === SECOND)!;
  expect(cached.lastSeenAt).toBe(1234);
  expect(cached.sessions[0]!.disabled).toBe(true);
  f.catalogs.get(REMOTE)![0]!.emit(live());
  expect(f.owner.getSnapshot().groups.find((group) => group.id === REMOTE)!.state).toBe("ready");
  f.owner.dispose();
});
