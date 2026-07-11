import { describe, expect, it } from "vitest";
import {
  parseStatusPorcelain,
  classifyDiffLine,
  classifyDiff,
  untrackedDiffText,
  clampSel,
  parseStatusGroups,
  filterEntries,
  buildDiffRows,
  rowIndexOfFile,
  parseNumstat,
  untrackedLineCount,
  applyCounts,
  totalCounts,
  parseHunkHeader,
  hunkLineIndices,
  nextHunkTop,
  hunkEditTarget,
  type DiffEntry,
} from "./diff-model.ts";

const entry = (group: DiffEntry["group"], path: string, status = "M"): DiffEntry => ({
  group,
  status,
  path,
  additions: null,
  deletions: null,
});

describe("parseStatusPorcelain", () => {
  it("parses index/worktree/untracked states into display letters", () => {
    const out = [" M src/a.ts", "M  src/b.ts", "?? new.ts", "A  added.ts", " D gone.ts"].join("\n");
    expect(parseStatusPorcelain(out)).toEqual([
      { status: "M", path: "src/a.ts", staged: false },
      { status: "M", path: "src/b.ts", staged: true },
      { status: "?", path: "new.ts", staged: false },
      { status: "A", path: "added.ts", staged: true },
      { status: "D", path: "gone.ts", staged: false },
    ]);
  });
  it("prefers the worktree state when a staged file is edited again", () => {
    expect(parseStatusPorcelain("MM src/a.ts")).toEqual([
      { status: "M", path: "src/a.ts", staged: true },
    ]);
  });
  it("takes the new path for renames", () => {
    expect(parseStatusPorcelain("R  old.ts -> new.ts")).toEqual([
      { status: "R", path: "new.ts", staged: true },
    ]);
  });
  it("skips blank and too-short lines", () => {
    expect(parseStatusPorcelain("\nx\n M a.ts\n")).toEqual([
      { status: "M", path: "a.ts", staged: false },
    ]);
  });
});

describe("classifyDiffLine", () => {
  it("catches file headers as meta before add/del", () => {
    expect(classifyDiffLine("+++ b/file.ts")).toBe("meta");
    expect(classifyDiffLine("--- a/file.ts")).toBe("meta");
  });
  it("classifies hunk / add / del / context", () => {
    expect(classifyDiffLine("@@ -1,3 +1,4 @@")).toBe("hunk");
    expect(classifyDiffLine("+added")).toBe("add");
    expect(classifyDiffLine("-removed")).toBe("del");
    expect(classifyDiffLine(" unchanged")).toBe("context");
  });
  it("treats git metadata lines as meta", () => {
    expect(classifyDiffLine("diff --git a/x b/x")).toBe("meta");
    expect(classifyDiffLine("index 0000..1111 100644")).toBe("meta");
    expect(classifyDiffLine("new file mode 100644")).toBe("meta");
    expect(classifyDiffLine("Binary files a/x and b/x differ")).toBe("meta");
    expect(classifyDiffLine("\\ No newline at end of file")).toBe("meta");
  });
});

describe("classifyDiff", () => {
  it("splits and classifies, dropping the trailing empty line", () => {
    const diff = ["@@ -1 +1 @@", "-old", "+new", " ctx", ""].join("\n");
    expect(classifyDiff(diff)).toEqual([
      { kind: "hunk", text: "@@ -1 +1 @@" },
      { kind: "del", text: "-old" },
      { kind: "add", text: "+new" },
      { kind: "context", text: " ctx" },
    ]);
  });
  it("returns [] for empty input", () => {
    expect(classifyDiff("")).toEqual([]);
  });
});

describe("untrackedDiffText", () => {
  it("prefixes every content line with + and drops the trailing newline", () => {
    expect(untrackedDiffText("a\nb\n")).toBe("+a\n+b");
    expect(classifyDiff(untrackedDiffText("a\nb\n")).every((l) => l.kind === "add")).toBe(true);
  });
});

describe("clampSel", () => {
  it("clamps into range and floors an empty list to 0", () => {
    expect(clampSel(5, 3)).toBe(2);
    expect(clampSel(-1, 3)).toBe(0);
    expect(clampSel(1, 0)).toBe(0);
  });
});

