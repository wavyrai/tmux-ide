import { describe, expect, it, vi } from "vitest";
import { type SavedMachine } from "@tmux-ide/contracts";
import { createApplicationDaemonAuthority } from "./application-daemon-authority-owner.ts";
import { createApplicationMachineAuthorityManager } from "./application-machine-authority.ts";

const local = {
  pid: 123,
  port: 7000,
  protocolVersion: 2,
  productVersion: "beta",
  instanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  startedAt: "2026-09-09T10:00:00.000Z",
  bindHostname: "127.0.0.1" as const,
  authToken: "private-local",
};
const firstProfile: SavedMachine = {
  id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  label: "Build",
  sshTarget: "build",
  enabled: true,
};
const secondProfile: SavedMachine = {
  id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  label: "Dev",
  sshTarget: "dev",
  enabled: true,
};
function connection(port: number) {
  let close!: () => void;
  const closed = new Promise<void>((resolve) => {
    close = resolve;
  });
  return {
    daemon: { ...local, pid: 999999, authToken: `private-remote-${port}` },
    baseUrl: `http://127.0.0.1:${port}`,
    closed,
    dispose: vi.fn(close),
    close,
  };
}
function fixture() {
  const first = connection(43210),
    second = connection(43211);
  const connect = vi.fn(async ({ alias }: { alias: string }) =>
    alias === "build" ? first : second,
  );
  const readLocal = vi.fn(() => local);
  const localObservers: Array<(generation: string | null) => void> = [];
  const stopped = vi.fn();
  const manager = createApplicationMachineAuthorityManager({
    retryDelayMs: 1,
    createOwner: () =>
      createApplicationDaemonAuthority({
        readLocal,
        isLocalAlive: async () => true,
        observeLocal: async (listener) => {
          localObservers.push(listener);
          return stopped;
        },
        connect,
        retryDelayMs: 1,
      }),
  });
  return { manager, connect, readLocal, first, second, localObservers, stopped };
}
describe("simultaneous machine authority", () => {
  it("retires only the edited SSH route and preserves the other connected host", async () => {
    const f = fixture();
    const replacement = connection(43212);
    try {
      const first = f.manager.add(firstProfile);
      const second = f.manager.add(secondProfile);
      await Promise.all([first.ready, second.ready]);
      f.manager.select(first.id);
      f.connect.mockImplementation(async ({ alias }) =>
        alias === "next-build" ? replacement : f.second,
      );
      f.manager.reconcile([{ ...firstProfile, sshTarget: "next-build" }, secondProfile]);
      const next = f.manager.getMachine(first.id)!;
      await next.ready;
      expect(next).not.toBe(first);
      expect(first.read()).toBeNull();
      expect(f.first.dispose).toHaveBeenCalledOnce();
      expect(next.read()?.port).toBe(43212);
      expect(f.manager.getMachine(second.id)).toBe(second);
      expect(f.second.dispose).not.toHaveBeenCalled();
      expect(f.connect).toHaveBeenCalledTimes(3);
      expect(f.manager.snapshot().selectedMachineId).toBe(first.id);
    } finally {
      f.manager.dispose();
    }
  });

  it("renames a selected profile without retiring its connection or changing selection", async () => {
    const f = fixture();
    try {
      const first = f.manager.add(firstProfile);
      const second = f.manager.add(secondProfile);
      await Promise.all([first.ready, second.ready]);
      f.manager.select(first.id);
      const generation = vi.fn();
      const stop = await first.observe(generation);
      f.manager.reconcile([{ ...firstProfile, label: "Renamed build" }, secondProfile]);
      expect(f.manager.getMachine(first.id)).toBe(first);
      expect(f.manager.getMachine(second.id)).toBe(second);
      expect(f.manager.snapshot().selectedMachineId).toBe(first.id);
      expect(first.label).toBe("Renamed build");
      expect(first.endpoint().label).toBe("Renamed build");
      expect(f.manager.snapshot().machines.find((machine) => machine.id === first.id)?.label).toBe(
        "Renamed build",
      );
      expect(f.connect).toHaveBeenCalledTimes(2);
      expect(f.first.dispose).not.toHaveBeenCalled();
      expect(f.second.dispose).not.toHaveBeenCalled();
      expect(generation).not.toHaveBeenCalled();
      stop();
    } finally {
      f.manager.dispose();
    }
  });

  it("reconciles edited profiles without reconnecting unchanged machines or retaining disabled routes", async () => {
    const f = fixture();
    try {
      const first = f.manager.add(firstProfile);
      const second = f.manager.add(secondProfile);
      await Promise.all([first.ready, second.ready]);
      const retired = vi.fn();
      await first.observe(retired);
      f.manager.select(first.id);
      f.manager.reconcile([{ ...firstProfile, enabled: false }, secondProfile]);
      expect(f.manager.snapshot().selectedMachineId).toBe("local");
      expect(f.manager.getMachine(first.id)).toBeNull();
      expect(first.read()).toBeNull();
      expect(retired).toHaveBeenCalledWith(null);
      expect(first.endpoint().state).toBe("disconnected");
      expect(f.first.dispose).toHaveBeenCalledOnce();
      expect(f.manager.getMachine(second.id)).toBe(second);
      expect(second.read()?.port).toBe(43211);
      expect(f.second.dispose).not.toHaveBeenCalled();
      f.manager.reconcile([secondProfile]);
      expect(f.connect).toHaveBeenCalledTimes(2);
      f.manager.reconcile([]);
      expect(f.manager.snapshot().machines.map((m) => m.id)).toEqual(["local"]);
      expect(f.second.dispose).toHaveBeenCalledOnce();
    } finally {
      f.manager.dispose();
    }
  });
  it("cancels late connections for removed profiles and closes the profile watcher", async () => {
    const f = fixture();
    let deliver!: (value: typeof f.first) => void;
    const stop = vi.fn();
    f.connect.mockImplementation(
      () =>
        new Promise((resolve) => {
          deliver = resolve;
        }),
    );
    f.manager.followProfiles(() => stop);
    const handle = f.manager.add(firstProfile);
    f.manager.reconcile([]);
    deliver(f.first);
    expect(await handle.ready).toBe(false);
    await vi.waitFor(() => expect(f.first.dispose).toHaveBeenCalledOnce());
    expect(handle.read()).toBeNull();
    expect(f.manager.getMachine(firstProfile.id)).toBeNull();
    f.manager.dispose();
    expect(stop).toHaveBeenCalledOnce();
  });
  it("keeps local usable while independent remote profiles connect concurrently", async () => {
    const f = fixture();
    let resolveFirst!: (value: typeof f.first) => void;
    let resolveSecond!: (value: typeof f.second) => void;
    f.connect.mockImplementation(
      ({ alias }) =>
        new Promise((resolve) => {
          if (alias === "build") resolveFirst = resolve;
          else resolveSecond = resolve;
        }),
    );
    f.manager.initialize([firstProfile, secondProfile]);
    expect(f.connect).toHaveBeenCalledTimes(2);
    expect(f.manager.read()).toEqual(local);
    expect(f.manager.snapshot().machines.map((machine) => [machine.id, machine.state])).toEqual([
      ["local", "ready"],
      [firstProfile.id, "connecting"],
      [secondProfile.id, "connecting"],
    ]);
    resolveFirst(f.first);
    resolveSecond(f.second);
    await Promise.all([
      f.manager.getMachine(firstProfile.id)!.ready,
      f.manager.getMachine(secondProfile.id)!.ready,
    ]);
    expect(f.manager.getMachine(firstProfile.id)!.read()?.port).toBe(43210);
    expect(f.manager.getMachine(secondProfile.id)!.read()?.port).toBe(43211);
    f.manager.dispose();
  });
  it("revokes the old selection before changing machine and fences identical daemon IDs", async () => {
    const f = fixture();
    const handle = f.manager.add(firstProfile);
    await handle.ready;
    const events: Array<{ generation: string | null; port: number | undefined }> = [];
    await f.manager.observeSelected((generation) =>
      events.push({ generation, port: f.manager.read()?.port }),
    );
    const before = f.manager.endpoint().epoch;
    expect(f.manager.select(firstProfile.id)).toBe(true);
    expect(events).toEqual([
      { generation: null, port: 7000 },
      { generation: local.instanceId, port: 43210 },
    ]);
    expect(f.manager.endpoint().epoch).toBeGreaterThan(before);
    const epoch = f.manager.endpoint().epoch;
    f.manager.select(firstProfile.id);
    expect(f.manager.endpoint().epoch).toBe(epoch);
    expect(events).toHaveLength(2);
    expect(f.manager.select("unknown")).toBe(false);
    f.manager.dispose();
  });
  it("does not retire the selected local machine when a background remote disconnects", async () => {
    const f = fixture();
    await f.manager.add(firstProfile).ready;
    const listener = vi.fn();
    await f.manager.observeSelected(listener);
    const before = f.manager.endpoint().epoch;
    f.first.close();
    await Promise.resolve();
    expect(f.manager.getMachine(firstProfile.id)!.read()).toBeNull();
    expect(f.manager.read()).toEqual(local);
    expect(listener).not.toHaveBeenCalled();
    expect(f.manager.endpoint().epoch).toBe(before);
    f.manager.dispose();
  });
  it("does not retire the selected remote when another machine reports a new generation", async () => {
    const f = fixture();
    await f.manager.add(firstProfile).ready;
    await f.manager.add(secondProfile).ready;
    f.manager.select(firstProfile.id);
    const listener = vi.fn();
    await f.manager.observeSelected(listener);
    f.second.close();
    await Promise.resolve();
    f.localObservers[0]!("dddddddd-dddd-4ddd-8ddd-dddddddddddd");
    expect(f.manager.read()?.port).toBe(43210);
    expect(listener).not.toHaveBeenCalled();
    f.manager.dispose();
  });
  it("retries initial connection failure without duplicate loops or a temporary local route", async () => {
    const f = fixture();
    f.connect.mockRejectedValueOnce(new Error("offline"));
    const handle = f.manager.add(firstProfile);
    f.manager.select(firstProfile.id);
    expect(await handle.ready).toBe(false);
    expect(handle.read()).toBeNull();
    expect(f.manager.add(firstProfile)).toBe(handle);
    await vi.waitFor(() => expect(handle.read()?.port).toBe(43210), { interval: 1, timeout: 1000 });
    expect(f.connect).toHaveBeenCalledTimes(2);
    expect(f.manager.getMachine(firstProfile.id)).toBe(handle);
    f.manager.dispose();
  });
  it("disposes every machine and cancels initial retry work", async () => {
    const f = fixture();
    f.connect.mockRejectedValueOnce(new Error("offline"));
    await f.manager.add(firstProfile).ready;
    await f.manager.add(secondProfile).ready;
    const stop = f.manager.subscribe(() => {});
    await Promise.resolve();
    f.manager.dispose();
    f.manager.dispose();
    stop();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(f.connect).toHaveBeenCalledTimes(2);
    expect(f.second.dispose).toHaveBeenCalledOnce();
    expect(f.manager.read()).toBeNull();
    expect(f.stopped).toHaveBeenCalledOnce();
  });
  it("validates profiles before dialing and ignores disabled saved profiles", () => {
    const f = fixture();
    f.manager.initialize([{ ...firstProfile, enabled: false }]);
    expect(f.manager.snapshot().machines).toHaveLength(1);
    expect(f.connect).not.toHaveBeenCalled();
    expect(() => f.manager.add({ ...firstProfile, sshTarget: "host;command" })).toThrow();
    expect(f.connect).not.toHaveBeenCalled();
    f.manager.dispose();
  });
  it("does not start local watchers merely from importing or constructing a manager", async () => {
    const f = fixture();
    expect(f.localObservers).toHaveLength(0);
    const one = f.manager.subscribe(() => {});
    const two = f.manager.subscribe(() => {});
    await Promise.resolve();
    expect(f.localObservers).toHaveLength(1);
    one();
    two();
    f.manager.dispose();
    f.manager.subscribe(() => {});
    await f.manager.observeSelected(() => {});
    await f.manager.getMachine("local")!.observe(() => {});
    expect(f.localObservers).toHaveLength(1);
  });
});
