import { describe, expect, it } from "vitest";

import {
  commitWebTiledFocus,
  createWebTiledOptimisticState,
  deriveWebTiledProjection,
  enqueueWebTiledIntent,
  settleWebTiledIntent,
  supersedeWebTiledManipulation,
} from "./workspace-tiled-optimistic.ts";

const preview = (cells: number) =>
  ({
    kind: "resize",
    pane: "pane.a",
    axis: "cols",
    originalCells: 100,
    cells,
    movedCells: cells - 100,
    guideTransform: { translateX: 0, translateY: 0, scaleX: 1, scaleY: 1 },
    placements: [],
  }) as const;

describe("web tiled optimistic adapter", () => {
  it("projects focus immediately and settles it once from authoritative focus", () => {
    let state = createWebTiledOptimisticState("workspace.a", "pane.a");
    state = enqueueWebTiledIntent(state, "focus-1", { kind: "focus", pane: "pane.b" }, 1, 100);
    expect(deriveWebTiledProjection(state).focusPane).toBe("pane.b");
    state = commitWebTiledFocus(state, {
      generation: "workspace.a",
      revision: 1,
      focusPane: "pane.b",
      nowMs: 2,
    });
    expect(state.pending).toHaveLength(0);
    const duplicate = settleWebTiledIntent(state, "focus-1", "rejected");
    expect(duplicate).toBe(state);
    expect(deriveWebTiledProjection(duplicate).focusPane).toBe("pane.b");
  });

  it("keeps one resize preview while an accepted result clamps its cells", () => {
    let state = createWebTiledOptimisticState("workspace.a", "pane.a");
    state = enqueueWebTiledIntent(
      state,
      "resize-1",
      { kind: "manipulation", preview: preview(120) },
      1,
      100,
    );
    state = supersedeWebTiledManipulation(
      state,
      "resize-1",
      "resize-1:accepted",
      preview(116),
      2,
      100,
    );
    expect(deriveWebTiledProjection(state).manipulationPreview).toEqual(preview(116));
    expect(state.pending.map(({ operationId }) => operationId)).toEqual(["resize-1:accepted"]);
    state = settleWebTiledIntent(state, "resize-1:accepted", "observed");
    expect(deriveWebTiledProjection(state).manipulationPreview).toBeNull();
  });
});
