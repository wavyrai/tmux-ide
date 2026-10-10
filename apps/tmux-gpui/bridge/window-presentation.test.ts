import { test } from "node:test";
import assert from "node:assert/strict";
import { blankTerminalReplicaSnapshot } from "../../../packages/core/src/terminal-replica.ts";
import type { Layout } from "./topology.ts";
import { createWindowPresentation } from "./window-presentation.ts";

const layout = (width = 2): Layout => ({
  type: "layout",
  semanticWindowId: "window-a",
  windowName: "test",
  currentWindow: true,
  cols: width * 2 + 1,
  rows: 2,
  zoomed: false,
  paneBorderStatus: "off",
  panes: [
    { pane: "left", left: 0, top: 0, width, height: 2, active: false },
    { pane: "right", left: width + 1, top: 0, width, height: 2, active: true },
  ],
});
const surfaces = (left = 2, right = left) => [
  { paneId: "left", snapshot: blankTerminalReplicaSnapshot(left, 2) },
  { paneId: "right", snapshot: blankTerminalReplicaSnapshot(right, 2) },
];
for (const order of ["layout-first", "surfaces-first", "sibling-first"] as const) {
  test(`${order} resize retains one atomic presentation then promotes matching geometry`, () => {
    const owner = createWindowPresentation("right");
    const old = owner.update(layout(), surfaces(), true)!;
    const intermediate = owner.update(
      order === "layout-first" ? layout(3) : layout(),
      order === "layout-first"
        ? surfaces()
        : order === "surfaces-first"
          ? surfaces(3)
          : surfaces(3, 2),
      true,
    );
    assert.equal(intermediate, old);
    assert.equal(intermediate!.snapshot.cols, 5);
    assert.equal(intermediate!.copyRegion.left, 3);
    assert.equal(intermediate!.regions[1].left, 3);
    const next = owner.update(layout(3), surfaces(3), true)!;
    assert.notEqual(next, old);
    assert.equal(next.snapshot.cols, 7);
    assert.equal(next.copyRegion.left, 4);
    assert.equal(next.copyRegion.width, 3);
    assert.equal(next.regions[1].left, 4);
  });
}

test("outer status row copy geometry and wrap flags remain paired with retained pixels", () => {
  const owner = createWindowPresentation("right");
  const withStatus = {
    ...layout(),
    rows: 3,
    paneBorderStatus: "top" as const,
    panes: layout().panes.map((p) => ({ ...p, height: 3 })),
  };
  const input = surfaces();
  input[1].snapshot = {
    ...input[1].snapshot,
    grid: input[1].snapshot.grid.map((row, i) => (i === 0 ? { ...row, wrapped: true } : row)),
  };
  const old = owner.update(withStatus, input, true)!;
  assert.deepEqual(old.copyRegion, {
    id: "right",
    left: 3,
    top: 1,
    width: 2,
    height: 2,
    wrapped: [true, false],
  });
  assert.equal(
    owner.update(
      {
        ...withStatus,
        cols: 7,
        panes: withStatus.panes.map((p, i) => ({ ...p, width: 3, left: i * 4 })),
      },
      input,
      true,
    ),
    old,
  );
});

test("scope replacement, missing surfaces, and invalid geometry clear retained state", () => {
  const base = layout();
  const cases: [Layout | undefined, ReturnType<typeof surfaces>][] = [
    [undefined, surfaces()],
    [{ ...base, semanticWindowId: "replacement" }, surfaces(3)],
    [{ ...base, panes: [base.panes[0]] }, surfaces()],
    [
      { ...base, panes: [{ ...base.panes[0], pane: "replacement" }, base.panes[1]] },
      [{ paneId: "replacement", snapshot: blankTerminalReplicaSnapshot(3, 2) }, surfaces()[1]],
    ],
    [base, surfaces().slice(1)],
    [{ ...base, panes: [base.panes[0], { ...base.panes[1], left: 1 }] }, surfaces(3)],
    [{ ...base, cols: 4 }, surfaces(3)],
    [{ ...base, panes: [base.panes[0], { ...base.panes[1], left: -1 }] }, surfaces(3)],
    [{ ...base, panes: [base.panes[0], { ...base.panes[1], pane: "left" }] }, surfaces(3)],
    [base, [...surfaces(), surfaces()[0]]],
    [
      base,
      [{ ...surfaces()[0], snapshot: { ...surfaces()[0].snapshot, grid: [] } }, surfaces()[1]],
    ],
  ];
  for (const [nextLayout, nextSurfaces] of cases) {
    const owner = createWindowPresentation("right");
    assert.ok(owner.update(base, surfaces(), true));
    assert.equal(owner.update(nextLayout, nextSurfaces, true), null);
    assert.equal(
      owner.update(layout(3), surfaces(), true),
      null,
      "invalid event must erase old cache",
    );
  }
});

test("authority, presence or history disable clears cache even when read-only composition succeeds", () => {
  const owner = createWindowPresentation("right");
  assert.ok(owner.update(layout(), surfaces(), true));
  assert.equal(owner.update(layout(3), surfaces(), false), null);
  assert.equal(owner.update(layout(3), surfaces(), true), null);
  assert.ok(owner.update(layout(), surfaces(), false), "fresh read-only output remains available");
  assert.equal(
    owner.update(layout(3), surfaces(), true),
    null,
    "read-only output must not seed retention",
  );
  assert.ok(owner.update(layout(3), surfaces(3), true));
});

test("another instance and an initial skew cannot borrow an earlier coherent frame", () => {
  assert.ok(createWindowPresentation("right").update(layout(), surfaces(), true));
  assert.equal(createWindowPresentation("right").update(layout(3), surfaces(), true), null);
});
