import { describe, expect, it, vi } from "vitest";
import {
  DAEMON_WIRE_PROTOCOL_VERSION,
  type DesktopDaemonEvent,
  type DesktopDaemonHostSubscriptionResult,
  type HostCapabilities,
} from "@tmux-ide/contracts";

import {
  createTargetPinnedStore,
  validateWorkspaceResourceTarget,
  type TargetPinnedAdapter,
  type TargetPinnedFetchResult,
  type TargetPinnedView,
  type WorkspaceResourceClock,
} from "./target-pinned-store.ts";

/**
 * The target-pinned engine's own contract, exercised through a minimal adapter
 * rather than through any of the four stores that instantiate it.
 */

const DAEMON = {
  protocolVersion: DAEMON_WIRE_PROTOCOL_VERSION,
  productVersion: "2.8.0",
  instanceId: "8f2a1c74-0f0f-4d0b-9d6d-3b1a0c9b7e21",
  startedAt: "2026-07-21T00:00:00.000Z",
};

const TARGET = { daemon: DAEMON, workspaceName: "alpha" };
const OTHER_TARGET = { daemon: DAEMON, workspaceName: "beta" };

type View = TargetPinnedView<string>;

class FakeClock implements WorkspaceResourceClock {
  #now = 500;
  #next = 1;
  readonly pending = new Map<number, () => void>();
  readonly delays: number[] = [];

