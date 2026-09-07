import { describe, expect, it, vi } from "vitest";
import type { EmbeddedDaemonHandle, EmbeddedDaemonOptions } from "../daemon-embed.ts";
import { startOwnedEmbeddedDaemon } from "../embedded-daemon-lifecycle.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function fixture() {
  const options: EmbeddedDaemonOptions[] = [];
  const generations: EmbeddedDaemonHandle[] = [];
  const start = vi.fn(async (opts: EmbeddedDaemonOptions) => {
    options.push(opts);
    const index = options.length;
    const handle: EmbeddedDaemonHandle = {
      instanceId: `generation-${index}`,
      pid: 42,
      port: 4000 + index,
      apiBaseUrl: `http://127.0.0.1:${4000 + index}`,
      wsUrl: `ws://127.0.0.1:${4000 + index}/ws/events`,
      localBypassToken: `local-${index}`,
      tmuxAuthorityReplaced: vi.fn(async () => index > 1),
      compatibilityTerminalAttachmentRuntimeConstructed: () => index > 1,
      activateProject: vi.fn(async () => ({ stop: async () => {} })),
      stop: vi.fn(async () => {}),
    };
    generations.push(handle);
    return handle;
  });
  return { options, generations, start };
}
const request = { enabled: false, bindHostname: "127.0.0.1", token: null } as const;

describe("standalone embedded lifecycle", () => {
  it("delegates identity, authority and actions to each replacement and preserves launch options", async () => {
    const f = fixture();
    const handle = await startOwnedEmbeddedDaemon(
      { silent: true, productVersion: "test", takeoverIfRunning: true },
      f.start,
    );
    expect(handle.instanceId).toBe("generation-1");
    await f.options[0]!.requestRestart!(request);
    expect(f.options[1]).toMatchObject({
      silent: true,
      productVersion: "test",
      takeoverIfRunning: false,
      restoreTmuxWorkspaces: true,
      localBypassToken: "local-1",
      port: 4001,
      bindHostname: request.bindHostname,
      authToken: null,
    });
    expect(handle.instanceId).toBe("generation-2");
    expect(handle.port).toBe(4002);
    expect(handle.apiBaseUrl).toBe("http://127.0.0.1:4002");
    expect(handle.wsUrl).toBe("ws://127.0.0.1:4002/ws/events");
    expect(handle.localBypassToken).toBe("local-2");
    expect(await handle.tmuxAuthorityReplaced!()).toBe(true);
    expect(handle.compatibilityTerminalAttachmentRuntimeConstructed()).toBe(true);
    await handle.activateProject("workspace");
    expect(f.generations[1]!.activateProject).toHaveBeenCalledWith("workspace", undefined);
    await f.options[0]!.requestRestart!(request);
    expect(f.start).toHaveBeenCalledTimes(2);
    await f.options[1]!.requestRestart!({ ...request, port: 4567 });
    expect(f.options[2]!.port).toBe(4567);
    expect(handle.instanceId).toBe("generation-3");
    await handle.stop();
    expect(f.generations[2]!.stop).toHaveBeenCalledTimes(1);
  });

  it("does not launch a replacement after shutdown fails", async () => {
    const f = fixture();
    await startOwnedEmbeddedDaemon({}, f.start);
    vi.mocked(f.generations[0]!.stop).mockRejectedValue(new Error("listener still owned"));
    await expect(f.options[0]!.requestRestart!(request)).rejects.toThrow("listener still owned");
    expect(f.start).toHaveBeenCalledTimes(1);
  });

  it("does not activate projects on a retired generation after replacement startup fails", async () => {
    const f = fixture();
    const handle = await startOwnedEmbeddedDaemon({}, f.start);
    f.start.mockRejectedValueOnce(new Error("replacement failed"));
    await expect(f.options[0]!.requestRestart!(request)).rejects.toThrow("replacement failed");
    await expect(handle.activateProject("workspace")).rejects.toThrow("retiring");
    expect(f.generations[0]!.activateProject).not.toHaveBeenCalled();
    await handle.stop();
  });

  it("coalesces duplicate restarts and cancels launch when the caller stops during retirement", async () => {
    const f = fixture();
    const handle = await startOwnedEmbeddedDaemon({}, f.start);
    const gate = deferred();
    vi.mocked(f.generations[0]!.stop).mockReturnValue(gate.promise);
    const first = f.options[0]!.requestRestart!(request);
    const second = f.options[0]!.requestRestart!(request);
    expect(first).toBe(second);
    const stopped = handle.stop();
    await expect(handle.activateProject("workspace")).rejects.toThrow("retiring");
    gate.resolve();
    await Promise.all([first, second, stopped]);
    await f.options[0]!.requestRestart!(request);
    expect(f.start).toHaveBeenCalledTimes(1);
  });

  it("retires a replacement whose startup finishes after the caller stops", async () => {
    const f = fixture();
    const launchGate = deferred();
    const underlying = f.start.getMockImplementation()!;
    f.start.mockImplementation(async (opts) => {
      const next = await underlying(opts);
      if (f.options.length === 2) await launchGate.promise;
      return next;
    });
    const handle = await startOwnedEmbeddedDaemon({}, f.start);
    const restarted = f.options[0]!.requestRestart!(request);
    await vi.waitFor(() => expect(f.start).toHaveBeenCalledTimes(2));
    const stopped = handle.stop();
    launchGate.resolve();
    await Promise.all([restarted, stopped]);
    expect(f.generations[1]!.stop).toHaveBeenCalled();
    await f.options[1]!.requestRestart!(request);
    expect(f.start).toHaveBeenCalledTimes(2);
  });

  it("uses the latest settings received during retirement", async () => {
    const f = fixture();
    const handle = await startOwnedEmbeddedDaemon({}, f.start);
    const gate = deferred();
    vi.mocked(f.generations[0]!.stop).mockReturnValue(gate.promise);
    const first = f.options[0]!.requestRestart!({ ...request, port: 4501 });
    const last = f.options[0]!.requestRestart!({ ...request, port: 4502 });
    gate.resolve();
    await Promise.all([first, last]);
    expect(f.start).toHaveBeenCalledTimes(2);
    expect(f.options[1]!.port).toBe(4502);
    await handle.stop();
  });

  it("serializes a newer settings intent received while replacement startup is pending", async () => {
    const f = fixture();
    const gate = deferred();
    const underlying = f.start.getMockImplementation()!;
    f.start.mockImplementation(async (opts) => {
      const next = await underlying(opts);
      if (f.options.length === 2) await gate.promise;
      return next;
    });
    const handle = await startOwnedEmbeddedDaemon({}, f.start);
    const first = f.options[0]!.requestRestart!({ ...request, port: 4501 });
    await vi.waitFor(() => expect(f.start).toHaveBeenCalledTimes(2));
    const last = f.options[0]!.requestRestart!({ ...request, port: 4502 });
    gate.resolve();
    await Promise.all([first, last]);
    expect(f.start).toHaveBeenCalledTimes(3);
    expect(f.generations[1]!.stop).toHaveBeenCalledTimes(1);
    expect(f.options[2]!.port).toBe(4502);
    expect(handle.instanceId).toBe("generation-3");
    await handle.stop();
  });
});
