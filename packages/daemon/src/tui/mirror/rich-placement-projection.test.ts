import type { TerminalReplicaPlacement } from "@tmux-ide/contracts";
import { describe, expect, it } from "vitest";

import {
  projectRichPlacements,
  projectSnapshotRichPlacements,
} from "./rich-placement-projection.ts";

function placement(
  id: string,
  geometry: Partial<Pick<TerminalReplicaPlacement, "row" | "column" | "rows" | "columns">> = {},
  contentDigest = `digest:${id}`,
): TerminalReplicaPlacement {
  return {
    id,
    kind: "widget",
    row: geometry.row ?? 0,
    column: geometry.column ?? 0,
    rows: geometry.rows ?? 1,
    columns: geometry.columns ?? 1,
    contentDigest,
  };
}

describe("rich placement projection", () => {
  it("projects every placement in canonical order with stable per-placement identity", () => {
    const before = projectRichPlacements(
      "pane:editor",
      [placement("markdown", { row: 1, columns: 20 }), placement("image", { row: 4, columns: 8 })],
      { row: 0, column: 0, rows: 10, columns: 40 },
    );
    const after = projectRichPlacements(
      "pane:editor",
      [
        placement("markdown", { row: 2, columns: 30 }, "new-content"),
        placement("image", { row: 5, columns: 12 }, "new-image"),
      ],
      { row: 1, column: 0, rows: 8, columns: 32 },
    );

    expect(before.map((value) => value.placementId)).toEqual(["markdown", "image"]);
    expect(after.map((value) => value.renderableId)).toEqual(
      before.map((value) => value.renderableId),
    );
    expect(new Set(before.map((value) => value.renderableId)).size).toBe(2);
  });

  it("clips all four edges and exposes viewport-local host geometry", () => {
    const [projection] = projectRichPlacements(
      "pane",
      [placement("card", { row: 2, column: 3, rows: 8, columns: 12 })],
      { row: 4, column: 5, rows: 4, columns: 6 },
    );

    expect(projection).toMatchObject({
      visible: true,
      clipped: { row: 4, column: 5, rows: 4, columns: 6 },
      hostRect: { top: 0, left: 0, height: 4, width: 6 },
      clipping: { top: true, right: true, bottom: true, left: true },
    });
  });

  it("retains fully occluded placements as non-visible projections", () => {
    const projections = projectRichPlacements(
      "pane",
      [
        placement("above", { row: 0, column: 0, rows: 2, columns: 2 }),
        placement("below", { row: 12, column: 0, rows: 2, columns: 2 }),
      ],
      { row: 4, column: 4, rows: 4, columns: 4 },
    );

    expect(projections).toHaveLength(2);
    expect(
      projections.map(({ visible, clipped, hostRect }) => ({ visible, clipped, hostRect })),
    ).toEqual([
      { visible: false, clipped: null, hostRect: null },
      { visible: false, clipped: null, hostRect: null },
    ]);
  });

  it("disambiguates duplicate protocol ids without coupling identity to geometry", () => {
    const project = (row: number) =>
      projectRichPlacements(
        "pane",
        [placement("markdown", { row }), placement("markdown", { row: row + 1 })],
        { row: 0, column: 0, rows: 20, columns: 80 },
      );

    const before = project(1);
    const after = project(8);
    expect(before[0]?.renderableId).not.toBe(before[1]?.renderableId);
    expect(after.map((value) => value.renderableId)).toEqual(
      before.map((value) => value.renderableId),
    );
  });

  it("carries typed, immutable fallback metadata and the existing marker adapter", () => {
    const source = placement("markdown", { row: 2, columns: 80 }, "sha256:content");
    const [projection] = projectSnapshotRichPlacements("pane", {
      cols: 80,
      rows: 24,
      placements: [source],
    });

    expect(projection?.fallback).toEqual({
      kind: "authenticated-content-unavailable",
      widgetId: "markdown",
      placementKind: "widget",
      contentDigest: "sha256:content",
    });
    expect(projection?.marker).toEqual({
      id: "markdown",
      args: { semanticPlacement: source },
      lineIndex: 2,
    });
    expect(Object.isFrozen(projection)).toBe(true);
    expect(Object.isFrozen(projection?.fallback)).toBe(true);
    expect(Object.isFrozen(projection?.marker.args)).toBe(true);
  });

  it("uses the full snapshot grid when no viewport is supplied", () => {
    const [projection] = projectSnapshotRichPlacements("pane", {
      cols: 10,
      rows: 5,
      placements: [placement("card", { row: 4, column: 8, rows: 3, columns: 6 })],
    });

    expect(projection).toMatchObject({
      clipped: { row: 4, column: 8, rows: 1, columns: 2 },
      hostRect: { top: 4, left: 8, height: 1, width: 2 },
      clipping: { right: true, bottom: true },
    });
  });
});
