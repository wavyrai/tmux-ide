import { describe, expect, it } from "vitest";

import {
  canvasOwnsWheel,
  canvasResizeHitTargets,
  routeCanvasPointer,
} from "./canvas-input-routing.ts";

describe("canvas resize hit targets", () => {
  it("models eight transparent targets wider than their painted edges", () => {
    const targets = canvasResizeHitTargets(
      { x: 100, y: 80, width: 400, height: 300 },
      { x: 0, y: 0, scale: 1 },
      { hitSlop: 8, edgeThickness: 1, cornerSpan: 24 },
    );
    expect(targets.map(({ edge }) => edge)).toEqual([
      "north-west",
      "north",
      "north-east",
      "east",
      "south-east",
      "south",
      "south-west",
      "west",
    ]);
    expect(targets.find(({ edge }) => edge === "east")).toMatchObject({
      hitRect: { x: 492, y: 104, width: 16, height: 252 },
      edgeRect: { x: 499, y: 104, width: 1, height: 252 },
    });
  });

  it("keeps hit slop, painted edges, and corners constant in screen pixels", () => {
    const rect = { x: 100, y: 80, width: 400, height: 300 };
    const metrics = { hitSlop: 8, edgeThickness: 1, cornerSpan: 24 };
    const atHalfZoom = canvasResizeHitTargets(rect, { x: 0, y: 0, scale: 0.5 }, metrics);
    const atDoubleZoom = canvasResizeHitTargets(rect, { x: 0, y: 0, scale: 2 }, metrics);
    const halfEast = atHalfZoom.find(({ edge }) => edge === "east")!;
    const doubleEast = atDoubleZoom.find(({ edge }) => edge === "east")!;

    expect(halfEast.hitRect.width * 0.5).toBe(16);
    expect(doubleEast.hitRect.width * 2).toBe(16);
    expect(halfEast.edgeRect.width * 0.5).toBe(1);
    expect(doubleEast.edgeRect.width * 2).toBe(1);
    expect((halfEast.hitRect.y - rect.y) * 0.5).toBe(24);
    expect((doubleEast.hitRect.y - rect.y) * 2).toBe(24);
  });

  it("honors a custom zoom range while deriving screen-constant targets", () => {
    const targets = canvasResizeHitTargets(
      { x: 0, y: 0, width: 800, height: 600 },
      { x: 0, y: 0, scale: 0.1 },
      { hitSlop: 8 },
      { min: 0.05, max: 0.2 },
    );
    expect(targets.find(({ edge }) => edge === "west")?.hitRect.width).toBe(160);
  });
});

describe("canvas focus and gesture gating", () => {
  it("leaves terminal clicks and wheel input owned by the terminal", () => {
    const terminal = { kind: "terminal", windowId: "window.lead" } as const;
    expect(routeCanvasPointer({ region: terminal, button: 0, spaceKey: false })).toEqual({
      action: "terminal-input",
      claimPointer: false,
      focusWindowId: "window.lead",
    });
    expect(canvasOwnsWheel(terminal)).toBe(false);
  });

  it("claims only explicit window chrome for move and resize", () => {
    expect(
      routeCanvasPointer({
        region: { kind: "window-header", windowId: "window.lead", interactiveControl: false },
        button: 0,
        spaceKey: false,
      }),
    ).toEqual({ action: "move", claimPointer: true, focusWindowId: "window.lead" });
    expect(
      routeCanvasPointer({
        region: { kind: "resize-handle", windowId: "window.lead", edge: "south-east" },
        button: 0,
        spaceKey: false,
      }),
    ).toEqual({
      action: "resize",
      edge: "south-east",
      claimPointer: true,
      focusWindowId: "window.lead",
    });
  });

  it("does not steal pointer capture from header controls", () => {
    expect(
      routeCanvasPointer({
        region: { kind: "window-header", windowId: "window.lead", interactiveControl: true },
        button: 0,
        spaceKey: false,
      }),
    ).toEqual({ action: "focus", claimPointer: false, focusWindowId: "window.lead" });
  });

  it("pans only from explicit canvas gestures", () => {
    const canvas = { kind: "canvas" } as const;
    expect(routeCanvasPointer({ region: canvas, button: 0, spaceKey: true }).action).toBe("pan");
    expect(routeCanvasPointer({ region: canvas, button: 1, spaceKey: false }).action).toBe("pan");
    expect(routeCanvasPointer({ region: canvas, button: 0, spaceKey: false }).action).toBe(
      "clear-focus",
    );
    expect(canvasOwnsWheel(canvas)).toBe(true);
  });
});
