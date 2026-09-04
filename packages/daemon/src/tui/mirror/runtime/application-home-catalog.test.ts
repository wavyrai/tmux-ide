import type { CanonicalDaemonInfo, WorkspaceCatalogResourceV3 } from "@tmux-ide/contracts";
import type { PushResourceSessionAdapter } from "@tmux-ide/daemon-client/push-resource-session";
import { describe, expect, it, vi } from "vitest";

import {
  closeApplicationHomeCatalogTransport,
  createApplicationHomeCatalog,
  moveHomeCatalogSelection,
  selectedHomeCatalogIndex,
  type ApplicationHomeCatalogFailure,
  type ApplicationHomeCatalogResource,
  type ApplicationHomeCatalogResourceKey,
  type ApplicationHomeCatalogTarget,
} from "./application-home-catalog.ts";

const daemon = (instanceId: string, port: number): CanonicalDaemonInfo => ({
  pid: port,
  port,
  protocolVersion: 1,
  productVersion: "test",
  instanceId,
  startedAt: `2026-08-31T00:00:0${port % 10}.000Z`,
  bindHostname: "127.0.0.1",
  authToken: "owner",
});

const DAEMON_A = daemon("11111111-1111-4111-8111-111111111111", 4040);
const DAEMON_B = daemon("22222222-2222-4222-8222-222222222222", 4041);

function catalog(
  owner: CanonicalDaemonInfo,
  sessions: readonly { readonly id: string; readonly name: string }[],
): WorkspaceCatalogResourceV3 {
  return {
    version: 3,
    daemon: owner,
    intents: [],
    liveSessions: sessions.map(({ id, name }) => ({
      liveSessionId: `live-session.${id}`,
      sessionName: name,
      fleetSessionId: `session.${id}`,
      paneCount: 1,
    })),
  };
}

class FakeClock {
  readonly callbacks = new Map<number, () => void>();
  #next = 1;

  setTimeout(callback: () => void): number {
    const id = this.#next++;
    this.callbacks.set(id, callback);
    return id;
  }

  clearTimeout(id: unknown): void {
    this.callbacks.delete(id as number);
  }

  runNext(): void {
    const entry = this.callbacks.entries().next().value as [number, () => void] | undefined;
    if (!entry) throw new Error("no retry scheduled");
    this.callbacks.delete(entry[0]);
    entry[1]();
  }
}

type Adapter = PushResourceSessionAdapter<
  ApplicationHomeCatalogTarget,
  ApplicationHomeCatalogResourceKey,
  ApplicationHomeCatalogResource,
  ApplicationHomeCatalogFailure
>;

function adapterHarness(
  read: (target: ApplicationHomeCatalogTarget) => Promise<WorkspaceCatalogResourceV3>,
) {
  let retire = () => undefined;
  let invalidate = (_keys?: readonly ApplicationHomeCatalogResourceKey[]) => undefined;
  const adapter: Adapter = {
    validateTarget(value) {
      if (!value) {
        return {
          ok: false,
          failure: { code: "target-invalid", message: "missing", retryable: false },
        };
      }
      const target = value as ApplicationHomeCatalogTarget;
      return { ok: true, target, key: target.daemon.instanceId };
    },
    async fetch(target, key) {
      if (key !== "live-catalog") throw new Error(`unexpected key ${key}`);
      return { status: "ok", resource: { kind: "live-catalog", value: await read(target) } };
    },
    connect(_target, _interests, handlers) {
      invalidate = handlers.invalidate;
      return { status: "connected", close: () => undefined };
    },
    rejectionFailure: () => ({
      code: "unavailable",
      message: "rejected",
      retryable: false,
    }),
    retryable: (failure) => failure.retryable,
    interestKey: () => "workspace-catalog",
  };
  return {
    adapter,
    bindRetirement(callback: () => void) {
      retire = callback;
      return adapter;
    },
    retire: () => retire(),
    invalidate: () => invalidate(["live-catalog"]),
  };
}

