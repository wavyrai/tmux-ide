import { describe, expect, it } from "vitest";

import {
  canvasDeltaFromScreenDelta,
  canvasRectBounds,
  canvasToScreen,
  fitCanvasViewport,
  moveCanvasRect,
  panCanvasViewport,
  resizeCanvasRect,
  screenToCanvas,
  zoomCanvasViewportAt,
  type CanvasRect,
  type CanvasResizeEdge,
} from "./canvas-interaction-geometry.ts";

const RECT: CanvasRect = { x: 100, y: 80, width: 300, height: 200 };
const CONSTRAINTS = {
  minWidth: 120,
  minHeight: 90,
  bounds: { x: 0, y: 0, width: 800, height: 600 },
};

describe("canvas viewport geometry", () => {
  it("round-trips canvas and screen coordinates", () => {
    const transform = { x: 37, y: -22, scale: 1.75 };
    const canvas = { x: 210, y: -15 };
    expect(screenToCanvas(canvasToScreen(canvas, transform), transform)).toEqual(canvas);
  });

  it("keeps the canvas coordinate beneath the zoom anchor fixed", () => {
    const anchor = { x: 540, y: 320 };
    const before = { x: 80, y: 40, scale: 1 };
    const anchoredCanvasPoint = screenToCanvas(anchor, before);
    const after = zoomCanvasViewportAt(before, 2.5, anchor);

    expect(screenToCanvas(anchor, after)).toEqual(anchoredCanvasPoint);
    expect(canvasToScreen(anchoredCanvasPoint, after)).toEqual(anchor);
  });

  it("clamps zoom to a normalized scale range without moving its anchor", () => {
    const anchor = { x: 100, y: 50 };
    const after = zoomCanvasViewportAt({ x: 10, y: 5, scale: 1 }, 20, anchor, { min: 0.5, max: 3 });
    expect(after.scale).toBe(3);
    expect(canvasToScreen({ x: 90, y: 45 }, after, { min: 0.5, max: 3 })).toEqual(anchor);
  });

  it("propagates a custom scale range through projection, inversion, pan, and deltas", () => {
    const range = { min: 0.05, max: 0.2 };
    const transform = { x: 10, y: 20, scale: 0.1 };
    const canvas = { x: 400, y: 300 };
    const screen = canvasToScreen(canvas, transform, range);

    expect(screen).toEqual({ x: 50, y: 50 });
    expect(screenToCanvas(screen, transform, range)).toEqual(canvas);
    expect(canvasDeltaFromScreenDelta({ x: 10, y: -5 }, transform, range)).toEqual({
      x: 100,
      y: -50,
    });
    expect(panCanvasViewport(transform, { x: 5, y: 8 }, range)).toEqual({
      x: 15,
      y: 28,
      scale: 0.1,
    });
  });

  it("fits the complete window bounds with screen-space padding", () => {
    const transform = fitCanvasViewport(
      [
        { x: -100, y: 50, width: 400, height: 200 },
        { x: 500, y: 300, width: 300, height: 250 },
      ],
      { width: 1_000, height: 700 },
      { padding: 50, scaleRange: { min: 0.25, max: 2 } },
    );
    const bounds = canvasRectBounds([
      { x: -100, y: 50, width: 400, height: 200 },
      { x: 500, y: 300, width: 300, height: 250 },
    ])!;
    const topLeft = canvasToScreen({ x: bounds.x, y: bounds.y }, transform);
    const bottomRight = canvasToScreen(
      { x: bounds.x + bounds.width, y: bounds.y + bounds.height },
      transform,
    );

    expect(bounds).toEqual({ x: -100, y: 50, width: 900, height: 500 });
    expect(transform.scale).toBe(1);
    expect(topLeft).toEqual({ x: 50, y: 100 });
    expect(bottomRight).toEqual({ x: 950, y: 600 });
  });

  it("uses an identity viewport when there is no content to fit", () => {
    expect(fitCanvasViewport([], { width: 900, height: 600 })).toEqual({
      x: 0,
      y: 0,
      scale: 1,
    });
  });
});

describe("canvas rect constraints", () => {
  it("snaps movement and clamps the whole rect to finite bounds", () => {
    expect(
      moveCanvasRect(RECT, { x: 658, y: -94 }, { ...CONSTRAINTS, grid: { size: 16 } }),
    ).toEqual({ x: 500, y: 0, width: 300, height: 200 });
  });

  it("leaves oversize windows anchored at the bounds origin", () => {
    expect(
      moveCanvasRect({ x: 20, y: 30, width: 900, height: 700 }, { x: 200, y: 200 }, CONSTRAINTS),
    ).toEqual({ x: 0, y: 0, width: 900, height: 700 });
  });

  it.each<{
    edge: CanvasResizeEdge;
    delta: { x: number; y: number };
    expected: CanvasRect;
  }>([
    {
      edge: "north",
      delta: { x: 0, y: -20 },
      expected: { x: 100, y: 60, width: 300, height: 220 },
    },
    {
      edge: "north-east",
      delta: { x: 25, y: -20 },
      expected: { x: 100, y: 60, width: 325, height: 220 },
    },
    { edge: "east", delta: { x: 25, y: 0 }, expected: { x: 100, y: 80, width: 325, height: 200 } },
    {
      edge: "south-east",
      delta: { x: 25, y: 30 },
      expected: { x: 100, y: 80, width: 325, height: 230 },
    },
    { edge: "south", delta: { x: 0, y: 30 }, expected: { x: 100, y: 80, width: 300, height: 230 } },
    {
      edge: "south-west",
      delta: { x: -25, y: 30 },
      expected: { x: 75, y: 80, width: 325, height: 230 },
    },
    { edge: "west", delta: { x: -25, y: 0 }, expected: { x: 75, y: 80, width: 325, height: 200 } },
    {
      edge: "north-west",
      delta: { x: -25, y: -20 },
      expected: { x: 75, y: 60, width: 325, height: 220 },
    },
  ])("resizes the $edge edge with its opposite edges anchored", ({ edge, delta, expected }) => {
    expect(resizeCanvasRect(RECT, edge, delta, CONSTRAINTS)).toEqual(expected);
  });

  it("enforces minimum size from either moving edge", () => {
    expect(resizeCanvasRect(RECT, "west", { x: 500, y: 0 }, CONSTRAINTS)).toEqual({
      x: 280,
      y: 80,
      width: 120,
      height: 200,
    });
    expect(resizeCanvasRect(RECT, "north", { x: 0, y: 500 }, CONSTRAINTS)).toEqual({
      x: 100,
      y: 190,
      width: 300,
      height: 90,
    });
  });

  it("clamps moving edges to bounds and snaps their canvas coordinates", () => {
    expect(
      resizeCanvasRect(
        RECT,
        "north-west",
        { x: -200, y: -200 },
        {
          ...CONSTRAINTS,
          grid: { size: 16 },
        },
      ),
    ).toEqual({ x: 0, y: 0, width: 400, height: 280 });
    expect(resizeCanvasRect(RECT, "south-east", { x: 900, y: 900 }, CONSTRAINTS)).toEqual({
      x: 100,
      y: 80,
      width: 700,
      height: 520,
    });
  });
});
