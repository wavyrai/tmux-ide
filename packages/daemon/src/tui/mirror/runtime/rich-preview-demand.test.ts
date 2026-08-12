import { describe, expect, it, vi } from "vitest";

import type { SemanticPaneCanonicalSnapshot } from "../semantic-pane-render-source.ts";
import type { RichPlacementProjection } from "../rich-placement-projection.ts";
import { collectRichPreviewCanonicalDemand } from "./rich-preview-demand.ts";

const canonical = { snapshot: {} } as SemanticPaneCanonicalSnapshot;
const placement = (visible: boolean, clipped: boolean) =>
  ({
    visible,
    hostRect: clipped ? null : { left: 0, top: 0, width: 1, height: 1 },
  }) as RichPlacementProjection;

describe("rich-preview root demand", () => {
  it.each([
    [false, true],
    [true, false],
  ])(
    "does not inspect panes before admission or outside the Terminals canvas",
    (admitted, visible) => {
      const placementsFor = vi.fn(() => [placement(true, false)]);
      expect(
        collectRichPreviewCanonicalDemand({
          admitted,
          terminalsVisible: visible,
          paneIds: ["pane"],
          placementsFor,
          canonicalFor: () => canonical,
        }),
      ).toEqual([]);
      expect(placementsFor).not.toHaveBeenCalled();
    },
  );

  it("rejects empty, hidden, and fully clipped placements without retaining canonical input", () => {
    for (const placements of [[], [placement(false, false)], [placement(true, true)]]) {
      const canonicalFor = vi.fn(() => canonical);
      expect(
        collectRichPreviewCanonicalDemand({
          admitted: true,
          terminalsVisible: true,
          paneIds: ["pane"],
          placementsFor: () => placements,
          canonicalFor,
        }),
      ).toEqual([]);
      expect(canonicalFor).not.toHaveBeenCalled();
    }
  });

  it("retains the exact canonical snapshot and only visible, clipped-in placement references", () => {
    const visible = placement(true, false);
    const result = collectRichPreviewCanonicalDemand({
      admitted: true,
      terminalsVisible: true,
      paneIds: ["pane"],
      placementsFor: () => [placement(false, false), visible, placement(true, true)],
      canonicalFor: () => canonical,
    });
    expect(result).toEqual([{ canonical, placements: [visible] }]);
    expect(result[0]?.canonical).toBe(canonical);
    expect(result[0]?.placements[0]).toBe(visible);
  });
});
