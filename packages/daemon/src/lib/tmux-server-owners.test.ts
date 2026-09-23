import { describe, expect, it, vi } from "vitest";
import type { TmuxServerDescriptor, TmuxServerScope } from "@tmux-ide/contracts";
import {
  MAX_TMUX_SERVER_OWNERS,
  TmuxServerOwners,
  type TmuxServerObservation,
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
});
