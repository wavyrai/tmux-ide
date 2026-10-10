import { test } from "node:test";
import assert from "node:assert/strict";
import { blankTerminalReplicaSnapshot } from "../../../packages/core/src/terminal-replica.ts";
import { windowCanvas } from "./window-canvas.ts";
import type { Layout } from "./topology.ts";
const layout: Layout = {
  type: "layout",
  semanticWindowId: "window-a",
  windowName: "test",
  currentWindow: true,
  cols: 5,
  rows: 2,
  zoomed: false,
  paneBorderStatus: "off",
  panes: [
    { pane: "left", left: 0, top: 0, width: 2, height: 2, active: false },
    { pane: "right", left: 3, top: 0, width: 2, height: 2, active: true },
  ],
};
const snapshot = (text: string) => {
  const base = blankTerminalReplicaSnapshot(2, 2);
  return {
    ...base,
    grid: base.grid.map((row) => ({
      ...row,
      cells: row.cells.map((cell) => ({ ...cell, grapheme: text })),
    })),
  };
};
const surfaces = [
  { paneId: "left", snapshot: snapshot("L") },
  { paneId: "right", snapshot: snapshot("R") },
];
test("canvas preserves tmux offsets, separator gap and selected cursor", () => {
  const result = windowCanvas(layout, "right", surfaces)!;
  assert.equal(result.grid[0].cells.map((c) => c.grapheme).join(""), "LL RR");
  assert.equal(result.cursor.x, 3);
  assert.equal(result.cols, 5);
  assert.equal(surfaces[0].snapshot.cols, 2);
});
test("incomplete, resized, overlapping and unverified layouts never promote", () => {
  assert.equal(windowCanvas(layout, "left", surfaces.slice(0, 1)), null);
  assert.equal(
    windowCanvas(
      { ...layout, panes: [{ ...layout.panes[0], width: 3 }, layout.panes[1]] },
      "left",
      surfaces,
    ),
    null,
  );
  assert.equal(
    windowCanvas(
      { ...layout, panes: [layout.panes[0], { ...layout.panes[1], left: 1 }] },
      "left",
      surfaces,
    ),
    null,
  );
  assert.equal(windowCanvas({ ...layout, semanticWindowId: null }, "left", surfaces), null);
  assert.throws(() => windowCanvas(layout, "left", [...surfaces, surfaces[0]]));
});
for (const status of ["top", "bottom"] as const) {
  test(`${status} status row is outside pane content and cursor`, () => {
    const bordered = {
      ...layout,
      rows: 3,
      paneBorderStatus: status,
      panes: layout.panes.map((p) => ({ ...p, height: 3 })),
    };
    const result = windowCanvas(bordered, "right", surfaces)!;
    const contentRow = status === "top" ? 1 : 0;
    assert.equal(result.grid[contentRow].cells.map((c) => c.grapheme).join(""), "LL RR");
    assert.equal(
      result.grid[status === "top" ? 0 : 2].cells.map((c) => c.grapheme).join(""),
      "     ",
    );
    assert.equal(result.cursor.y, contentRow);
    assert.equal(
      windowCanvas(
        bordered,
        "right",
        surfaces.map((s) => ({ ...s, snapshot: blankTerminalReplicaSnapshot(2, 3) })),
      ),
      null,
    );
  });
  test(`${status} status only reduces the outer pane in vertical splits`, () => {
    const vertical: Layout = {
      ...layout,
      cols: 2,
      rows: 6,
      paneBorderStatus: status,
      panes: [
        { ...layout.panes[0], left: 0, top: 0, height: status === "top" ? 3 : 2 },
        {
          ...layout.panes[1],
          left: 0,
          top: status === "top" ? 4 : 3,
          height: status === "top" ? 2 : 3,
        },
      ],
    };
    const result = windowCanvas(vertical, "right", surfaces)!;
    assert.equal(result.grid[status === "top" ? 1 : 0].cells[0].grapheme, "L");
    assert.equal(result.grid[status === "top" ? 4 : 3].cells[0].grapheme, "R");
    assert.equal(result.cursor.y, status === "top" ? 4 : 3);
  });
}
