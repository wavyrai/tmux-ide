import { describe, expect, it, vi } from "vitest";
import type {
  DesktopApplicationShellTarget,
  DesktopDaemonEvent,
  HostCapabilities,
} from "@tmux-ide/contracts";

import {
  createWebWorkspaceOwnerActionPort,
  createWebWorkspaceCatalogPort,
  createWebWorkspaceRuntimeBridgePorts,
  submitWebWorkspaceSemanticIntent,
} from "./web-workspace-client.ts";
import { createWebWorkspacePaneStreamBridge } from "./web-workspace-pane-stream-bridge.ts";
import type {
  WebWorkspaceRuntimeOptions,
  WebWorkspaceRuntimePort,
} from "./web-workspace-runtime.ts";

const OPERATION = "10000000-0000-4000-8000-000000000001";
const GENERATION = "20000000-0000-4000-8000-000000000001";
const TARGET = {
  daemon: {
    protocolVersion: 1,
    productVersion: "test",
    instanceId: GENERATION,
    startedAt: "2026-08-23T00:00:00.000Z",
  },
  workspaceName: "workspace-a",
} satisfies DesktopApplicationShellTarget;

function physicalSession(
  generation: string,
  workspaceName: string,
  panes: readonly string[],
  clientId = "web-client-a",
) {
  return {
    dispose: vi.fn(),
    card5PhysicalBinding: () => ({
      physicalEpoch: 1,
      generation,
      requestId: `request-${clientId}`,
      runtimeSession: "runtime-a",
      workspaceName,
      semanticPaneIds: [...panes],
      clientId,
      stage: "first-seed" as const,
    }),
  };
}

function canonical(generation: string, revision: number) {
  return {
    deliveryRequestId: `delivery-${revision}`,
    generation,
    incarnation: "incarnation-a",
    revision,
    stateHash: String(revision).padStart(64, "0"),
    cols: 80,
    rows: 24,
    sourceEpoch: 1,
    alternateScreen: false,
    cursor: { x: 0, y: 0, hidden: false, style: "block" as const, blink: false },
    gridRowsRead: 24,
    gridCellsRead: 1_920,
    fullGridWalks: 1,
  };
}

const layout = {
  semanticWindowId: "window-a",
  windowName: "main",
  currentWindow: true,
  cols: 80,
  rows: 24,
  zoomed: false,
  paneBorderStatus: "off" as const,
  panes: [],
};

