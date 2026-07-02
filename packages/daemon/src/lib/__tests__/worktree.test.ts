/**
 * Unit tests for the pure worktree helpers: session-name sanitization, path
 * derivation (+ the app-config override), porcelain parsing, and git-stderr
 * error mapping. The io wrappers shell out to git and are exercised by the
 * live worktree gate, not here.
 */
import { describe, expect, it } from "vitest";
import {
  defaultWorktreeBaseDir,
  mapWorktreeError,
  parseWorktreeList,
  WorktreeError,
  worktreePath,
  worktreeSessionName,
} from "../worktree.ts";

describe("worktreeSessionName", () => {
  it("joins project and branch with @", () => {
    expect(worktreeSessionName("myapp", "fix-auth")).toBe("myapp@fix-auth");
  });

  it("sanitizes tmux-hostile chars (dots, colons, whitespace) to -", () => {
    // tmux rewrites `.` → `_` and treats `:` as a target separator, so we
    // normalize both up front to keep the name stable and inert.
    expect(worktreeSessionName("my.app", "feat:v2")).toBe("my-app@feat-v2");
    // slashed branches sanitize too — a `/` breaks tmux targets and bar ranges
    expect(worktreeSessionName("myapp", "feat/y-1")).toBe("myapp@feat-y-1");
    expect(worktreeSessionName("app", "hot fix")).toBe("app@hot-fix");
  });
});

describe("defaultWorktreeBaseDir", () => {
  it("is a sibling `<repo-name>-worktrees` dir, never inside the repo", () => {
    expect(defaultWorktreeBaseDir("/home/me/myapp")).toBe("/home/me/myapp-worktrees");
    expect(defaultWorktreeBaseDir("/home/me/myapp/")).toBe("/home/me/myapp-worktrees");
  });
});

describe("worktreePath", () => {
  it("defaults to the sibling base with the branch as the final segment", () => {
    expect(worktreePath("/home/me/myapp", "fix-auth")).toBe("/home/me/myapp-worktrees/fix-auth");
  });

  it("nests a slashed branch under the base (git creates the dir)", () => {
    expect(worktreePath("/home/me/myapp", "feat/y-1")).toBe("/home/me/myapp-worktrees/feat/y-1");
  });

  it("uses an absolute config override verbatim as the base", () => {
    expect(worktreePath("/home/me/myapp", "fix", "/scratch/checkouts")).toBe(
      "/scratch/checkouts/fix",
    );
  });

  it("resolves a relative config override against the repo", () => {
    expect(worktreePath("/home/me/myapp", "fix", "../checkouts")).toBe("/home/me/checkouts/fix");
  });

  it("falls back to the default base for an empty/nullish override", () => {
    expect(worktreePath("/home/me/myapp", "fix", "")).toBe("/home/me/myapp-worktrees/fix");
    expect(worktreePath("/home/me/myapp", "fix", null)).toBe("/home/me/myapp-worktrees/fix");
  });
});

describe("parseWorktreeList", () => {
  it("parses a main + linked + detached mix, stripping refs/heads/", () => {
    const porcelain = [
      "worktree /home/me/myapp",
      "HEAD abc123",
      "branch refs/heads/main",
      "",
      "worktree /home/me/myapp-worktrees/fix-auth",
      "HEAD def456",
      "branch refs/heads/fix-auth",
      "",
      "worktree /home/me/myapp-worktrees/spike",
      "HEAD 789abc",
      "detached",
      "",
    ].join("\n");
    const entries = parseWorktreeList(porcelain);
    expect(entries).toHaveLength(3);
    expect(entries[0]).toEqual({
      path: "/home/me/myapp",
      head: "abc123",
      branch: "main",
      bare: false,
      detached: false,
    });
    expect(entries[1]!.branch).toBe("fix-auth");
    expect(entries[2]).toEqual({
      path: "/home/me/myapp-worktrees/spike",
      head: "789abc",
      branch: null,
      bare: false,
      detached: true,
    });
  });

  it("marks a bare repo entry", () => {
    const entries = parseWorktreeList(["worktree /repo.git", "bare", ""].join("\n"));
    expect(entries).toHaveLength(1);
    expect(entries[0]!.bare).toBe(true);
    expect(entries[0]!.branch).toBeNull();
  });

  it("handles a trailing record with no final blank line and CRLF", () => {
    const entries = parseWorktreeList("worktree /a\r\nHEAD zzz\r\nbranch refs/heads/dev\r\n");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      path: "/a",
      head: "zzz",
      branch: "dev",
      bare: false,
      detached: false,
    });
  });

  it("returns [] for empty input", () => {
    expect(parseWorktreeList("")).toEqual([]);
    expect(parseWorktreeList("\n\n")).toEqual([]);
  });
});

describe("mapWorktreeError", () => {
  it("maps 'not a git repository'", () => {
    const err = mapWorktreeError("fatal: not a git repository (or any parent)", "fallback");
    expect(err).toBeInstanceOf(WorktreeError);
    expect(err.code).toBe("NOT_A_GIT_REPO");
  });

  it("maps an existing branch", () => {
    const err = mapWorktreeError("fatal: a branch named 'x' already exists", "fallback");
    expect(err.code).toBe("BRANCH_EXISTS");
  });

  it("maps a branch already checked out in another worktree", () => {
    const err = mapWorktreeError("fatal: 'main' is already checked out at '/repo'", "fallback");
    expect(err.code).toBe("ALREADY_CHECKED_OUT");
  });

  it("maps a dirty worktree on remove and points at --force", () => {
    const err = mapWorktreeError(
      "fatal: '/wt' contains modified or untracked files, use --force to delete it",
      "fallback",
    );
    expect(err.code).toBe("WORKTREE_DIRTY");
    expect(err.message).toContain("--force");
  });

  it("maps a missing working tree on remove", () => {
    const err = mapWorktreeError("fatal: '/nope' is not a working tree", "fallback");
    expect(err.code).toBe("WORKTREE_NOT_FOUND");
  });

  it("falls back to GIT_FAILED with the trimmed stderr", () => {
    const err = mapWorktreeError("  some other git failure\n", "fallback");
    expect(err.code).toBe("GIT_FAILED");
    expect(err.message).toBe("some other git failure");
  });

  it("uses the fallback message when stderr is empty", () => {
    const err = mapWorktreeError("   ", "the fallback");
    expect(err.code).toBe("GIT_FAILED");
    expect(err.message).toBe("the fallback");
  });
});
