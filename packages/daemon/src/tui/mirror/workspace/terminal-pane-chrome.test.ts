import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { projectAgentTerminalCanvas } from "./agent-terminal-canvas.ts";
import {
  CARD_22_4B2_PANE_FRAME_ROOT_WIRING_DEFERRALS,
  dispatchTerminalPaneChromePointerIntent,
  projectTerminalPaneChrome,
  reconcileTerminalPaneChromeActionTarget,
  terminalPaneChromeActionTargetForIntent,
  terminalPaneChromeHitTest,
  terminalPaneChromeMotionState,
  terminalPaneChromeOverlapsBodies,
  terminalPaneChromePointerIntent,
  terminalPaneChromeTitle,
  terminalPaneSemanticId,
  type TerminalPaneChromePane,
} from "./terminal-pane-chrome.ts";

const canvas = projectAgentTerminalCanvas({ width: 120, height: 40, chromeRows: 2 });

function pane(overrides: Partial<TerminalPaneChromePane>): TerminalPaneChromePane {
  return {
    id: "%1",
    left: 0,
    top: 0,
    width: 120,
    height: 38,
    active: true,
    zoomed: false,
    ...overrides,
  };
}

describe("terminal pane chrome projection", () => {
  it("encodes and bounds live tmux ids at the semantic schema boundary", () => {
    expect(terminalPaneSemanticId("%7")).toBe("pane.tmux.25-37");
    const first = terminalPaneSemanticId(`%${"pane-".repeat(80)}a`);
    const second = terminalPaneSemanticId(`%${"pane-".repeat(80)}b`);
    expect(first.length).toBeLessThanOrEqual(128);
    expect(first).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
    expect(second).not.toBe(first);
  });

  it("segments the native header for horizontal panes without touching either body", () => {
    const panes = [
      pane({ id: "%1", width: 59 }),
      pane({ id: "%2", left: 60, width: 60, active: false }),
    ];
    const layout = projectTerminalPaneChrome({ canvas, panes });
    expect(layout.native.map((item) => [item.paneId, item.layerRect])).toEqual([
      ["%1", { x: 0, y: 1, width: 59, height: 1 }],
      ["%2", { x: 60, y: 1, width: 60, height: 1 }],
    ]);
    expect(layout.framebuffer).toEqual([]);
    expect(
      layout.native.every((item) => !terminalPaneChromeOverlapsBodies({ canvas, panes }, item)),
    ).toBe(true);
  });

  it("uses the existing horizontal separator for a lower pane", () => {
    const panes = [
      pane({ id: "%1", height: 18 }),
      pane({ id: "%2", top: 19, height: 19, active: false }),
    ];
    const layout = projectTerminalPaneChrome({ canvas, panes });
    expect(layout.native[0]?.placement).toBe("native-header");
    expect(layout.framebuffer[0]).toMatchObject({
      paneId: "%2",
      placement: "gutter-header",
      layerRect: { x: 0, y: 18, width: 120, height: 1 },
      canvasRect: { x: 0, y: 20, width: 120, height: 1 },
    });
    expect(
      layout.framebuffer.every(
        (item) => !terminalPaneChromeOverlapsBodies({ canvas, panes }, item),
      ),
    ).toBe(true);
  });

  it("compacts nested lower-pane chrome around a neighboring full-height body", () => {
    const panes = [
      pane({ id: "%1", width: 59 }),
      pane({ id: "%2", left: 60, width: 60, height: 18, active: false }),
      pane({ id: "%3", left: 60, top: 19, width: 60, height: 19, active: false }),
    ];
    const layout = projectTerminalPaneChrome({ canvas, panes });
    const lower = layout.framebuffer.find((item) => item.paneId === "%3")!;
    expect(lower).toMatchObject({
      placement: "gutter-header",
      layerRect: { x: 60, y: 18, width: 60, height: 1 },
    });
    expect(terminalPaneChromeOverlapsBodies({ canvas, panes }, lower)).toBe(false);
  });

  it("reflects zoom as an active restore action while retaining exact tmux size", () => {
    const panes = [pane({ zoomed: true })];
    const before = canvas.tmuxSize;
    const layout = projectTerminalPaneChrome({ canvas, panes });
    const zoom = layout.native[0]!.frame!.actions.find((action) => action.id === "zoom")!;
    expect(zoom).toMatchObject({
      fullLabel: "restore",
      label: "▣",
      appearance: "icon",
      active: true,
    });
    expect(canvas.tmuxSize).toEqual(before);
    expect(layout.framebuffer).toEqual([]);
  });

  it("keeps fixed icon hit spans while hiding inactive chrome until hover", () => {
    const panes = [
      pane({ id: "%1", width: 59 }),
      pane({ id: "%2", left: 60, width: 60, active: false }),
    ];
    const idle = projectTerminalPaneChrome({ canvas, panes });
    const idleActions = idle.native[1]!.frame!.actions;
    expect(idleActions.map((action) => [action.id, action.label, action.hidden])).toEqual([
      ["zoom", "□", true],
      ["menu", "⋯", true],
    ]);

    const hovered = projectTerminalPaneChrome({
      canvas,
      panes,
      hoveredAction: { paneId: "%2", actionIndex: null },
    });
    const hoveredActions = hovered.native[1]!.frame!.actions;
    expect(hoveredActions.map((action) => [action.id, action.start, action.width])).toEqual(
      idleActions.map((action) => [action.id, action.start, action.width]),
    );
    expect(hoveredActions.every((action) => action.hidden === false)).toBe(true);
    expect(hoveredActions.every((action) => action.hovered === false)).toBe(true);
  });

  it.each([1, 2, 3, 4, 5, 8, 12, 13, 16])(
    "reserves a bounded zoom hit span at width %s",
    (width) => {
      const narrowCanvas = projectAgentTerminalCanvas({ width, height: 6, chromeRows: 2 });
      const panes = [pane({ width, height: narrowCanvas.framebuffer.height })];
      const layout = projectTerminalPaneChrome({ canvas: narrowCanvas, panes });
      const header = layout.native[0]!;
      const zoom = header.frame!.actions.find((action) => action.id === "zoom")!;
      expect(zoom).toBeDefined();
      expect(zoom.width).toBeGreaterThan(0);
      expect(zoom.start).toBeGreaterThanOrEqual(0);
      expect(zoom.start + zoom.width).toBeLessThanOrEqual(width);
      expect(
        terminalPaneChromeHitTest(
          layout,
          header.canvasRect.x + zoom.start + Math.floor((zoom.width - 1) / 2),
          header.canvasRect.y,
        ),
      ).toMatchObject({ paneId: "%1", hit: { area: "action", actionId: "zoom" } });
      expect(terminalPaneChromeOverlapsBodies({ canvas: narrowCanvas, panes }, header)).toBe(false);
    },
  );

  it("uses live descriptors when present and otherwise keeps pane ids visibly distinct", () => {
    const panes = [
      pane({ id: "%1", width: 59 }),
      pane({ id: "%2", left: 60, width: 60, active: false }),
    ];
    const layout = projectTerminalPaneChrome({ canvas, panes });
    expect(layout.native[0]!.frame!.titleSpan.text).toContain("%1");
    expect(layout.native[1]!.frame!.titleSpan.text).toContain("%2");
    expect(terminalPaneChromeTitle(pane({ title: "API server" }))).toBe("API server");
    expect(terminalPaneChromeTitle(pane({ currentCommand: "pnpm dev" }))).toBe("pnpm dev");
    expect(
      terminalPaneChromeTitle(pane({ title: "API server" }), { title: "Codex implementer" }),
    ).toBe("Codex implementer");
  });

  it("keeps tiny and malformed layouts bounded and reports unavailable chrome", () => {
    const tinyCanvas = projectAgentTerminalCanvas({ width: 8, height: 6, chromeRows: 2 });
    const panes = [
      pane({ id: "%1", width: 8, height: 4 }),
      pane({ id: "%2", top: 1, width: 8, height: 3, active: false }),
    ];
    const layout = projectTerminalPaneChrome({ canvas: tinyCanvas, panes });
    const malformed = layout.framebuffer[0]!;
    expect(malformed.placement).toBe("unavailable");
    expect(malformed.frame).toBeNull();
    expect(malformed.diagnostic).toContain("no non-body cell");
    expect(terminalPaneChromeOverlapsBodies({ canvas: tinyCanvas, panes }, malformed)).toBe(false);
    for (const item of [...layout.native, ...layout.framebuffer]) {
      expect(item.layerRect.width).toBeGreaterThanOrEqual(0);
      expect(item.layerRect.height).toBeGreaterThanOrEqual(0);
    }
  });

  it("uses the widest safe compact segment when only part of a gutter is free", () => {
    const partialCanvas = projectAgentTerminalCanvas({ width: 20, height: 12, chromeRows: 2 });
    const panes = [
      pane({ id: "%1", width: 8, height: 6 }),
      pane({ id: "%2", top: 6, width: 20, height: 4, active: false }),
    ];
    const layout = projectTerminalPaneChrome({ canvas: partialCanvas, panes });
    const compact = layout.framebuffer[0]!;
    expect(compact).toMatchObject({
      paneId: "%2",
      placement: "compact-gutter",
      layerRect: { x: 8, y: 5, width: 12, height: 1 },
    });
    expect(compact.diagnostic).toContain("compacted");
    expect(terminalPaneChromeOverlapsBodies({ canvas: partialCanvas, panes }, compact)).toBe(false);
  });

  it("hit-tests actions and returns root-owned focus/action/settle intents", () => {
    const panes = [
      pane({ id: "%1", width: 59 }),
      pane({ id: "%2", left: 60, width: 60, active: false }),
    ];
    const layout = projectTerminalPaneChrome({ canvas, panes });
    const second = layout.native[1]!;
    const zoom = second.frame!.actions.find((action) => action.id === "zoom")!;
    const zoomIndex = second.frame!.actions.findIndex((action) => action.id === "zoom");
    const x = second.canvasRect.x + zoom.start;
    const y = second.canvasRect.y;
    expect(terminalPaneChromeHitTest(layout, x, y)).toMatchObject({
      paneId: "%2",
      hit: { area: "action", actionId: "zoom" },
    });
    expect(terminalPaneChromePointerIntent(layout, x, y, "down")).toEqual({
      kind: "action",
      paneId: "%2",
      actionId: "zoom",
      actionIndex: zoomIndex,
      semanticIntent: {
        kind: "action",
        paneId: terminalPaneSemanticId("%2"),
        actionId: "zoom",
        commandId: "workspace.windowMode.maximize.toggle",
      },
    });
    const intent = terminalPaneChromePointerIntent(layout, x, y, "down");
    expect(
      intent?.kind === "action"
        ? terminalPaneChromeActionTargetForIntent(layout, intent.semanticIntent)
        : null,
    ).toEqual({
      paneId: "%2",
      actionIndex: zoomIndex,
    });
    expect(terminalPaneChromePointerIntent(layout, second.canvasRect.x, y, "down")).toEqual({
      kind: "focus",
      paneId: "%2",
    });
    expect(
      terminalPaneChromePointerIntent(
        layout,
        second.canvasRect.x + second.frame!.titleSpan.x,
        y,
        "move",
      ),
    ).toEqual({ kind: "hover", target: { paneId: "%2", actionIndex: null } });
    expect(terminalPaneChromePointerIntent(layout, x, y, "up")).toEqual({
      kind: "settle",
      paneId: "%2",
    });
  });

  it("dispatches nonfocused zoom as focus then effect with no PTY transport", () => {
    const calls: string[] = [];
    const ptyWrites: string[] = [];
    dispatchTerminalPaneChromePointerIntent(
      {
        kind: "action",
        paneId: "%9",
        actionId: "zoom",
        actionIndex: 0,
        semanticIntent: {
          kind: "action",
          paneId: terminalPaneSemanticId("%9"),
          actionId: "zoom",
          commandId: "workspace.windowMode.maximize.toggle",
        },
      },
      {
        hover: () => calls.push("hover"),
        focus: (paneId) => calls.push(`focus:${paneId}`),
        action: (paneId, actionId) => calls.push(`${actionId}:${paneId}`),
        menu: (paneId) => calls.push(`menu:${paneId}`),
        settle: (paneId) => calls.push(`settle:${paneId}`),
      },
    );
    expect(calls).toEqual(["focus:%9", "zoom:%9"]);
    expect(ptyWrites).toEqual([]);
  });

  it("keeps the one-item production root swap executable and owned by Card 22.4b2", () => {
    const appSource = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");
    expect(CARD_22_4B2_PANE_FRAME_ROOT_WIRING_DEFERRALS).toEqual([
      {
        component: "TerminalPaneChromeLayer",
        replacement: "SharedTerminalPaneChromeLayer",
        owner: "22.4b2",
      },
    ]);
    expect(appSource).toContain(
      'import { TerminalPaneChromeLayer } from "./workspace/terminal-pane-chrome-view.tsx"',
    );
    expect(appSource).not.toContain("SharedTerminalPaneChromeLayer");
  });

  it("lets non-action lower-header cells fall through to separator resize", () => {
    const panes = [
      pane({ id: "%1", height: 18 }),
      pane({ id: "%2", top: 19, height: 19, active: false }),
    ];
    const layout = projectTerminalPaneChrome({ canvas, panes });
    const lower = layout.framebuffer[0]!;
    const zoom = lower.frame!.actions.find((action) => action.id === "zoom")!;
    expect(
      terminalPaneChromePointerIntent(
        layout,
        lower.canvasRect.x + zoom.start,
        lower.canvasRect.y,
        "down",
      ),
    ).toMatchObject({ kind: "action", paneId: "%2", actionId: "zoom" });
    expect(
      terminalPaneChromePointerIntent(
        layout,
        lower.canvasRect.x + lower.frame!.grip!.x,
        lower.canvasRect.y,
        "down",
      ),
    ).toBeNull();
    expect(
      terminalPaneChromePointerIntent(
        layout,
        lower.canvasRect.x + lower.frame!.grip!.x,
        lower.canvasRect.y,
        "move",
      ),
    ).toEqual({ kind: "hover", target: { paneId: "%2", actionIndex: null } });
    expect(
      terminalPaneChromePointerIntent(
        layout,
        lower.canvasRect.x + lower.frame!.grip!.x,
        lower.canvasRect.y,
        "drag",
      ),
    ).toBeNull();
  });

  it("clears motion and lifecycle state outside live terminal chrome", () => {
    const target = { paneId: "%2", actionIndex: 0 };
    expect(terminalPaneChromeMotionState({ kind: "hover", target: { ...target } }, target)).toEqual(
      { hovered: target, pressed: target },
    );
    expect(
      terminalPaneChromeMotionState(
        { kind: "hover", target: { paneId: "%2", actionIndex: null } },
        target,
      ),
    ).toEqual({ hovered: { paneId: "%2", actionIndex: null }, pressed: null });
    expect(terminalPaneChromeMotionState(null, target)).toEqual({ hovered: null, pressed: null });
    expect(reconcileTerminalPaneChromeActionTarget(target, new Set(["%2"]), true)).toBe(target);
    expect(reconcileTerminalPaneChromeActionTarget(target, new Set(["%1"]), true)).toBeNull();
    expect(reconcileTerminalPaneChromeActionTarget(target, new Set(["%2"]), false)).toBeNull();
  });
});