  now(): number {
    return (this.#now += 1);
  }
  setTimeout(run: () => void, delayMs: number): unknown {
    const handle = this.#next++;
    this.delays.push(delayMs);
    this.pending.set(handle, run);
    return handle;
  }
  clearTimeout(handle: unknown): void {
    this.pending.delete(handle as number);
  }
  runNext(): void {
    const entry = [...this.pending.entries()][0];
    if (entry === undefined) throw new Error("no pending timer");
    this.pending.delete(entry[0]);
    entry[1]();
  }
}

interface Harness {
  readonly host: Pick<HostCapabilities, "daemon">;
  readonly subscribe: ReturnType<typeof vi.fn>;
  readonly unsubscribe: ReturnType<typeof vi.fn>;
  publish(event: DesktopDaemonEvent): void;
}

function fakeHost(subscribeResult?: () => Promise<DesktopDaemonHostSubscriptionResult>): Harness {
  let listener: ((event: DesktopDaemonEvent) => void) | null = null;
  const unsubscribe = vi.fn();
  const subscribe = vi.fn(
    async (_request: { workspaceNames: string[] }, next: (event: DesktopDaemonEvent) => void) => {
      listener = next;
      return subscribeResult
        ? subscribeResult()
        : ({ status: "subscribed", unsubscribe } as DesktopDaemonHostSubscriptionResult);
    },
  );
  return {
    host: { daemon: { subscribe } as unknown as HostCapabilities["daemon"] },
    subscribe,
    unsubscribe,
    publish: (event) => listener?.(event),
  };
}

function adapterFor(
  fetch: TargetPinnedAdapter<string, View>["fetch"],
  host: Pick<HostCapabilities, "daemon">,
  extra: Partial<TargetPinnedAdapter<string, View>> = {},
): TargetPinnedAdapter<string, View> {
  return { host, fetch, project: (view) => view, ...extra };
}

function ok(resource: string): TargetPinnedFetchResult<string> {
  return { status: "ok", resource };
}

describe("target-pinned store engine", () => {
  it("loads the eager key on a valid target and publishes the slot", async () => {
    const fake = fakeHost();
    const read = vi.fn(async () => ok("root-1"));
    const store = createTargetPinnedStore(
      adapterFor(read, fake.host, { eagerKey: "root" }),
      TARGET,
      { clock: new FakeClock() },
    );
    expect(store.getState().slots.get("root")).toEqual({ status: "loading" });
    await vi.waitFor(() =>
      expect(store.getState().slots.get("root")).toMatchObject({
        status: "loaded",
        resource: "root-1",
        refreshing: false,
      }),
    );
    expect(read).toHaveBeenCalledOnce();
  });

  it("keeps one slot per key and drops only what it is asked to drop", async () => {
    const fake = fakeHost();
    const store = createTargetPinnedStore(
      adapterFor(async (_target, key) => ok(`read-${key}`), fake.host, { eagerKey: "root" }),
      TARGET,
      { clock: new FakeClock() },
    );
    store.load("src");
    store.load("docs");
    await vi.waitFor(() => expect(store.getState().slots.size).toBe(3));
    store.drop("src");
    expect([...store.getState().slots.keys()].sort()).toEqual(["docs", "root"]);
  });

  it("retires every other slot for a single-selection surface", async () => {
    const fake = fakeHost();
    const store = createTargetPinnedStore(
      adapterFor(async (_target, key) => ok(`read-${key}`), fake.host, { singleSlot: true }),
      TARGET,
      { clock: new FakeClock() },
    );
    expect(store.getState().slots.size).toBe(0);
    store.load("file-a");
    await vi.waitFor(() => expect(store.getState().slots.get("file-a")?.status).toBe("loaded"));
    store.load("file-b");
    expect([...store.getState().slots.keys()]).toEqual(["file-b"]);
  });

  it("does not resurrect retired single-selection interests after reactivation", async () => {
    const fake = fakeHost();
    const read = vi.fn(async (_target: unknown, key: string) => ok(`read-${key}`));
    const store = createTargetPinnedStore(
      adapterFor(read, fake.host, { singleSlot: true }),
      TARGET,
      { active: false, clock: new FakeClock() },
    );
    store.load("file-a");
    store.load("file-b");
    expect(read).not.toHaveBeenCalled();
    store.setActive(true);
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    expect(read).toHaveBeenCalledWith(expect.anything(), "file-b", expect.any(AbortSignal));
    expect([...store.getState().slots.keys()]).toEqual(["file-b"]);
  });

  it("keeps the previous read on screen while a refresh is in flight", async () => {
    const fake = fakeHost();
    let release: ((value: TargetPinnedFetchResult<string>) => void) | null = null;
    let first = true;
    const store = createTargetPinnedStore(
      adapterFor(
        () => {
          if (first) {
            first = false;
            return Promise.resolve(ok("first"));
          }
          return new Promise((resolve) => {
            release = resolve;
          });
        },
        fake.host,
        { eagerKey: "root" },
      ),
      TARGET,
      { clock: new FakeClock() },
    );
    await vi.waitFor(() => expect(store.getState().slots.get("root")?.status).toBe("loaded"));
    store.refresh();
    expect(store.getState().slots.get("root")).toMatchObject({
      status: "loaded",
      resource: "first",
      refreshing: true,
    });
    release!(ok("second"));
    await vi.waitFor(() =>
      expect(store.getState().slots.get("root")).toMatchObject({
        status: "loaded",
        resource: "second",
        refreshing: false,
      }),
    );
  });

  it("retains the previous read alongside a failure instead of blanking it", async () => {
    const fake = fakeHost();
    let fail = false;
    const store = createTargetPinnedStore(
      adapterFor(
        async () =>
          fail
            ? ({ status: "failed", code: "workspace-not-found", reason: "gone" } as const)
            : ok("good"),
        fake.host,
        { eagerKey: "root" },
      ),
      TARGET,
      { clock: new FakeClock() },
    );
    await vi.waitFor(() => expect(store.getState().slots.get("root")?.status).toBe("loaded"));
    fail = true;
    store.refresh();
    await vi.waitFor(() => expect(store.getState().slots.get("root")?.status).toBe("error"));
    expect(store.getState().slots.get("root")).toMatchObject({
      status: "error",
      code: "workspace-not-found",
      reason: "gone",
      stale: { resource: "good" },
    });
  });

  it("runs a bounded ladder for a transient code and leaves a hard code alone", async () => {
    const fake = fakeHost();
    const clock = new FakeClock();
    const transient = vi.fn(
      async () => ({ status: "failed", code: "request-failed", reason: "down" }) as const,
    );
    const store = createTargetPinnedStore(
      adapterFor(transient, fake.host, { eagerKey: "root" }),
      TARGET,
      { clock, retry: { initialDelayMs: 10, maximumDelayMs: 40, maximumAttempts: 2 } },
    );
    await vi.waitFor(() => expect(clock.delays).toEqual([10]));
    clock.runNext();
    await vi.waitFor(() => expect(clock.delays).toEqual([10, 20]));
    clock.runNext();
    await vi.waitFor(() => expect(transient).toHaveBeenCalledTimes(3));
    expect(clock.pending.size).toBe(0);
    expect(store.getState().slots.get("root")?.status).toBe("error");

    const hardClock = new FakeClock();
    const hard = vi.fn(
      async () => ({ status: "failed", code: "daemon-identity-mismatch", reason: "no" }) as const,
    );
    createTargetPinnedStore(adapterFor(hard, fakeHost().host, { eagerKey: "root" }), TARGET, {
      clock: hardClock,
    });
    await vi.waitFor(() => expect(hard).toHaveBeenCalledOnce());
    expect(hardClock.delays).toEqual([]);
  });

  it("drops a read that resolves against a superseded target", async () => {
    const fake = fakeHost();
    let release: ((value: TargetPinnedFetchResult<string>) => void) | null = null;
    const store = createTargetPinnedStore(
      adapterFor(
        (target) =>
          target.workspaceName === "alpha"
            ? new Promise((resolve) => {
                release = resolve;
              })
            : Promise.resolve(ok("beta-read")),
        fake.host,
        { eagerKey: "root" },
      ),
      TARGET,
      { clock: new FakeClock() },
    );
    store.setTarget(OTHER_TARGET);
    await vi.waitFor(() =>
      expect(store.getState().slots.get("root")).toMatchObject({ resource: "beta-read" }),
    );
    release!(ok("alpha-read"));
    await Promise.resolve();
    expect(store.getState().slots.get("root")).toMatchObject({ resource: "beta-read" });
    expect(store.getState().generation).toBe(2);
  });

  it("refetches every loaded slot on a subscribed invalidation", async () => {
    const fake = fakeHost();
    const read = vi.fn(async (_target: unknown, key: string) => ok(`read-${key}`));
    const store = createTargetPinnedStore(
      adapterFor(read, fake.host, { eagerKey: "root", invalidatesOn: ["workspaces.changed"] }),
      TARGET,
      { clock: new FakeClock() },
    );
    store.load("src");
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(fake.subscribe).toHaveBeenCalledOnce());
    expect(fake.subscribe.mock.calls[0]?.[0]).toEqual({ workspaceNames: ["alpha"] });

    fake.publish({ type: "workspaces.changed" });
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(4));
    // An event this store did not subscribe to changes nothing.
    fake.publish({ type: "fleet.changed" });
    await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(4);
    expect(store.getState().slots.size).toBe(2);
  });

