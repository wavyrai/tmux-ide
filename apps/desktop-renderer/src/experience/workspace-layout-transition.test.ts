import { describe, expect, it } from "vitest";

import {
  planPaneLayoutTransition,
  type PaneLayoutSnapshot,
} from "./workspace-layout-transition.ts";

function pane(
  id: string,
  rect: { left: number; top: number; width: number; height: number },
): PaneLayoutSnapshot {
  return { pane: id, title: id, rect };
}

describe("planPaneLayoutTransition", () => {
  it("keys movement by semantic pane identity and computes the FLIP inverse", () => {
    const plan = planPaneLayoutTransition(
      [pane("pane.a", { left: 0, top: 0, width: 800, height: 500 })],
      [pane("pane.a", { left: 0, top: 0, width: 399, height: 500 })],
    );
    expect(plan.moves).toEqual([
      expect.objectContaining({
        pane: "pane.a",
        translateX: 0,
        translateY: 0,
        scaleX: 800 / 399,
        scaleY: 1,
      }),
    ]);
  });

  it("separates entering and exiting panes for split and kill transitions", () => {
    const before = [pane("pane.a", { left: 0, top: 0, width: 800, height: 500 })];
    const split = [
      pane("pane.a", { left: 0, top: 0, width: 399, height: 500 }),
      pane("pane.b", { left: 400, top: 0, width: 400, height: 500 }),
    ];
    expect(planPaneLayoutTransition(before, split).enters.map(({ pane }) => pane)).toEqual([
      "pane.b",
    ]);
    expect(planPaneLayoutTransition(split, before).exits.map(({ pane }) => pane)).toEqual([
      "pane.b",
    ]);
  });

  it("does not animate sub-pixel measurement noise", () => {
    const plan = planPaneLayoutTransition(
      [pane("pane.a", { left: 10, top: 10, width: 400, height: 300 })],
      [pane("pane.a", { left: 10.2, top: 9.8, width: 400.1, height: 300.1 })],
    );
    expect(plan.moves).toEqual([]);
  });
});