describe("application Home catalog", () => {
  it("retains live incarnation identities while a same-daemon push refresh is pending", async () => {
    const first = catalog(DAEMON_A, [{ id: "aaaaaaaaaaaaaaaaaaaa", name: "alpha" }]);
    let resolveRefresh!: (value: WorkspaceCatalogResourceV3) => void;
    let reads = 0;
    const harness = adapterHarness(async () =>
      ++reads === 1
        ? first
        : new Promise((resolve) => {
            resolveRefresh = resolve;
          }),
    );
    const owner = createApplicationHomeCatalog({
      readCanonicalDaemonInfo: () => DAEMON_A,
      createAdapter: (retired) => harness.bindRetirement(retired),
    });
    owner.start();
    await vi.waitFor(() => expect(owner.getSnapshot().phase).toBe("live"));
    const previous = owner.getSnapshot();
    harness.invalidate();
    await vi.waitFor(() => expect(reads).toBe(2));
    expect(owner.getSnapshot()).toEqual(previous);
    resolveRefresh(catalog(DAEMON_A, [{ id: "aaaaaaaaaaaaaaaaaaaa", name: "renamed" }]));
    await vi.waitFor(() => expect(owner.getSnapshot().sessions[0]?.name).toBe("renamed"));
    expect(owner.getSnapshot().sessions[0]?.id).toBe(previous.sessions[0]?.id);
    owner.dispose();
  });

  it("releases its logical observer before retiring the physical transport", () => {
    const order: string[] = [];
    closeApplicationHomeCatalogTransport(
      { close: () => order.push("subscription") },
      { dispose: () => order.push("supervisor") },
    );
    expect(order).toEqual(["subscription", "supervisor"]);
  });

  it("surfaces missing startup authority and self-heals when the daemon appears", async () => {
    const clock = new FakeClock();
    let canonical: CanonicalDaemonInfo | null = null;
    const harness = adapterHarness(async () =>
      catalog(DAEMON_A, [{ id: "aaaaaaaaaaaaaaaaaaaa", name: "alpha" }]),
    );
    const owner = createApplicationHomeCatalog({
      readCanonicalDaemonInfo: () => canonical,
      createAdapter: (retired) => harness.bindRetirement(retired),
      clock,
    });

    owner.start();
    expect(owner.getSnapshot()).toMatchObject({
      phase: "unavailable",
      sessions: [],
      note: expect.stringContaining("Retrying automatically"),
    });

    canonical = DAEMON_A;
    clock.runNext();
    await vi.waitFor(() => expect(owner.getSnapshot().phase).toBe("live"));
    expect(owner.getSnapshot().sessions.map(({ name }) => name)).toEqual(["alpha"]);
    expect(clock.callbacks.size).toBe(0);
    owner.dispose();
  });

  it("replaces add/remove/rename/recreate snapshots from push invalidations", async () => {
    let resource = catalog(DAEMON_A, [
      { id: "aaaaaaaaaaaaaaaaaaaa", name: "alpha" },
      { id: "bbbbbbbbbbbbbbbbbbbb", name: "beta" },
    ]);
    const harness = adapterHarness(async () => resource);
    const owner = createApplicationHomeCatalog({
      readCanonicalDaemonInfo: () => DAEMON_A,
      createAdapter: (retired) => harness.bindRetirement(retired),
    });
    owner.start();
    await vi.waitFor(() => expect(owner.getSnapshot().phase).toBe("live"));
    const betaId = owner.getSnapshot().sessions.find(({ name }) => name === "beta")!.id;

    resource = catalog(DAEMON_A, [
      { id: "bbbbbbbbbbbbbbbbbbbb", name: "renamed" },
      { id: "cccccccccccccccccccc", name: "gamma" },
    ]);
    harness.invalidate();
    await vi.waitFor(() =>
      expect(owner.getSnapshot().sessions.map(({ name }) => name)).toEqual(["gamma", "renamed"]),
    );
    expect(owner.getSnapshot().sessions.find(({ name }) => name === "renamed")!.id).toBe(betaId);

    resource = catalog(DAEMON_A, [
      { id: "dddddddddddddddddddd", name: "renamed" },
      { id: "cccccccccccccccccccc", name: "gamma" },
    ]);
    harness.invalidate();
    await vi.waitFor(() =>
      expect(owner.getSnapshot().sessions.find(({ name }) => name === "renamed")!.id).not.toBe(
        betaId,
      ),
    );
    owner.dispose();
  });

  it("rebinds the same daemon generation after its event transport retires", async () => {
    const clock = new FakeClock();
    let resource = catalog(DAEMON_A, [{ id: "aaaaaaaaaaaaaaaaaaaa", name: "before" }]);
    const read = vi.fn(async () => resource);
    const harness = adapterHarness(read);
    const owner = createApplicationHomeCatalog({
      readCanonicalDaemonInfo: () => DAEMON_A,
      createAdapter: (retired) => harness.bindRetirement(retired),
      clock,
    });
    owner.start();
    await vi.waitFor(() => expect(owner.getSnapshot().sessions[0]?.name).toBe("before"));

    resource = catalog(DAEMON_A, [{ id: "bbbbbbbbbbbbbbbbbbbb", name: "after" }]);
    harness.retire();
    clock.runNext();

    await vi.waitFor(() => expect(owner.getSnapshot().sessions[0]?.name).toBe("after"));
    expect(read).toHaveBeenCalledTimes(2);
    owner.dispose();
  });

  it("fences a late read from a retired daemon generation", async () => {
    const clock = new FakeClock();
    let canonical = DAEMON_A;
    let resolveA!: (resource: WorkspaceCatalogResourceV3) => void;
    const pendingA = new Promise<WorkspaceCatalogResourceV3>((resolve) => {
      resolveA = resolve;
    });
    const harness = adapterHarness((target) =>
      target.daemon.instanceId === DAEMON_A.instanceId
        ? pendingA
        : Promise.resolve(catalog(DAEMON_B, [{ id: "bbbbbbbbbbbbbbbbbbbb", name: "current" }])),
    );
    const owner = createApplicationHomeCatalog({
      readCanonicalDaemonInfo: () => canonical,
      createAdapter: (retired) => harness.bindRetirement(retired),
      clock,
    });
    owner.start();
    await vi.waitFor(() => expect(owner.getSnapshot().phase).toBe("loading"));

    canonical = DAEMON_B;
    harness.retire();
    clock.runNext();
    await vi.waitFor(() =>
      expect(owner.getSnapshot()).toMatchObject({
        phase: "live",
        daemonInstanceId: DAEMON_B.instanceId,
      }),
    );
    resolveA(catalog(DAEMON_A, [{ id: "aaaaaaaaaaaaaaaaaaaa", name: "stale" }]));
    await Promise.resolve();
    expect(owner.getSnapshot().sessions.map(({ name }) => name)).toEqual(["current"]);
    owner.dispose();
  });

  it("moves and reconciles by opaque identity instead of stale index", () => {
    const sessions = [
      { id: "a", name: "alpha", paneCount: 1 },
      { id: "b", name: "beta", paneCount: 1 },
      { id: "c", name: "gamma", paneCount: 1 },
    ];
    expect(moveHomeCatalogSelection(sessions, "b", 1)).toBe("c");
    expect(moveHomeCatalogSelection([...sessions].reverse(), "b", 1)).toBe("a");
    expect(selectedHomeCatalogIndex([...sessions].reverse(), "b")).toBe(1);
    expect(selectedHomeCatalogIndex(sessions, "retired")).toBe(0);
  });
});