  it("leaves reads manual when the host refuses to subscribe", async () => {
    const refusing = fakeHost(async () => ({
      status: "error",
      error: { code: "event-unavailable", reason: "no events" },
    }));
    const read = vi.fn(async () => ok("root"));
    const store = createTargetPinnedStore(
      adapterFor(read, refusing.host, {
        eagerKey: "root",
        invalidatesOn: ["workspaces.changed"],
      }),
      TARGET,
      { clock: new FakeClock() },
    );
    await vi.waitFor(() => expect(store.getState().slots.get("root")?.status).toBe("loaded"));
    store.refresh();
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  });

  it("does not subscribe at all when no invalidation applies", async () => {
    const fake = fakeHost();
    createTargetPinnedStore(
      adapterFor(async () => ok("preview"), fake.host, { singleSlot: true }),
      TARGET,
      { clock: new FakeClock() },
    );
    await Promise.resolve();
    expect(fake.subscribe).not.toHaveBeenCalled();
  });

  it("publishes an invalid target as a target error and forgets every slot", async () => {
    const fake = fakeHost();
    const read = vi.fn(async () => ok("root"));
    const store = createTargetPinnedStore(
      adapterFor(read, fake.host, { eagerKey: "root", invalidatesOn: ["workspaces.changed"] }),
      TARGET,
      { clock: new FakeClock() },
    );
    await vi.waitFor(() => expect(store.getState().slots.get("root")?.status).toBe("loaded"));
    store.setTarget({ daemon: DAEMON, workspaceName: 42 });
    const state = store.getState();
    expect(state.target).toBeNull();
    expect(state.slots.size).toBe(0);
    expect(state.targetError?.reason).toBe("Workspace resource target is invalid.");
    await vi.waitFor(() => expect(fake.unsubscribe).toHaveBeenCalledOnce());
    expect(read).toHaveBeenCalledOnce();
  });

