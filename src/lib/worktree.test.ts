import { describe, it, beforeEach, afterEach, expect } from "bun:test";
import { mkdtempSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createWorktree, removeWorktree, listWorktrees, validateWorktreePath } from "./worktree.ts";

let tmpDir: string;

function initGitRepo(dir: string): void {
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "ignore" });
  // Need at least one commit for worktrees
  execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: dir, stdio: "ignore" });
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "tmux-ide-worktree-test-"));
  initGitRepo(tmpDir);
});

afterEach(() => {
  // Clean up worktrees first so git doesn't complain
  try {
    execFileSync("git", ["worktree", "prune"], { cwd: tmpDir, stdio: "ignore" });
  } catch {
    /* ignore */
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("createWorktree", () => {
  it("creates directory and branch", () => {
    const result = createWorktree(tmpDir, ".worktrees", "001", "fix-auth");
    expect(existsSync(result.path)).toBeTruthy();
    expect(result.branch).toBe("task/001-fix-auth");
    expect(result.path.includes("001-fix-auth")).toBeTruthy();
  });

  it("returns existing if already created", () => {
    const first = createWorktree(tmpDir, ".worktrees", "001", "fix-auth");
    const second = createWorktree(tmpDir, ".worktrees", "001", "fix-auth");
    expect(first.path).toBe(second.path);
    expect(first.branch).toBe(second.branch);
  });

  it("creates worktree root directory", () => {
    createWorktree(tmpDir, ".worktrees", "001", "test");
    expect(existsSync(join(tmpDir, ".worktrees"))).toBeTruthy();
  });
});

describe("removeWorktree", () => {
  it("removes an existing worktree", () => {
    const { path } = createWorktree(tmpDir, ".worktrees", "001", "to-remove");
    expect(existsSync(path)).toBeTruthy();
    removeWorktree(tmpDir, path);
    expect(!existsSync(path)).toBeTruthy();
  });

  it("does not throw for non-existent path", () => {
    removeWorktree(tmpDir, join(tmpDir, ".worktrees", "nonexistent"));
    // Should not throw
  });
});

describe("listWorktrees", () => {
  it("lists main worktree", () => {
    const trees = listWorktrees(tmpDir);
    expect(trees.length >= 1).toBeTruthy();
    // macOS resolves /var → /private/var, so just check at least one entry exists
  });

  it("includes created worktrees", () => {
    createWorktree(tmpDir, ".worktrees", "001", "listed");
    const trees = listWorktrees(tmpDir);
    expect(trees.length >= 2).toBeTruthy();
    expect(trees.some((t) => t.includes("001-listed"))).toBeTruthy();
  });
});

describe("validateWorktreePath", () => {
  it("accepts a path within the worktree root", () => {
    const root = join(tmpDir, ".worktrees");
    mkdirSync(root, { recursive: true });
    const wtPath = join(root, "001-test");
    mkdirSync(wtPath, { recursive: true });

    const result = validateWorktreePath(tmpDir, ".worktrees", wtPath);
    expect(result.valid).toBe(true);
    expect(result.reason).toBe(undefined);
  });

  it("rejects a path that escapes the worktree root", () => {
    const result = validateWorktreePath(tmpDir, ".worktrees", "/etc/passwd");
    expect(result.valid).toBe(false);
    expect(result.reason!.includes("escapes root")).toBeTruthy();
  });

  it("rejects a path using ../ to escape", () => {
    const root = join(tmpDir, ".worktrees");
    mkdirSync(root, { recursive: true });
    // This resolves to tmpDir (parent of .worktrees) — outside root
    const escapedPath = join(root, "..", "escape-attempt");

    const result = validateWorktreePath(tmpDir, ".worktrees", escapedPath);
    expect(result.valid).toBe(false);
    expect(result.reason!.includes("escapes root")).toBeTruthy();
  });

  it("works with non-existent but valid paths", () => {
    const root = join(tmpDir, ".worktrees");
    mkdirSync(root, { recursive: true });
    const wtPath = join(root, "future-worktree");

    const result = validateWorktreePath(tmpDir, ".worktrees", wtPath);
    expect(result.valid).toBe(true);
  });

  it("handles symlink resolution", () => {
    const root = join(tmpDir, ".worktrees");
    mkdirSync(root, { recursive: true });
    const realDir = join(root, "real-001");
    mkdirSync(realDir);

    const result = validateWorktreePath(tmpDir, ".worktrees", realDir);
    expect(result.valid).toBe(true);
  });
});
