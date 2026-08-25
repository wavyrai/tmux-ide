import { describe, expect, it, vi } from "vitest";

import { createWebWorkspacePaneStreamBridge } from "./web-workspace-pane-stream-bridge.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

describe("Web WorkspaceClient compositor bridge", () => {
  it("exposes a detailed-only deterministic one-slot sink blocker", async () => {
    const globals = globalThis as typeof globalThis & Record<string, unknown>;
    globals.__TMUX_IDE_CARD5_EVIDENCE_ENABLED__ = true;
    const bridge = createWebWorkspacePaneStreamBridge("workspace-a");
    const control = globals.__TMUX_IDE_CARD5_SINK_CONTROL__ as {
      setBlocked(value: boolean): void;
      snapshot(): {
        pendingCurrent: number;
        pendingPeak: number;
        queueCap: number;
        coalescedCount: number;
      };
    };
    control.setBlocked(true);
    const listener = vi.fn();
    await bridge.connect(
      { workspaceName: "workspace-a", panes: ["pane.a"] },
      { onPaneEvent: listener, onEnd: vi.fn() },
    );
    for (let byte = 0; byte < 100; byte += 1) {
      bridge.publishPane("pane.a", {
        type: "output",
        bytes: new Uint8Array([byte]),
        replay: () => ({ reset: null, seed: new Uint8Array([byte]), held: [], cursor: null }),
      });
    }
    await Promise.resolve();
    expect(control.snapshot()).toMatchObject({
      pendingCurrent: 1,
      pendingPeak: 1,
      queueCap: 1,
      coalescedCount: 99,
    });
    expect(listener).not.toHaveBeenCalled();
    control.setBlocked(false);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(listener).toHaveBeenCalledTimes(2);
    bridge.end({ code: "test", reason: "done", retryable: false });
    expect(globals.__TMUX_IDE_CARD5_SINK_CONTROL__).toBeUndefined();
    delete globals.__TMUX_IDE_CARD5_EVIDENCE_ENABLED__;
  });

  it("bounds a blocked pane to one in-flight and one latest authoritative replay", async () => {
    const bridge = createWebWorkspacePaneStreamBridge("workspace-a");
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    const events: Array<{ type: string; byte: number | undefined }> = [];
    let calls = 0;
    const connected = await bridge.connect(
      { workspaceName: "workspace-a", panes: ["pane.a"] },
      {
        onPaneEvent: async (_pane, event) => {
          calls += 1;
          events.push({
            type: event.type,
            byte:
              event.type === "output"
                ? event.bytes[0]
                : event.type === "seed-batch"
                  ? event.batch.seed[0]
                  : undefined,
          });
          if (calls === 1) await blocked;
        },
        onEnd: vi.fn(),
      },
    );
    bridge.publishPane("pane.a", {
      type: "output",
      bytes: new Uint8Array([1]),
      replay: () => ({ reset: null, seed: new Uint8Array([1]), held: [], cursor: null }),
    });
    let replayCount = 0;
    for (let index = 0; index < 5_000; index += 1) {
      const byte = index & 255;
      bridge.publishPane("pane.a", {
        type: "output",
        bytes: new Uint8Array([byte]),
        replay: () => {
          replayCount += 1;
          return { reset: null, seed: new Uint8Array([byte]), held: [], cursor: null };
        },
      });
    }
    bridge.publishPane("pane.a", { type: "cursor", x: 7, y: 9 });
    bridge.publishPane("pane.a", {
      type: "flow",
      state: "resumed",
      reason: "backpressure",
    });
    expect(calls).toBe(1);
    expect(replayCount).toBe(0);
    release();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(2);
    expect(replayCount).toBe(1);
    expect(events).toEqual([
      { type: "output", byte: 1 },
      { type: "seed-batch", byte: (5_000 - 1) & 255 },
    ]);
    if (connected.status !== "connected") throw new Error("bridge did not connect");
    connected.session.dispose();
  });

  it("materializes retained output lazily and isolates a slow/reconnected viewer", async () => {
    const bridge = createWebWorkspacePaneStreamBridge("workspace-a");
    const replay = vi.fn(() => ({
      reset: { cols: 80, rows: 24 },
      seed: new Uint8Array([1, 2, 3]),
      held: [],
      cursor: { x: 0, y: 0 },
    }));
    bridge.publishPane("pane.a", {
      type: "output",
      bytes: new Uint8Array([1]),
      replay,
    });
    expect(replay).not.toHaveBeenCalled();

    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const firstListener = vi.fn(async () => await blocked);
    const first = await bridge.connect(
      { workspaceName: "workspace-a", panes: ["pane.a"] },
      { onPaneEvent: firstListener, onEnd: vi.fn() },
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(replay).toHaveBeenCalledTimes(1);
    expect(firstListener).toHaveBeenCalledTimes(1);
    bridge.publishPane("pane.a", {
      type: "output",
      bytes: new Uint8Array([2]),
      replay: () => ({
        reset: null,
        seed: new Uint8Array([2]),
        held: [],
        cursor: null,
      }),
    });
    await Promise.resolve();
    expect(firstListener).toHaveBeenCalledTimes(1);

    if (first.status !== "connected") throw new Error("bridge did not connect");
    first.session.dispose();
    release();
    await Promise.resolve();
    expect(firstListener).toHaveBeenCalledTimes(1);
    const reconnected = vi.fn();
    await bridge.connect(
      { workspaceName: "workspace-a", panes: ["pane.a"] },
      { onPaneEvent: reconnected, onEnd: vi.fn() },
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(reconnected).toHaveBeenCalledTimes(1);
  });

  it("delegates presence only to the currently bound runtime session", async () => {
    const bridge = createWebWorkspacePaneStreamBridge("workspace-a");
    const firstPresence = vi.fn();
    const secondPresence = vi.fn();
    bridge.bindSession({ dispose: vi.fn(), updatePresence: firstPresence });
    const result = await bridge.connect(
      { workspaceName: "workspace-a", panes: ["pane.a"] },
      { onPaneEvent: vi.fn(), onEnd: vi.fn() },
    );
    if (result.status !== "connected") throw new Error("bridge did not connect");
    result.session.updatePresence?.("foreground");
    bridge.bindSession({ dispose: vi.fn(), updatePresence: secondPresence });
    result.session.updatePresence?.("background");
    expect(firstPresence).toHaveBeenCalledTimes(1);
    expect(secondPresence).toHaveBeenCalledWith("background");
  });

  it("fails every control closed while no physical session is bound", async () => {
    const bridge = createWebWorkspacePaneStreamBridge("workspace-a");
    const result = await bridge.connect(
      { workspaceName: "workspace-a", panes: ["pane.a"], viewerMode: "interactive" },
      { onPaneEvent: vi.fn(), onEnd: vi.fn() },
    );
    if (result.status !== "connected") throw new Error("bridge did not connect");
    await expect(result.session.write!("pane.a", "marker")).resolves.toBe(false);
    await expect(result.session.resize!(140, 46)).resolves.toBe("lifecycle-retired");
    await expect(result.session.requestAuthority!("geometry")).resolves.toBeNull();
    await expect(result.session.releaseAuthority!("geometry")).resolves.toBeNull();
  });

  it("never delegates controls for read-only viewers or writes outside the pane set", async () => {
    const bridge = createWebWorkspacePaneStreamBridge("workspace-a");
    const physical = {
      dispose: vi.fn(),
      write: vi.fn(async () => true),
      resize: vi.fn(async () => "ok" as const),
      requestAuthority: vi.fn(async () => null),
      releaseAuthority: vi.fn(async () => null),
    };
    bridge.bindSession(physical);
    const readOnly = await bridge.connect(
      { workspaceName: "workspace-a", panes: ["pane.a"], viewerMode: "read-only" },
      { onPaneEvent: vi.fn(), onEnd: vi.fn() },
    );
    if (readOnly.status !== "connected") throw new Error("bridge did not connect");
    await expect(readOnly.session.write!("pane.a", "marker")).resolves.toBe(false);
    await expect(readOnly.session.resize!(140, 46)).resolves.toBe("lifecycle-retired");
    await expect(readOnly.session.requestAuthority!("geometry")).resolves.toBeNull();
    await expect(readOnly.session.releaseAuthority!("geometry")).resolves.toBeNull();

    const interactive = await bridge.connect(
      { workspaceName: "workspace-a", panes: ["pane.a"], viewerMode: "interactive" },
      { onPaneEvent: vi.fn(), onEnd: vi.fn() },
    );
    if (interactive.status !== "connected") throw new Error("bridge did not connect");
    await expect(interactive.session.write!("pane.b", "marker")).resolves.toBe(false);
    expect(physical.write).not.toHaveBeenCalled();
    expect(physical.resize).not.toHaveBeenCalled();
    expect(physical.requestAuthority).not.toHaveBeenCalled();
    expect(physical.releaseAuthority).not.toHaveBeenCalled();
  });

  it("rejects workspace splices and retires controls from the prior bound target", async () => {
    const bridge = createWebWorkspacePaneStreamBridge("workspace-a");
    const firstWrite = vi.fn(async () => true);
    const secondWrite = vi.fn(async () => true);
    bridge.bindSession({ dispose: vi.fn(), write: firstWrite }, "workspace-a");
    const firstPane = vi.fn();
    const firstLayout = vi.fn();
    const firstLayoutSnapshot = vi.fn();
    const firstEnd = vi.fn();
    const first = await bridge.connect(
      { workspaceName: "workspace-a", panes: ["pane.a"], viewerMode: "interactive" },
      {
        onPaneEvent: firstPane,
        onLayout: firstLayout,
        onLayoutSnapshot: firstLayoutSnapshot,
        onEnd: firstEnd,
      },
    );
    if (first.status !== "connected") throw new Error("bridge did not connect");

    bridge.bindSession({ dispose: vi.fn(), write: secondWrite }, "workspace-b");
    bridge.publishPane("pane.a", {
      type: "seed-batch",
      batch: { reset: null, seed: new Uint8Array([2]), held: [], cursor: null },
    });
    bridge.publishLayout({
      semanticWindowId: "window.b",
      windowName: "window-b",
      currentWindow: true,
      cols: 140,
      rows: 46,
      zoomed: false,
      paneBorderStatus: "top",
      panes: [{ pane: "pane.a", left: 0, top: 0, width: 140, height: 46, active: true }],
    });
    bridge.publishLayoutSnapshot({
      topologyEpoch: 1,
      layouts: [],
    });
    await Promise.resolve();
    expect(firstPane).not.toHaveBeenCalled();
    expect(firstLayout).not.toHaveBeenCalled();
    expect(firstLayoutSnapshot).not.toHaveBeenCalled();
    expect(firstEnd).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ code: "workspace-client-target-mismatch" }),
    );
    await expect(first.session.write!("pane.a", "stale")).resolves.toBe(false);
    const staleTarget = await bridge.connect(
      { workspaceName: "workspace-a", panes: ["pane.a"], viewerMode: "interactive" },
      { onPaneEvent: vi.fn(), onEnd: vi.fn() },
    );
    expect(staleTarget).toMatchObject({
      status: "error",
      error: { code: "workspace-client-target-mismatch" },
    });
    const current = await bridge.connect(
      { workspaceName: "workspace-b", panes: ["pane.a"], viewerMode: "interactive" },
      { onPaneEvent: vi.fn(), onEnd: vi.fn() },
    );
    if (current.status !== "connected") throw new Error("bridge did not connect");
    await expect(current.session.write!("pane.a", "current")).resolves.toBe(true);
    expect(firstWrite).not.toHaveBeenCalled();
    expect(secondWrite).toHaveBeenCalledExactlyOnceWith("pane.a", "current");

    const thirdWrite = vi.fn(async () => true);
    const thirdPresence = vi.fn();
    bridge.bindSession(
      { dispose: vi.fn(), write: thirdWrite, updatePresence: thirdPresence },
      "workspace-a",
    );
    await expect(first.session.write!("pane.a", "resurrected")).resolves.toBe(false);
    first.session.updatePresence?.("foreground");
    expect(thirdWrite).not.toHaveBeenCalled();
    expect(thirdPresence).not.toHaveBeenCalled();
  });

  it("fences every in-flight control result to the exact bound physical session", async () => {
    const bridge = createWebWorkspacePaneStreamBridge("workspace-a");
    const writeA = deferred<boolean>();
    const resizeA = deferred<"geometry-authority-conflict">();
    const requestA = deferred<null>();
    const releaseA = deferred<null>();
    let firstGeometryClient: string | null = "client-a";
    const first = {
      dispose: vi.fn(),
      write: vi.fn(() => writeA.promise),
      resize: vi.fn(() => resizeA.promise),
      requestAuthority: vi.fn(() => requestA.promise),
      connectionAuthorityClientId: vi.fn(() => firstGeometryClient),
      releaseAuthority: vi.fn(() => {
        firstGeometryClient = null;
        return releaseA.promise;
      }),
    };
    const second = {
      dispose: vi.fn(),
      write: vi.fn(async () => true),
      resize: vi.fn(async () => "ok" as const),
      requestAuthority: vi.fn(async () => null),
      connectionAuthorityClientId: vi.fn(() => null),
      releaseAuthority: vi.fn(async () => null),
    };
    bridge.bindSession(first);
    const result = await bridge.connect(
      { workspaceName: "workspace-a", panes: ["pane.a"], viewerMode: "interactive" },
      { onPaneEvent: vi.fn(), onEnd: vi.fn() },
    );
    if (result.status !== "connected") throw new Error("bridge did not connect");
    expect(result.session.connectionAuthorityClientId!("geometry")).toBe("client-a");
    const lateWrite = result.session.write!("pane.a", "marker");
    const lateResize = result.session.resize!(140, 46);
    const lateRequest = result.session.requestAuthority!("geometry");
    const lateRelease = result.session.releaseAuthority!("geometry");
    bridge.bindSession(second);
    expect(result.session.connectionAuthorityClientId!("geometry")).toBeNull();
    writeA.resolve(true);
    resizeA.resolve("geometry-authority-conflict");
    requestA.resolve(null);
    releaseA.resolve(null);
    await expect(lateWrite).resolves.toBe(false);
    await expect(lateResize).resolves.toBe("lifecycle-retired");
    await expect(lateRequest).resolves.toBeNull();
    await expect(lateRelease).resolves.toBeNull();

    await expect(result.session.write!("pane.a", "current")).resolves.toBe(true);
    await expect(result.session.resize!(140, 46)).resolves.toBe("ok");
    expect(first.write).toHaveBeenCalledOnce();
    expect(second.write).toHaveBeenCalledExactlyOnceWith("pane.a", "current");
    result.session.dispose();
    expect(first.dispose).not.toHaveBeenCalled();
    expect(second.dispose).not.toHaveBeenCalled();
    await expect(result.session.write!("pane.a", "late")).resolves.toBe(false);
    await expect(result.session.resize!(140, 46)).resolves.toBe("lifecycle-retired");
  });

  it("keeps a local viewer across a WorkspaceClient-owned clean runtime rebind", async () => {
    const bridge = createWebWorkspacePaneStreamBridge("workspace-a");
    const events = vi.fn();
    const ended = vi.fn();
    const result = await bridge.connect(
      { workspaceName: "workspace-a", panes: ["pane.a"] },
      { onPaneEvent: events, onEnd: ended },
    );
    bridge.end(null);
    bridge.bindSession({ dispose: vi.fn() });
    bridge.publishPane("pane.a", {
      type: "seed-batch",
      batch: { reset: null, seed: new Uint8Array([9]), held: [], cursor: null },
    });
    await Promise.resolve();
    expect(ended).not.toHaveBeenCalled();
    expect(events).toHaveBeenCalledOnce();
    if (result.status !== "connected") throw new Error("bridge did not connect");
    result.session.dispose();
  });
});