describe("parseStatusGroups", () => {
  it("splits XY lines into staged/unstaged/untracked components", () => {
    const out = [" M work.ts", "M  index.ts", "?? new.ts", "A  added.ts", " D gone.ts"].join("\n");
    expect(parseStatusGroups(out)).toEqual([
      entry("unstaged", "work.ts", "M"),
      entry("staged", "index.ts", "M"),
      entry("untracked", "new.ts", "?"),
      entry("staged", "added.ts", "A"),
      entry("unstaged", "gone.ts", "D"),
    ]);
  });
  it("yields BOTH a staged and an unstaged entry for MM (staged-then-edited)", () => {
    expect(parseStatusGroups("MM both.ts")).toEqual([
      entry("staged", "both.ts", "M"),
      entry("unstaged", "both.ts", "M"),
    ]);
  });
  it("takes the new path for renames and skips ignored/short lines", () => {
    expect(parseStatusGroups("R  old.ts -> new.ts\n!! dist\nx\n")).toEqual([
      entry("staged", "new.ts", "R"),
    ]);
  });
});

describe("filterEntries", () => {
  const entries = [
    entry("staged", "src/App.tsx"),
    entry("unstaged", "docs/readme.md"),
    entry("untracked", "src/new.ts", "?"),
  ];
  it("narrows to case-insensitive path substrings", () => {
    expect(filterEntries(entries, "SRC").map((e) => e.path)).toEqual(["src/App.tsx", "src/new.ts"]);
  });
  it("returns the input unchanged for an empty/blank query", () => {
    expect(filterEntries(entries, "")).toBe(entries);
    expect(filterEntries(entries, "  ")).toBe(entries);
  });
});

describe("buildDiffRows", () => {
  it("orders non-empty sections Staged→Unstaged→Untracked with counted headers", () => {
    const { rows, files } = buildDiffRows([
      entry("untracked", "n.ts", "?"),
      entry("staged", "s.ts", "A"),
      entry("unstaged", "u.ts"),
      entry("staged", "s2.ts"),
    ]);
    expect(rows.map((r) => (r.kind === "header" ? r.label : r.entry.path))).toEqual([
      "Staged (2)",
      "s.ts",
      "s2.ts",
      "Unstaged (1)",
      "u.ts",
      "Untracked (1)",
      "n.ts",
    ]);
    expect(files.map((f) => f.path)).toEqual(["s.ts", "s2.ts", "u.ts", "n.ts"]);
    // File rows carry their index into the flat selectable order.
    expect(
      rows.filter((r) => r.kind === "file").map((r) => (r.kind === "file" ? r.fileIndex : -1)),
    ).toEqual([0, 1, 2, 3]);
  });
  it("emits no header for an empty group and handles an empty list", () => {
    const { rows, files } = buildDiffRows([entry("unstaged", "u.ts")]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ kind: "header", group: "unstaged", label: "Unstaged (1)" });
    expect(files).toHaveLength(1);
    expect(buildDiffRows([])).toEqual({ rows: [], files: [] });
  });
});

describe("rowIndexOfFile", () => {
  it("maps a file index to its row (headers offset it), -1 when absent", () => {
    const { rows } = buildDiffRows([entry("staged", "a.ts"), entry("unstaged", "b.ts")]);
    expect(rowIndexOfFile(rows, 0)).toBe(1);
    expect(rowIndexOfFile(rows, 1)).toBe(3);
    expect(rowIndexOfFile(rows, 9)).toBe(-1);
  });
});

describe("parseNumstat", () => {
  it("parses added/deleted per path and skips binary rows", () => {
    const out = ["3\t1\tsrc/a.ts", "-\t-\timg.png", "0\t5\tgone.ts", ""].join("\n");
    const m = parseNumstat(out);
    expect(m.get("src/a.ts")).toEqual({ additions: 3, deletions: 1 });
    expect(m.get("gone.ts")).toEqual({ additions: 0, deletions: 5 });
    expect(m.has("img.png")).toBe(false);
  });
  it("resolves rename cells to the new path (brace and bare forms)", () => {
    const m = parseNumstat("1\t2\tsrc/{old.ts => new.ts}\n3\t4\ta.ts => b.ts");
    expect(m.get("src/new.ts")).toEqual({ additions: 1, deletions: 2 });
    expect(m.get("b.ts")).toEqual({ additions: 3, deletions: 4 });
  });
});

