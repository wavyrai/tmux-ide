/**
 * Three-way merge — pure-module tests.
 *
 * Locks the hunk-classification rules, the LCS-pair alignment,
 * and the `applyResolutions` round-trip. No Solid / Monaco
 * surfaces involved.
 */

import { describe, expect, it } from "vitest";
import {
  applyResolutions,
  conflictCount,
  emptyResolutions,
  lcsPairs,
  resolvedCount,
  threeWayMerge,
  type MergeHunk,
} from "@/lib/editor/three-way-merge";

function lines(...xs: string[]): string {
  return xs.join("\n");
}

describe("lcsPairs", () => {
  it("returns the LCS index pairs in increasing order", () => {
    const pairs = lcsPairs(["a", "b", "c", "d"], ["a", "x", "c", "d"]);
    expect(pairs).toEqual([
      [0, 0],
      [2, 2],
      [3, 3],
    ]);
  });

  it("handles empty inputs", () => {
    expect(lcsPairs([], ["a"])).toEqual([]);
    expect(lcsPairs(["a"], [])).toEqual([]);
  });
});

describe("threeWayMerge — hunk classification", () => {
  it("identical inputs produce only `unchanged` hunks", () => {
    const hunks = threeWayMerge("a\nb\nc", "a\nb\nc", "a\nb\nc");
    for (const h of hunks) expect(h.kind).toBe("unchanged");
    expect(applyResolutions(hunks, {})).toBe("a\nb\nc");
  });

  it("classifies external-only changes", () => {
    const hunks = threeWayMerge("a\nb\nc", "a\nB\nc", "a\nb\nc");
    const changed = hunks.find((h) => h.kind !== "unchanged");
    expect(changed?.kind).toBe("external-only");
    expect(applyResolutions(hunks, {})).toBe("a\nB\nc");
  });

  it("classifies local-only changes", () => {
    const hunks = threeWayMerge("a\nb\nc", "a\nb\nc", "a\nB\nc");
    const changed = hunks.find((h) => h.kind !== "unchanged");
    expect(changed?.kind).toBe("local-only");
    expect(applyResolutions(hunks, {})).toBe("a\nB\nc");
  });

  it("classifies conflicts where both sides diverge from base", () => {
    const hunks = threeWayMerge(
      lines("a", "b", "c"),
      lines("a", "X", "c"),
      lines("a", "Y", "c"),
    );
    const conflict = hunks.find((h) => h.kind === "conflict");
    expect(conflict).toBeDefined();
    expect(conflict?.baseLines).toEqual(["b"]);
    expect(conflict?.externalLines).toEqual(["X"]);
    expect(conflict?.localLines).toEqual(["Y"]);
    expect(conflictCount(hunks)).toBe(1);
  });

  it("a conflict where both sides converge on the same value is auto-resolved", () => {
    const hunks = threeWayMerge(
      lines("a", "b", "c"),
      lines("a", "Z", "c"),
      lines("a", "Z", "c"),
    );
    expect(hunks.find((h) => h.kind === "conflict")).toBeUndefined();
  });

  it("emits a tail hunk when only one side appends new lines", () => {
    const hunks = threeWayMerge(
      lines("a", "b"),
      lines("a", "b", "X"),
      lines("a", "b"),
    );
    const tail = hunks[hunks.length - 1]!;
    expect(tail.kind).toBe("external-only");
    expect(tail.externalLines).toEqual(["X"]);
  });
});

describe("applyResolutions — choice handling", () => {
  const base = lines("a", "b", "c");
  const external = lines("a", "X", "c");
  const local = lines("a", "Y", "c");
  const hunks = threeWayMerge(base, external, local);
  const conflict = hunks.find((h) => h.kind === "conflict") as MergeHunk;

  it("renders the local lines for an unresolved conflict (preview default)", () => {
    expect(applyResolutions(hunks, { [conflict.index]: { choice: null } })).toBe(
      lines("a", "Y", "c"),
    );
  });

  it("`external` picks the external side", () => {
    expect(
      applyResolutions(hunks, { [conflict.index]: { choice: "external" } }),
    ).toBe(lines("a", "X", "c"));
  });

  it("`local` picks the local side", () => {
    expect(applyResolutions(hunks, { [conflict.index]: { choice: "local" } })).toBe(
      lines("a", "Y", "c"),
    );
  });

  it("`combine` concatenates external + local", () => {
    expect(
      applyResolutions(hunks, { [conflict.index]: { choice: "combine" } }),
    ).toBe(lines("a", "X", "Y", "c"));
  });
});

describe("emptyResolutions / resolvedCount", () => {
  it("emptyResolutions only seeds conflict hunks", () => {
    const hunks = threeWayMerge(
      lines("a", "b", "c"),
      lines("a", "X", "c"),
      lines("a", "Y", "c"),
    );
    const init = emptyResolutions(hunks);
    expect(Object.keys(init).length).toBe(1);
    expect(resolvedCount(hunks, init)).toBe(0);
  });

  it("resolvedCount jumps as conflicts pick a choice", () => {
    const hunks = threeWayMerge(
      lines("a", "b", "c"),
      lines("X1", "b", "X2"),
      lines("Y1", "b", "Y2"),
    );
    const init = emptyResolutions(hunks);
    expect(conflictCount(hunks)).toBeGreaterThanOrEqual(2);
    const conflicts = hunks.filter((h) => h.kind === "conflict");
    init[conflicts[0]!.index] = { choice: "external" };
    expect(resolvedCount(hunks, init)).toBe(1);
    init[conflicts[1]!.index] = { choice: "combine" };
    expect(resolvedCount(hunks, init)).toBe(2);
  });
});

describe("threeWayMerge — round-trip safety", () => {
  it("applyResolutions(unchanged-only) preserves base text", () => {
    const base = lines("// header", "function f() {", "  return 1;", "}", "");
    const hunks = threeWayMerge(base, base, base);
    expect(applyResolutions(hunks, {})).toBe(base);
  });

  it("auto-applies the external side when only external diverges", () => {
    const base = lines("alpha", "beta", "gamma");
    const external = lines("alpha", "BETA", "gamma");
    const local = base;
    const hunks = threeWayMerge(base, external, local);
    expect(applyResolutions(hunks, {})).toBe(external);
  });

  it("auto-applies the local side when only local diverges", () => {
    const base = lines("alpha", "beta", "gamma");
    const external = base;
    const local = lines("alpha", "BETA", "gamma");
    const hunks = threeWayMerge(base, external, local);
    expect(applyResolutions(hunks, {})).toBe(local);
  });

  it("handles empty inputs without crashing", () => {
    const hunks = threeWayMerge("", "", "");
    expect(hunks).toEqual([]);
    expect(applyResolutions(hunks, {})).toBe("");
  });
});