describe("Web WorkspaceClient owner action binding", () => {
  it("activates a candidate from one authoritative replay and retires prior panes", async () => {
    const bridge = createWebWorkspacePaneStreamBridge("workspace-a");
    const captures: WebWorkspaceRuntimeOptions[] = [];
    const connect = vi.fn(async (options: WebWorkspaceRuntimeOptions) => {
      captures.push(options);
      options.onSession?.(
        physicalSession(
          options.inventory.daemonGeneration,
          options.inventory.workspaceName,
          options.inventory.semanticPaneIds,
        ),
      );
      return {
        generation: GENERATION,
        closed: new Promise<unknown>(() => undefined),
        close: vi.fn(),
      } as unknown as WebWorkspaceRuntimePort;
    });
    const ports = createWebWorkspaceRuntimeBridgePorts({
      host: { daemon: {}, workspace: {} } as unknown as HostCapabilities,
      bridge,
      connect,
    });
    const inventory = {
      workspaceName: "workspace-a",
      workspaceId: "workspace-a",
      sessionId: "session-a",
      daemonGeneration: GENERATION,
      shellGeneration: 1,
      semanticPaneIds: ["pane.primary"],
    };
    const a = await ports.connectRuntime(
      TARGET,
      inventory,
      new AbortController().signal,
      async () => undefined,
    );
    captures[0]!.onPaneEvent?.("pane.primary", {
      type: "seed-batch",
      batch: { reset: null, seed: new Uint8Array([1]), held: [], cursor: null },
      canonical: canonical(GENERATION, 1),
    });
    captures[0]!.onLayout?.(layout);
    ports.didActivateRuntime?.(a, inventory);
    const events: Array<{ pane: string; type: string; byte: number | undefined }> = [];
    await bridge.connect(
      { workspaceName: "workspace-a", panes: ["pane.primary"] },
      {
        onPaneEvent: (pane, event) => {
          events.push({
            pane,
            type: event.type,
            byte:
              event.type === "seed-batch"
                ? event.batch.seed[0]
                : event.type === "output"
                  ? event.bytes[0]
                  : undefined,
          });
        },
        onEnd: vi.fn(),
      },
    );
    await Promise.resolve();
    await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const b = await ports.connectRuntime(
      TARGET,
      inventory,
      new AbortController().signal,
      async () => undefined,
    );
    captures[1]!.onPaneEvent?.("pane.primary", {
      type: "seed-batch",
      batch: { reset: null, seed: new Uint8Array([2]), held: [], cursor: null },
      canonical: canonical(GENERATION, 2),
    });
    captures[1]!.onPaneEvent?.("pane.primary", {
      type: "output",
      bytes: new Uint8Array([9]),
      replay: () => ({ reset: null, seed: new Uint8Array([3]), held: [], cursor: null }),
      canonical: canonical(GENERATION, 3),
    });
    captures[1]!.onLayout?.(layout);
    captures[1]!.onPaneEvent?.("pane.primary", { type: "cursor", x: 7, y: 8 });
    captures[1]!.onPaneEvent?.("pane.primary", {
      type: "flow",
      state: "resumed",
      reason: "backpressure",
    });
    ports.didActivateRuntime?.(b, inventory);
    await Promise.resolve();
    await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual([
      { pane: "pane.primary", type: "seed-batch", byte: 1 },
      { pane: "pane.primary", type: "seed-batch", byte: 3 },
    ]);

    const removed = { ...inventory, semanticPaneIds: ["pane.secondary"] };
    const c = await ports.connectRuntime(
      TARGET,
      removed,
      new AbortController().signal,
      async () => undefined,
    );
    captures[2]!.onPaneEvent?.("pane.secondary", {
      type: "seed-batch",
      batch: { reset: null, seed: new Uint8Array([4]), held: [], cursor: null },
      canonical: canonical(GENERATION, 4),
    });
    captures[2]!.onLayout?.(layout);
    ports.didActivateRuntime?.(c, removed);
    await Promise.resolve();
    await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(events.at(-1)).toEqual({ pane: "pane.primary", type: "closed", byte: undefined });
  });

  it("fences late runtime A end from active B and closes a rejected candidate", async () => {
    const bridge = createWebWorkspacePaneStreamBridge("workspace-a");
    const captures: WebWorkspaceRuntimeOptions[] = [];
    const runtimes: Array<WebWorkspaceRuntimePort & { close: ReturnType<typeof vi.fn> }> = [];
    const sessionPresence: Array<ReturnType<typeof vi.fn>> = [];
    const connect = vi.fn(async (options: WebWorkspaceRuntimeOptions) => {
      captures.push(options);
      const close = vi.fn();
      const runtime = {
        generation: GENERATION,
        closed: new Promise<unknown>(() => undefined),
        close,
      } as unknown as WebWorkspaceRuntimePort & { close: ReturnType<typeof vi.fn> };
      runtimes.push(runtime);
      const updatePresence = vi.fn();
      sessionPresence.push(updatePresence);
      options.onSession?.({
        ...physicalSession(
          options.inventory.daemonGeneration,
          options.inventory.workspaceName,
          options.inventory.semanticPaneIds,
          `web-client-${captures.length}`,
        ),
        updatePresence,
      });
      return runtime;
    });
    const ports = createWebWorkspaceRuntimeBridgePorts({
      host: { daemon: {}, workspace: {} } as unknown as HostCapabilities,
      bridge,
      connect,
    });
    const inventory = {
      workspaceName: "workspace-a",
      workspaceId: "workspace-a",
      sessionId: "session-a",
      daemonGeneration: GENERATION,
      shellGeneration: 1,
      semanticPaneIds: ["pane.primary"],
    };
    const a = await ports.connectRuntime(
      TARGET,
      inventory,
      new AbortController().signal,
      async () => undefined,
    );
    captures[0]?.onPaneEvent?.("pane.primary", {
      type: "seed-batch",
      batch: { reset: null, seed: new Uint8Array([1]), held: [], cursor: null },
      canonical: canonical(GENERATION, 1),
    });
    captures[0]?.onLayout?.(layout);
    ports.didActivateRuntime?.(a, inventory);
    const b = await ports.connectRuntime(
      TARGET,
      inventory,
      new AbortController().signal,
      async () => undefined,
    );
    captures[1]?.onPaneEvent?.("pane.primary", {
      type: "seed-batch",
      batch: { reset: null, seed: new Uint8Array([2]), held: [], cursor: null },
      canonical: canonical(GENERATION, 2),
    });
    captures[1]?.onLayout?.(layout);
    ports.didActivateRuntime?.(b, inventory);
    await Promise.resolve();
    await Promise.resolve();
    captures[0]?.onEnd?.(new Error("late A"));
    const paneEvent = vi.fn();
    const layoutListener = vi.fn();
    const connected = await bridge.connect(
      { workspaceName: "workspace-a", panes: ["pane.primary"] },
      { onPaneEvent: paneEvent, onLayout: layoutListener, onEnd: vi.fn() },
    );
    expect(connected).toMatchObject({ status: "connected" });
    await Promise.resolve();
    await Promise.resolve();
    paneEvent.mockClear();
    layoutListener.mockClear();
    captures[0]?.onPaneEvent?.("pane.primary", {
      type: "seed-batch",
      batch: { reset: null, seed: new Uint8Array([8]), held: [], cursor: null },
    });
    captures[0]?.onLayout?.({
      semanticWindowId: "window.late-a",
      windowName: "late-a",
      currentWindow: true,
      cols: 80,
      rows: 24,
      zoomed: false,
      paneBorderStatus: "off",
      panes: [],
    });
    const latePresence = vi.fn();
    captures[0]?.onSession?.({ dispose: vi.fn(), updatePresence: latePresence });
    await Promise.resolve();
    expect(paneEvent).not.toHaveBeenCalled();
    expect(layoutListener).not.toHaveBeenCalled();
    if (connected.status !== "connected") throw new Error("bridge did not connect");
    connected.session.updatePresence?.("background");
    expect(sessionPresence[1]).toHaveBeenCalledWith("background");
    expect(latePresence).not.toHaveBeenCalled();

    await expect(
      ports.connectRuntime(TARGET, inventory, new AbortController().signal, async () => {
        throw new Error("prepare rejected");
      }),
    ).rejects.toThrow("prepare rejected");
    expect(runtimes.at(-1)?.close).toHaveBeenCalledTimes(1);
  });

  it("publishes no binding for incomplete, duplicate, wrong-generation, or overflow candidates", async () => {
    for (const invalid of [
      "missing",
      "duplicate-seed",
      "duplicate-layout",
      "duplicate-session",
      "wrong-generation",
      "overflow",
    ] as const) {
      const bridge = createWebWorkspacePaneStreamBridge("workspace-a");
      const bindSession = vi.spyOn(bridge, "bindSession");
      const activateRuntime = vi.spyOn(bridge, "activateRuntime");
      let capture!: WebWorkspaceRuntimeOptions;
      const close = vi.fn();
      const ports = createWebWorkspaceRuntimeBridgePorts({
        host: { daemon: {}, workspace: {} } as unknown as HostCapabilities,
        bridge,
        connect: vi.fn(async (options: WebWorkspaceRuntimeOptions) => {
          capture = options;
          options.onSession?.(
            physicalSession(
              options.inventory.daemonGeneration,
              options.inventory.workspaceName,
              options.inventory.semanticPaneIds,
            ),
          );
          return {
            generation: GENERATION,
            closed: new Promise<unknown>(() => undefined),
            close,
          } as unknown as WebWorkspaceRuntimePort;
        }),
      });
      const inventory = {
        workspaceName: "workspace-a",
        workspaceId: "workspace-a",
        sessionId: "session-a",
        daemonGeneration: GENERATION,
        shellGeneration: 1,
        semanticPaneIds: ["pane.primary"],
      };
      const controller = new AbortController();
      const runtime = await ports.connectRuntime(
        TARGET,
        inventory,
        controller.signal,
        async () => undefined,
      );
      const seedCount = invalid === "missing" ? 0 : invalid === "duplicate-seed" ? 2 : 1;
      for (let index = 0; index < seedCount; index += 1) {
        capture.onPaneEvent?.("pane.primary", {
          type: "seed-batch",
          batch: { reset: null, seed: new Uint8Array([index]), held: [], cursor: null },
          canonical: canonical(
            invalid === "wrong-generation" ? "generation-foreign" : GENERATION,
            index + 1,
          ),
        });
      }
      capture.onLayout?.(layout);
      if (invalid === "duplicate-layout") capture.onLayout?.(layout);
      if (invalid === "duplicate-session")
        capture.onSession?.(physicalSession(GENERATION, "workspace-a", ["pane.primary"]));
      if (invalid === "overflow") {
        for (let index = 0; index < 8_193; index += 1)
          capture.onPaneEvent?.("pane.primary", { type: "cursor", x: index, y: 0 });
      }
      ports.didActivateRuntime?.(runtime, inventory);
      expect(bindSession).toHaveBeenCalledWith(null, "workspace-a");
      expect(activateRuntime).not.toHaveBeenCalled();
      if (invalid === "missing") {
        expect(close).not.toHaveBeenCalled();
        controller.abort();
      }
      expect(close).toHaveBeenCalledTimes(1);
    }
  });

  it("treats activation as intent and commits once after every delayed readiness permutation", async () => {
    const permutations = [
      ["session", "layout", "seed"],
      ["session", "seed", "layout"],
      ["layout", "session", "seed"],
      ["layout", "seed", "session"],
      ["seed", "session", "layout"],
      ["seed", "layout", "session"],
    ] as const;
    for (const order of permutations) {
      const sourceShapedOutputSeed = order === permutations[0];
      const bridge = createWebWorkspacePaneStreamBridge("workspace-a");
      const activateRuntime = vi.spyOn(bridge, "activateRuntime");
      let capture!: WebWorkspaceRuntimeOptions;
      const close = vi.fn();
      const ports = createWebWorkspaceRuntimeBridgePorts({
        host: { daemon: {}, workspace: {} } as unknown as HostCapabilities,
        bridge,
        connect: vi.fn(async (options: WebWorkspaceRuntimeOptions) => {
          capture = options;
          return {
            generation: GENERATION,
            closed: new Promise<unknown>(() => undefined),
            close,
          } as unknown as WebWorkspaceRuntimePort;
        }),
      });
      const inventory = {
        workspaceName: "workspace-a",
        workspaceId: "workspace-a",
        sessionId: "session-a",
        daemonGeneration: GENERATION,
        shellGeneration: 1,
        semanticPaneIds: ["pane.primary"],
      };
      const runtime = await ports.connectRuntime(
        TARGET,
        inventory,
        new AbortController().signal,
        async () => undefined,
      );
      ports.didActivateRuntime?.(runtime, inventory);
      expect(activateRuntime).not.toHaveBeenCalled();
      for (const [index, stage] of order.entries()) {
        if (stage === "session")
          capture.onSession?.(physicalSession(GENERATION, "workspace-a", ["pane.primary"]));
        else if (stage === "layout") capture.onLayout?.(layout);
        else if (sourceShapedOutputSeed)
          capture.onPaneEvent?.("pane.primary", {
            type: "output",
            bytes: new Uint8Array([1]),
            replay: () => ({ reset: null, seed: new Uint8Array([1]), held: [], cursor: null }),
            canonical: canonical(GENERATION, 1),
            canonicalUpdate: { type: "terminal.seed", generation: GENERATION } as never,
          });
        else
          capture.onPaneEvent?.("pane.primary", {
            type: "seed-batch",
            batch: { reset: null, seed: new Uint8Array([1]), held: [], cursor: null },
            canonical: canonical(GENERATION, 1),
          });
        if (index < order.length - 1) expect(activateRuntime).not.toHaveBeenCalled();
      }
      await Promise.resolve();
      await Promise.resolve();
      expect(activateRuntime).toHaveBeenCalledTimes(1);
      expect(close).not.toHaveBeenCalled();
    }
  });

  it("closes an activation intent once when readiness misses its hard deadline", async () => {
    vi.useFakeTimers();
    try {
      const bridge = createWebWorkspacePaneStreamBridge("workspace-a");
      let capture!: WebWorkspaceRuntimeOptions;
      const close = vi.fn();
      const ports = createWebWorkspaceRuntimeBridgePorts({
        host: { daemon: {}, workspace: {} } as unknown as HostCapabilities,
        bridge,
        connect: vi.fn(async (options: WebWorkspaceRuntimeOptions) => {
          capture = options;
          return {
            generation: GENERATION,
            closed: new Promise<unknown>(() => undefined),
            close,
          } as unknown as WebWorkspaceRuntimePort;
        }),
      });
      const inventory = {
        workspaceName: "workspace-a",
        workspaceId: "workspace-a",
        sessionId: "session-a",
        daemonGeneration: GENERATION,
        shellGeneration: 1,
        semanticPaneIds: ["pane.primary"],
      };
      const runtime = await ports.connectRuntime(
        TARGET,
        inventory,
        new AbortController().signal,
        async () => undefined,
      );
      capture.onSession?.(physicalSession(GENERATION, "workspace-a", ["pane.primary"]));
      ports.didActivateRuntime?.(runtime, inventory);
      expect(close).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(15_000);
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed on invalid or regressing readiness clocks", async () => {
    for (const clockValues of [[Number.NaN], [100, 99], ["throw"], [100, "throw"]] as const) {
      let index = 0;
      const clock = vi.spyOn(performance, "now").mockImplementation(() => {
        const value = clockValues[Math.min(index++, clockValues.length - 1)]!;
        if (value === "throw") throw new Error("clock unavailable");
        return value;
      });
      try {
        const bridge = createWebWorkspacePaneStreamBridge("workspace-a");
        let capture!: WebWorkspaceRuntimeOptions;
        const close = vi.fn();
        const ports = createWebWorkspaceRuntimeBridgePorts({
          host: { daemon: {}, workspace: {} } as unknown as HostCapabilities,
          bridge,
          connect: vi.fn(async (options: WebWorkspaceRuntimeOptions) => {
            capture = options;
            options.onSession?.(physicalSession(GENERATION, "workspace-a", ["pane.primary"]));
            return {
              generation: GENERATION,
              closed: new Promise<unknown>(() => undefined),
              close,
            } as unknown as WebWorkspaceRuntimePort;
          }),
        });
        const inventory = {
          workspaceName: "workspace-a",
          workspaceId: "workspace-a",
          sessionId: "session-a",
          daemonGeneration: GENERATION,
          shellGeneration: 1,
          semanticPaneIds: ["pane.primary"],
        };
        const runtime = await ports.connectRuntime(
          TARGET,
          inventory,
          new AbortController().signal,
          async () => undefined,
        );
        capture.onPaneEvent?.("pane.primary", {
          type: "seed-batch",
          batch: { reset: null, seed: new Uint8Array([1]), held: [], cursor: null },
          canonical: canonical(GENERATION, 1),
        });
        capture.onLayout?.(layout);
        ports.didActivateRuntime?.(runtime, inventory);
        expect(close).toHaveBeenCalledTimes(1);
      } finally {
        clock.mockRestore();
      }
    }
  });

  it("keeps the hard deadline through consumer settlement and fences a late acknowledgement", async () => {
    vi.useFakeTimers();
    let browserNow = 100;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => browserNow);
    const globals = globalThis as typeof globalThis & Record<string, unknown>;
    globals.__TMUX_IDE_CARD5_EVIDENCE_ENABLED__ = true;
    try {
      const bridge = createWebWorkspacePaneStreamBridge("workspace-a");
      const activation = vi.spyOn(bridge, "activateRuntime");
      const control = globals.__TMUX_IDE_CARD5_SINK_CONTROL__ as {
        setBlocked(value: boolean): void;
      };
      let capture!: WebWorkspaceRuntimeOptions;
      const close = vi.fn();
      const ports = createWebWorkspaceRuntimeBridgePorts({
        host: { daemon: {}, workspace: {} } as unknown as HostCapabilities,
        bridge,
        connect: vi.fn(async (options: WebWorkspaceRuntimeOptions) => {
          capture = options;
          options.onSession?.(physicalSession(GENERATION, "workspace-a", ["pane.primary"]));
          return {
            generation: GENERATION,
            closed: new Promise<unknown>(() => undefined),
            close,
          } as unknown as WebWorkspaceRuntimePort;
        }),
      });
      const inventory = {
        workspaceName: "workspace-a",
        workspaceId: "workspace-a",
        sessionId: "session-a",
        daemonGeneration: GENERATION,
        shellGeneration: 1,
        semanticPaneIds: ["pane.primary"],
      };
      const connected = await bridge.connect(
        { workspaceName: "workspace-a", panes: ["pane.primary"], viewerMode: "interactive" },
        { onPaneEvent: vi.fn(), onEnd: vi.fn() },
      );
      if (connected.status !== "connected") throw new Error("bridge did not connect");
      const runtime = await ports.connectRuntime(
        TARGET,
        inventory,
        new AbortController().signal,
        async () => undefined,
      );
      capture.onPaneEvent?.("pane.primary", {
        type: "seed-batch",
        batch: { reset: null, seed: new Uint8Array([1]), held: [], cursor: null },
        canonical: canonical(GENERATION, 1),
      });
      capture.onLayout?.(layout);
      control.setBlocked(true);
      ports.didActivateRuntime?.(runtime, inventory);
      await Promise.resolve();
      expect(connected.session.connectionClientId?.()).toBeNull();
      browserNow += 15_001;
      control.setBlocked(false);
      await Promise.all(
        activation.mock.results.map(({ value }) => value as unknown as Promise<boolean>),
      );
      expect(close).toHaveBeenCalledTimes(1);
      expect(connected.session.connectionClientId?.()).toBeNull();
      await Promise.resolve();
      await Promise.resolve();
      expect(close).toHaveBeenCalledTimes(1);
      expect(connected.session.connectionClientId?.()).toBeNull();
      connected.session.dispose();
      bridge.end({ code: "workspace-client-closed", reason: "test", retryable: false });
    } finally {
      delete globals.__TMUX_IDE_CARD5_EVIDENCE_ENABLED__;
      delete globals.__TMUX_IDE_CARD5_SINK_CONTROL__;
      clock.mockRestore();
      vi.useRealTimers();
    }
  });

  it("aborts a blocked candidate when its session, contract, or signal changes", async () => {
    for (const churn of ["session", "foreign-pane", "abort"] as const) {
      const globals = globalThis as typeof globalThis & Record<string, unknown>;
      globals.__TMUX_IDE_CARD5_EVIDENCE_ENABLED__ = true;
      const bridge = createWebWorkspacePaneStreamBridge("workspace-a");
      const activation = vi.spyOn(bridge, "activateRuntime");
      const control = globals.__TMUX_IDE_CARD5_SINK_CONTROL__ as {
        setBlocked(value: boolean): void;
      };
      const captures: WebWorkspaceRuntimeOptions[] = [];
      const closes: Array<ReturnType<typeof vi.fn>> = [];
      const ports = createWebWorkspaceRuntimeBridgePorts({
        host: { daemon: {}, workspace: {} } as unknown as HostCapabilities,
        bridge,
        connect: vi.fn(async (options: WebWorkspaceRuntimeOptions) => {
          captures.push(options);
          const close = vi.fn();
          closes.push(close);
          options.onSession?.(
            physicalSession(
              options.inventory.daemonGeneration,
              options.inventory.workspaceName,
              options.inventory.semanticPaneIds,
              `client-${captures.length}`,
            ),
          );
          return {
            generation: GENERATION,
            closed: new Promise<unknown>(() => undefined),
            close,
          } as unknown as WebWorkspaceRuntimePort;
        }),
      });
      const inventory = {
        workspaceName: "workspace-a",
        workspaceId: "workspace-a",
        sessionId: "session-a",
        daemonGeneration: GENERATION,
        shellGeneration: 1,
        semanticPaneIds: ["pane.primary"],
      };
      const stage = (capture: WebWorkspaceRuntimeOptions, byte: number): void => {
        capture.onPaneEvent?.("pane.primary", {
          type: "seed-batch",
          batch: { reset: null, seed: new Uint8Array([byte]), held: [], cursor: null },
          canonical: canonical(GENERATION, byte),
        });
        capture.onLayout?.(layout);
      };
      const first = await ports.connectRuntime(
        TARGET,
        inventory,
        new AbortController().signal,
        async () => undefined,
      );
      stage(captures[0]!, 1);
      ports.didActivateRuntime?.(first, inventory);
      await Promise.resolve();
      await Promise.resolve();
      const connected = await bridge.connect(
        { workspaceName: "workspace-a", panes: ["pane.primary"], viewerMode: "interactive" },
        { onPaneEvent: vi.fn(), onEnd: vi.fn() },
      );
      if (connected.status !== "connected") throw new Error("bridge did not connect");
      control.setBlocked(true);
      const secondController = new AbortController();
      const second = await ports.connectRuntime(
        TARGET,
        inventory,
        secondController.signal,
        async () => undefined,
      );
      stage(captures[1]!, 2);
      ports.didActivateRuntime?.(second, inventory);
      await Promise.resolve();
      expect(connected.session.connectionClientId?.()).toBeNull();
      if (churn === "session") {
        captures[1]!.onSession?.(
          physicalSession(GENERATION, "workspace-a", ["pane.primary"], "replacement"),
        );
      } else if (churn === "foreign-pane") {
        captures[1]!.onPaneEvent?.("pane.foreign", {
          type: "seed-batch",
          batch: { reset: null, seed: new Uint8Array([9]), held: [], cursor: null },
          canonical: canonical(GENERATION, 9),
        });
      } else secondController.abort();
      control.setBlocked(false);
      await Promise.all(
        activation.mock.results.map(({ value }) => value as unknown as Promise<boolean>),
      );
      await Promise.resolve();
      await Promise.resolve();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(closes[1]).toHaveBeenCalledTimes(1);
      expect(connected.session.connectionClientId?.()).toBeNull();
      connected.session.dispose();
      bridge.end({ code: "workspace-client-closed", reason: "test", retryable: false });
      delete globals.__TMUX_IDE_CARD5_EVIDENCE_ENABLED__;
      delete globals.__TMUX_IDE_CARD5_SINK_CONTROL__;
    }
  });

  it("reads one coherent catalog and invalidates only its exact global resource", async () => {
    const subscription = {
      listener: null as ((event: DesktopDaemonEvent) => void) | null,
    };
    const invalidate = vi.fn();
    const unsubscribe = vi.fn();
    const host = {
      daemon: {
        fetchWorkspaceCatalog: vi.fn(async () => ({
          status: "ok" as const,
          envelope: {
            version: 2 as const,
            daemon: TARGET.daemon,
            intents: [
              {
                workspaceName: "workspace-a",
                sessionName: "session-a",
                source: "project" as const,
                availability: "live" as const,
              },
            ],
            liveSessions: [
              { sessionName: "session-a", fleetSessionId: "fleet.session-a", paneCount: 2 },
            ],
          },
        })),
        subscribe: vi.fn(async (_request, next) => {
          subscription.listener = next;
          return { status: "subscribed" as const, unsubscribe };
        }),
      },
    } as unknown as HostCapabilities;
    const port = createWebWorkspaceCatalogPort(host);
    await expect(port.read(TARGET, new AbortController().signal)).resolves.toMatchObject({
      version: 2,
      intents: [{ workspaceName: "workspace-a" }],
    });
    const connection = port.subscribe(TARGET, invalidate);
    await Promise.resolve();
    subscription.listener?.({ type: "workspaces.changed" });
    expect(invalidate).toHaveBeenCalledTimes(1);
    connection.close();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("preserves one operation id and current target through pane and semantic dispatch", async () => {
    const createWorkspacePane = vi.fn(async (request: { operationId?: string }) => ({
      status: "ok" as const,
      result: {
        operationId: request.operationId!,
        daemonInstanceId: GENERATION,
        outcome: "created" as const,
        resource: {
          resourceVersion: 1 as const,
          workspaceName: "workspace-a",
          semanticPaneId: "pane.created",
          displayTitle: "Shell",
          kind: "terminal" as const,
          harnessProfileId: null,
          role: null,
          missionId: null,
        },
      },
    }));
    const invokeVerb = vi.fn(async (request: { operationId?: string }) => ({
      status: "ok" as const,
      result: {
        operationId: request.operationId!,
        daemonInstanceId: GENERATION,
        outcome: "applied" as const,
        workspaceName: "workspace-a",
        verb: "workspace.pane.select" as const,
        semanticPaneId: "pane.primary",
      },
    }));
    const host = {
      daemon: { createWorkspacePane, invokeVerb },
      workspace: {},
    } as unknown as HostCapabilities;
    const actions = createWebWorkspaceOwnerActionPort(host);
    const pane = await actions.dispatch({
      target: TARGET,
      name: "workspace.pane.create",
      operationId: OPERATION,
      input: { kind: "terminal", workspaceName: "workspace-a", displayTitle: "Shell" },
    });
    expect(pane?.operationId).toBe(OPERATION);
    expect(createWorkspacePane.mock.calls[0]?.[0]).toMatchObject({ operationId: OPERATION });

    await submitWebWorkspaceSemanticIntent(host, GENERATION, "workspace-a", OPERATION, {
      verb: "workspace.pane.select",
      workspaceName: "workspace-a",
      semanticPaneId: "pane.primary",
    });
    expect(invokeVerb.mock.calls[0]?.[0]).toMatchObject({ operationId: OPERATION });
  });

  it("binds prepare/commit/cancel tokens and operation ids without exposing the selected path", async () => {
    const prepareToken = "30000000-0000-4000-8000-000000000001";
    const prepareProjectDirectory = vi.fn(
      async (_previous: string | null, operationId?: string) => ({
        status: "ok" as const,
        result: {
          operationId: operationId!,
          daemonInstanceId: GENERATION,
          phase: "prepared" as const,
          prepareToken,
          preparedRevision: 7,
          outcome: "created" as const,
          workspaceName: "workspace-b",
          previousWorkspaceName: "workspace-a",
          proof: {
            semanticPaneId: "pane.primary",
            paneCount: 1,
            terminalRevision: 0,
            terminalStateHash: "0123456789abcdef",
          },
        },
      }),
    );
    const commitPreparedOpen = vi.fn(async (decision, operationId?: string) => ({
      status: "ok" as const,
      result: {
        operationId: operationId!,
        daemonInstanceId: GENERATION,
        phase: "committed" as const,
        ...decision,
        workspaceName: "workspace-b",
        previousWorkspaceName: "workspace-a",
      },
    }));
    const cancelPreparedOpen = vi.fn(async (decision, operationId?: string) => ({
      status: "ok" as const,
      result: {
        operationId: operationId!,
        daemonInstanceId: GENERATION,
        phase: "cancelled" as const,
        ...decision,
        workspaceName: "workspace-b",
        previousWorkspaceName: "workspace-a",
      },
    }));
    const actions = createWebWorkspaceOwnerActionPort({
      workspace: { prepareProjectDirectory, commitPreparedOpen, cancelPreparedOpen },
      daemon: {},
    } as unknown as HostCapabilities);
    await actions.dispatch({
      target: TARGET,
      name: "workspace.open.prepare",
      operationId: OPERATION,
      input: { source: { kind: "host-selection" }, previousWorkspaceName: "workspace-a" },
    });
    expect(prepareProjectDirectory).toHaveBeenCalledWith("workspace-a", OPERATION);
    expect(JSON.stringify(prepareProjectDirectory.mock.calls)).not.toMatch(/projectDir|\/Users\//u);
    const decision = { prepareToken, preparedRevision: 7 };
    await actions.dispatch({
      target: TARGET,
      name: "workspace.open.commit",
      operationId: OPERATION,
      input: decision,
    });
    await actions.dispatch({
      target: TARGET,
      name: "workspace.open.cancel",
      operationId: OPERATION,
      input: decision,
    });
    expect(commitPreparedOpen).toHaveBeenCalledWith(decision, OPERATION);
    expect(cancelPreparedOpen).toHaveBeenCalledWith(decision, OPERATION);
  });

  it("rejects cross-workspace actions before invoking the issued host capability", async () => {
    const createWorkspacePane = vi.fn();
    const actions = createWebWorkspaceOwnerActionPort({
      daemon: { createWorkspacePane },
      workspace: {},
    } as unknown as HostCapabilities);
    await expect(
      actions.dispatch({
        target: TARGET,
        name: "workspace.pane.create",
        operationId: OPERATION,
        input: { kind: "terminal", workspaceName: "workspace-b" },
      }),
    ).rejects.toThrow(/another workspace/u);
    expect(createWorkspacePane).not.toHaveBeenCalled();
  });
});