describe("untrackedLineCount", () => {
  it("counts content lines, ignoring the single trailing newline", () => {
    expect(untrackedLineCount("a\nb\n")).toBe(2);
    expect(untrackedLineCount("a\nb")).toBe(2);
    expect(untrackedLineCount("")).toBe(0);
  });
});

describe("applyCounts / totalCounts", () => {
  it("merges the right map per group and leaves misses null", () => {
    const entries = [
      entry("staged", "s.ts"),
      entry("unstaged", "s.ts"),
      entry("untracked", "n.ts", "?"),
      entry("unstaged", "bin.png"),
    ];
    const merged = applyCounts(
      entries,
      new Map([["s.ts", { additions: 2, deletions: 1 }]]),
      new Map([["s.ts", { additions: 4, deletions: 3 }]]),
      new Map([["n.ts", 7]]),
    );
    expect(merged[0]).toMatchObject({ additions: 2, deletions: 1 });
    expect(merged[1]).toMatchObject({ additions: 4, deletions: 3 });
    expect(merged[2]).toMatchObject({ additions: 7, deletions: 0 });
    expect(merged[3]).toMatchObject({ additions: null, deletions: null });
    expect(totalCounts(merged)).toEqual({ additions: 13, deletions: 4 });
  });
});

describe("parseHunkHeader", () => {
  it("parses full and count-omitted forms", () => {
    expect(parseHunkHeader("@@ -5,3 +7,4 @@ fn ctx()")).toEqual({
      oldStart: 5,
      oldCount: 3,
      newStart: 7,
      newCount: 4,
    });
    expect(parseHunkHeader("@@ -1 +1 @@")).toEqual({
      oldStart: 1,
      oldCount: 1,
      newStart: 1,
      newCount: 1,
    });
    expect(parseHunkHeader("+not a hunk")).toBeNull();
  });
});

// A two-hunk classified diff used by the hunk-math tables below.
const TWO_HUNKS = classifyDiff(
  [
    "diff --git a/f b/f",
    "index 111..222 100644",
    "--- a/f",
    "+++ b/f",
    "@@ -1,3 +1,4 @@", // line 4
    " ctx1",
    "+added at new line 2",
    " ctx2",
    " ctx3",
    "@@ -10,2 +11,1 @@", // line 9
    " ctx",
    "-removed (was new line 12's spot)",
    "",
  ].join("\n"),
);

describe("hunkLineIndices / nextHunkTop", () => {
  it("finds hunk lines and steps ]/[ between them", () => {
    expect(hunkLineIndices(TWO_HUNKS)).toEqual([4, 9]);
    expect(nextHunkTop(TWO_HUNKS, 0, 1)).toBe(4);
    expect(nextHunkTop(TWO_HUNKS, 4, 1)).toBe(9);
    expect(nextHunkTop(TWO_HUNKS, 9, 1)).toBeNull();
    expect(nextHunkTop(TWO_HUNKS, 9, -1)).toBe(4);
    expect(nextHunkTop(TWO_HUNKS, 4, -1)).toBeNull();
    expect(nextHunkTop([], 0, 1)).toBeNull();
  });
});

describe("hunkEditTarget", () => {
  it("targets the first changed line of the hunk at/above the view top", () => {
    // View above/at the first hunk: header +1,4, first add after one context
    // line → new-file line 2 → 0-based 1.
    expect(hunkEditTarget(TWO_HUNKS, 0)).toBe(1);
    expect(hunkEditTarget(TWO_HUNKS, 4)).toBe(1);
    // Scrolled into the second hunk: header +11,1, del after one context line
    // → new-file position 12 → 0-based 11.
    expect(hunkEditTarget(TWO_HUNKS, 9)).toBe(11);
    expect(hunkEditTarget(TWO_HUNKS, 11)).toBe(11);
  });
  it("falls back to the hunk start without ± lines and null without hunks", () => {
    const ctxOnly = classifyDiff("@@ -3,2 +5,2 @@\n ctx\n ctx\n");
    expect(hunkEditTarget(ctxOnly, 0)).toBe(4);
    expect(hunkEditTarget(classifyDiff("Binary files differ\n"), 0)).toBeNull();
    expect(hunkEditTarget([], 0)).toBeNull();
  });
});
