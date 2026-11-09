/**
 * Git worktree flow — one checkout per branch so parallel agents (or a fleet)
 * each work on isolation. `tmux-ide worktree create <branch>` adds a git
 * worktree in a SIBLING directory (never inside the repo) and opens a tmux
 * session there; the CLI (`bin/cli.ts`, `worktree` case) wires the io.
 *
 * The pure helpers — {@link worktreeSessionName}, {@link worktreePath},
 * {@link parseWorktreeList}, {@link mapWorktreeError} — carry no io so they're
 * cheaply testable. The io wrappers ({@link createWorktree},
 * {@link removeWorktree}, {@link listWorktrees}) shell out to `git` and map its
 * stderr into a typed {@link WorktreeError} with an actionable message.
 */
import { execFileSync } from "node:child_process";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { IdeError } from "./errors.ts";

// ---------------------------------------------------------------------------
// Typed error
// ---------------------------------------------------------------------------

export type WorktreeErrorCode =
  | "NOT_A_GIT_REPO"
  | "BRANCH_EXISTS"
  | "BRANCH_NOT_FOUND"
  | "ALREADY_CHECKED_OUT"
  | "WORKTREE_EXISTS"
  | "WORKTREE_DIRTY"
  | "WORKTREE_NOT_FOUND"
  | "GIT_FAILED";

