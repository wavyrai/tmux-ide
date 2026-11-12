import { describe, expect, it, vi } from "vitest";
import type { TmuxServerDescriptor, TmuxServerScope } from "@tmux-ide/contracts";
import {
  MAX_TMUX_SERVER_OWNERS,
  OBSERVE_MAX_WAIT_MS,
  OBSERVE_MIN_INTERVAL_MS,
  TmuxServerOwners,
  createRetryDelayMs,
  type TmuxServerObservation,
  type TmuxServerOwnerRetirement,
  type TmuxServerOwnersEvent,
  type TmuxServerProbeResult,
} from "./tmux-server-owners.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function observation(fingerprint: string) {
  const valid = vi.fn(() => true);
  return {
    fingerprint,
    valid,
    authority: {
      executablePath: "/private/tmux",
      socketSelector: { kind: "path" as const, path: `/private/${fingerprint}` },
    },
  };
}
function scope(descriptor: TmuxServerDescriptor): TmuxServerScope {
  if (descriptor.state !== "online") throw new Error("Expected online owner");
  return { serverId: descriptor.serverId, generation: descriptor.generation };
}
function fixture() {
  const observations = new Map<string, TmuxServerObservation | null>();
  const probe = vi.fn(
    async (selector: { kind: "path"; path: string } | { kind: "name"; name: string }) =>
      observations.get(selector.kind === "path" ? selector.path : selector.name) ?? null,
  );
  const create = vi.fn(async () => ({ dispose: vi.fn(async () => {}) }));
  const persist = vi.fn();
  const owners = new TmuxServerOwners({ probe, create, persist });
  const register = (name: string) =>
    owners.register({ selector: { kind: "name", name }, label: name });
  return { owners, observations, probe, create, persist, register };
}