  it("re-asserting the same target is inert", async () => {
    const fake = fakeHost();
    const read = vi.fn(async () => ok("root"));
    const store = createTargetPinnedStore(
      adapterFor(read, fake.host, { eagerKey: "root" }),
      TARGET,
      { clock: new FakeClock() },
    );
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    store.setTarget({ daemon: { ...DAEMON }, workspaceName: "alpha" });
    expect(read).toHaveBeenCalledOnce();
    expect(store.getState().generation).toBe(1);
  });

  it("isolates observer faults and notifies the observers disposal retires", async () => {
    const fake = fakeHost();
    const store = createTargetPinnedStore(
      adapterFor(async () => ok("root"), fake.host, {
        eagerKey: "root",
        invalidatesOn: ["workspaces.changed"],
      }),
      TARGET,
      { clock: new FakeClock() },
    );
    const seen: boolean[] = [];
    expect(() =>
      store.subscribe(() => {
        throw new Error("private observer failure");
      }),
    ).not.toThrow();
    store.subscribe((state) => {
      seen.push(state.disposed);
      if (state.disposed) {
        store.load("late");
        store.refresh();
        throw new Error("observer attempted re-entry");
      }
    });
    await vi.waitFor(() => expect(store.getState().slots.get("root")?.status).toBe("loaded"));
    await vi.waitFor(() => expect(fake.subscribe).toHaveBeenCalledOnce());
    expect(() => store.dispose()).not.toThrow();
    expect(seen.at(-1)).toBe(true);
    expect(store.getState().disposed).toBe(true);
    expect(fake.unsubscribe).toHaveBeenCalledOnce();

    const after = seen.length;
    store.dispose();
    store.setTarget(OTHER_TARGET);
    store.load("anything");
    expect(seen).toHaveLength(after);
  });

  it("survives a host teardown that throws", async () => {
    const throwing = fakeHost();
    throwing.unsubscribe.mockImplementation(() => {
      throw new Error("private host teardown failure");
    });
    const store = createTargetPinnedStore(
      adapterFor(async () => ok("root"), throwing.host, {
        eagerKey: "root",
        invalidatesOn: ["workspaces.changed"],
      }),
      TARGET,
      { clock: new FakeClock() },
    );
    await vi.waitFor(() => expect(throwing.subscribe).toHaveBeenCalledOnce());
    await Promise.resolve();
    expect(() => store.dispose()).not.toThrow();
    expect(throwing.unsubscribe).toHaveBeenCalledOnce();
  });

  it("publishes a rejected read as a request failure with its retained snapshot", async () => {
    const fake = fakeHost();
    let reject = false;
    const store = createTargetPinnedStore(
      adapterFor(
        () => (reject ? Promise.reject(new Error("boom")) : Promise.resolve(ok("good"))),
        fake.host,
        { eagerKey: "root" },
      ),
      TARGET,
      { clock: new FakeClock() },
    );
    await vi.waitFor(() => expect(store.getState().slots.get("root")?.status).toBe("loaded"));
    reject = true;
    store.refresh();
    await vi.waitFor(() =>
      expect(store.getState().slots.get("root")).toMatchObject({
        status: "error",
        code: "request-failed",
        stale: { resource: "good" },
      }),
    );
  });
});

describe("workspace resource target validation", () => {
  it("accepts a compatible target and keys it by generation and workspace", () => {
    const validation = validateWorkspaceResourceTarget(TARGET);
    expect(validation.ok).toBe(true);
    expect(validation.ok && validation.key).toContain("alpha");
  });

  it("rejects a malformed target and an incompatible protocol", () => {
    expect(validateWorkspaceResourceTarget(null)).toEqual({
      ok: false,
      reason: "Workspace resource target is invalid.",
    });
    const incompatible = validateWorkspaceResourceTarget({
      daemon: { ...DAEMON, protocolVersion: 9_999 },
      workspaceName: "alpha",
    });
    expect(incompatible.ok).toBe(false);
    expect(incompatible.ok === false && incompatible.reason).toContain("not compatible");
  });
});
