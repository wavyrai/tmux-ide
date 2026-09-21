import { describe, expect, it, vi } from "vitest";
import { createPreloadDaemonBridge, type PreloadDaemonIpc } from "./preload-daemon.ts";
import { HOST_IPC, scopedHostChannel } from "./ipc-channels.ts";

const scopeA = "10000000-0000-4000-8000-000000000001";
const scopeB = "20000000-0000-4000-8000-000000000001";
const event = { type: "workspaces.changed" };
const subscriptionId = "desktop-subscription-1";
function rig() {
  const listeners = new Map<string, Set<(event: unknown, value: unknown) => void>>();
  const invoke = vi
    .fn<PreloadDaemonIpc["invoke"]>()
    .mockResolvedValue({ status: "subscribed", subscriptionId });
  const ipc: PreloadDaemonIpc = {
    invoke,
    on(channel, listener) {
      const group = listeners.get(channel) ?? new Set();
      group.add(listener);
      listeners.set(channel, group);
    },
    removeListener(channel, listener) {
      listeners.get(channel)?.delete(listener);
    },
  };
  return {
    ipc,
    invoke,
    listeners,
    emit: (scope: string | null, requestId: string) => {
      for (const receive of listeners.get(scopedHostChannel(scope, HOST_IPC.daemonEvent)) ?? [])
        receive({}, { subscriptionId, subscriptionRequestId: requestId, event });
    },
  };
}

