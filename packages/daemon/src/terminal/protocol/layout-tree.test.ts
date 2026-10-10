import { describe, expect, it } from "vitest";
import { parseLayout, parseLayoutTree, type LayoutTreeNode } from "./layout-parse.ts";

// Exact real tmux strings retained from apps/tmux-gpui/evidence/
// split-target-2026-10-10/gpui-split-target-no-descendant.log.
const recorded = [
  "cd2f,160x80,0,0{80x80,0,0,1,39x80,81,0[39x40,81,0{19x40,81,0,2,19x40,101,0,5},39x39,81,41,4],39x80,121,0,3}",
  "b195,160x80,0,0{80x80,0,0,1,39x80,81,0[39x40,81,0{16x40,81,0,2,22x40,98,0,5},39x39,81,41,4],39x80,121,0,3}",
  "72da,160x80,0,0{80x80,0,0,1,42x80,81,0[42x40,81,0{21x40,81,0,2,20x40,103,0,5},42x39,81,41,4],36x80,124,0,3}",
  "9baa,160x80,0,0[160x40,0,0,6,160x19,0,41{80x19,0,41[80x9,0,41,7,80x9,0,51,10],79x19,81,41,9},160x19,0,61,8]",
  "9b2d,160x80,0,0[160x40,0,0,6,160x19,0,41{80x19,0,41[80x6,0,41,7,80x12,0,48,10],79x19,81,41,9},160x19,0,61,8]",
  "6cb6,160x80,0,0[160x40,0,0,6,160x22,0,41{80x22,0,41[80x11,0,41,7,80x10,0,53,10],79x22,81,41,9},160x16,0,64,8]",
  "91aa,160x80,0,0{80x80,0,0[80x40,0,0{40x40,0,0,11,39x40,41,0,14},80x39,0,41{40x39,0,41,13,39x39,41,41,15}],79x80,81,0[79x40,81,0{39x40,81,0,12,39x40,121,0,17},79x39,81,41{39x39,81,41,16,39x39,121,41,18}]}",
  "68ab,160x80,0,0{80x80,0,0[80x40,0,0{43x40,0,0,11,36x40,44,0,14},80x39,0,41{40x39,0,41,13,39x39,41,41,15}],79x80,81,0[79x40,81,0{39x40,81,0,12,39x40,121,0,17},79x39,81,41{39x39,81,41,16,39x39,121,41,18}]}",
  "612c,160x80,0,0{80x80,0,0[80x40,0,0{37x40,0,0,11,42x40,38,0,14},80x39,0,41{40x39,0,41,13,39x39,41,41,15}],79x80,81,0[79x40,81,0{39x40,81,0,12,39x40,121,0,17},79x39,81,41{39x39,81,41,16,39x39,121,41,18}]}",
  "9473,160x80,0,0{80x80,0,0[80x40,0,0{40x40,0,0,11,39x40,41,0,14},80x39,0,41{43x39,0,41,13,36x39,44,41,15}],79x80,81,0[79x40,81,0{39x40,81,0,12,39x40,121,0,17},79x39,81,41{39x39,81,41,16,39x39,121,41,18}]}",
  "155e,160x80,0,0{80x80,0,0[80x40,0,0{40x40,0,0,11,39x40,41,0,14},80x39,0,41{37x39,0,41,13,42x39,38,41,15}],79x80,81,0[79x40,81,0{39x40,81,0,12,39x40,121,0,17},79x39,81,41{39x39,81,41,16,39x39,121,41,18}]}",
  "be0a,160x80,0,0{80x80,0,0[80x40,0,0{40x40,0,0,11,39x40,41,0,14},80x39,0,41{40x39,0,41,13,39x39,41,41,15}],79x80,81,0[79x40,81,0{42x40,81,0,12,36x40,124,0,17},79x39,81,41{39x39,81,41,16,39x39,121,41,18}]}",
  "f75a,160x80,0,0{80x80,0,0[80x40,0,0{40x40,0,0,11,39x40,41,0,14},80x39,0,41{40x39,0,41,13,39x39,41,41,15}],79x80,81,0[79x40,81,0{36x40,81,0,12,42x40,118,0,17},79x39,81,41{39x39,81,41,16,39x39,121,41,18}]}",
  "931a,160x80,0,0{80x80,0,0[80x40,0,0{40x40,0,0,11,39x40,41,0,14},80x39,0,41{40x39,0,41,13,39x39,41,41,15}],79x80,81,0[79x40,81,0{39x40,81,0,12,39x40,121,0,17},79x39,81,41{42x39,81,41,16,36x39,124,41,18}]}",
  "14de,160x80,0,0{80x80,0,0[80x40,0,0{40x40,0,0,11,39x40,41,0,14},80x39,0,41{40x39,0,41,13,39x39,41,41,15}],79x80,81,0[79x40,81,0{39x40,81,0,12,39x40,121,0,17},79x39,81,41{36x39,81,41,16,42x39,118,41,18}]}",
];
function leaves(
  node: LayoutTreeNode,
): Array<{ id: string; left: number; top: number; width: number; height: number }> {
  if (node.kind === "leaf") {
    const { id, left, top, width, height } = node;
    return [{ id, left, top, width, height }];
  }
  return node.children.flatMap(leaves);
}
function balanced(count: number, left = 0, first = 0): string {
  const width = count * 2 - 1;
  if (count === 1) return `1x1,${left},0,${first}`;
  const a = Math.floor(count / 2),
    b = count - a;
  return `${width}x1,${left},0{${balanced(a, left, first)},${balanced(b, left + a * 2, first + a)}}`;
}
// Valid but pathologically deep, with an actual two-child split at every level.
function deep(depth: number, left = 0): string {
  if (depth === 1) return `1x1,${left},0,${left}`;
  return `${depth * 2 - 1}x1,${left},0{1x1,${left},0,${left},${deep(depth - 1, left + 2)}}`;
}
describe("opt-in bounded layout ancestry", () => {
  it("preserves all recorded flat geometry and nested internal ancestry", () => {
    for (const layout of recorded) {
      const tree = parseLayoutTree(layout)!;
      expect(tree).not.toBeNull();
      expect({ width: tree.width, height: tree.height, leaves: leaves(tree) }).toEqual(
        parseLayout(layout),
      );
    }
    const tree = parseLayoutTree(recorded[0]!)!;
    expect(tree.kind).toBe("split");
    if (tree.kind !== "split") throw new Error("split expected");
    expect(tree.axis).toBe("cols");
    const middle = tree.children[1]!;
    expect(middle.kind).toBe("split");
    if (middle.kind !== "split") throw new Error("split expected");
    expect(middle.axis).toBe("rows");
    expect(middle.children.map((c) => leaves(c).map((l) => l.id))).toEqual([["%2", "%5"], ["%4"]]);
  });
  it("accepts single pane/zoom, synthetic checksum and exact capacity", () => {
    expect(parseLayoutTree("abcd,80x24,0,0,9")).toEqual({
      kind: "leaf",
      id: "%9",
      left: 0,
      top: 0,
      width: 80,
      height: 24,
    });
    expect(leaves(parseLayoutTree(`abcd,${balanced(512)}`)!)).toHaveLength(512);
    expect(parseLayoutTree(`abcd,${balanced(513)}`)).toBeNull();
    expect(parseLayoutTree(`abcd,${deep(64)}`)).not.toBeNull();
    expect(parseLayoutTree(`abcd,${deep(65)}`)).toBeNull();
  });
  it.each([
    "abcd,0x1,0,0,1",
    "abcd,1x0,0,0,1",
    "abcd,1x1,1,0,1",
    "abcd,1x1,0,1,1",
    "abcd,9007199254740992x1,0,0,1",
    "abcd,1x1,9007199254740991,0,1",
    "abcd,1x1,0,0,9007199254740992",
    "abcd,1x1,0,0,-1",
    "abcd,3x1,0,0{1x1,0,0,1,1x1,2,0,01}",
    "abcd,3x1,0,0{1x1,0,0,1,1x1,1,0,2}", // missing separator
    "abcd,4x1,0,0{1x1,0,0,1,1x1,3,0,2}", // gap
    "abcd,3x1,0,0{2x1,0,0,1,2x1,1,0,2}", // overlap
    "abcd,3x1,0,0{1x1,0,0,1,2x1,2,0,2}", // outside
    "abcd,3x2,0,0{1x1,0,0,1,1x2,2,0,2}", // unequal orthogonal span
    "abcd,3x1,0,0[1x1,0,0,1,1x1,2,0,2]", // wrong axis
    "abcd,1x1,0,0{1x1,0,0,1}", // unary node
    "abcd,3x1,0,0{1x1,0,0,1,1x1,2,0,2]", // mismatched delimiter
    "abcd,1x1,0,0,1suffix",
    "abcd,1x1,0,0,1,",
    "bad,1x1,0,0,1",
  ])("refuses invalid ancestry %s", (layout) => expect(parseLayoutTree(layout)).toBeNull());
  it("bounds source scanning and unsafe numeric values without changing the old parser", () => {
    expect(parseLayoutTree("abcd," + "9".repeat(65536) + "x1,0,0,1")).toBeNull();
    expect(parseLayoutTree("abcd," + "9".repeat(400) + "x1,0,0,1")).toBeNull();
    // Existing callers retain deliberately permissive geometry behavior.
    for (const layout of [
      "abcd,0x0,0,0,1",
      "abcd,3x1,0,0{1x1,0,0,1,1x1,1,0,1}",
      "abcd,1x1,0,0{1x1,0,0,1}",
    ])
      expect(parseLayout(layout)).not.toBeNull();
  });
});
