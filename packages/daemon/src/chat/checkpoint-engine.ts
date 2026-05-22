/**
 * Turn-level git checkpoint engine.
 *
 * Snapshots are stored as commit objects pointed at by refs under
 * `refs/tmux-ide/checkpoints/<threadId>/<turnId>`. Keeping them under
 * `refs/` (rather than a branch) means:
 *   - they survive `git gc` (refs anchor reachability),
 *   - they don't pollute `git branch` output, and
 *   - they're discoverable with `git for-each-ref refs/tmux-ide/checkpoints/`.
 *
 * The snapshot is created with `git stash create` — that produces a commit
 * SHA capturing the working tree + index without modifying anything. We
 * then attach a ref to that SHA so the orphan commit isn't garbage
 * collected.
 *
 * Revert applies the snapshot tree over tracked files in the workspace.
 * Untracked files are left alone (they weren't part of the snapshot's tree
 * to begin with). If any tracked file in the working tree has uncommitted
 * changes that would conflict with the revert, we refuse and ask the
 * caller to clean their tree first.
 *
 * NB: This module ONLY implements the git mechanism. Persistence of
 * CheckpointSummary records lives in checkpoint-store (T072).
 */

import { execFile, type ExecFileException } from "node:child_process";
import { promisify } from "node:util";
import type { CheckpointFile, CheckpointStatus } from "@tmux-ide/contracts";

const execFileAsync = promisify(execFile);

const REF_PREFIX = "refs/tmux-ide/checkpoints";

const NAME_STATUS_KIND_MAP: Record<string, CheckpointFile["kind"]> = {
  M: "modified",
  A: "added",
  D: "deleted",
  R: "renamed",
  C: "modified",
  T: "modified",
};

export type CheckpointEngineExec = (args: readonly string[], cwd: string) => Promise<string>;

export interface CheckpointSnapshot {
  /** Commit SHA produced by `git stash create` (or HEAD on a clean tree). */
  checkpointRef: string;
  /** Ref name we created to anchor the SHA. */
  refName: string;
  files: CheckpointFile[];
}

export interface CheckpointEngine {
  snapshot(input: {
    threadId: string;
    turnId: string;
    workspaceDir: string;
  }): Promise<CheckpointSnapshot>;
  status(input: { checkpointRef: string; workspaceDir: string }): Promise<CheckpointStatus>;
  revert(input: { checkpointRef: string; workspaceDir: string }): Promise<void>;
  listForThread(input: {
    threadId: string;
    workspaceDir: string;
  }): Promise<Array<{ turnId: string; refName: string; checkpointRef: string }>>;
}

export type CheckpointEngineErrorCode =
  | "not_a_git_repo"
  | "git_failed"
  | "ref_not_found"
  | "dirty_conflict"
  | "invalid_id";

export class CheckpointEngineError extends Error {
  readonly code: CheckpointEngineErrorCode;
  override readonly cause?: unknown;
  constructor(message: string, code: CheckpointEngineErrorCode, cause?: unknown) {
    super(message);
    this.name = "CheckpointEngineError";
    this.code = code;
    this.cause = cause;
  }
}

export interface MakeCheckpointEngineOptions {
  /** Replace the git invoker (for tests). Defaults to spawning `git`. */
  exec?: CheckpointEngineExec;
}

