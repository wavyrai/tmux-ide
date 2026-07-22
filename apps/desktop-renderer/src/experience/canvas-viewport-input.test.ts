import { describe, expect, it } from "vitest";

import {
  canvasViewportKeyboardCommand,
  canvasWheelTransform,
  keyboardCanvasViewportTransform,
} from "./canvas-viewport-input.ts";
import { screenToCanvas } from "./canvas-interaction-geometry.ts";

describe("canvas viewport input", () => {
  it("treats ordinary trackpad input as pan and ctrl-wheel as anchored pinch zoom", () => {
    const before = { x: 40, y: -20, scale: 1 };
    expect(
      canvasWheelTransform({
        transform: before,
        anchor: { x: 300, y: 200 },
        deltaX: 12,
        deltaY: 30,
        deltaMode: 0,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
      }),
    ).toEqual({ x: 28, y: -50, scale: 1 });

    const anchor = { x: 300, y: 200 };
    const canvasPoint = screenToCanvas(anchor, before);
    const pinched = canvasWheelTransform({
      transform: before,
      anchor,
      deltaX: 0,
      deltaY: -40,
      deltaMode: 0,
      ctrlKey: true,
      metaKey: false,
      shiftKey: false,
    });
    expect(pinched.scale).toBeGreaterThan(1);
    expect(screenToCanvas(anchor, pinched).x).toBeCloseTo(canvasPoint.x);
    expect(screenToCanvas(anchor, pinched).y).toBeCloseTo(canvasPoint.y);
  });

  it("maps unmodified canvas keys but leaves application shortcuts alone", () => {
    const key = (value: string, ctrlKey = false) =>
      canvasViewportKeyboardCommand({ key: value, ctrlKey, metaKey: false, altKey: false });
    expect(key("+")).toBe("zoom-in");
    expect(key("-")).toBe("zoom-out");
    expect(key("f")).toBe("fit");
    expect(key("0")).toBe("reset");
    expect(key("k", true)).toBeNull();
  });

  it("keeps keyboard zoom centered and pans in fixed screen increments", () => {
    const before = { x: 0, y: 0, scale: 1 };
    const zoomed = keyboardCanvasViewportTransform({
      transform: before,
      command: "zoom-in",
      center: { x: 500, y: 300 },
    });
    expect(screenToCanvas({ x: 500, y: 300 }, zoomed)).toEqual({ x: 500, y: 300 });
    expect(
      keyboardCanvasViewportTransform({
        transform: before,
        command: "pan-right",
        center: { x: 500, y: 300 },
      }),
    ).toEqual({ x: -48, y: 0, scale: 1 });
  });
});
