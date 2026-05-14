/**
 * Pure parser tests for `git status --porcelain=v2 --branch -z` and
 * the branch/remote list parsers. Covers G18-P1 happy path + a
 * representative subset of the v2 format the daemon's git-service
 * actually exercises.
 */

import { describe, it, expect } from "vitest";
import { parseBranchList, parseRemoteBranches, parseRemotes, parseStatus } from "../status-parser";

const NUL = "\0";

function records(...lines: string[]): string {
  return lines.join(NUL) + NUL;
}

describe("parseStatus — porcelain v2", () => {
  it("parses headers (branch, ahead/behind, upstream)", () => {
    const raw = records(
      "# branch.oid abc123",
      "# branch.head main",
      "# branch.upstream origin/main",
      "# branch.ab +3 -1",
    );
    const s = parseStatus(raw);
    expect(s.currentBranch).toBe("main");
    expect(s.ahead).toBe(3);
    expect(s.behind).toBe(1);
    expect(s.isUnborn).toBe(false);
    expect(s.staged).toEqual([]);
    expect(s.unstaged).toEqual([]);
  });

  it("marks an unborn HEAD when branch.oid is (initial)", () => {
    const raw = records("# branch.oid (initial)", "# branch.head main");
    const s = parseStatus(raw);
    expect(s.isUnborn).toBe(true);
    expect(s.currentBranch).toBe("main");
  });

  it("treats (detached) as no current branch", () => {
    const raw = records("# branch.head (detached)");
    expect(parseStatus(raw).currentBranch).toBeNull();
  });

  it("splits ordinary records into staged + unstaged buckets", () => {
    // X (staged) = M, Y (unstaged) = .  → staged modified
    // X = ., Y = M  → unstaged modified
    // X = A, Y = .  → staged added
    const raw = records(
      "# branch.head main",
      "1 M. N... 100644 100644 100644 abc def src/staged.ts",
      "1 .M N... 100644 100644 100644 abc def src/unstaged.ts",
      "1 A. N... 100644 100644 100644 000 abc src/new.ts",
    );
    const s = parseStatus(raw);
    expect(s.staged.map((c) => c.path)).toEqual(["src/staged.ts", "src/new.ts"]);
    expect(s.staged.map((c) => c.status)).toEqual(["modified", "added"]);
    expect(s.unstaged.map((c) => c.path)).toEqual(["src/unstaged.ts"]);
    expect(s.unstaged[0]!.status).toBe("modified");
  });

  it("attributes untracked entries to the unstaged bucket", () => {
    const raw = records("# branch.head main", "? README.md");
    const s = parseStatus(raw);
    expect(s.unstaged).toEqual([
      { path: "README.md", status: "added", additions: 0, deletions: 0 },
    ]);
    expect(s.staged).toEqual([]);
  });

  it("handles renamed records with their embedded NUL", () => {
    // Format: "2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <newPath>" + NUL + "<oldPath>"
    const raw =
      "# branch.head main" +
      NUL +
      "2 R. N... 100644 100644 100644 abc def R100 new/path.ts" +
      NUL +
      "old/path.ts" +
      NUL;
    const s = parseStatus(raw);
    expect(s.staged).toEqual([
      { path: "new/path.ts", status: "renamed", additions: 0, deletions: 0 },
    ]);
  });

  it("flags unmerged entries as conflicted in the unstaged bucket", () => {
    const raw = records(
      "# branch.head main",
      "u UU N... 100644 100644 100644 100644 abc def ghi src/conflict.ts",
    );
    const s = parseStatus(raw);
    expect(s.unstaged).toEqual([
      { path: "src/conflict.ts", status: "conflicted", additions: 0, deletions: 0 },
    ]);
  });
});

describe("parseBranchList", () => {
  it("parses the for-each-ref output and marks the current branch", () => {
    const raw = [
      `*${NUL}feature/x${NUL}origin/feature/x${NUL}ahead 2, behind 1`,
      ` ${NUL}main${NUL}origin/main${NUL}`,
      ` ${NUL}detached${NUL}${NUL}`,
    ].join("\n");
    const parsed = parseBranchList(raw);
    expect(parsed.current).toBe("feature/x");
    expect(parsed.branches).toEqual([
      {
        name: "feature/x",
        isCurrent: true,
        upstream: "origin/feature/x",
        ahead: 2,
        behind: 1,
      },
      { name: "main", isCurrent: false, upstream: "origin/main" },
      { name: "detached", isCurrent: false },
    ]);
  });

  it("returns no current when no branch is starred", () => {
    const raw = ` ${NUL}main${NUL}${NUL}`;
    expect(parseBranchList(raw).current).toBeNull();
  });
});

describe("parseRemotes + parseRemoteBranches", () => {
  it("dedups (fetch) and (push) entries into a single Remote", () => {
    const raw = [
      "origin\tgit@github.com:foo/bar.git (fetch)",
      "origin\tgit@github.com:foo/bar.git (push)",
      "upstream\thttps://example.com/baz.git (fetch)",
    ].join("\n");
    expect(parseRemotes(raw)).toEqual([
      { name: "origin", url: "git@github.com:foo/bar.git" },
      { name: "upstream", url: "https://example.com/baz.git" },
    ]);
  });

  it("skips HEAD pointer entries and groups remote branches by remote", () => {
    const remotes = [
      { name: "origin", url: "git@example.com:repo.git" },
      { name: "upstream", url: "https://up.example.com/repo.git" },
    ];
    const raw = [
      "origin/main",
      "origin/HEAD -> origin/main",
      "upstream/dev",
      "origin/feature-x",
    ].join("\n");
    const out = parseRemoteBranches(raw, remotes);
    expect(out).toEqual([
      { type: "remote", branch: "main", remote: remotes[0] },
      { type: "remote", branch: "dev", remote: remotes[1] },
      { type: "remote", branch: "feature-x", remote: remotes[0] },
    ]);
  });
});
