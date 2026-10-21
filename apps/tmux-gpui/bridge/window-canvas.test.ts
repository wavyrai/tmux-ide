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

test("composer reuses unchanged rows/grid/snapshot and only replaces changed contributors", async () => {
  const { createWindowCanvasComposer } = await import("./window-canvas.ts");
  const composer = createWindowCanvasComposer();
  const first = composer.compose(layout, "left", surfaces)!;
  assert.equal(composer.compose(layout, "left", surfaces), first);
  const cursorOnly = surfaces.map((s, i) =>
    i === 0 ? { ...s, snapshot: { ...s.snapshot, cursor: { ...s.snapshot.cursor, x: 1 } } } : s,
  );
  const cursor = composer.compose(layout, "left", cursorOnly)!;
  assert.notEqual(cursor, first);
  assert.equal(cursor.grid, first.grid);
  assert.equal(cursor.cursor.x, 1);
  const changed = cursorOnly.map((s, i) =>
    i === 1
      ? {
          ...s,
          snapshot: {
            ...s.snapshot,
            grid: s.snapshot.grid.map((r, y) =>
              y === 1 ? { ...r, cells: r.cells.map((c) => ({ ...c, grapheme: "😀é" })) } : r,
            ),
          },
        }
      : s,
  );
  const next = composer.compose(layout, "left", changed)!;
  assert.equal(next.grid[0], cursor.grid[0]);
  assert.notEqual(next.grid[1], cursor.grid[1]);
  assert.equal(next.grid[1]!.cells[0], cursor.grid[1]!.cells[0]);
  assert.equal(next.grid[1]!.cells[3]!.grapheme, "😀é");
  assert.equal(cursor.grid[1]!.cells[3]!.grapheme, "R");
  assert.equal(composer.compose(layout, "left", changed), next);
});

test("focus and active layout metadata changes do not rebuild cells", async () => {
  const { createWindowCanvasComposer } = await import("./window-canvas.ts");
  const composer = createWindowCanvasComposer();
  const first = composer.compose(layout, "left", surfaces)!;
  const focused = {
    ...layout,
    panes: layout.panes.map((p) => ({ ...p, active: p.pane === "right" })),
  };
  const next = composer.compose(focused, "right", surfaces)!;
  assert.equal(next.grid, first.grid);
  assert.equal(next.cursor.x, 3);
  assert.deepEqual(next, windowCanvas(focused, "right", surfaces));
  const same = surfaces.map((s) => ({
    ...s,
    snapshot: {
      ...s.snapshot,
      modes: { ...s.snapshot.modes },
      bootstrap: { ...s.snapshot.bootstrap },
      cursor: { ...s.snapshot.cursor },
    },
  }));
  assert.equal(composer.compose(focused, "right", same), next);
});

test("basis, layout identity, explicit reset and invalid geometry discard cached rows", async () => {
  const { createWindowCanvasComposer } = await import("./window-canvas.ts");
  const composer = createWindowCanvasComposer();
  const first = composer.compose(layout, "left", surfaces, "a")!;
  const next = composer.compose(layout, "left", surfaces, "b")!;
  assert.notEqual(next.grid[0], first.grid[0]);
  const other = composer.compose({ ...layout, semanticWindowId: "other" }, "left", surfaces, "b")!;
  assert.notEqual(other.grid[0], next.grid[0]);
  assert.equal(composer.compose({ ...layout, cols: 0 }, "left", surfaces), null);
  const restored = composer.compose(layout, "left", surfaces)!;
  composer.reset();
  assert.notEqual(composer.compose(layout, "left", surfaces)!.grid[0], restored.grid[0]);
  for (const bad of [{ cols: NaN }, { rows: -1 }, { cols: 1001 }, { rows: 501 }])
    assert.equal(composer.compose({ ...layout, ...bad }, "left", surfaces), null);
  for (const change of [{ left: -1 }, { top: -1 }, { width: 1.5 }, { height: 0 }, { left: 4 }])
    assert.equal(
      composer.compose(
        { ...layout, panes: [{ ...layout.panes[0], ...change }, layout.panes[1]] },
        "left",
        surfaces,
      ),
      null,
    );
  assert.equal(
    composer.compose(
      { ...layout, panes: [layout.panes[0], { ...layout.panes[1], pane: "left" }] },
      "left",
      surfaces,
    ),
    null,
  );
  assert.throws(() => composer.compose(layout, "left", [...surfaces, surfaces[0]]));
});

