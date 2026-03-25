/**
 * Git worktree management for per-task workspace isolation.
 *
 * Creates, validates, lists, and removes git worktrees so each orchestrated
 * task runs in its own isolated checkout. Worktrees live under a configurable
 * root directory (default `.worktrees/`) with branches named `task/{id}-{slug}`.
 *
 * @module worktree
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

type GitExecutor = (args: string[], cwd: string) => string;

let _gitExec: GitExecutor = (args, cwd) =>
  execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });

export function _setGitExecutor(fn: GitExecutor): () => void {
  const prev = _gitExec;
  _gitExec = fn;
  return () => {
    _gitExec = prev;
  };
}

export function createWorktree(
  projectDir: string,
  worktreeRoot: string,
  taskId: string,
  taskSlug: string,
): { path: string; branch: string } {
  const branchName = `task/${taskId}-${taskSlug}`;
  const worktreePath = join(projectDir, worktreeRoot, `${taskId}-${taskSlug}`);

  if (existsSync(worktreePath)) {
    return { path: worktreePath, branch: branchName };
  }

  mkdirSync(join(projectDir, worktreeRoot), { recursive: true });

  // Create branch from current HEAD (may already exist)
  try {
    _gitExec(["branch", branchName], projectDir);
  } catch {
    // Branch already exists — fine
  }

  // Create worktree
  _gitExec(["worktree", "add", worktreePath, branchName], projectDir);

  return { path: worktreePath, branch: branchName };
}

export function removeWorktree(projectDir: string, worktreePath: string): void {
  try {
    _gitExec(["worktree", "remove", worktreePath, "--force"], projectDir);
  } catch {
    // Already removed or doesn't exist
  }
}

export function listWorktrees(projectDir: string): string[] {
  try {
    const output = _gitExec(["worktree", "list", "--porcelain"], projectDir);
    return output
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.replace("worktree ", ""));
  } catch {
    return [];
  }
}

function resolveReal(p: string): string {
  // If the path exists, resolve symlinks fully
  if (existsSync(p)) return realpathSync(p);

  // For non-existent paths, resolve the nearest existing ancestor then append the rest
  const resolved = resolve(p);
  const parts = resolved.split("/");
  for (let i = parts.length - 1; i >= 1; i--) {
    const ancestor = parts.slice(0, i).join("/") || "/";
    if (existsSync(ancestor)) {
      const realAncestor = realpathSync(ancestor);
      return realAncestor + "/" + parts.slice(i).join("/");
    }
  }
  return resolved;
}

export function validateWorktreePath(
  projectDir: string,
  worktreeRoot: string,
  worktreePath: string,
): { valid: boolean; reason?: string } {
  let realRoot: string;
  try {
    realRoot = resolveReal(resolve(projectDir, worktreeRoot));
  } catch {
    return {
      valid: false,
      reason: `Cannot resolve worktree root: ${resolve(projectDir, worktreeRoot)}`,
    };
  }

  let realPath: string;
  try {
    realPath = resolveReal(worktreePath);
  } catch {
    return { valid: false, reason: `Cannot resolve worktree path: ${worktreePath}` };
  }

  // Ensure the worktree path is within the root (with trailing separator to prevent prefix attacks)
  const rootPrefix = realRoot.endsWith("/") ? realRoot : realRoot + "/";
  if (realPath !== realRoot && !realPath.startsWith(rootPrefix)) {
    return {
      valid: false,
      reason: `Worktree path "${realPath}" escapes root "${realRoot}"`,
    };
  }

  return { valid: true };
}

/**
 * Remove worktrees that exist on disk but are not referenced by any task.
 *
 * This handles the case where a crash occurred between createWorktree() and
 * saveTask() — the worktree exists on disk but no task knows about it.
 * Each orphaned worktree is logged and removed.
 */
export function cleanupOrphanedWorktrees(
  projectDir: string,
  worktreeRoot: string,
  tasks: { branch: string | null }[],
): void {
  const rootDir = join(projectDir, worktreeRoot);
  if (!existsSync(rootDir)) return;

  // Collect all branch names referenced by tasks (e.g. "task/001-slug")
  const taskBranches = new Set<string>();
  for (const task of tasks) {
    if (task.branch) taskBranches.add(task.branch);
  }

  let entries: string[];
  try {
    entries = readdirSync(rootDir);
  } catch {
    return;
  }

  for (const entry of entries) {
    // Worktree directories follow the pattern "{id}-{slug}"
    // The corresponding branch is "task/{id}-{slug}"
    const branch = `task/${entry}`;
    if (!taskBranches.has(branch)) {
      const worktreePath = join(rootDir, entry);
      removeWorktree(projectDir, worktreePath);
    }
  }
}