export function makeCheckpointEngine(opts: MakeCheckpointEngineOptions = {}): CheckpointEngine {
  const exec = opts.exec ?? defaultExec;

  function buildRefName(threadId: string, turnId: string): string {
    assertSafeRefSegment(threadId, "threadId");
    assertSafeRefSegment(turnId, "turnId");
    return `${REF_PREFIX}/${threadId}/${turnId}`;
  }

  async function ensureGitRepo(cwd: string): Promise<void> {
    try {
      await exec(["rev-parse", "--git-dir"], cwd);
    } catch (err) {
      throw new CheckpointEngineError(
        `Directory is not a git repository: ${cwd}`,
        "not_a_git_repo",
        err,
      );
    }
  }

  async function snapshot(input: {
    threadId: string;
    turnId: string;
    workspaceDir: string;
  }): Promise<CheckpointSnapshot> {
    await ensureGitRepo(input.workspaceDir);

    // `git stash create` snapshots index+worktree and returns a commit SHA
    // without modifying the working tree or the stash list. On a clean tree
    // it prints nothing — fall back to HEAD so the checkpoint still has an
    // addressable SHA pointing at the current state.
    let sha = (await exec(["stash", "create"], input.workspaceDir)).trim();
    if (!sha) {
      sha = (await exec(["rev-parse", "HEAD"], input.workspaceDir)).trim();
    }
    if (!sha) {
      throw new CheckpointEngineError(
        "Could not produce a checkpoint SHA (empty repo?)",
        "git_failed",
      );
    }

    const refName = buildRefName(input.threadId, input.turnId);
    try {
      await exec(["update-ref", refName, sha], input.workspaceDir);
    } catch (err) {
      throw new CheckpointEngineError(`git update-ref failed for ${refName}`, "git_failed", err);
    }

    const files = await collectChangedFiles(input.workspaceDir, exec);
    return { checkpointRef: sha, refName, files };
  }

  async function status(input: {
    checkpointRef: string;
    workspaceDir: string;
  }): Promise<CheckpointStatus> {
    try {
      await ensureGitRepo(input.workspaceDir);
    } catch {
      return "error";
    }
    try {
      const resolved = (
        await exec(["rev-parse", "--verify", `${input.checkpointRef}^{commit}`], input.workspaceDir)
      ).trim();
      return resolved ? "ready" : "missing";
    } catch (err) {
      // Distinguish "definitely missing" (clean stderr) from "something
      // else broke" (anything that doesn't look like a missing-rev error).
      const message = errorMessage(err);
      if (/unknown revision|not a valid|bad revision|fatal: Needed/i.test(message)) {
        return "missing";
      }
      return "error";
    }
  }

  async function revert(input: { checkpointRef: string; workspaceDir: string }): Promise<void> {
    await ensureGitRepo(input.workspaceDir);

    const refStatus = await status({
      checkpointRef: input.checkpointRef,
      workspaceDir: input.workspaceDir,
    });
    if (refStatus !== "ready") {
      throw new CheckpointEngineError(
        `Checkpoint ref not found: ${input.checkpointRef}`,
        "ref_not_found",
      );
    }

    const conflicts = await detectDirtyConflicts(input.workspaceDir, input.checkpointRef, exec);
    if (conflicts.length > 0) {
      throw new CheckpointEngineError(
        `Cannot revert — working tree has uncommitted changes that conflict with the checkpoint: ${conflicts.join(", ")}`,
        "dirty_conflict",
      );
    }

    try {
      // `git checkout <sha> -- .` rewrites tracked paths to the snapshot's
      // tree without touching untracked files or branch state.
      await exec(["checkout", input.checkpointRef, "--", "."], input.workspaceDir);
    } catch (err) {
      throw new CheckpointEngineError(
        `git checkout from ${input.checkpointRef} failed`,
        "git_failed",
        err,
      );
    }
  }

  async function listForThread(input: {
    threadId: string;
    workspaceDir: string;
  }): Promise<Array<{ turnId: string; refName: string; checkpointRef: string }>> {
    await ensureGitRepo(input.workspaceDir);
    assertSafeRefSegment(input.threadId, "threadId");
    const prefix = `${REF_PREFIX}/${input.threadId}/`;
    const output = await exec(
      ["for-each-ref", "--format=%(refname) %(objectname)", prefix],
      input.workspaceDir,
    );
    return output
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [refName = "", sha = ""] = line.split(/\s+/, 2);
        const turnId = refName.slice(prefix.length);
        return { turnId, refName, checkpointRef: sha };
      })
      .filter((row) => row.turnId.length > 0);
  }

  return { snapshot, status, revert, listForThread };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function defaultExec(args: readonly string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args as string[], {
      cwd,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
    return stdout;
  } catch (err) {
    // Surface stderr so error classification can see the real reason.
    const ex = err as ExecFileException;
    const stderr = typeof ex.stderr === "string" ? ex.stderr : "";
    const message = stderr.trim() || ex.message || "git command failed";
    const wrapped = new Error(message);
    (wrapped as Error & { cause?: unknown }).cause = err;
    throw wrapped;
  }
}

const SAFE_REF_SEGMENT = /^[A-Za-z0-9._-]+$/;

function assertSafeRefSegment(value: string, what: string): void {
  if (!SAFE_REF_SEGMENT.test(value)) {
    throw new CheckpointEngineError(
      `Invalid ${what}: must match ${SAFE_REF_SEGMENT.source}, got "${value}"`,
      "invalid_id",
    );
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

async function collectChangedFiles(
  cwd: string,
  exec: CheckpointEngineExec,
): Promise<CheckpointFile[]> {
  // `diff --numstat HEAD` gives additions/deletions; `diff --name-status
  // HEAD` gives the change kind. Pair them by path.
  const [numstatRaw, nameStatusRaw] = await Promise.all([
    exec(["diff", "--numstat", "HEAD"], cwd).catch(() => ""),
    exec(["diff", "--name-status", "HEAD"], cwd).catch(() => ""),
  ]);

  const kindByPath = new Map<string, CheckpointFile["kind"]>();
  for (const line of nameStatusRaw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [code = "", ...rest] = trimmed.split(/\s+/);
    if (rest.length === 0) continue;
    const head = code.charAt(0);
    const kind = NAME_STATUS_KIND_MAP[head] ?? "modified";
    // For renames/copies git emits "R100\tfrom\tto" — record the
    // destination path so the snapshot points at the file that exists now.
    const path = rest[rest.length - 1]!;
    kindByPath.set(path, kind);
  }

  const files: CheckpointFile[] = [];
  for (const line of numstatRaw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [addStr = "0", delStr = "0", ...pathParts] = trimmed.split(/\s+/);
    const path = pathParts.join(" ");
    if (!path) continue;
    const additions = addStr === "-" ? 0 : Math.max(0, Number.parseInt(addStr, 10) || 0);
    const deletions = delStr === "-" ? 0 : Math.max(0, Number.parseInt(delStr, 10) || 0);
    files.push({
      path,
      kind: kindByPath.get(path) ?? "modified",
      additions,
      deletions,
    });
  }
  return files;
}

async function detectDirtyConflicts(
  cwd: string,
  checkpointRef: string,
  exec: CheckpointEngineExec,
): Promise<string[]> {
  // Paths that will be touched by the revert.
  const refPaths = (await exec(["diff", "--name-only", `${checkpointRef}`], cwd).catch(() => ""))
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  if (refPaths.length === 0) return [];

  // Currently-uncommitted tracked paths.
  const dirtyPaths = new Set(
    (await exec(["diff", "--name-only", "HEAD"], cwd).catch(() => ""))
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  return refPaths.filter((p) => dirtyPaths.has(p));
}