test("border separators and wrapped semantics survive immutable row replacement", async () => {
  const { createWindowCanvasComposer } = await import("./window-canvas.ts");
  const composer = createWindowCanvasComposer();
  const bordered = {
    ...layout,
    rows: 3,
    paneBorderStatus: "top" as const,
    panes: layout.panes.map((p) => ({ ...p, height: 3 })),
  };
  const first = composer.compose(bordered, "right", surfaces)!;
  const replaced = surfaces.map((s, i) =>
    i === 0
      ? {
          ...s,
          snapshot: {
            ...s.snapshot,
            grid: s.snapshot.grid.map((r, y) => (y === 0 ? { ...r, wrapped: true } : r)),
          },
        }
      : s,
  );
  const next = composer.compose(bordered, "right", replaced)!;
  assert.equal(next.grid[0], first.grid[0]);
  assert.equal(next.grid[2], first.grid[2]);
  assert.equal(next.grid[1]!.wrapped, false);
  assert.deepEqual(next, windowCanvas(bordered, "right", replaced));
  const short = surfaces.map((s, i) =>
    i === 0
      ? {
          ...s,
          snapshot: {
            ...s.snapshot,
            grid: [{ ...s.snapshot.grid[0]!, cells: [] }, s.snapshot.grid[1]!],
          },
        }
      : s,
  );
  assert.equal(composer.compose(bordered, "right", short), null);
});

test("changing one contributor does not reread another pane's cells", async () => {
  const { createWindowCanvasComposer } = await import("./window-canvas.ts");
  const composer = createWindowCanvasComposer();
  let reads = 0;
  const observed = surfaces.map((s, i) =>
    i === 0
      ? {
          ...s,
          snapshot: {
            ...s.snapshot,
            grid: s.snapshot.grid.map((row) => ({
              ...row,
              cells: new Proxy(row.cells, {
                get(target, key, receiver) {
                  if (typeof key === "string" && /^\d+$/.test(key)) reads++;
                  return Reflect.get(target, key, receiver);
                },
              }),
            })),
          },
        }
      : s,
  );
  composer.compose(layout, "left", observed);
  assert.ok(reads > 0);
  reads = 0;
  const changed = observed.map((s, i) =>
    i === 1
      ? {
          ...s,
          snapshot: {
            ...s.snapshot,
            grid: s.snapshot.grid.map((row, y) =>
              y === 0 ? { ...row, cells: row.cells.map((c) => ({ ...c, grapheme: "new" })) } : row,
            ),
          },
        }
      : s,
  );
  const next = composer.compose(layout, "left", changed)!;
  assert.equal(reads, 0);
  assert.equal(next.grid[0]!.cells[3]!.grapheme, "new");
});

test("invalid publication fences prior cache and selected modes/bootstrap stay current", async () => {
  const { createWindowCanvasComposer } = await import("./window-canvas.ts");
  const composer = createWindowCanvasComposer();
  const first = composer.compose(layout, "left", surfaces)!;
  assert.equal(composer.compose(layout, "left", surfaces.slice(0, 1)), null);
  const restored = composer.compose(layout, "left", surfaces)!;
  assert.notEqual(restored.grid[0], first.grid[0]);
  const changed = surfaces.map((s, i) =>
    i === 0
      ? {
          ...s,
          snapshot: {
            ...s.snapshot,
            modes: { ...s.snapshot.modes, bracketedPaste: true },
            bootstrap: {
              kind: "authoritative-stream" as const,
              hiddenState: "observed-from-start" as const,
            },
          },
        }
      : s,
  );
  const next = composer.compose(layout, "left", changed)!;
  assert.equal(next.grid, restored.grid);
  assert.equal(next.modes.bracketedPaste, true);
  assert.equal(next.bootstrap.hiddenState, "observed-from-start");
});
