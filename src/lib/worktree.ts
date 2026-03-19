import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

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
