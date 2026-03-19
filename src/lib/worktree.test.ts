import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createWorktree, removeWorktree, listWorktrees } from "./worktree.ts";

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