describe("isolated preload daemon scopes", () => {
  it("cannot cross-deliver equal subscription IDs and disposes only its own scope", async () => {
    const r = rig();
    const a = createPreloadDaemonBridge(r.ipc, scopeA),
      b = createPreloadDaemonBridge(r.ipc, scopeB);
    const receiveA = vi.fn(),
      receiveB = vi.fn();
    const first = await a.daemon.subscribe({ workspaceNames: ["a"] }, receiveA);
    await b.daemon.subscribe({ workspaceNames: ["b"] }, receiveB);
    const idA = r.invoke.mock.calls[0]![2] as string,
      idB = r.invoke.mock.calls[1]![2] as string;
    r.emit(scopeA, idA);
    expect(receiveA).toHaveBeenCalledOnce();
    expect(receiveB).not.toHaveBeenCalled();
    a.dispose();
    a.dispose();
    if (first.status === "subscribed") first.unsubscribe();
    r.emit(scopeA, idA);
    r.emit(scopeB, idB);
    expect(receiveA).toHaveBeenCalledOnce();
    expect(receiveB).toHaveBeenCalledOnce();
    expect(
      r.invoke.mock.calls.filter(
        ([channel]) => channel === scopedHostChannel(scopeA, HOST_IPC.daemonUnsubscribe),
      ),
    ).toEqual([[scopedHostChannel(scopeA, HOST_IPC.daemonUnsubscribe), subscriptionId]]);
    expect(r.listeners.get(scopedHostChannel(scopeA, HOST_IPC.daemonEvent))?.size).toBe(0);
    b.dispose();
  });

  it("retains at most eight early events for the exact invoke within each scope", async () => {
    const r = rig();
    const a = createPreloadDaemonBridge(r.ipc, scopeA),
      b = createPreloadDaemonBridge(r.ipc, scopeB);
    r.invoke.mockImplementation(async (channel, _request, requestId) => {
      const scope =
        channel === scopedHostChannel(scopeA, HOST_IPC.daemonSubscribe) ? scopeA : scopeB;
      for (let i = 0; i < 10; i++) r.emit(scope, requestId as string);
      return { status: "subscribed", subscriptionId };
    });
    const receiveA = vi.fn(),
      receiveB = vi.fn();
    await Promise.all([
      a.daemon.subscribe({ workspaceNames: [] }, receiveA),
      b.daemon.subscribe({ workspaceNames: [] }, receiveB),
    ]);
    expect(receiveA).toHaveBeenCalledTimes(8);
    expect(receiveB).toHaveBeenCalledTimes(8);
    a.dispose();
    b.dispose();
  });

  it("cancels a scoped read without cancelling an independent read", async () => {
    const r = rig();
    const a = createPreloadDaemonBridge(r.ipc, scopeA),
      b = createPreloadDaemonBridge(r.ipc, scopeB);
    const settle = new Map<string, (value: unknown) => void>();
    r.invoke.mockImplementation((channel) => {
      if (
        channel === scopedHostChannel(scopeA, HOST_IPC.daemonRequest) ||
        channel === scopedHostChannel(scopeB, HOST_IPC.daemonRequest)
      )
        return new Promise((resolve) => settle.set(channel, resolve));
      return Promise.resolve(undefined);
    });
    const controller = new AbortController();
    const readA = a.daemon.fetchWorkspaceFiles({ workspaceName: "a" }, controller.signal);
    const readB = b.daemon.fetchWorkspaceFiles({ workspaceName: "b" });
    controller.abort();
    const failure = { status: "error", error: { code: "disposed", reason: "cancelled" } };
    settle.get(scopedHostChannel(scopeA, HOST_IPC.daemonRequest))!(failure);
    settle.get(scopedHostChannel(scopeB, HOST_IPC.daemonRequest))!(failure);
    await expect(readA).rejects.toMatchObject({ name: "AbortError" });
    await expect(readB).resolves.toEqual(failure);
    expect(
      r.invoke.mock.calls.filter(([channel]) =>
        [scopeA, scopeB].some(
          (scope) => channel === scopedHostChannel(scope, HOST_IPC.daemonCancelRequest),
        ),
      ),
    ).toHaveLength(1);
    expect(r.invoke.mock.calls[2]![0]).toBe(
      scopedHostChannel(scopeA, HOST_IPC.daemonCancelRequest),
    );
    a.dispose();
    b.dispose();
  });

  it("disposes pending subscriptions and releases a late successful handoff", async () => {
    const r = rig();
    const a = createPreloadDaemonBridge(r.ipc, scopeA);
    let settle!: (value: unknown) => void;
    r.invoke.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );
    const receive = vi.fn();
    const pending = a.daemon.subscribe({ workspaceNames: [] }, receive);
    a.dispose();
    settle({ status: "subscribed", subscriptionId });
    await expect(pending).resolves.toMatchObject({ status: "error", error: { code: "disposed" } });
    expect(receive).not.toHaveBeenCalled();
    expect(r.invoke.mock.calls.map(([channel]) => channel)).toEqual([
      scopedHostChannel(scopeA, HOST_IPC.daemonSubscribe),
      scopedHostChannel(scopeA, HOST_IPC.daemonCancelSubscribe),
      scopedHostChannel(scopeA, HOST_IPC.daemonUnsubscribe),
    ]);
    await expect(a.daemon.subscribe({ workspaceNames: [] }, receive)).resolves.toMatchObject({
      status: "error",
      error: { code: "disposed" },
    });
  });

  it("disposal cancels pending reads once and rejects further requests", async () => {
    const r = rig();
    const bridge = createPreloadDaemonBridge(r.ipc, scopeA);
    let settle!: (value: unknown) => void;
    r.invoke.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );
    const controller = new AbortController();
    const pending = bridge.daemon.fetchWorkspaceFiles({ workspaceName: "a" }, controller.signal);
    bridge.dispose();
    bridge.dispose();
    controller.abort();
    settle({ status: "error", error: { code: "disposed", reason: "cancelled" } });
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(r.invoke.mock.calls.map(([channel]) => channel)).toEqual([
      scopedHostChannel(scopeA, HOST_IPC.daemonRequest),
      scopedHostChannel(scopeA, HOST_IPC.daemonCancelRequest),
    ]);
    await expect(bridge.daemon.fetchWorkspaceFiles({ workspaceName: "a" })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(r.invoke).toHaveBeenCalledTimes(2);
  });

  it("retires pending requests and subscriptions when contextBridge stripped the signal prototype", async () => {
    const r = rig();
    const bridge = createPreloadDaemonBridge(r.ipc, scopeA);
    const settlers: Array<(value: unknown) => void> = [];
    r.invoke.mockImplementation((channel) =>
      channel === scopedHostChannel(scopeA, HOST_IPC.daemonRequest) ||
      channel === scopedHostChannel(scopeA, HOST_IPC.daemonSubscribe)
        ? new Promise((resolve) => settlers.push(resolve))
        : Promise.resolve(),
    );
    const copiedSignal = {} as AbortSignal;
    const read = bridge.daemon.fetchWorkspaceFiles({ workspaceName: "a" }, copiedSignal);
    const subscribed = bridge.daemon.subscribe({ workspaceNames: [] }, () => {}, copiedSignal);
    expect(() => bridge.dispose()).not.toThrow();
    for (const settle of settlers)
      settle({ status: "error", error: { code: "disposed", reason: "cancelled" } });
    await expect(read).rejects.toMatchObject({ name: "AbortError" });
    await expect(subscribed).resolves.toMatchObject({ status: "error" });
    expect(r.invoke.mock.calls.map(([channel]) => channel)).toContain(
      scopedHostChannel(scopeA, HOST_IPC.daemonCancelRequest),
    );
    expect(r.invoke.mock.calls.map(([channel]) => channel)).toContain(
      scopedHostChannel(scopeA, HOST_IPC.daemonCancelSubscribe),
    );
  });

  it("uses a bridged subscribe cleanup and remembers abort when the copied boolean stays false", async () => {
    const r = rig();
    const bridge = createPreloadDaemonBridge(r.ipc, scopeA);
    let settle!: (value: unknown) => void;
    let abort!: () => void;
    r.invoke.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );
    const cleanup = vi.fn();
    const signal = {
      aborted: false,
      subscribeAbort: (callback: () => void) => {
        abort = callback;
        return cleanup;
      },
    } as unknown as AbortSignal;
    const read = bridge.daemon.fetchWorkspaceFiles({ workspaceName: "a" }, signal);
    abort();
    settle({ status: "error", error: { code: "disposed", reason: "cancelled" } });
    await expect(read).rejects.toMatchObject({ name: "AbortError" });
    expect(cleanup).toHaveBeenCalledOnce();
    bridge.dispose();
  });

  it("cleans up when abort subscription or its renderer cleanup proxy throws", async () => {
    const r = rig();
    const bridge = createPreloadDaemonBridge(r.ipc, scopeA);
    const broken = {
      aborted: false,
      subscribeAbort: () => {
        throw Error("retired proxy");
      },
    } as unknown as AbortSignal;
    await expect(bridge.daemon.fetchWorkspaceFiles({ workspaceName: "a" }, broken)).rejects.toThrow(
      "retired proxy",
    );
    await expect(bridge.daemon.subscribe({ workspaceNames: [] }, () => {}, broken)).rejects.toThrow(
      "retired proxy",
    );
    expect(r.invoke).not.toHaveBeenCalled();
    let settle!: (value: unknown) => void;
    r.invoke.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );
    const signal = {
      aborted: false,
      subscribeAbort: () => () => {
        throw Error("retired cleanup");
      },
    } as unknown as AbortSignal;
    const read = bridge.daemon.fetchWorkspaceFiles({ workspaceName: "a" }, signal);
    expect(() => bridge.dispose()).not.toThrow();
    settle({ status: "error", error: { code: "disposed", reason: "cancelled" } });
    await expect(read).rejects.toMatchObject({ name: "AbortError" });
    expect(r.invoke.mock.calls).toHaveLength(2);
  });

  it("does not cancel or misreport a mutation already committed during disposal", async () => {
    const r = rig();
    const bridge = createPreloadDaemonBridge(r.ipc, scopeA);
    let settle!: (value: unknown) => void;
    r.invoke.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );
    const pending = bridge.daemon.refreshConnection();
    bridge.dispose();
    settle({
      outcome: "unchanged",
      daemon: { status: "unavailable", code: "record-missing", reason: "down" },
    });
    await expect(pending).resolves.toMatchObject({ outcome: "unchanged" });
    expect(r.invoke).toHaveBeenCalledTimes(1);
  });

  it("keeps default local channels and validates scoped requests and responses", async () => {
    const r = rig();
    const a = createPreloadDaemonBridge(r.ipc);
    r.invoke.mockResolvedValue({ malformed: true });
    await expect(a.daemon.fetchWorkspaceFiles({ workspaceName: "a" })).rejects.toThrow();
    expect(r.invoke.mock.calls[0]![0]).toBe(HOST_IPC.daemonRequest);
    const count = r.invoke.mock.calls.length;
    await expect(a.daemon.fetchWorkspaceFiles({ workspaceName: "" })).rejects.toThrow();
    expect(r.invoke).toHaveBeenCalledTimes(count);
    a.dispose();
  });
});
