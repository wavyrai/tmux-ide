import { describe, it, beforeEach, afterEach, expect } from "bun:test";
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
    expect(getGitBranch(tmpDir)).toBe("main");
  });

  it("returns null for a non-git directory", () => {
    const nonGit = mkdtempSync(join(tmpdir(), "tmux-ide-nongit-"));
    try {
      expect(getGitBranch(nonGit)).toBe(null);
    } finally {
      rmSync(nonGit, { recursive: true, force: true });
    }
  });
});

describe("isGitRepo", () => {
  it("returns true for a git directory", () => {
    expect(isGitRepo(tmpDir)).toBe(true);
  });

  it("returns false for a non-git directory", () => {
    const nonGit = mkdtempSync(join(tmpdir(), "tmux-ide-nongit-"));
    try {
      expect(isGitRepo(nonGit)).toBe(false);
    } finally {
      rmSync(nonGit, { recursive: true, force: true });
    }
  });
});

describe("getGitFileStatuses", () => {
  it("returns empty array for a clean working tree", () => {
    const statuses = getGitFileStatuses(tmpDir);
    expect(statuses).toEqual([]);
  });

  it("detects modified files with line counts", () => {
    writeFileSync(join(tmpDir, "initial.txt"), "hello\nworld\n");
    const statuses = getGitFileStatuses(tmpDir);
    const modified = statuses.find((s) => s.path === "initial.txt");
    expect(modified).toBeTruthy();
    expect(modified.status).toBe("M");
    expect(modified.additions).toBe(1);
    expect(modified.deletions).toBe(0);
  });

  it("detects untracked files", () => {
    writeFileSync(join(tmpDir, "new-file.txt"), "content\n");
    const statuses = getGitFileStatuses(tmpDir);
    const untracked = statuses.find((s) => s.path === "new-file.txt");
    expect(untracked).toBeTruthy();
    expect(untracked.status).toBe("?");
  });

  it("detects deleted files", () => {
    unlinkSync(join(tmpDir, "initial.txt"));
    const statuses = getGitFileStatuses(tmpDir);
    const deleted = statuses.find((s) => s.path === "initial.txt");
    expect(deleted).toBeTruthy();
    expect(deleted.status).toBe("D");
  });

  it("detects files in subdirectories", () => {
    mkdirSync(join(tmpDir, "subdir"));
    writeFileSync(join(tmpDir, "subdir", "nested.txt"), "nested\n");
    const statuses = getGitFileStatuses(tmpDir);
    const nested = statuses.find((s) => s.path === "subdir/nested.txt");
    expect(nested).toBeTruthy();
    expect(nested.status).toBe("?");
  });

  it("returns empty array for a non-git directory", () => {
    const nonGit = mkdtempSync(join(tmpdir(), "tmux-ide-nongit-"));
    try {
      expect(getGitFileStatuses(nonGit)).toEqual([]);
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
    expect(map.get("src/lib/deep.txt")).toBe("?");
    expect(map.get("src/lib")).toBe("?");
    expect(map.get("src")).toBe("?");
  });

  it("returns empty map for clean working tree", () => {
    const map = getGitStatusMap(tmpDir);
    expect(map.size).toBe(0);
  });

  it("includes both modified and untracked files", () => {
    writeFileSync(join(tmpDir, "initial.txt"), "changed\n");
    writeFileSync(join(tmpDir, "new.txt"), "new\n");
    const map = getGitStatusMap(tmpDir);
    expect(map.get("initial.txt")).toBe("M");
    expect(map.get("new.txt")).toBe("?");
  });
});

describe("getFileDiff", () => {
  it("returns a diff for modified files", () => {
    writeFileSync(join(tmpDir, "initial.txt"), "hello\nworld\n");
    const diff = getFileDiff(tmpDir, "initial.txt", false);
    expect(diff.includes("+world")).toBeTruthy();
  });

  it("returns empty string for unmodified files", () => {
    const diff = getFileDiff(tmpDir, "initial.txt", false);
    expect(diff).toBe("");
  });
});
