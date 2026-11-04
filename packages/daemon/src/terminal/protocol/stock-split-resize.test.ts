import { describe, expect, it, vi } from "vitest";
import { parseLayoutTree, type LayoutTreeNode } from "./layout-parse.ts";
import {
  planStockSplitResize,
  resizeStockSplit,
  stockSplitCommand,
  stockSplitTarget,
} from "./stock-split-resize.ts";

const tree = (layout: string): LayoutTreeNode => parseLayoutTree(layout)!;
const THREE = "0000,120x40,0,0{30x40,0,0,0,29x40,31,0,3,59x40,61,0[59x20,61,0,1,59x19,61,21,2]}";
// cols[ rows[cols[a,b],cols[c,d]], x ]: the left cell has no pane reaching the root split.
const NESTED =
  "0000,120x40,0,0{60x40,0,0[60x20,0,0{30x20,0,0,1,29x20,31,0,2},60x19,0,21{30x19,0,21,3,29x19,31,21,4}],59x40,61,0,5}";
// As NESTED with a third cell after, so the trailing side is not last either.
const UNADDRESSABLE =
  "0000,119x40,0,0{40x40,0,0[40x20,0,0{20x20,0,0,1,19x20,21,0,2},40x19,0,21{20x19,0,21,3,19x19,21,21,4}],39x40,41,0[39x20,41,0{20x20,41,0,5,18x20,62,0,6},39x19,41,21{20x19,41,21,7,18x19,62,21,8}],38x40,81,0,9}";

describe("stock split target", () => {
  it("names a pane in the leading cell whose nearest same-axis ancestor is the split's parent", () => {
    expect(stockSplitTarget(tree(THREE), [0], "cols")).toEqual({ paneId: "%0", trailing: false });
    expect(stockSplitTarget(tree(THREE), [1], "cols")).toEqual({ paneId: "%3", trailing: false });
    expect(stockSplitTarget(tree(THREE), [2, 0], "rows")).toEqual({
      paneId: "%1",
      trailing: false,
    });
  });
  it("uses the last cell when the leading cell has no such pane", () => {
    expect(stockSplitTarget(tree(NESTED), [0], "cols")).toEqual({ paneId: "%5", trailing: true });
  });
  it("gives up when neither side has one", () => {
    expect(stockSplitTarget(tree(UNADDRESSABLE), [0], "cols")).toBeNull();
  });
  it("does not use a trailing cell that has its own next sibling, which would move that boundary", () => {
    // rows[cols[a, b], cols[c, d]] | x | y: resizing x moves x's boundary with y.
    const middle =
      "0000,119x40,0,0{40x40,0,0[40x20,0,0{20x20,0,0,1,19x20,21,0,2},40x19,0,21{20x19,0,21,3,19x19,21,21,4}],39x40,41,0,5,38x40,81,0,6}";
    expect(stockSplitTarget(tree(middle), [0], "cols")).toBeNull();
    expect(stockSplitTarget(tree(middle), [1], "cols")).toEqual({ paneId: "%5", trailing: false });
  });
  it("refuses a path that is not a boundary on that axis", () => {
    expect(stockSplitTarget(tree(THREE), [2], "cols")).toBeNull();
    expect(stockSplitTarget(tree(THREE), [0], "rows")).toBeNull();
  });
});

describe("stock split plan", () => {
  it("turns a boundary into the leading cell's size", () => {
    expect(planStockSplitResize(tree(THREE), [0], "cols", 20)).toMatchObject({
      paneId: "%0",
      boundary: 20,
      size: 20,
    });
    expect(planStockSplitResize(tree(THREE), [1], "cols", 70)).toMatchObject({
      paneId: "%3",
      boundary: 70,
      size: 39,
    });
  });
  it("turns a boundary into the last cell's size when it targets that cell", () => {
    expect(planStockSplitResize(tree(NESTED), [0], "cols", 80)).toMatchObject({
      paneId: "%5",
      trailing: true,
      boundary: 80,
      size: 39,
    });
  });
  it("stops at the two neighbours' minimum sizes", () => {
    expect(planStockSplitResize(tree(THREE), [0], "cols", 110)?.boundary).toBe(58);
    expect(planStockSplitResize(tree(THREE), [0], "cols", 0)?.boundary).toBe(1);
    expect(planStockSplitResize(tree(THREE), [2, 0], "rows", 39)?.boundary).toBe(37);
    expect(planStockSplitResize(tree(THREE), [2, 0], "rows", 0)?.boundary).toBe(2);
  });
});

