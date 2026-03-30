import { execFileSync } from "node:child_process";

export interface GitFileStatus {
  path: string;
  status: "M" | "A" | "D" | "R" | "?";
  additions: number;
  deletions: number;
}

function execGit(dir: string, args: string[]): string {
  try {
    return execFileSync(
      "git",
      ["-c", "core.fsmonitor=false", "-c", "core.quotepath=false", ...args],
      { cwd: dir, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
    );
  } catch {
    return "";
  }
}

export function getGitBranch(dir: string): string | null {
  const result = execGit(dir, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  return result || null;
}

export function getGitFileStatuses(dir: string): GitFileStatus[] {
  const results: GitFileStatus[] = [];

  // 1. Identify deleted files first so we can tag them correctly in numstat
  const deleted = execGit(dir, ["diff", "--name-only", "--diff-filter=D", "HEAD"]);
  const deletedPaths = new Set(deleted.split("\n").filter(Boolean));

  // 2. Modified/deleted files with line counts
  const numstat = execGit(dir, ["diff", "--numstat", "HEAD"]);
  for (const line of numstat.split("\n").filter(Boolean)) {
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const [added, removed, ...pathParts] = parts;
    const filepath = pathParts.join("\t");
    if (added === "-") continue; // binary file
    results.push({
      path: filepath,
      status: deletedPaths.has(filepath) ? "D" : "M",
      additions: parseInt(added!, 10) || 0,
      deletions: parseInt(removed!, 10) || 0,
    });
  }

  // 3. Deleted files not in numstat (shouldn't happen, but be safe)
  const numstatPaths = new Set(results.map((r) => r.path));
  for (const filepath of deletedPaths) {
    if (!numstatPaths.has(filepath)) {
      results.push({ path: filepath, status: "D", additions: 0, deletions: 0 });
    }
  }

  // 4. Untracked files
  const untracked = execGit(dir, ["ls-files", "--others", "--exclude-standard"]);
  for (const filepath of untracked.split("\n").filter(Boolean)) {
    results.push({ path: filepath, status: "?", additions: 0, deletions: 0 });
  }

  return results;
}

export function getGitStatusMap(dir: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const file of getGitFileStatuses(dir)) {
    map.set(file.path, file.status);
    // Propagate to parent directories
    let parent = file.path;
    while (parent.includes("/")) {
      parent = parent.substring(0, parent.lastIndexOf("/"));
      if (!map.has(parent)) map.set(parent, file.status);
    }
  }
  return map;
}

export function getFileDiff(dir: string, path: string, staged: boolean): string {
  const args = staged ? ["diff", "--cached", "--", path] : ["diff", "--", path];
  return execGit(dir, args);
}

export function isGitRepo(dir: string): boolean {
  return execGit(dir, ["rev-parse", "--is-inside-work-tree"]).trim() === "true";
}
