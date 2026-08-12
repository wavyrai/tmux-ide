import { describe, expect, it, vi } from "vitest";

import { cancelModalPointerCapture } from "./modal-pointer-capture.ts";

describe("modal pointer capture boundary", () => {
  it("cancels an active resize and prevents later drag ticks changing its preview", () => {
    let previewCells = 44;
    let dragging = true;
    const cancelBorderResize = vi.fn();
    const releaseForwardedDown = vi.fn();
    cancelModalPointerCapture({
      dragKind: "border",
      cancelBorderResize,
      clearDragging: () => {
        dragging = false;
      },
      clearSelecting: vi.fn(),
      clearDragAutoScroll: vi.fn(),
      clearPendingPress: vi.fn(),
      releaseForwardedDown,
      clearForwardedDown: vi.fn(),
      clearVisuals: vi.fn(),
    });

    // This is the underlying resize route's mutation guard after admission.
    if (dragging) previewCells = 80;
    expect(cancelBorderResize).toHaveBeenCalledOnce();
    expect(releaseForwardedDown).toHaveBeenCalledOnce();
    expect(previewCells).toBe(44);
  });
});
