import { describe, expect, it } from "vitest";
import {
  parseStatusPorcelain,
  classifyDiffLine,
  classifyDiff,
  untrackedDiffText,
  clampSel,
} from "./diff-model.ts";

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
