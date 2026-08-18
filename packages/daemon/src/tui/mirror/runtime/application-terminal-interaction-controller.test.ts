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
    const diagnostics: Array<{ phase: string; details?: Readonly<Record<string, unknown>> }> = [];
    const focused = vi.fn();
    const controller = createApplicationTerminalInteractionController({
      generation: () => null,
      layout: () => snapshot,
      setFocusedPane: focused,
      diagnosticsEnabled: true,
      diagnose: (phase, details) => diagnostics.push({ phase, details }),
      createTraceId: () => "switch-trace",
      nowMicros: () => micros,
    });

    controller.cycleWindow();
    expect(focused).toHaveBeenCalledWith("pane.logs");
    expect(diagnostics[0]).toEqual({
      phase: "window-switch-start",
      details: { traceId: "switch-trace", target: "window.logs" },
    });
    controller.settleWindowSwitchFrame();
    expect(diagnostics.some(({ phase }) => phase === "window-switch-settled")).toBe(false);

    snapshot = layout(1);
    controller.adoptLayout(snapshot);
    micros = 175;
    controller.settleWindowSwitchFrame();
    expect(diagnostics).toContainEqual({
      phase: "window-switch-settled",
      details: { traceId: "switch-trace", target: "window.logs", durationMicros: 75 },
    });
    await Promise.resolve();
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
    expect(nowMicros).not.toHaveBeenCalled();
  });
});