export class WorktreeError extends IdeError {
  constructor(message: string, code: WorktreeErrorCode) {
    super(message, { code, exitCode: 1 });
    this.name = "WorktreeError";
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * PURE — sanitize a component for a tmux session name. tmux treats `:` as a
 * target separator and silently rewrites `.` to `_`, so we normalize both (plus
 * whitespace) to `-` up front, keeping the name stable and predictable. `/` is
 * left intact — tmux accepts it in session names (verified live on tmux 3.6).
 */
function sanitizeForTmux(part: string): string {
  // Slashes too: `feat/x` would parse as a path-ish target in tmux commands
  // and can't appear in the status bar's `#[range=user|sw<name>]` mouse ranges.
  return part.replace(/[.:/\s]+/g, "-");
}

/**
 * PURE — the tmux session name for a project's worktree on `branch`, e.g.
 * `myapp@fix-auth`. Both sides are sanitized ({@link sanitizeForTmux}) so a
 * dotted/colon'd branch (or project) stays a single inert session name; the
 * `@` separator is preserved so the session reads as "project, this branch".
 */
export function worktreeSessionName(project: string, branch: string): string {
  return `${sanitizeForTmux(project)}@${sanitizeForTmux(branch)}`;
}

/**
 * PURE — the default base directory for a repo's worktrees: a SIBLING of the
 * repo named `<repo-name>-worktrees`. Kept outside the repo so a worktree is
 * never nested inside its own parent checkout (which git rejects and which
 * would pollute the project tree).
 */
export function defaultWorktreeBaseDir(repoDir: string): string {
  const abs = resolve(repoDir);
  return join(dirname(abs), `${basename(abs)}-worktrees`);
}

/**
 * PURE — the on-disk path for a worktree of `branch`. Defaults to
 * `<repo>/../<repo-name>-worktrees/<branch>`; a non-empty `configuredDir` (the
 * app-config `worktrees.dir` override) replaces the base, resolved relative to
 * the repo when it isn't absolute. The branch is the final path segment (a
 * slashed branch nests, which `git worktree add` creates).
 */
export function worktreePath(
  repoDir: string,
  branch: string,
  configuredDir?: string | null,
): string {
  const base =
    configuredDir && configuredDir.length > 0
      ? isAbsolute(configuredDir)
        ? configuredDir
        : resolve(repoDir, configuredDir)
      : defaultWorktreeBaseDir(repoDir);
  return join(base, branch);
}

/** A single record from `git worktree list --porcelain`. */
export interface WorktreeEntry {
  /** Absolute path of the worktree. */
  path: string;
  /** The checked-out commit sha, or null (bare repo). */
  head: string | null;
  /** Short branch name (no `refs/heads/`), or null when detached/bare. */
  branch: string | null;
  /** The bare repository entry. */
  bare: boolean;
  /** A detached-HEAD worktree (no branch). */
  detached: boolean;
}

/**
 * PURE — parse `git worktree list --porcelain`. Records are separated by blank
 * lines; each has a `worktree <path>` line, then optional `HEAD <sha>`,
 * `branch refs/heads/<name>`, `bare`, `detached` attribute lines. Unknown
 * attribute lines are ignored. Malformed/empty input yields `[]`.
 */
export function parseWorktreeList(porcelain: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | null = null;

  const flush = () => {
    if (current) entries.push(current);
    current = null;
  };

  for (const rawLine of porcelain.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.length === 0) {
      flush();
      continue;
    }
    if (line.startsWith("worktree ")) {
      flush();
      current = {
        path: line.slice("worktree ".length),
        head: null,
        branch: null,
        bare: false,
        detached: false,
      };
      continue;
    }
    if (!current) continue;
    if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (line === "bare") {
      current.bare = true;
    } else if (line === "detached") {
      current.detached = true;
    }
  }
  flush();
  return entries;
}

/**
 * PURE — map a failed `git` invocation's stderr to a typed
 * {@link WorktreeError}. Recognizes the common worktree failures so the CLI can
 * surface an actionable message instead of a raw git dump; anything unmatched
 * falls back to `GIT_FAILED` carrying the trimmed stderr.
 */
export function mapWorktreeError(stderr: string, fallbackMessage: string): WorktreeError {
  const text = stderr.trim();
  const lower = text.toLowerCase();

  if (lower.includes("not a git repository")) {
    return new WorktreeError(
      "Not a git repository. Run `tmux-ide worktree` from inside a git repo.",
      "NOT_A_GIT_REPO",
    );
  }
  if (lower.includes("already exists") && lower.includes("branch")) {
    return new WorktreeError(
      `${text}\nUse \`tmux-ide worktree create <branch>\` without --from to check out the existing branch, or pick a new name.`,
      "BRANCH_EXISTS",
    );
  }
  if (lower.includes("is already checked out") || lower.includes("already used by worktree")) {
    return new WorktreeError(text, "ALREADY_CHECKED_OUT");
  }
  if (lower.includes("already exists")) {
    return new WorktreeError(text, "WORKTREE_EXISTS");
  }
  if (
    (lower.includes("invalid reference") || lower.includes("not a valid ref")) &&
    !lower.includes("already")
  ) {
    return new WorktreeError(text, "BRANCH_NOT_FOUND");
  }
  if (
    lower.includes("contains modified or untracked files") ||
    lower.includes("use --force") ||
    lower.includes("use 'remove -f'")
  ) {
    return new WorktreeError(
      `${text}\nRe-run with --force to discard those changes.`,
      "WORKTREE_DIRTY",
    );
  }
  if (lower.includes("is not a working tree") || lower.includes("not a working tree")) {
    return new WorktreeError(text, "WORKTREE_NOT_FOUND");
  }
  return new WorktreeError(text.length > 0 ? text : fallbackMessage, "GIT_FAILED");
}

// ---------------------------------------------------------------------------
// io — git shell-outs (map stderr → WorktreeError)
// ---------------------------------------------------------------------------

/**
 * `env` with git hooks off for every git command run with it: core.hooksPath
 * points at /dev/null, through GIT_CONFIG_* (which outrank the repository's
 * own config, a relative hooksPath that a branch carries included).
 */
export function gitHooksOff(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const count = Number.parseInt(env.GIT_CONFIG_COUNT ?? "0", 10);
  const index = Number.isInteger(count) && count >= 0 ? count : 0;
  return {
    ...env,
    GIT_CONFIG_COUNT: String(index + 1),
    [`GIT_CONFIG_KEY_${index}`]: "core.hooksPath",
    [`GIT_CONFIG_VALUE_${index}`]: "/dev/null",
  };
}

/** Injectable git runner so io wrappers stay unit-testable. */
export type GitRunner = (repoDir: string, args: string[]) => string;

let gitRunner: GitRunner = (repoDir, args) =>
  execFileSync("git", args, {
    cwd: repoDir,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });

/** Swap the git runner (tests). Returns a restore fn. */
export function _setGitRunnerForTests(fn: GitRunner): () => void {
  const prev = gitRunner;
  gitRunner = fn;
  return () => {
    gitRunner = prev;
  };
}

interface GitExecError {
  stderr?: Buffer | string;
}

function runGit(repoDir: string, args: string[], fallbackMessage: string): string {
  try {
    return gitRunner(repoDir, args);
  } catch (error) {
    const stderr = (error as GitExecError).stderr;
    const text = stderr ? stderr.toString() : "";
    throw mapWorktreeError(text, fallbackMessage);
  }
}

export interface CreateWorktreeOptions {
  /** Create a NEW branch (git worktree add -b). Off → check out an existing branch. */
  newBranch?: boolean;
  /** Base ref for the new branch (default: current HEAD). Only used with newBranch. */
  from?: string | null;
}

/**
 * Add a git worktree for `branch` at `worktreeAbsPath` and return that path.
 * With `newBranch`, creates the branch (optionally off `from`); otherwise
 * checks out an existing branch. Failures throw a typed {@link WorktreeError}.
 */
export function createWorktree(
  repoDir: string,
  branch: string,
  worktreeAbsPath: string,
  options: CreateWorktreeOptions = {},
): string {
  const args = ["worktree", "add"];
  if (options.newBranch) {
    args.push("-b", branch, worktreeAbsPath);
    if (options.from && options.from.length > 0) args.push(options.from);
  } else {
    args.push(worktreeAbsPath, branch);
  }
  runGit(repoDir, args, `Failed to create worktree for ${branch}`);
  return worktreeAbsPath;
}

/** Remove a git worktree by path. `force` discards uncommitted changes. */
export function removeWorktree(
  repoDir: string,
  worktreeAbsPath: string,
  options: { force?: boolean } = {},
): void {
  const args = ["worktree", "remove"];
  if (options.force) args.push("--force");
  args.push(worktreeAbsPath);
  runGit(repoDir, args, `Failed to remove worktree ${worktreeAbsPath}`);
}

/** List the repo's worktrees. Throws a typed {@link WorktreeError} on failure. */
export function listWorktrees(repoDir: string): WorktreeEntry[] {
  const out = runGit(repoDir, ["worktree", "list", "--porcelain"], "Failed to list worktrees");
  return parseWorktreeList(out);
}
