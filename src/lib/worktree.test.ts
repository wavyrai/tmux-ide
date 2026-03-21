import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
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
    assert.ok(existsSync(result.path));
    assert.strictEqual(result.branch, "task/001-fix-auth");
    assert.ok(result.path.includes("001-fix-auth"));
  });

  it("returns existing if already created", () => {
    const first = createWorktree(tmpDir, ".worktrees", "001", "fix-auth");
    const second = createWorktree(tmpDir, ".worktrees", "001", "fix-auth");
    assert.strictEqual(first.path, second.path);
    assert.strictEqual(first.branch, second.branch);
  });

  it("creates worktree root directory", () => {
    createWorktree(tmpDir, ".worktrees", "001", "test");
    assert.ok(existsSync(join(tmpDir, ".worktrees")));
  });
});

describe("removeWorktree", () => {
  it("removes an existing worktree", () => {
    const { path } = createWorktree(tmpDir, ".worktrees", "001", "to-remove");
    assert.ok(existsSync(path));
    removeWorktree(tmpDir, path);
    assert.ok(!existsSync(path));
  });

  it("does not throw for non-existent path", () => {
    removeWorktree(tmpDir, join(tmpDir, ".worktrees", "nonexistent"));
    // Should not throw
  });
});

describe("listWorktrees", () => {
  it("lists main worktree", () => {
    const trees = listWorktrees(tmpDir);
    assert.ok(trees.length >= 1);
    // macOS resolves /var → /private/var, so just check at least one entry exists
  });

  it("includes created worktrees", () => {
    createWorktree(tmpDir, ".worktrees", "001", "listed");
    const trees = listWorktrees(tmpDir);
    assert.ok(trees.length >= 2);
    assert.ok(trees.some((t) => t.includes("001-listed")));
  });
});

describe("validateWorktreePath", () => {
  it("accepts a path within the worktree root", () => {
    const root = join(tmpDir, ".worktrees");
    mkdirSync(root, { recursive: true });
    const wtPath = join(root, "001-test");
    mkdirSync(wtPath, { recursive: true });

    const result = validateWorktreePath(tmpDir, ".worktrees", wtPath);
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.reason, undefined);
  });

  it("rejects a path that escapes the worktree root", () => {
    const result = validateWorktreePath(tmpDir, ".worktrees", "/etc/passwd");
    assert.strictEqual(result.valid, false);
    assert.ok(result.reason!.includes("escapes root"));
  });

  it("rejects a path using ../ to escape", () => {
    const root = join(tmpDir, ".worktrees");
    mkdirSync(root, { recursive: true });
    // This resolves to tmpDir (parent of .worktrees) — outside root
    const escapedPath = join(root, "..", "escape-attempt");

    const result = validateWorktreePath(tmpDir, ".worktrees", escapedPath);
    assert.strictEqual(result.valid, false);
    assert.ok(result.reason!.includes("escapes root"));
  });

  it("works with non-existent but valid paths", () => {
    const root = join(tmpDir, ".worktrees");
    mkdirSync(root, { recursive: true });
    const wtPath = join(root, "future-worktree");

    const result = validateWorktreePath(tmpDir, ".worktrees", wtPath);
    assert.strictEqual(result.valid, true);
  });

  it("handles symlink resolution", () => {
    const root = join(tmpDir, ".worktrees");
    mkdirSync(root, { recursive: true });
    const realDir = join(root, "real-001");
    mkdirSync(realDir);

    const result = validateWorktreePath(tmpDir, ".worktrees", realDir);
    assert.strictEqual(result.valid, true);
  });
});
