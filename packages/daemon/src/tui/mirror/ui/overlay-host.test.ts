import { describe, expect, it, vi } from "vitest";

import {
  createOverlayFocusCoordinator,
  overlayEscapeTarget,
  overlayFrameSize,
  overlayTopmost,
  overlayZIndex,
} from "./overlay-host.ts";

describe("overlay host model", () => {
  it("keeps one deterministic topmost layer and monotonic z-order", () => {
    const entries = [{ id: "palette" }, { id: "rename" }];
    expect(overlayTopmost(entries)).toEqual({ id: "rename" });
    expect(entries.map((_entry, index) => overlayZIndex(index))).toEqual([100, 110]);
    expect(overlayEscapeTarget(entries, "escape")).toBe("rename");
    expect(
      overlayEscapeTarget(
        [...entries, { id: "toast", modal: false, dismissOnEscape: false }],
        "escape",
      ),
    ).toBe("rename");
    expect(overlayEscapeTarget(entries, "enter")).toBeNull();
  });

  it.each([
    [80, 24, 76, 22],
    [120, 40, 116, 38],
    [200, 60, 196, 58],
  ] as const)(
    "bounds frames inside the %sx%s golden viewport",
    (width, height, frameWidth, frameHeight) => {
      expect(
        overlayFrameSize({
          viewportWidth: width,
          viewportHeight: height,
          preferredWidth: 400,
          preferredHeight: 100,
        }),
      ).toEqual({ width: frameWidth, height: frameHeight });
    },
  );

  it("captures once, restores after the final modal closes, and skips stale owners", () => {
    const restore = vi.fn();
    let mounted = true;
    const coordinator = createOverlayFocusCoordinator({
      capture: () => "pane:%7",
      mounted: () => mounted,
      restore,
    });
    coordinator.sync(["palette"]);
    coordinator.sync(["palette", "rename"]);
    coordinator.sync(["palette"]);
    expect(restore).not.toHaveBeenCalled();
    coordinator.sync([]);
    expect(restore).toHaveBeenCalledOnce();
    expect(restore).toHaveBeenCalledWith("pane:%7");

    coordinator.sync(["palette"]);
    mounted = false;
    coordinator.sync([]);
    expect(restore).toHaveBeenCalledOnce();
  });
});
