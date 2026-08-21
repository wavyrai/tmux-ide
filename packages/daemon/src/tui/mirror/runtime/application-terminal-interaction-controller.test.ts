import { describe, expect, it, vi } from "vitest";

import type { OpenTuiWorkspaceLayoutSnapshot } from "../open-tui-workspace-runtime-port.ts";
import { createApplicationTerminalInteractionController } from "./application-terminal-interaction-controller.ts";
import { installTuiPerformanceEventSink } from "../performance-events.ts";

function layout(currentIndex = 0): OpenTuiWorkspaceLayoutSnapshot {
  const windows = ["main", "logs"].map((name, index) => ({
    type: "layout" as const,
    semanticWindowId: `window.${name}`,
    windowName: name,
    currentWindow: index === currentIndex,
    cols: 20,
    rows: 8,
    zoomed: false,
    paneBorderStatus: "off" as const,
    panes: [
      {
        pane: `pane.${name}`,
        left: 0,
        top: 0,
        width: 20,
        height: 8,
        active: true,
      },
    ],
  }));
  return Object.freeze({ current: windows[currentIndex]!, windows: Object.freeze(windows) });
}

describe("application terminal interaction controller", () => {
  it("does zero phase clock, trace-id, or diagnostic work when diagnostics are disabled", async () => {
    const nowMicros = vi.fn(() => {
      throw new Error("clock must stay cold");
    });
    const createTraceId = vi.fn(() => {
      throw new Error("trace id must stay cold");
    });
    const diagnose = vi.fn();
    const controller = createApplicationTerminalInteractionController({
      generation: () => null,
      layout: () => layout(0),
      setFocusedPane: () => undefined,
      diagnosticsEnabled: false,
      detailedWindowSwitchTiming: false,
      diagnose,
      nowMicros,
      createTraceId,
    });
    controller.cycleWindow();
    await Promise.resolve();
    expect(nowMicros).not.toHaveBeenCalled();
    expect(createTraceId).not.toHaveBeenCalled();
    expect(diagnose).not.toHaveBeenCalled();
  });

  it("keeps selection, layout, presentation, and frame publication fail-open when timing clocks throw", async () => {
    let snapshot = layout(0);
    let clockCalls = 0;
    const dispatch = vi.fn(async () => ({
      kind: "semantic-intent",
      operationId: "switch-trace",
      result: {
        verb: "workspace.pane.select",
        semanticPaneId: "pane.logs",
        workspaceName: "workspace.alpha",
        daemonInstanceId: "generation-a",
        operationId: "switch-trace",
        outcome: "applied",
      },
    }));
    const generation = {
      status: "live",
      daemonGeneration: "generation-a",
      rendererEpoch: 7,
      connection: { workspaceName: "workspace.alpha" },
      client: {
        ownsRuntimeAuthority: () => true,
        requestAuthority: async () => ({}),
        dispatch,
        getSnapshot: () => ({ generation: 4 }),
      },
      adapter: {
        paneCanonicalIdentity: () => ({
          sourceEpoch: 2,
          generation: "generation-a",
          incarnation: "incarnation-a",
          revision: 9,
          stateHash: "0123456789abcdef",
          cols: 20,
          rows: 8,
        }),
      },
    };
    const controller = createApplicationTerminalInteractionController({
      generation: () => generation as never,
      layout: () => snapshot,
      setFocusedPane: () => undefined,
      diagnosticsEnabled: true,
      detailedWindowSwitchTiming: true,
      diagnose: () => undefined,
      diagnoseCritical: () => true,
      createTraceId: () => "switch-trace",
      nowMicros: () => {
        clockCalls += 1;
        if (clockCalls > 1) throw new Error("diagnostic clock");
        return 100;
      },
    });
    controller.cycleWindow();
    await Promise.resolve();
    await Promise.resolve();
    snapshot = layout(1);
    expect(() => controller.adoptLayout(snapshot)).not.toThrow();
    expect(() => controller.observeWindowPresentation("window.logs", "pane.logs")).not.toThrow();
    expect(() => controller.observeDiagnosticWindowFrame()).not.toThrow();
    expect(() => controller.settleWindowSwitchFrame()).not.toThrow();
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("keeps product selection active when the initial diagnostic clock throws", async () => {
    const dispatch = vi.fn(async () => null);
    const generation = {
      status: "live",
      daemonGeneration: "generation-a",
      rendererEpoch: 7,
      connection: { workspaceName: "workspace.alpha" },
      client: {
        ownsRuntimeAuthority: () => true,
        requestAuthority: async () => ({}),
        dispatch,
        getSnapshot: () => ({ generation: 4 }),
      },
      adapter: { paneCanonicalIdentity: () => ({}) },
    };
    const controller = createApplicationTerminalInteractionController({
      generation: () => generation as never,
      layout: () => layout(0),
      setFocusedPane: () => undefined,
      diagnosticsEnabled: true,
      detailedWindowSwitchTiming: true,
      diagnose: () => undefined,
      nowMicros: () => {
        throw new Error("diagnostic clock");
      },
    });
    controller.cycleWindow();
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
  });

  it("uses one canonical snapshot for parser origin and causal fixture preparation", async () => {
    const canonical = {
      semanticPaneId: "pane.main",
      generation: "generation-a",
      incarnation: "incarnation-a",
      revision: 3,
      hash: "hash-a",
      snapshot: {
        cols: 20,
        rows: 8,
        cursor: { x: 19, y: 0 },
        modes: { wraparound: false },
        grid: Array.from({ length: 8 }, () => ({
          cells: Array.from({ length: 20 }, () => ({ grapheme: " ", width: 1 })),
        })),
      },
    };
    const paneState = vi.fn(() => canonical);
    const sendInput = vi.fn(async () => ({ status: "sent" as const }));
    const origins: unknown[] = [];
    const uninstall = installTuiPerformanceEventSink({
      frame: () => undefined,
      terminalPaint: () => undefined,
      terminalDelivery: () => undefined,
      terminalInputOrigin: true,
      beginTerminalInput: (origin) => {
        origins.push(origin);
        return { traceId: "trace-a", finish: () => undefined, cancel: () => undefined };
      },
    });
    try {
      const controller = createApplicationTerminalInteractionController({
        generation: () =>
          ({
            status: "live",
            daemonGeneration: "generation-a",
            fastLane: {
              lane: { paneState, sendInput },
              causalCellLedger: { arm: () => true },
            },
          }) as never,
        layout: () => layout(),
        setFocusedPane: () => undefined,
        diagnosticsEnabled: false,
        diagnose: () => undefined,
        causalCellFixtureEnabled: () => true,
      });
      controller.adoptLayout(layout());
      await controller.sendInput(
        { kind: "text", data: "x" },
        { origin: "keyboard", payload: Buffer.from("x") },
      );
      expect(paneState).toHaveBeenCalledOnce();
      expect(origins).toEqual([
        {
          origin: "keyboard",
          payload: Buffer.from("x"),
          semanticPaneId: "pane.main",
          generation: "generation-a",
          incarnation: "incarnation-a",
          revision: 3,
          stateHash: "hash-a",
        },
      ]);
      expect(sendInput).toHaveBeenCalledOnce();
    } finally {
      uninstall();
    }
  });

  it("finishes input admission after the lane's synchronous enqueue boundary", async () => {
    const order: string[] = [];
    const canonical = {
      incarnation: "incarnation-a",
      revision: 1,
      hash: "hash-a",
      snapshot: { cols: 20, rows: 8, cursor: { x: 0, y: 0 }, modes: { wraparound: true } },
    };
    const uninstall = installTuiPerformanceEventSink({
      frame: () => undefined,
      terminalPaint: () => undefined,
      terminalDelivery: () => undefined,
      beginTerminalInput: () => {
        order.push("input-start");
        return {
          traceId: "trace-a",
          finish: () => order.push("input-end"),
          cancel: () => undefined,
        };
      },
    });
    try {
      const controller = createApplicationTerminalInteractionController({
        generation: () =>
          ({
            status: "live",
            daemonGeneration: "generation-a",
            fastLane: {
              lane: {
                paneState: () => canonical,
                sendInput: () => {
                  order.push("lane-enqueue-and-transport-start");
                  return Promise.resolve({ status: "sent" });
                },
              },
            },
          }) as never,
        layout: () => layout(),
        setFocusedPane: () => undefined,
        diagnosticsEnabled: false,
        diagnose: () => undefined,
        causalCellFixtureEnabled: () => false,
      });
      controller.adoptLayout(layout());
      await controller.sendInput({ kind: "text", data: "x" });
      expect(order).toEqual(["input-start", "lane-enqueue-and-transport-start", "input-end"]);
    } finally {
      uninstall();
    }
  });

  it("does not read canonical pane state when input diagnostics are absent", async () => {
    const paneState = vi.fn(() => {
      throw new Error("ordinary input must not inspect diagnostic state");
    });
    const sendInput = vi.fn(async () => ({ status: "sent" as const }));
    const controller = createApplicationTerminalInteractionController({
      generation: () =>
        ({
          status: "live",
          daemonGeneration: "generation-a",
          fastLane: { lane: { paneState, sendInput } },
        }) as never,
      layout: () => layout(),
      setFocusedPane: () => undefined,
      diagnosticsEnabled: false,
      diagnose: () => undefined,
      causalCellFixtureEnabled: () => {
        throw new Error("disabled path must not inspect fixture configuration");
      },
    });
    controller.adoptLayout(layout());
    await controller.sendInput({ kind: "text", data: "x" });
    expect(paneState).not.toHaveBeenCalled();
    expect(sendInput).toHaveBeenCalledOnce();
  });

  it("fails open when parser-origin diagnostics throw before or after dispatch", async () => {
    const canonical = { incarnation: "i", revision: 1, hash: "h", snapshot: null };
    for (const failure of ["pane-state", "begin", "finish"] as const) {
      const sendInput = vi.fn(async () => ({ status: "sent" as const }));
      const uninstall = installTuiPerformanceEventSink({
        frame: () => undefined,
        terminalPaint: () => undefined,
        terminalDelivery: () => undefined,
        beginTerminalInput: () => {
          if (failure === "begin") throw new Error("diagnostic begin");
          return {
            traceId: "trace-a",
            finish: () => {
              if (failure === "finish") throw new Error("diagnostic finish");
            },
            cancel: () => undefined,
          };
        },
      });
      try {
        const controller = createApplicationTerminalInteractionController({
          generation: () =>
            ({
              status: "live",
              daemonGeneration: "generation-a",
              fastLane: {
                lane: {
                  paneState: () => {
                    if (failure === "pane-state") throw new Error("diagnostic pane state");
                    return canonical;
                  },
                  sendInput,
                },
              },
            }) as never,
          layout: () => layout(),
          setFocusedPane: () => undefined,
          diagnosticsEnabled: false,
          diagnose: () => undefined,
          causalCellFixtureEnabled: () => false,
        });
        controller.adoptLayout(layout());
        await expect(
          controller.sendInput(
            { kind: "text", data: "x" },
            { origin: "keyboard", payload: Buffer.from("x") },
          ),
        ).resolves.toBeUndefined();
        expect(sendInput).toHaveBeenCalledOnce();
      } finally {
        uninstall();
      }
    }
  });

  it("fails open when causal ledger arm or failure diagnostics throw", async () => {
    const canonical = {
      incarnation: "incarnation-a",
      revision: 1,
      hash: "hash-a",
      snapshot: {
        cols: 20,
        rows: 8,
        cursor: { x: 19, y: 0 },
        modes: { wraparound: false },
        grid: Array.from({ length: 8 }, () => ({
          cells: Array.from({ length: 20 }, () => ({ grapheme: " ", width: 1 })),
        })),
      },
    };
    for (const failure of ["arm-throw", "arm-false", "fail"] as const) {
      const sendInput = vi.fn(async () =>
        failure === "fail"
          ? ({ status: "rejected", reason: "authority-lost" } as const)
          : ({ status: "sent" } as const),
      );
      const uninstall = installTuiPerformanceEventSink({
        frame: () => undefined,
        terminalPaint: () => undefined,
        terminalDelivery: () => undefined,
        beginTerminalInput: () => ({
          traceId: "00000000-0000-4000-8000-000000000001",
          finish: () => undefined,
          cancel: () => undefined,
        }),
      });
      try {
        const controller = createApplicationTerminalInteractionController({
          generation: () =>
            ({
              status: "live",
              daemonGeneration: "generation-a",
              fastLane: {
                lane: { paneState: () => canonical, sendInput },
                causalCellLedger: {
                  arm: () => {
                    if (failure === "arm-throw") throw new Error("diagnostic arm");
                    return failure !== "arm-false";
                  },
                  fail: () => {
                    if (failure === "fail") throw new Error("diagnostic fail");
                  },
                },
              },
            }) as never,
          layout: () => layout(),
          setFocusedPane: () => undefined,
          diagnosticsEnabled: false,
          diagnose: () => undefined,
          causalCellFixtureEnabled: () => true,
        });
        controller.adoptLayout(layout());
        await expect(controller.sendInput({ kind: "text", data: "x" })).resolves.toBeUndefined();
        expect(sendInput).toHaveBeenCalledOnce();
      } finally {
        uninstall();
      }
    }
  });

  it("owns the window-switch trace from selection through the matching layout frame", async () => {
    let snapshot = layout(0);
    let micros = 100;
    let presentedFocusedPane: string | null = "pane.main";
    let rendererFocused = true;
    let shellPresentation: readonly (string | number | boolean | null)[] = ["project", "one"];
    const diagnostics: Array<{ phase: string; details?: Readonly<Record<string, unknown>> }> = [];
    const focused = vi.fn((paneId: string | null) => (presentedFocusedPane = paneId));
    const dispatch = vi.fn(async () => ({
      kind: "semantic-intent",
      operationId: "switch-trace",
      result: {
        verb: "workspace.pane.select",
        semanticPaneId: "pane.logs",
        workspaceName: "workspace.alpha",
        daemonInstanceId: "generation-a",
        operationId: "switch-trace",
        outcome: "applied",
      },
    }));
    const requestRender = vi.fn();
    const generation = {
      status: "live",
      daemonGeneration: "generation-a",
      rendererEpoch: 7,
      connection: { workspaceName: "workspace.alpha" },
      client: {
        ownsRuntimeAuthority: () => true,
        requestAuthority: async () => ({}),
        dispatch,
        getSnapshot: () => ({ generation: 4 }),
      },
      adapter: {
        paneCanonicalIdentity: () => ({
          sourceEpoch: 2,
          generation: "generation-a",
          incarnation: "incarnation-a",
          revision: 9,
          stateHash: "0123456789abcdef",
          cols: 20,
          rows: 8,
        }),
      },
    };
    const controller = createApplicationTerminalInteractionController({
      generation: () => generation as never,
      layout: () => snapshot,
      focusedPane: () => presentedFocusedPane,
      rendererFocused: () => rendererFocused,
      shellPresentation: () => shellPresentation,
      setFocusedPane: focused,
      diagnosticsEnabled: true,
      detailedWindowSwitchTiming: true,
      diagnose: (phase, details) => diagnostics.push({ phase, details }),
      createTraceId: () => "switch-trace",
      nowMicros: () => micros,
      requestRender,
    });

    expect(controller.observeDiagnosticWindowFrame()).toBeNull();
    controller.cycleWindow();
    expect(focused).not.toHaveBeenCalled();
    expect(diagnostics[0]).toMatchObject({
      phase: "window-switch-start",
      details: {
        traceId: "switch-trace",
        target: "window.logs",
        paneId: "pane.logs",
        daemonGeneration: "generation-a",
        clientGeneration: 4,
        rendererEpoch: 7,
        generation: "generation-a",
        incarnation: "incarnation-a",
        revision: 9,
        stateHash: "0123456789abcdef",
        cols: 20,
        rows: 8,
      },
    });
    await Promise.resolve();
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ operationId: "switch-trace" }));
    controller.settleWindowSwitchFrame();
    expect(diagnostics.some(({ phase }) => phase === "window-switch-settled")).toBe(false);

    snapshot = layout(1);
    controller.adoptLayout(snapshot);
    expect(diagnostics).toContainEqual({
      phase: "window-switch-layout",
      details: expect.objectContaining({ phaseAtMicros: 100 }),
    });
    expect(focused).toHaveBeenCalledWith("pane.logs");
    micros = 175;
    controller.settleWindowSwitchFrame();
    expect(diagnostics.some(({ phase }) => phase === "window-switch-settled")).toBe(false);
    controller.observeWindowPresentation("window.logs", "pane.logs");
    expect(diagnostics).toContainEqual({
      phase: "window-switch-presentation",
      details: expect.objectContaining({ phaseAtMicros: 175 }),
    });
    await Promise.resolve();
    expect(requestRender).toHaveBeenCalledOnce();
    const settlingFrame = controller.observeDiagnosticWindowFrame();
    expect(settlingFrame).toMatchObject({
      kind: "window-switch",
      traceId: "switch-trace",
      targetVisible: true,
      presentationChanged: true,
      settledTargetFrame: true,
    });
    expect(settlingFrame).not.toHaveProperty("target");
    expect(settlingFrame).not.toHaveProperty("paneId");
    controller.settleWindowSwitchFrame();
    expect(diagnostics).toContainEqual({
      phase: "window-switch-settled",
      details: expect.objectContaining({
        traceId: "switch-trace",
        target: "window.logs",
        durationMicros: 75,
        phaseAtMicros: 175,
      }),
    });
    expect(controller.observeDiagnosticWindowFrame()).toMatchObject({
      traceId: "switch-trace",
      presentationDigest: settlingFrame?.presentationDigest,
      presentationChanged: false,
      settledTargetFrame: false,
    });
    shellPresentation = ["project", "two"];
    const shellFrame = controller.observeDiagnosticWindowFrame();
    expect(shellFrame).toMatchObject({ presentationChanged: true, settledTargetFrame: false });
    expect(shellFrame?.presentationDigest).not.toBe(settlingFrame?.presentationDigest);
    rendererFocused = false;
    const blurredFrame = controller.observeDiagnosticWindowFrame();
    expect(blurredFrame).toMatchObject({ presentationChanged: true, settledTargetFrame: false });
    expect(blurredFrame?.presentationDigest).not.toBe(shellFrame?.presentationDigest);
    expect(JSON.stringify(blurredFrame)).not.toContain("pane.logs");
    micros = 1_000_176;
    expect(controller.observeDiagnosticWindowFrame()).toBeNull();
    await Promise.resolve();
  });

  it("requests one post-prerequisite frame when the applied receipt arrives last", async () => {
    let snapshot = layout(0);
    let resolveDispatch!: (value: unknown) => void;
    const dispatch = vi.fn(() => new Promise<unknown>((resolve) => (resolveDispatch = resolve)));
    const requestRender = vi.fn();
    const diagnostics = vi.fn();
    const generation = {
      status: "live",
      daemonGeneration: "generation-a",
      rendererEpoch: 7,
      connection: { workspaceName: "workspace.alpha" },
      client: {
        ownsRuntimeAuthority: () => true,
        requestAuthority: async () => ({}),
        dispatch,
        getSnapshot: () => ({ generation: 4 }),
      },
      adapter: {
        paneCanonicalIdentity: () => ({
          sourceEpoch: 2,
          generation: "generation-a",
          incarnation: "incarnation-a",
          revision: 9,
          stateHash: "0123456789abcdef",
          cols: 20,
          rows: 8,
        }),
      },
    };
    const controller = createApplicationTerminalInteractionController({
      generation: () => generation as never,
      layout: () => snapshot,
      setFocusedPane: () => undefined,
      diagnosticsEnabled: true,
      diagnose: diagnostics,
      createTraceId: () => "switch-trace",
      nowMicros: () => 100,
      requestRender,
    });

    controller.cycleWindow();
    snapshot = layout(1);
    controller.adoptLayout(snapshot);
    controller.observeWindowPresentation("window.logs", "pane.logs");
    controller.settleWindowSwitchFrame();
    expect(requestRender).not.toHaveBeenCalled();
    expect(diagnostics).not.toHaveBeenCalledWith("window-switch-settled", expect.anything());

    resolveDispatch({
      kind: "semantic-intent",
      operationId: "switch-trace",
      result: {
        verb: "workspace.pane.select",
        semanticPaneId: "pane.logs",
        workspaceName: "workspace.alpha",
        daemonInstanceId: "generation-a",
        operationId: "switch-trace",
        outcome: "applied",
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(requestRender).toHaveBeenCalledOnce();
    controller.adoptLayout(snapshot);
    controller.observeWindowPresentation("window.logs", "pane.logs");
    expect(requestRender).toHaveBeenCalledOnce();
    controller.settleWindowSwitchFrame();
    expect(diagnostics).toHaveBeenCalledWith(
      "window-switch-settled",
      expect.objectContaining({ traceId: "switch-trace", cols: 20, rows: 8 }),
    );
    controller.settleWindowSwitchFrame();
    expect(requestRender).toHaveBeenCalledOnce();
  });

  it("retires a receipt-settled deferred routing target when the live runtime is replaced", async () => {
    let resolveDispatch!: (value: unknown) => void;
    const dispatch = vi.fn(() => new Promise<unknown>((resolve) => (resolveDispatch = resolve)));
    const oldLaneSend = vi.fn(async () => ({ status: "sent" as const }));
    const newLaneSend = vi.fn(async () => ({ status: "sent" as const }));
    const connection = { workspaceName: "workspace.alpha" };
    const adapter = {
      paneCanonicalIdentity: () => ({
        sourceEpoch: 2,
        generation: "generation-a",
        incarnation: "incarnation-a",
        revision: 9,
        stateHash: "0123456789abcdef",
        cols: 20,
        rows: 8,
      }),
    };
    const clientA = {
      ownsRuntimeAuthority: () => true,
      requestAuthority: async () => ({}),
      dispatch,
      getSnapshot: () => ({ generation: 4 }),
    };
    const clientB = {
      ownsRuntimeAuthority: () => true,
      requestAuthority: async () => ({}),
      dispatch: vi.fn(),
      getSnapshot: () => ({ generation: 5 }),
    };
    const fastLaneA = { lane: { sendInput: oldLaneSend } };
    const fastLaneB = { lane: { sendInput: newLaneSend } };
    let generation = {
      status: "live",
      daemonGeneration: "generation-a",
      rendererEpoch: 7,
      connection,
      client: clientA,
      fastLane: fastLaneA,
      adapter,
    };
    const focused: Array<string | null> = [];
    const controller = createApplicationTerminalInteractionController({
      generation: () => generation as never,
      layout: () => layout(0),
      setFocusedPane: (pane) => void focused.push(pane),
      diagnosticsEnabled: true,
      diagnose: () => undefined,
      createTraceId: () => "switch-trace",
      causalCellFixtureEnabled: () => false,
    });
    controller.adoptGeneration(generation as never);
    controller.adoptLayout(layout(0));
    controller.cycleWindow();
    resolveDispatch({
      kind: "semantic-intent",
      operationId: "switch-trace",
      result: {
        verb: "workspace.pane.select",
        semanticPaneId: "pane.logs",
        workspaceName: "workspace.alpha",
        daemonInstanceId: "generation-a",
        operationId: "switch-trace",
        outcome: "applied",
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(focused).toEqual(["pane.main"]);

    controller.adoptGeneration({ ...generation, status: "rebinding" } as never);
    generation = {
      ...generation,
      rendererEpoch: 8,
      client: clientB,
      fastLane: fastLaneB,
      adapter: { ...adapter },
    };
    controller.adoptGeneration(generation as never);
    await controller.sendInput({ kind: "text", data: "after-rebind" });

    expect(oldLaneSend).not.toHaveBeenCalled();
    expect(newLaneSend).toHaveBeenCalledWith(
      "pane.main",
      { kind: "text", data: "after-rebind" },
      undefined,
      undefined,
    );
    expect(focused).toEqual(["pane.main"]);
  });

  it("rolls an optimistic receipt back to the canonical pane before replacement input", async () => {
    let resolveDispatch!: (value: unknown) => void;
    const dispatch = vi.fn(() => new Promise<unknown>((resolve) => (resolveDispatch = resolve)));
    const oldLaneSend = vi.fn(async () => ({ status: "sent" as const }));
    const newLaneSend = vi.fn(async () => ({ status: "sent" as const }));
    const connection = { workspaceName: "workspace.alpha" };
    const adapter = {};
    const clientA = {
      ownsRuntimeAuthority: () => true,
      requestAuthority: async () => ({}),
      dispatch,
      getSnapshot: () => ({ generation: 4 }),
    };
    const clientB = {
      ownsRuntimeAuthority: () => true,
      requestAuthority: async () => ({}),
      dispatch: vi.fn(),
      getSnapshot: () => ({ generation: 5 }),
    };
    let generation = {
      status: "live",
      daemonGeneration: "generation-a",
      rendererEpoch: 7,
      connection,
      client: clientA,
      fastLane: { lane: { sendInput: oldLaneSend } },
      adapter,
    };
    const focused: Array<string | null> = [];
    const controller = createApplicationTerminalInteractionController({
      generation: () => generation as never,
      layout: () => layout(0),
      setFocusedPane: (pane) => void focused.push(pane),
      diagnosticsEnabled: false,
      diagnose: () => undefined,
      causalCellFixtureEnabled: () => false,
    });
    controller.adoptGeneration(generation as never);
    controller.adoptLayout(layout(0));
    controller.selectPane("pane.logs");
    resolveDispatch({
      kind: "semantic-intent",
      operationId: "select-op",
      result: {
        verb: "workspace.pane.select",
        semanticPaneId: "pane.logs",
        workspaceName: "workspace.alpha",
        daemonInstanceId: "generation-a",
        operationId: "select-op",
        outcome: "applied",
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(focused).toEqual(["pane.main", "pane.logs"]);

    controller.adoptGeneration({ ...generation, status: "rebinding" } as never);
    generation = {
      ...generation,
      rendererEpoch: 8,
      client: clientB,
      fastLane: { lane: { sendInput: newLaneSend } },
      adapter: {},
    };
    controller.adoptGeneration(generation as never);
    await controller.sendInput({ kind: "text", data: "replacement" });

    expect(oldLaneSend).not.toHaveBeenCalled();
    expect(newLaneSend).toHaveBeenCalledWith(
      "pane.main",
      { kind: "text", data: "replacement" },
      undefined,
      undefined,
    );
    expect(focused).toEqual(["pane.main", "pane.logs", "pane.main"]);
  });

  it("publishes one critical bounded switch failure when selection transport rejects", async () => {
    const diagnose = vi.fn();
    const diagnoseCritical = vi.fn(() => true);
    const generation = {
      status: "live",
      daemonGeneration: "generation-a",
      rendererEpoch: 7,
      connection: { workspaceName: "workspace.alpha" },
      client: {
        ownsRuntimeAuthority: () => true,
        requestAuthority: async () => ({}),
        dispatch: vi.fn(async () => {
          throw Object.assign(new Error("private backend detail"), {
            code: "pane_inventory_not_ready",
          });
        }),
        getSnapshot: () => ({ generation: 4 }),
      },
      adapter: {
        paneCanonicalIdentity: () => ({
          sourceEpoch: 2,
          generation: "generation-a",
          incarnation: "incarnation-a",
          revision: 9,
          stateHash: "0123456789abcdef",
          cols: 20,
          rows: 8,
        }),
      },
    };
    const controller = createApplicationTerminalInteractionController({
      generation: () => generation as never,
      layout: () => layout(0),
      setFocusedPane: () => undefined,
      diagnosticsEnabled: true,
      diagnose,
      diagnoseCritical,
      createTraceId: () => "switch-trace",
      nowMicros: () => 100,
    });

    controller.cycleWindow();
    await Promise.resolve();
    await Promise.resolve();

    expect(diagnose).toHaveBeenCalledWith(
      "window-switch-receipt",
      expect.objectContaining({
        selected: false,
        applied: false,
        failureStage: "dispatch",
        failureReason: "transport-rejected",
        failureBackendReason: "pane_inventory_not_ready",
      }),
    );
    expect(diagnoseCritical).toHaveBeenCalledOnce();
    expect(diagnoseCritical).toHaveBeenCalledWith(
      "window-switch:switch-trace:failed",
      "window-switch-failed",
      expect.objectContaining({
        stage: "dispatch",
        reason: "transport-rejected",
        backendReason: "pane_inventory_not_ready",
      }),
    );
  });

  it("fences an active window rename on its first matching actual frame without terminal work", () => {
    let snapshot = layout(0);
    const diagnose = vi.fn();
    const diagnoseCritical = vi.fn(() => true);
    const requestRender = vi.fn();
    const generation = {
      status: "live",
      daemonGeneration: "generation-a",
      rendererEpoch: 7,
      client: { getSnapshot: () => ({ generation: 4 }) },
      adapter: {
        paneCanonicalIdentity: () => ({
          sourceEpoch: 2,
          generation: "generation-a",
          incarnation: "incarnation-a",
          revision: 9,
          stateHash: "0123456789abcdef",
          cols: 20,
          rows: 8,
        }),
      },
    };
    const controller = createApplicationTerminalInteractionController({
      generation: () => generation as never,
      layout: () => snapshot,
      setFocusedPane: () => undefined,
      diagnosticsEnabled: true,
      diagnose,
      diagnoseCritical,
      diagnosticHealth: () => ({
        droppedRecords: 0,
        failed: false,
        pendingCriticalRecords: 0,
      }),
      createTraceId: () => "rename-trace",
      nowMicros: () => 100,
      requestRender,
    });
    controller.adoptLayout(snapshot);
    expect(controller.observeDiagnosticWindowFrame()).toBeNull();
    const renamed = { ...snapshot.current!, windowName: "renamed-main" };
    snapshot = Object.freeze({
      current: renamed,
      windows: Object.freeze([renamed, snapshot.windows[1]!]),
    });
    controller.adoptLayout(snapshot);
    controller.observeWindowPresentation("window.main", "pane.main", "renamed-main");
    expect(controller.observeDiagnosticWindowFrame()).toMatchObject({
      kind: "window-rename",
      traceId: "rename-trace",
      identityExact: true,
      targetVisible: true,
      presentationChanged: true,
      settledTargetFrame: true,
    });
    controller.settleWindowSwitchFrame();
    expect(requestRender).not.toHaveBeenCalled();
    expect(diagnose).toHaveBeenCalledWith(
      "window-rename-start",
      expect.objectContaining({ traceId: "rename-trace", previousName: "main" }),
    );
    expect(diagnoseCritical).toHaveBeenCalledWith(
      "window-rename:rename-trace:presented",
      "window-rename-presented",
      expect.objectContaining({ paneId: "pane.main", windowName: "renamed-main" }),
    );
    expect(diagnoseCritical).toHaveBeenCalledWith(
      "window-rename:rename-trace:fence",
      "window-rename-fence",
      expect.objectContaining({
        writerHealth: { droppedRecords: 0, failed: false, pendingCriticalRecords: 0 },
      }),
    );
    controller.settleWindowSwitchFrame();
    expect(diagnoseCritical).toHaveBeenCalledTimes(2);
  });

  it("cancels a switch when canonical geometry changes between presentation and frame", async () => {
    let snapshot = layout(0);
    let cols = 20;
    const diagnostics = vi.fn();
    const requestRender = vi.fn();
    const generation = {
      status: "live",
      daemonGeneration: "generation-a",
      rendererEpoch: 7,
      connection: { workspaceName: "workspace.alpha" },
      client: {
        ownsRuntimeAuthority: () => true,
        requestAuthority: async () => ({}),
        dispatch: async () => ({
          kind: "semantic-intent",
          operationId: "switch-trace",
          result: {
            verb: "workspace.pane.select",
            semanticPaneId: "pane.logs",
            workspaceName: "workspace.alpha",
            daemonInstanceId: "generation-a",
            operationId: "switch-trace",
            outcome: "applied",
          },
        }),
        getSnapshot: () => ({ generation: 4 }),
      },
      adapter: {
        paneCanonicalIdentity: () => ({
          sourceEpoch: 2,
          generation: "generation-a",
          incarnation: "incarnation-a",
          revision: 9,
          stateHash: "0123456789abcdef",
          cols,
          rows: 8,
        }),
      },
    };
    const controller = createApplicationTerminalInteractionController({
      generation: () => generation as never,
      layout: () => snapshot,
      setFocusedPane: () => undefined,
      diagnosticsEnabled: true,
      diagnose: diagnostics,
      createTraceId: () => "switch-trace",
      nowMicros: () => 100,
      requestRender,
    });
    controller.cycleWindow();
    await Promise.resolve();
    await Promise.resolve();
    snapshot = layout(1);
    controller.adoptLayout(snapshot);
    controller.observeWindowPresentation("window.logs", "pane.logs");
    expect(requestRender).not.toHaveBeenCalled();
    cols = 21;
    expect(controller.observeDiagnosticWindowFrame()).toMatchObject({
      identityExact: false,
      targetVisible: true,
      settledTargetFrame: false,
    });
    controller.settleWindowSwitchFrame();
    expect(diagnostics).not.toHaveBeenCalledWith("window-switch-settled", expect.anything());
  });

  it("coalesces resize previews and does no timing work when diagnostics are disabled", () => {
    let micros = 10;
    const enabledDiagnostics = vi.fn();
    const enabled = createApplicationTerminalInteractionController({
      generation: () => null,
      layout: () => layout(),
      setFocusedPane: () => undefined,
      diagnosticsEnabled: true,
      diagnose: enabledDiagnostics,
      createTraceId: () => "resize-trace",
      nowMicros: () => micros,
    });
    const preview = { semanticPaneId: "pane.main", axis: "x" as const, cells: 12 };
    enabled.previewPaneResize(preview);
    enabled.previewPaneResize(preview);
    micros = 40;
    enabled.settleResizeGuideFrame();
    expect(enabledDiagnostics).toHaveBeenCalledOnce();
    expect(enabledDiagnostics).toHaveBeenCalledWith("resize-guide-settled", {
      traceId: "resize-trace",
      durationMicros: 30,
    });

    const nowMicros = vi.fn(() => {
      throw new Error("disabled diagnostics must not read the clock");
    });
    const disabled = createApplicationTerminalInteractionController({
      generation: () => null,
      layout: () => layout(),
      setFocusedPane: () => undefined,
      diagnosticsEnabled: false,
      diagnose: vi.fn(),
      nowMicros,
    });
    disabled.previewPaneResize(preview);
    disabled.settleResizeGuideFrame();
    expect(disabled.observeDiagnosticWindowFrame()).toBeNull();
    expect(nowMicros).not.toHaveBeenCalled();
  });
});
