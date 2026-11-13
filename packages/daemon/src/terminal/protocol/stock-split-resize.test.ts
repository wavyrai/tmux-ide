import { describe, expect, it, vi } from "vitest";
import { parseLayoutTree, type LayoutTreeNode } from "./layout-parse.ts";
import {
  parseStockSplitOptions,
  planStockSplitResize,
  resizeStockSplit,
  stockSplitCommand,
  stockSplitMovable,
  stockSplitRange,
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

const OFF = { borderStatus: "off", scrollbar: 0 };
const TOP = { borderStatus: "top", scrollbar: 0 };
const BOTTOM = { borderStatus: "bottom", scrollbar: 0 };

describe("stock split target", () => {
  it("names a pane in the leading cell whose nearest same-axis ancestor is the split's parent", () => {
    expect(stockSplitTarget(tree(THREE), [0], "cols")).toBe("%0");
    expect(stockSplitTarget(tree(THREE), [1], "cols")).toBe("%3");
    expect(stockSplitTarget(tree(THREE), [2, 0], "rows")).toBe("%1");
  });
  it("uses the last cell when the leading cell has no such pane", () => {
    expect(stockSplitTarget(tree(NESTED), [0], "cols")).toBe("%5");
  });
  it("gives up when neither side has one", () => {
    expect(stockSplitTarget(tree(UNADDRESSABLE), [0], "cols")).toBeNull();
  });
  it("does not use a trailing cell that has its own next sibling, which would move that boundary", () => {
    // rows[cols[a, b], cols[c, d]] | x | y: resizing x moves x's boundary with y.
    const middle =
      "0000,119x40,0,0{40x40,0,0[40x20,0,0{20x20,0,0,1,19x20,21,0,2},40x19,0,21{20x19,0,21,3,19x19,21,21,4}],39x40,41,0,5,38x40,81,0,6}";
    expect(stockSplitTarget(tree(middle), [0], "cols")).toBeNull();
    expect(stockSplitTarget(tree(middle), [1], "cols")).toBe("%5");
  });
  it("refuses a path that is not a boundary on that axis", () => {
    expect(stockSplitTarget(tree(THREE), [2], "cols")).toBeNull();
    expect(stockSplitTarget(tree(THREE), [0], "rows")).toBeNull();
  });
});

describe("stock split plan", () => {
  it("turns a boundary into a signed move", () => {
    expect(planStockSplitResize(tree(THREE), [0], "cols", 20, OFF)).toEqual({
      paneId: "%0",
      boundary: 20,
      delta: -10,
    });
    expect(planStockSplitResize(tree(THREE), [1], "cols", 70, OFF)).toEqual({
      paneId: "%3",
      boundary: 70,
      delta: 10,
    });
    expect(planStockSplitResize(tree(NESTED), [0], "cols", 80, OFF)).toEqual({
      paneId: "%5",
      boundary: 80,
      delta: 20,
    });
  });
  it("stops at the two neighbours, at tmux's minimum for each border status", () => {
    const rows = (sizes: typeof OFF, wanted: number) =>
      planStockSplitResize(tree(THREE), [2, 0], "rows", wanted, sizes)?.boundary;
    expect(planStockSplitResize(tree(THREE), [0], "cols", 110, OFF)?.boundary).toBe(58);
    expect(planStockSplitResize(tree(THREE), [0], "cols", 0, OFF)?.boundary).toBe(1);
    expect(rows(OFF, 39)).toBe(38);
    expect(rows(OFF, 0)).toBe(1);
    // Only the pane on the status line's edge needs the extra row.
    expect(rows(TOP, 0)).toBe(2);
    expect(rows(TOP, 39)).toBe(38);
    expect(rows(BOTTOM, 0)).toBe(1);
    expect(rows(BOTTOM, 39)).toBe(37);
  });
  it("leaves room for a scrollbar", () => {
    const sizes = { borderStatus: "off", scrollbar: 2 };
    expect(planStockSplitResize(tree(THREE), [0], "cols", 110, sizes)?.boundary).toBe(56);
  });
});

describe("stock split movable", () => {
  // Three rows, the middle one a single row: 10 / 1 / 8.
  const ROWS = "0000,20x21,0,0[20x10,0,0,1,20x1,0,11,2,20x8,0,13,3]";
  it("offers a boundary next to a 1-row pane when it can move", () => {
    expect(stockSplitMovable(tree(ROWS), [0], "rows", OFF)).toBe(true);
    expect(stockSplitMovable(tree(ROWS), [1], "rows", OFF)).toBe(true);
  });
  it("offers no handle when the two neighbours have no room between them", () => {
    const tight = "0000,20x3,0,0[20x1,0,0,1,20x1,0,2,2]";
    expect(stockSplitMovable(tree(tight), [0], "rows", OFF)).toBe(false);
    const roomOff = "0000,20x4,0,0[20x1,0,0,1,20x2,0,2,2]";
    expect(stockSplitMovable(tree(roomOff), [0], "rows", OFF)).toBe(true);
    expect(stockSplitMovable(tree(roomOff), [0], "rows", TOP)).toBe(false);
  });
  it("offers no handle tmux cannot address", () => {
    expect(stockSplitMovable(tree(UNADDRESSABLE), [0], "cols", OFF)).toBe(false);
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
const OPTIONS = { borderStatus: "top", scrollbars: "off", scrollbar: 0 };

describe("stock split command", () => {
  const plan = (delta: number) => ({ paneId: "%1", boundary: 50 + delta, delta });
  it("guards window, session, zoom, pane count, sizing options and the escaped layout", () => {
    const command = stockSplitCommand(request, "1700000000", plan(-10), 2, OPTIONS, "MARK");
    expect(command).toMatch(/^if-shell -F -t '\$1:@2' '/u);
    for (const part of [
      "#{==:#{window_id},@2}",
      "#{==:#{session_id},$1}",
      "#{==:#{session_created},1700000000}",
      "#{==:#{window_zoomed_flag},0}",
      "#{==:#{window_panes},2}",
      "#{==:#{pane-border-status},top}",
      "#{==:#{pane-scrollbars},off}",
      "#{==:#{window_layout},abcd#,100x10#,0#,0{50x10#,0#,0#,1#,49x10#,51#,0#,2#}}",
    ])
      expect(command).toContain(part);
    expect(command).toContain(
      `'resize-pane -t %1 -L 10 ; display-message -p -t @2 "MARK #{window_layout}"' 'display-message -p MARK ; display-message -p MARK'`,
    );
  });
  it("moves relatively in the boundary's direction on each axis", () => {
    const rows = { ...request, axis: "rows" as const };
    const flag = (r: typeof request | typeof rows, delta: number) =>
      /resize-pane -t %1 (-[A-Z] \d+)/u.exec(
        stockSplitCommand(r, "1", plan(delta), 2, OPTIONS, "MARK"),
      )?.[1];
    expect(flag(request, 3)).toBe("-R 3");
    expect(flag(request, -3)).toBe("-L 3");
    expect(flag(rows, 3)).toBe("-D 3");
    expect(flag(rows, -3)).toBe("-U 3");
  });
  it("still answers in three blocks when nothing moves", () => {
    const command = stockSplitCommand(request, "1", plan(0), 2, OPTIONS, "MARK");
    expect(command).not.toContain("resize-pane");
    expect(command).toContain(`'display-message -p "" ; display-message -p -t @2 "MARK`);
  });
});

describe("stock split options", () => {
  it("reads border status and the room a scrollbar takes", () => {
    expect(parseStockSplitOptions("top\toff\tbg=black,width=1,pad=0")).toEqual(OPTIONS);
    expect(parseStockSplitOptions("off\ton\tfg=white,width=3,pad=1")).toEqual({
      borderStatus: "off",
      scrollbars: "on",
      scrollbar: 4,
    });
    expect(parseStockSplitOptions("off\tmodal\t")).toMatchObject({ scrollbar: 1 });
  });
  it("reads tmux 3.8's floating border status, which leaves tiled panes without a status line", () => {
    for (const borderStatus of ["top-floating", "bottom-floating"]) {
      const options = parseStockSplitOptions(`${borderStatus}\toff\t`);
      expect(options).toEqual({ borderStatus, scrollbars: "off", scrollbar: 0 });
      const tree = parseLayoutTree("aaaa,80x24,0,0[80x12,0,0,1,80x11,0,13,2]")!;
      // No status line on the window's edge: the edge pane can shrink to one row.
      expect(stockSplitRange(tree, [0], "rows", options!)).toEqual(
        stockSplitRange(tree, [0], "rows", { borderStatus: "off", scrollbar: 0 }),
      );
    }
  });
  it("refuses anything else", () => {
    for (const line of [undefined, "", "sideways\toff\t", "top\t\t", "top\tof f\t"])
      expect(parseStockSplitOptions(line)).toBeNull();
  });
});

describe("stock split resize", () => {
  const readOptions = () => Promise.resolve(["off\toff\twidth=1,pad=0"]);
  const answer = (layout: string) => (command: string) => {
    const marker = /tmux-ide-split-[0-9a-f-]+/u.exec(command)![0];
    return Promise.resolve([layout ? `${marker} ${layout}` : marker]);
  };
  const io = (send: (command: string) => Promise<string[]>) => ({ readOptions, send });
  it("authorizes before sending, in the same tick, and reports the read-back boundary", async () => {
    const order: string[] = [];
    const result = await resizeStockSplit(request, "1700000000", () => order.push("authorize"), {
      readOptions,
      send: (command) => {
        order.push("send");
        return answer(MOVED)(command);
      },
    });
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
        { readOptions, send },
      ),
    ).rejects.toThrow("retired");
    expect(send).not.toHaveBeenCalled();
  });
  it("sends nothing when the window's options cannot be read", async () => {
    const send = vi.fn();
    for (const read of [
      () => Promise.reject(new Error("gone")),
      () => Promise.resolve(["nonsense"]),
    ])
      await expect(
        resizeStockSplit(request, "1700000000", () => {}, { readOptions: read, send }),
      ).resolves.toEqual({ status: "refused", reason: "unsupported" });
    expect(send).not.toHaveBeenCalled();
  });
  it("reports a refused guard as stale", async () => {
    await expect(
      resizeStockSplit(request, "1700000000", () => {}, io(answer(""))),
    ).resolves.toEqual({ status: "refused", reason: "stale-layout" });
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
      expect((await resizeStockSplit(request, "1700000000", () => {}, io(send))).status).toBe(
        "uncertain",
      );
  });
  it("calls it uncertain when another boundary of the parent moved too", async () => {
    const three = {
      ...request,
      expectedLayout: "abcd,100x10,0,0{30x10,0,0,1,30x10,31,0,2,38x10,62,0,3}",
      boundary: 25,
    };
    const shifted = "0000,100x10,0,0{25x10,0,0,1,40x10,26,0,2,33x10,67,0,3}";
    expect((await resizeStockSplit(three, "1", () => {}, io(answer(shifted)))).status).toBe(
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
      expect((await resizeStockSplit(bad, "1700000000", () => {}, io(send))).status).toBe(
        "refused",
      );
    expect((await resizeStockSplit(request, "1 ; x", () => {}, io(send))).status).toBe("refused");
    expect(send).not.toHaveBeenCalled();
  });
});