const request = {
  sessionId: "$1",
  windowId: "@2",
  expectedLayout: "abcd,100x10,0,0{50x10,0,0,1,49x10,51,0,2}",
  path: [0],
  axis: "cols" as const,
  boundary: 40,
};
const MOVED = "0000,100x10,0,0{40x10,0,0,1,59x10,41,0,2}";

describe("stock split command", () => {
  it("guards window, session, zoom, pane count and the escaped layout in one if-shell -F", () => {
    const plan = { paneId: "%1", trailing: false, boundary: 40, size: 40 };
    const command = stockSplitCommand(request, "1700000000", plan, 2, "MARK");
    expect(command).toMatch(/^if-shell -F -t '\$1:@2' '/u);
    for (const part of [
      "#{==:#{window_id},@2}",
      "#{==:#{session_id},$1}",
      "#{==:#{session_created},1700000000}",
      "#{==:#{window_zoomed_flag},0}",
      "#{==:#{window_panes},2}",
      "#{==:#{window_layout},abcd#,100x10#,0#,0{50x10#,0#,0#,1#,49x10#,51#,0#,2#}}",
    ])
      expect(command).toContain(part);
    expect(command).toContain(
      `'resize-pane -t %1 -x 40 ; display-message -p -t @2 "MARK #{window_layout}"' 'display-message -p MARK ; display-message -p MARK'`,
    );
  });
});

describe("stock split resize", () => {
  const answer = (layout: string) => (command: string) => {
    const marker = /tmux-ide-split-[0-9a-f-]+/u.exec(command)![0];
    return Promise.resolve([layout ? `${marker} ${layout}` : marker]);
  };
  it("authorizes before sending, in the same tick, and reports the read-back boundary", async () => {
    const order: string[] = [];
    const result = await resizeStockSplit(
      request,
      "1700000000",
      () => order.push("authorize"),
      (command) => {
        order.push("send");
        return answer(MOVED)(command);
      },
    );
    expect(order).toEqual(["authorize", "send"]);
    expect(result).toMatchObject({ status: "applied", boundary: 40, layout: MOVED, changed: true });
  });
  it("sends nothing when authorization fails", async () => {
    const send = vi.fn();
    await expect(
      resizeStockSplit(
        request,
        "1700000000",
        () => {
          throw new Error("retired");
        },
        send,
      ),
    ).rejects.toThrow("retired");
    expect(send).not.toHaveBeenCalled();
  });
  it("reports a refused guard as stale", async () => {
    await expect(resizeStockSplit(request, "1700000000", () => {}, answer(""))).resolves.toEqual({
      status: "refused",
      reason: "stale-layout",
    });
  });
  it("calls a failed or unexpected answer uncertain, never applied", async () => {
    const cases: ((c: string) => Promise<string[]>)[] = [
      () => Promise.reject(new Error("no such pane")),
      () => Promise.resolve([]),
      () => Promise.resolve(["other"]),
      answer("not a layout"),
      // Another pane appeared, and a boundary outside the moved range.
      answer("0000,100x10,0,0{40x10,0,0,1,59x10,41,0,3}"),
      answer("0000,100x10,0,0{20x10,0,0,1,79x10,21,0,2}"),
    ];
    for (const send of cases)
      expect((await resizeStockSplit(request, "1700000000", () => {}, send)).status).toBe(
        "uncertain",
      );
  });
  it("refuses bad identities before sending", async () => {
    const send = vi.fn();
    for (const bad of [
      { ...request, sessionId: "$1'" },
      { ...request, windowId: "@2 ; kill-server" },
      { ...request, expectedLayout: "nope" },
    ])
      expect((await resizeStockSplit(bad, "1700000000", () => {}, send)).status).toBe("refused");
    expect((await resizeStockSplit(request, "1 ; x", () => {}, send)).status).toBe("refused");
    expect(send).not.toHaveBeenCalled();
  });
});
