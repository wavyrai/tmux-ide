import { describe, expect, it } from "vitest";

import {
  parseNumstatZ,
  parseStatusV2,
  parseUnifiedDiff,
  splitNul,
} from "./workspace-changes-git.ts";

function nul(...tokens: string[]): Buffer {
  return Buffer.from(tokens.map((t) => `${t}\0`).join(""), "utf8");
}

describe("splitNul", () => {
  it("splits NUL-delimited tokens and drops a trailing empty", () => {
    expect(splitNul(Buffer.from("a\0b\0", "utf8"))).toEqual(["a", "b"]);
    expect(splitNul(Buffer.from("a\0b", "utf8"))).toEqual(["a", "b"]);
  });

  it("preserves spaces and other bytes inside a token", () => {
    expect(splitNul(Buffer.from("a b\tc\0", "utf8"))).toEqual(["a b\tc"]);
  });
});

describe("parseStatusV2", () => {
  it("reads the branch header and maps index/worktree columns to groups", () => {
    const buffer = nul(
      "# branch.oid abcdef",
      "# branch.head main",
      "1 .M N... 100644 100644 100644 h h file one.txt",
      "1 A. N... 000000 100644 100644 h h added.txt",
      "? untracked.txt",
    );
    const result = parseStatusV2(buffer);
    expect(result.branch).toBe("main");
    expect(result.detached).toBe(false);
    expect(result.changes).toEqual([
      { group: "unstaged", status: "modified", path: "file one.txt", originPath: null },
      { group: "staged", status: "added", path: "added.txt", originPath: null },
      { group: "untracked", status: "untracked", path: "untracked.txt", originPath: null },
    ]);
  });

  it("splits a doubly-modified file into staged and unstaged entries", () => {
    const result = parseStatusV2(nul("# branch.head main", "1 MM N... 1 1 1 h h both.txt"));
    expect(result.changes).toEqual([
      { group: "staged", status: "modified", path: "both.txt", originPath: null },
      { group: "unstaged", status: "modified", path: "both.txt", originPath: null },
    ]);
  });

  it("carries the origin path for a staged rename", () => {
    const buffer = nul(
      "# branch.head main",
      "2 R. N... 100644 100644 100644 h h R100 new name.txt",
      "old name.txt",
    );
    const result = parseStatusV2(buffer);
    expect(result.changes).toEqual([
      { group: "staged", status: "renamed", path: "new name.txt", originPath: "old name.txt" },
    ]);
  });

  it("maps an unmerged record to a conflicted worktree entry", () => {
    const buffer = nul(
      "# branch.head main",
      "u UU N... 100644 100644 100644 100644 h1 h2 h3 conflict.txt",
    );
    const result = parseStatusV2(buffer);
    expect(result.changes).toEqual([
      { group: "unstaged", status: "conflicted", path: "conflict.txt", originPath: null },
    ]);
  });

  it("reports a detached HEAD with a null branch", () => {
    const result = parseStatusV2(nul("# branch.oid abc", "# branch.head (detached)"));
    expect(result.detached).toBe(true);
    expect(result.branch).toBeNull();
  });
});

describe("parseNumstatZ", () => {
  it("parses decimal counts keyed by path", () => {
    const map = parseNumstatZ(nul("3\t4\tsrc/file.txt"));
    expect(map.get("src/file.txt")).toEqual({ additions: 3, deletions: 4, binary: false });
  });

  it("flags binary entries with null counts", () => {
    const map = parseNumstatZ(nul("-\t-\tlogo.png"));
    expect(map.get("logo.png")).toEqual({ additions: null, deletions: null, binary: true });
  });

  it("keys a rename record by its new path", () => {
    const buffer = Buffer.from("1\t2\t\0old.txt\0new.txt\0", "utf8");
    const map = parseNumstatZ(buffer);
    expect(map.get("new.txt")).toEqual({ additions: 1, deletions: 2, binary: false });
    expect(map.has("old.txt")).toBe(false);
  });
});

describe("parseUnifiedDiff", () => {
  it("assigns running old and new line numbers per hunk", () => {
    const patch = [
      "diff --git a/f.txt b/f.txt",
      "index 111..222 100644",
      "--- a/f.txt",
      "+++ b/f.txt",
      "@@ -1,3 +1,4 @@",
      " context",
      "-removed",
      "+added one",
      "+added two",
      " tail",
      "",
    ].join("\n");
    const result = parseUnifiedDiff(patch);
    expect(result.binary).toBe(false);
    expect(result.hunks).toHaveLength(1);
    const hunk = result.hunks[0]!;
    expect(hunk.oldStart).toBe(1);
    expect(hunk.newStart).toBe(1);
    expect(hunk.lines).toEqual([
      { kind: "context", content: "context", oldLine: 1, newLine: 1 },
      { kind: "delete", content: "removed", oldLine: 2, newLine: null },
      { kind: "insert", content: "added one", oldLine: null, newLine: 2 },
      { kind: "insert", content: "added two", oldLine: null, newLine: 3 },
      { kind: "context", content: "tail", oldLine: 3, newLine: 4 },
    ]);
  });

  it("ignores the no-newline marker without emitting a line", () => {
    const patch = ["@@ -1 +1 @@", "-a", "+b", "\\ No newline at end of file", ""].join("\n");
    const result = parseUnifiedDiff(patch);
    expect(result.hunks[0]!.lines).toEqual([
      { kind: "delete", content: "a", oldLine: 1, newLine: null },
      { kind: "insert", content: "b", oldLine: null, newLine: 1 },
    ]);
  });

  it("detects a binary patch", () => {
    const patch = "diff --git a/x b/x\nBinary files a/x and b/x differ\n";
    expect(parseUnifiedDiff(patch)).toEqual({ binary: true, hunks: [], lineTruncated: false });
  });
});
