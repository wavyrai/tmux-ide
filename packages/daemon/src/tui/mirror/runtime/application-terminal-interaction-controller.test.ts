import { describe, expect, it, vi } from "vitest";

import type { OpenTuiWorkspaceLayoutSnapshot } from "../open-tui-workspace-runtime-port.ts";
import { createApplicationTerminalInteractionController } from "./application-terminal-interaction-controller.ts";

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
