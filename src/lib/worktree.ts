import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
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
    return { valid: false, reason: `Cannot resolve worktree root: ${resolve(projectDir, worktreeRoot)}` };
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