describe("independent tmux server owners", () => {
  it("deduplicates live aliases without constructing or persisting another owner", async () => {
    const f = fixture();
    f.observations.set("a", observation("same"));
    f.observations.set("alias", observation("same"));
    const a = await f.register("a");
    expect(await f.register("alias")).toEqual(a);
    expect(await f.register("a")).toEqual(a);
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.persist).toHaveBeenCalledTimes(1);
    expect(f.owners.list()).toEqual([a]);
    await f.owners.dispose();
  });

  it("retains offline intent and brings it online only by explicit refresh", async () => {
    const f = fixture();
    const offline = await f.register("a");
    expect(offline).toMatchObject({ state: "offline", generation: null });
    expect(f.create).not.toHaveBeenCalled();
    f.observations.set("a", observation("a"));
    const [online] = await f.owners.refresh();
    expect(online).toMatchObject({ state: "online", serverId: offline.serverId });
    expect(f.create).toHaveBeenCalledTimes(1);
    await f.owners.dispose();
  });

  it("bounds offline registrations as well as active owners", async () => {
    const f = fixture();
    for (let i = 0; i < MAX_TMUX_SERVER_OWNERS; i++) await f.register(`server-${i}`);
    await expect(f.register("overflow")).rejects.toMatchObject({ code: "capacity" });
    expect(f.owners.list()).toHaveLength(MAX_TMUX_SERVER_OWNERS);
    expect(f.create).not.toHaveBeenCalled();
    await f.owners.dispose();
  });

  it("replaces A without retiring B and rejects every old A target", async () => {
    const f = fixture();
    f.observations.set("a", observation("a1"));
    f.observations.set("b", observation("b1"));
    const a = scope(await f.register("a"));
    const b = scope(await f.register("b"));
    const oldA = f.owners.current(a);
    const ownerB = f.owners.current(b);
    f.observations.set("a", observation("a2"));
    const refreshed = await f.owners.refresh();
    expect(refreshed.find((entry) => entry.serverId === a.serverId)?.generation).not.toBe(
      a.generation,
    );
    expect(oldA.dispose).toHaveBeenCalledTimes(1);
    expect(ownerB.dispose).not.toHaveBeenCalled();
    expect(f.owners.current(b)).toBe(ownerB);
    expect(() => f.owners.current(a)).toThrow(
      expect.objectContaining({ code: "stale-generation" }),
    );
    const calls = f.create.mock.calls.length;
    await expect(f.owners.withOwner(a, async () => "unsafe")).rejects.toMatchObject({
      code: "stale-generation",
    });
    expect(f.create).toHaveBeenCalledTimes(calls);
    await f.owners.dispose();
  });

  it("rejects a late result after its generation retires", async () => {
    const f = fixture();
    f.observations.set("a", observation("a1"));
    const a = scope(await f.register("a"));
    const result = deferred<string>();
    const work = f.owners.withOwner(a, async () => result.promise);
    f.observations.set("a", observation("a2"));
    await f.owners.refresh();
    result.resolve("old result");
    await expect(work).rejects.toMatchObject({ code: "stale-generation" });
    await f.owners.dispose();
  });

  it("refuses stale socket fences without probing or constructing on actions", async () => {
    const f = fixture();
    const native = observation("a");
    f.observations.set("a", native);
    const a = scope(await f.register("a"));
    native.valid.mockReturnValue(false);
    const work = vi.fn(async () => "unsafe");
    await expect(f.owners.withOwner(a, work)).rejects.toMatchObject({ code: "stale-generation" });
    expect(work).not.toHaveBeenCalled();
    expect(f.probe).toHaveBeenCalledTimes(1);
    expect(f.create).toHaveBeenCalledTimes(1);
    await f.owners.dispose();
  });

  it("disposes an owner returned after shutdown without publishing it", async () => {
    const pending = deferred<{ dispose: ReturnType<typeof vi.fn<() => Promise<void>>> }>();
    const entered = deferred<void>();
    const owner = { dispose: vi.fn(async () => {}) };
    const owners = new TmuxServerOwners({
      probe: async () => observation("a"),
      create: async () => {
        entered.resolve();
        return pending.promise;
      },
    });
    const registration = owners.register({ selector: { kind: "name", name: "a" }, label: "a" });
    await entered.promise;
    const disposing = owners.dispose();
    pending.resolve(owner);
    await registration;
    await disposing;
    expect(owner.dispose).toHaveBeenCalledTimes(1);
    expect(owners.list()).toEqual([]);
  });

  it("does not create or persist owners after shutdown interrupts a probe", async () => {
    const pending = deferred<TmuxServerObservation | null>();
    const entered = deferred<void>();
    const create = vi.fn(async () => ({ dispose: vi.fn(async () => {}) }));
    const persist = vi.fn();
    const owners = new TmuxServerOwners({
      probe: async () => {
        entered.resolve();
        return pending.promise;
      },
      create,
      persist,
    });
    const registration = owners.register({ selector: { kind: "name", name: "a" }, label: "a" });
    await entered.promise;
    const rejected = expect(registration).rejects.toMatchObject({ code: "disposed" });
    const disposing = owners.dispose();
    pending.resolve(observation("a"));
    await rejected;
    await disposing;
    expect(create).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });

  it("reconnects a recreated socket and ignores stale alias observations", async () => {
    const f = fixture();
    const first = observation("same-process");
    f.observations.set("a", first);
    const a = scope(await f.register("a"));
    const old = f.owners.current(a);
    first.valid.mockReturnValue(false);
    f.observations.set("a", observation("same-process"));
    await f.owners.refresh();
    expect(old.dispose).toHaveBeenCalledTimes(1);
    expect(f.owners.list()[0]?.generation).not.toBe(a.generation);
    expect(f.create).toHaveBeenCalledTimes(2);
    await f.owners.dispose();
  });

  it("rolls back persistence failures and removes only the selected owner", async () => {
    const f = fixture();
    f.persist.mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    await expect(f.register("failed")).rejects.toThrow("disk full");
    expect(f.owners.list()).toEqual([]);
    f.observations.set("a", observation("a"));
    f.observations.set("b", observation("b"));
    const a = scope(await f.register("a"));
    const b = scope(await f.register("b"));
    const ownerA = f.owners.current(a);
    const ownerB = f.owners.current(b);
    f.persist.mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    await expect(f.owners.remove(a.serverId)).rejects.toThrow("disk full");
    expect(f.owners.current(a)).toBe(ownerA);
    expect(ownerA.dispose).not.toHaveBeenCalled();
    await f.owners.remove(a.serverId);
    expect(ownerA.dispose).toHaveBeenCalledTimes(1);
    expect(f.owners.current(b)).toBe(ownerB);
    expect(ownerB.dispose).not.toHaveBeenCalled();
    await f.owners.dispose();
  });

  // #709: GET /api/v1/tmux-servers refreshes every owner. Refreshes run one at
  // a time, so 8 concurrent requests used to cost 8 sequential refreshes.
  it("shares one queued refresh between callers that arrive while it waits", async () => {
    const f = fixture();
    f.observations.set("a", observation("a"));
    await f.register("a");
    const gate = deferred<void>();
    const original = f.probe.getMockImplementation()!;
    f.probe.mockImplementation(async (selector) => {
      await gate.promise;
      return original(selector);
    });
    f.probe.mockClear();
    const running = f.owners.refresh();
    await Promise.resolve();
    // Arrive while the first refresh runs: one more refresh is queued for all of them.
    const waiting = Array.from({ length: 7 }, () => f.owners.refresh());
    gate.resolve();
    const results = await Promise.all([running, ...waiting]);
    expect(f.probe).toHaveBeenCalledTimes(2);
    for (const result of results) expect(result).toEqual(f.owners.list());
    await f.owners.dispose();
  });

  it("never answers a caller with a refresh that started before it called", async () => {
    const f = fixture();
    await f.register("a");
    const gate = deferred<void>();
    const original = f.probe.getMockImplementation()!;
    f.probe.mockImplementation(async (selector) => {
      const seen = await original(selector);
      await gate.promise;
      return seen;
    });
    const before = f.owners.refresh();
    await vi.waitFor(() => expect(f.probe).toHaveBeenCalled());
    // The server comes online after the first refresh has already probed.
    f.observations.set("a", observation("a"));
    const after = f.owners.refresh();
    gate.resolve();
    expect((await before)[0]).toMatchObject({ state: "offline" });
    expect((await after)[0]).toMatchObject({ state: "online" });
    await f.owners.dispose();
  });

  // Review N1: a refresh stays ordered after a mutation queued before it.
  it("does not share a queued refresh with a caller that queued a mutation after it", async () => {
    const f = fixture();
    f.observations.set("a", observation("a"));
    f.observations.set("b", observation("b"));
    await f.register("a");
    const gate = deferred<void>();
    const original = f.probe.getMockImplementation()!;
    f.probe.mockImplementation(async (selector) => {
      await gate.promise;
      return original(selector);
    });
    const running = f.owners.refresh();
    await Promise.resolve();
    const queued = f.owners.refresh();
    const registering = f.register("b");
    const after = f.owners.refresh();
    gate.resolve();
    await Promise.all([running, queued, registering]);
    expect((await after).map((descriptor) => descriptor.label)).toEqual(["a", "b"]);
    await f.owners.dispose();
  });
});

