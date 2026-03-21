import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, unlinkSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  getGitBranch,
  getGitFileStatuses,
  getGitStatusMap,
  getFileDiff,
  isGitRepo,
} from "./git.ts";

let tmpDir: string;

function git(...args: string[]) {
  execFileSync("git", args, { cwd: tmpDir, stdio: "ignore" });
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "tmux-ide-git-test-"));
  git("init", "-b", "main");
  git("config", "user.email", "test@test.com");
  git("config", "user.name", "Test");
  writeFileSync(join(tmpDir, "initial.txt"), "hello\n");
  git("add", ".");
  git("commit", "-m", "initial");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("getGitBranch", () => {
  it("returns the current branch name", () => {
    assert.strictEqual(getGitBranch(tmpDir), "main");
  });

  it("returns null for a non-git directory", () => {
    const nonGit = mkdtempSync(join(tmpdir(), "tmux-ide-nongit-"));
    try {
      assert.strictEqual(getGitBranch(nonGit), null);
    } finally {
      rmSync(nonGit, { recursive: true, force: true });
    }
  });
});

describe("isGitRepo", () => {
  it("returns true for a git directory", () => {
    assert.strictEqual(isGitRepo(tmpDir), true);
  });

  it("returns false for a non-git directory", () => {
    const nonGit = mkdtempSync(join(tmpdir(), "tmux-ide-nongit-"));
    try {
      assert.strictEqual(isGitRepo(nonGit), false);
    } finally {
      rmSync(nonGit, { recursive: true, force: true });
    }
  });
});

describe("getGitFileStatuses", () => {
  it("returns empty array for a clean working tree", () => {
    const statuses = getGitFileStatuses(tmpDir);
    assert.deepStrictEqual(statuses, []);
  });

  it("detects modified files with line counts", () => {
    writeFileSync(join(tmpDir, "initial.txt"), "hello\nworld\n");
    const statuses = getGitFileStatuses(tmpDir);
    const modified = statuses.find((s) => s.path === "initial.txt");
    assert.ok(modified);
    assert.strictEqual(modified.status, "M");
    assert.strictEqual(modified.additions, 1);
    assert.strictEqual(modified.deletions, 0);
  });

  it("detects untracked files", () => {
    writeFileSync(join(tmpDir, "new-file.txt"), "content\n");
    const statuses = getGitFileStatuses(tmpDir);
    const untracked = statuses.find((s) => s.path === "new-file.txt");
    assert.ok(untracked);
    assert.strictEqual(untracked.status, "?");
  });

  it("detects deleted files", () => {
    unlinkSync(join(tmpDir, "initial.txt"));
    const statuses = getGitFileStatuses(tmpDir);
    const deleted = statuses.find((s) => s.path === "initial.txt");
    assert.ok(deleted);
    assert.strictEqual(deleted.status, "D");
  });

  it("detects files in subdirectories", () => {
    mkdirSync(join(tmpDir, "subdir"));
    writeFileSync(join(tmpDir, "subdir", "nested.txt"), "nested\n");
    const statuses = getGitFileStatuses(tmpDir);
    const nested = statuses.find((s) => s.path === "subdir/nested.txt");
    assert.ok(nested);
    assert.strictEqual(nested.status, "?");
  });

  it("returns empty array for a non-git directory", () => {
    const nonGit = mkdtempSync(join(tmpdir(), "tmux-ide-nongit-"));
    try {
      assert.deepStrictEqual(getGitFileStatuses(nonGit), []);
    } finally {
      rmSync(nonGit, { recursive: true, force: true });
    }
  });
});

describe("getGitStatusMap", () => {
  it("propagates status to parent directories", () => {
    mkdirSync(join(tmpDir, "src"));
    mkdirSync(join(tmpDir, "src", "lib"));
    writeFileSync(join(tmpDir, "src", "lib", "deep.txt"), "deep\n");
    const map = getGitStatusMap(tmpDir);
    assert.strictEqual(map.get("src/lib/deep.txt"), "?");
    assert.strictEqual(map.get("src/lib"), "?");
    assert.strictEqual(map.get("src"), "?");
  });

  it("returns empty map for clean working tree", () => {
    const map = getGitStatusMap(tmpDir);
    assert.strictEqual(map.size, 0);
  });

  it("includes both modified and untracked files", () => {
    writeFileSync(join(tmpDir, "initial.txt"), "changed\n");
    writeFileSync(join(tmpDir, "new.txt"), "new\n");
    const map = getGitStatusMap(tmpDir);
    assert.strictEqual(map.get("initial.txt"), "M");
    assert.strictEqual(map.get("new.txt"), "?");
  });
});

describe("getFileDiff", () => {
  it("returns a diff for modified files", () => {
    writeFileSync(join(tmpDir, "initial.txt"), "hello\nworld\n");
    const diff = getFileDiff(tmpDir, "initial.txt", false);
    assert.ok(diff.includes("+world"));
  });

  it("returns empty string for unmodified files", () => {
    const diff = getFileDiff(tmpDir, "initial.txt", false);
    assert.strictEqual(diff, "");
  });
});