// #840: a probe that failed is not proof that the tmux server is gone.
describe("owner retirement needs positive evidence (#840)", () => {
  const timeout = { failure: "timeout" as const, detail: "probe exceeded 500ms", durationMs: 500 };
  function liveFixture() {
    const alive = new Set(["41"]);
    const events: TmuxServerOwnersEvent[] = [];
    const observations = new Map<string, TmuxServerProbeResult>();
    const probe = vi.fn(
      async (selector: { kind: "path"; path: string } | { kind: "name"; name: string }) =>
        observations.get(selector.kind === "path" ? selector.path : selector.name) ?? null,
    );
    const create = vi.fn(async () => ({
      dispose: vi.fn(async (_retirement?: TmuxServerOwnerRetirement) => {}),
    }));
    const serverProcessAlive = vi.fn((pid: string) => alive.has(pid));
    const clock = { now: 10_000 };
    // By default the bound never expires, so a read waits for the work in flight.
    const delay = vi.fn((_ms: number) => new Promise<void>(() => {}));
    const owners = new TmuxServerOwners({
      probe,
      create,
      serverProcessAlive,
      onEvent: (event) => events.push(event),
      now: () => clock.now,
      delay,
    });
    const native = (fingerprint: string, pid = "41") => ({
      ...observation(fingerprint),
      nativeServerIdentity: { pid, startTime: "100" },
    });
    return {
      owners,
      observations,
      probe,
      create,
      alive,
      events,
      native,
      serverProcessAlive,
      clock,
      delay,
    };
  }

  it("keeps a healthy owner and its generation when one probe times out", async () => {
    const f = liveFixture();
    f.observations.set("a", f.native("a"));
    const online = scope(
      await f.owners.register({ selector: { kind: "name", name: "a" }, label: "a" }),
    );
    const owner = f.owners.current(online);
    f.observations.set("a", timeout);
    const [after] = await f.owners.refresh();
    expect(after).toMatchObject({ state: "online", generation: online.generation });
    expect(owner.dispose).not.toHaveBeenCalled();
    expect(f.owners.current(online)).toBe(owner);
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.events.at(-1)).toMatchObject({
      type: "owner-kept",
      serverId: online.serverId,
      generation: online.generation,
      probe: { failure: "timeout" },
      consecutiveProbeFailures: 1,
    });
    // The next good probe of the same server resets the count and changes nothing.
    f.observations.set("a", f.native("a"));
    expect((await f.owners.refresh())[0]).toMatchObject({ generation: online.generation });
    f.observations.set("a", timeout);
    await f.owners.refresh();
    expect(f.events.at(-1)).toMatchObject({ type: "owner-kept", consecutiveProbeFailures: 1 });
    await f.owners.dispose();
  });

  it("keeps the owner when tmux reports no observation but the server process is alive", async () => {
    const f = liveFixture();
    f.observations.set("a", f.native("a"));
    const online = scope(
      await f.owners.register({ selector: { kind: "name", name: "a" }, label: "a" }),
    );
    f.observations.delete("a"); // the probe answers null
    expect((await f.owners.refresh())[0]).toMatchObject({ generation: online.generation });
    await f.owners.dispose();
  });

  it("retires the owner when the probe fails and the server process is gone", async () => {
    const f = liveFixture();
    f.observations.set("a", f.native("a"));
    const online = scope(
      await f.owners.register({ selector: { kind: "name", name: "a" }, label: "a" }),
    );
    const owner = f.owners.current(online);
    f.alive.delete("41");
    f.observations.set("a", timeout);
    expect((await f.owners.refresh())[0]).toMatchObject({ state: "offline", generation: null });
    expect(owner.dispose).toHaveBeenCalledExactlyOnceWith("server-gone");
    expect(f.events.find((event) => event.type === "owner-retired")).toMatchObject({
      trigger: "server-process-gone",
      generation: online.generation,
      probe: { failure: "timeout" },
    });
    await f.owners.dispose();
  });

  it("retires the owner when its socket was replaced, even if the probe failed", async () => {
    const f = liveFixture();
    const first = f.native("a");
    f.observations.set("a", first);
    const online = scope(
      await f.owners.register({ selector: { kind: "name", name: "a" }, label: "a" }),
    );
    const owner = f.owners.current(online);
    first.valid.mockReturnValue(false);
    f.observations.set("a", timeout);
    expect((await f.owners.refresh())[0]).toMatchObject({ state: "offline" });
    expect(owner.dispose).toHaveBeenCalledExactlyOnceWith("server-gone");
    expect(f.events.find((event) => event.type === "owner-retired")).toMatchObject({
      trigger: "socket-identity-changed",
    });
    await f.owners.dispose();
  });

  it("an owner without a known server process is not kept on a failed probe", async () => {
    const f = liveFixture();
    f.observations.set("a", observation("a")); // no nativeServerIdentity
    const online = scope(
      await f.owners.register({ selector: { kind: "name", name: "a" }, label: "a" }),
    );
    const owner = f.owners.current(online);
    f.observations.set("a", timeout);
    expect((await f.owners.refresh())[0]).toMatchObject({ state: "offline" });
    expect(owner.dispose).toHaveBeenCalledTimes(1);
    // Decided without asking about a process nobody identified.
    expect(f.serverProcessAlive).not.toHaveBeenCalled();
    expect(f.events.find((event) => event.type === "owner-retired")).toMatchObject({
      trigger: "server-identity-unknown",
    });
    await f.owners.dispose();
  });

  it("tells the owner why it retires and reports the rebuild with timings", async () => {
    const f = liveFixture();
    f.observations.set("a", f.native("a1"));
    const first = scope(
      await f.owners.register({ selector: { kind: "name", name: "a" }, label: "a" }),
    );
    const replaced = f.owners.current(first);
    f.alive.add("42");
    f.observations.set("a", f.native("a2", "42"));
    const [next] = await f.owners.refresh();
    expect(replaced.dispose).toHaveBeenCalledExactlyOnceWith("server-replaced");
    expect(next).toMatchObject({ state: "online" });
    const retired = f.events.find((event) => event.type === "owner-retired")!;
    expect(retired).toMatchObject({ trigger: "fingerprint-changed", generation: first.generation });
    expect(retired.type === "owner-retired" && retired.disposeMs).toBeGreaterThanOrEqual(0);
    const created = f.events.filter((event) => event.type === "owner-created").at(-1)!;
    expect(created).toMatchObject({
      serverId: first.serverId,
      generation: scope(next!).generation,
    });

    const current = f.owners.current(scope(next!));
    await f.owners.remove(first.serverId);
    expect(current.dispose).toHaveBeenCalledExactlyOnceWith("removed");

    f.observations.set("b", f.native("b"));
    const b = scope(await f.owners.register({ selector: { kind: "name", name: "b" }, label: "b" }));
    const ownerB = f.owners.current(b);
    await f.owners.dispose();
    expect(ownerB.dispose).toHaveBeenCalledExactlyOnceWith("shutdown");
    expect(f.events.at(-1)).toMatchObject({ type: "owner-retired", trigger: "owners-disposed" });
  });

  it("passes a generation restart on to the owners instead of calling it a shutdown", async () => {
    const f = liveFixture();
    f.observations.set("a", f.native("a"));
    const a = scope(await f.owners.register({ selector: { kind: "name", name: "a" }, label: "a" }));
    const owner = f.owners.current(a);
    await f.owners.dispose("generation-restart");
    expect(owner.dispose).toHaveBeenCalledExactlyOnceWith("generation-restart");
    expect(f.events.at(-1)).toMatchObject({ type: "owner-retired", trigger: "owners-disposed" });
  });

  it("reports an owner that could not be built and retries it with backoff", async () => {
    const f = liveFixture();
    f.observations.set("a", f.native("a"));
    f.create.mockRejectedValueOnce(new Error("inventory startup failed"));
    f.create.mockRejectedValueOnce(new Error("inventory startup failed again"));
    expect(
      await f.owners.register({ selector: { kind: "name", name: "a" }, label: "a" }),
    ).toMatchObject({ state: "offline" });
    expect(f.events.at(-1)).toMatchObject({
      type: "owner-create-failed",
      error: "inventory startup failed",
      consecutiveCreateFailures: 1,
      retryInMs: 500,
    });
    // Neither the sweep nor a read hammers a failing build before its retry is due.
    await f.owners.sweep();
    await f.owners.observe();
    expect(f.create).toHaveBeenCalledTimes(1);
    f.clock.now += 500;
    await f.owners.sweep();
    expect(f.create).toHaveBeenCalledTimes(2);
    expect(f.events.at(-1)).toMatchObject({ consecutiveCreateFailures: 2, retryInMs: 1_000 });
    f.clock.now += 999;
    await f.owners.sweep();
    expect(f.create).toHaveBeenCalledTimes(2);
    f.clock.now += 1;
    expect((await f.owners.sweep())[0]).toMatchObject({ state: "online" });
    expect(f.create).toHaveBeenCalledTimes(3);
    expect(createRetryDelayMs(1)).toBe(500);
    expect(createRetryDelayMs(40)).toBe(30_000);
    await f.owners.dispose();
  });

  it("retires only when a second probe confirms the evidence", async () => {
    const f = liveFixture();
    f.observations.set("a", f.native("a1"));
    const first = scope(
      await f.owners.register({ selector: { kind: "name", name: "a" }, label: "a" }),
    );
    const owner = f.owners.current(first);
    f.alive.add("42");
    // One answer from another server, then the original again: not confirmed.
    const real = f.probe.getMockImplementation()!;
    f.probe.mockImplementationOnce(async () => f.native("a2", "42"));
    expect((await f.owners.refresh())[0]).toMatchObject({ generation: first.generation });
    expect(owner.dispose).not.toHaveBeenCalled();
    expect(f.events.at(-1)).toMatchObject({
      type: "retirement-unconfirmed",
      trigger: "fingerprint-changed",
      generation: first.generation,
    });
    // The same answer twice in a row retires, after exactly two probes.
    f.probe.mockImplementation(real);
    f.observations.set("a", f.native("a2", "42"));
    const before = f.probe.mock.calls.length;
    expect((await f.owners.refresh())[0]?.generation).not.toBe(first.generation);
    expect(f.probe.mock.calls.length - before).toBe(2);
    expect(owner.dispose).toHaveBeenCalledExactlyOnceWith("server-replaced");
    await f.owners.dispose();
  });

  it("a read never probes or retires an online owner, whatever tmux would say", async () => {
    const f = liveFixture();
    f.observations.set("a", f.native("a"));
    const online = scope(
      await f.owners.register({ selector: { kind: "name", name: "a" }, label: "a" }),
    );
    const owner = f.owners.current(online);
    const probes = f.probe.mock.calls.length;
    // Even with the server process gone a read answers from what is known.
    f.alive.delete("41");
    f.observations.set("a", timeout);
    for (let i = 0; i < 10; i += 1)
      expect(await f.owners.observe()).toEqual([{ ...online, label: "a", state: "online" }]);
    expect(f.probe.mock.calls.length).toBe(probes);
    expect(owner.dispose).not.toHaveBeenCalled();
    // The background sweep is what acts on that evidence.
    expect((await f.owners.sweep())[0]).toMatchObject({ state: "offline" });
    expect(owner.dispose).toHaveBeenCalledExactlyOnceWith("server-gone");
    await f.owners.dispose();
  });

  it("a read that brings an offline server online leaves the online ones unasked", async () => {
    const f = liveFixture();
    f.observations.set("a", f.native("a"));
    f.alive.add("42");
    const a = scope(await f.owners.register({ selector: { kind: "name", name: "a" }, label: "a" }));
    await f.owners.register({ selector: { kind: "name", name: "b" }, label: "b" });
    f.observations.set("b", f.native("b", "42"));
    f.probe.mockClear();
    f.clock.now += OBSERVE_MIN_INTERVAL_MS;
    const listed = await f.owners.observe();
    expect(listed.map((server) => server.state)).toEqual(["online", "online"]);
    expect(listed[0]).toMatchObject({ generation: a.generation });
    expect(f.probe.mock.calls.map(([selector]) => selector)).toEqual([{ kind: "name", name: "b" }]);
    await f.owners.dispose();
  });

  it("the sweep costs no probe while sockets and server processes are unchanged", async () => {
    const f = liveFixture();
    f.observations.set("a", f.native("a"));
    await f.owners.register({ selector: { kind: "name", name: "a" }, label: "a" });
    const probes = f.probe.mock.calls.length;
    for (let i = 0; i < 20; i += 1) await f.owners.sweep();
    expect(f.probe.mock.calls.length).toBe(probes);
    await f.owners.dispose();
  });

  it("concurrent reads share one rate-limited pass that brings an offline server online", async () => {
    const f = liveFixture();
    const offline = await f.owners.register({ selector: { kind: "name", name: "a" }, label: "a" });
    expect(offline).toMatchObject({ state: "offline" });
    const probes = f.probe.mock.calls.length;
    // Twenty lists at once ask tmux once.
    await Promise.all(Array.from({ length: 20 }, () => f.owners.observe()));
    expect(f.probe.mock.calls.length).toBe(probes + 1);
    // Inside the rate-limit window nothing more is asked, even though the server is now there.
    f.observations.set("a", f.native("a"));
    await Promise.all(Array.from({ length: 20 }, () => f.owners.observe()));
    expect(f.probe.mock.calls.length).toBe(probes + 1);
    f.clock.now += OBSERVE_MIN_INTERVAL_MS;
    const lists = await Promise.all(Array.from({ length: 20 }, () => f.owners.observe()));
    expect(f.probe.mock.calls.length).toBe(probes + 2);
    expect(f.create).toHaveBeenCalledTimes(1);
    for (const list of lists) expect(list[0]).toMatchObject({ state: "online" });
    await f.owners.dispose();
  });

  it("a read answers within its bound while a teardown is still running", async () => {
    const f = liveFixture();
    f.observations.set("a", f.native("a"));
    const online = scope(
      await f.owners.register({ selector: { kind: "name", name: "a" }, label: "a" }),
    );
    const teardown = deferred<void>();
    f.owners.current(online).dispose.mockImplementation(() => teardown.promise);
    f.alive.delete("41");
    f.observations.set("a", timeout);
    const sweeping = f.owners.sweep();
    await vi.waitFor(() => expect(f.owners.current.bind(f.owners, online)).toThrow());
    const waits: number[] = [];
    f.delay.mockImplementation(async (ms: number) => void waits.push(ms));
    // The teardown has not finished; the read still answers.
    expect((await f.owners.observe())[0]).toMatchObject({ state: "offline" });
    expect(waits).toEqual([OBSERVE_MAX_WAIT_MS]);
    teardown.resolve();
    await sweeping;
    await f.owners.dispose();
  });

  it("an absent server is asked less often by the sweep but at once by a read", async () => {
    const f = liveFixture();
    await f.owners.register({ selector: { kind: "name", name: "gone" }, label: "gone" });
    const probes = () => f.probe.mock.calls.length;
    let seen = probes();
    for (let i = 0; i < 5; i += 1) await f.owners.sweep();
    expect(probes()).toBe(seen); // first miss: next sweep probe in 500 ms
    f.clock.now += 500;
    await f.owners.sweep();
    expect(probes()).toBe(seen + 1);
    seen = probes();
    f.clock.now += 999; // second miss backed off to 1 s
    await f.owners.sweep();
    expect(probes()).toBe(seen);
    f.clock.now += OBSERVE_MIN_INTERVAL_MS;
    await f.owners.observe();
    expect(probes()).toBe(seen + 1);
    await f.owners.dispose();
  });
});
