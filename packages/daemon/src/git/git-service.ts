/**
 * Git core service — Effect-backed shell-out to the `git` CLI.
 *
 * G18-P1 surface: status, branches, checkout, commit, push. Larger
 * surface (cat-file, fetch-service, watcher, diff modes) waits for
 * G18-P2 per docs/goal-18-git-ops.md §G18-P1.
 *
 * Each public function returns `Effect.Effect<T, AnyGitError>` so the
 * REST layer can `pipe(Effect.matchTag(...))` to render
 * intent-specific UI copy.
 */

import { execFile } from "node:child_process";
import { Effect } from "effect";
import type { BranchesPayload, FullGitStatus, LocalBranch } from "@tmux-ide/contracts";
import {
  parseBranchList,
  parseRemoteBranches,
  parseRemotes,
  parseStatus,
} from "./status-parser.ts";
import { AuthFailed, GitError, NotGitRepo, classifyExitError, type AnyGitError } from "./errors.ts";

const GIT_MAX_BUFFER = 32 * 1024 * 1024;

interface RunOk {
  stdout: string;
  stderr: string;
}

interface ExecFailure {
  code: number;
  stdout: string;
  stderr: string;
}

/** Thin promise wrapper around `execFile` that resolves to stdout/stderr
 *  on success and rejects with `{code, stdout, stderr}` on exit≠0. */
function runRaw(cwd: string, args: ReadonlyArray<string>): Promise<RunOk> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd,
        encoding: "utf-8",
        maxBuffer: GIT_MAX_BUFFER,
      },
      (err, stdout, stderr) => {
        const out = String(stdout ?? "");
        const errOut = String(stderr ?? "");
        if (err) {
          const exit = (err as NodeJS.ErrnoException & { code?: number }).code ?? 1;
          const failure: ExecFailure = {
            code: typeof exit === "number" ? exit : 1,
            stdout: out,
            stderr: errOut,
          };
          reject(failure);
          return;
        }
        resolve({ stdout: out, stderr: errOut });
      },
    );
  });
}

/** Effect-wrapped runner. Classifies stderr to a tagged error. */
function run(cwd: string, args: ReadonlyArray<string>): Effect.Effect<RunOk, AnyGitError> {
  return Effect.tryPromise({
    try: () => runRaw(cwd, args),
    catch: (cause) => {
      if (cause && typeof cause === "object" && "stderr" in cause) {
        const fail = cause as ExecFailure;
        return classifyExitError(fail.stderr || fail.stdout);
      }
      const msg = cause instanceof Error ? cause.message : String(cause);
      return new GitError({ message: msg });
    },
  });
}

// ---------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------

/** Fast inside-work-tree check. Maps "not a git repo" to `NotGitRepo`. */
export function ensureRepo(cwd: string): Effect.Effect<void, AnyGitError> {
  return Effect.matchEffect(run(cwd, ["rev-parse", "--is-inside-work-tree"]), {
    onSuccess: () => Effect.void,
    onFailure: () => Effect.fail(new NotGitRepo({})),
  });
}

export function status(cwd: string): Effect.Effect<FullGitStatus, AnyGitError> {
  return Effect.gen(function* () {
    yield* ensureRepo(cwd);
    const { stdout } = yield* run(cwd, ["status", "--porcelain=v2", "--branch", "-z"]);
    return parseStatus(stdout);
  });
}

export function branches(cwd: string): Effect.Effect<BranchesPayload, AnyGitError> {
  return Effect.gen(function* () {
    yield* ensureRepo(cwd);
    const [local, remotesRaw, remoteRaw] = yield* Effect.all(
      [
        run(cwd, [
          "branch",
          "--list",
          "--format=%(HEAD)%00%(refname:short)%00%(upstream:short)%00%(upstream:track,nobracket)",
        ]),
        run(cwd, ["remote", "-v"]),
        run(cwd, ["branch", "-r", "--format=%(refname:short)"]),
      ],
      { concurrency: "unbounded" },
    );

    const parsedLocal = parseBranchList(local.stdout);
    const parsedRemotes = parseRemotes(remotesRaw.stdout);
    const parsedRemote = parseRemoteBranches(remoteRaw.stdout, parsedRemotes);

    const localBranches: LocalBranch[] = parsedLocal.branches.map((b) => {
      const out: LocalBranch = { type: "local", branch: b.name };
      if (b.upstream !== undefined) out.upstream = b.upstream;
      if (b.ahead !== undefined) out.ahead = b.ahead;
      if (b.behind !== undefined) out.behind = b.behind;
      return out;
    });

    return {
      local: localBranches,
      remote: parsedRemote,
      remotes: parsedRemotes,
      currentBranch: parsedLocal.current,
      isUnborn: parsedLocal.current === null && localBranches.length === 0,
    };
  });
}

export interface CheckoutOptions {
  branch: string;
  create?: boolean;
}

export function checkout(
  cwd: string,
  opts: CheckoutOptions,
): Effect.Effect<{ currentBranch: string }, AnyGitError> {
  return Effect.gen(function* () {
    yield* ensureRepo(cwd);
    const args = opts.create ? ["checkout", "-b", opts.branch] : ["checkout", opts.branch];
    yield* run(cwd, args);
    // Resolve the post-checkout HEAD name authoritatively rather than
    // trusting the requested name (handles short-ref disambiguation).
    const { stdout } = yield* run(cwd, ["symbolic-ref", "--short", "HEAD"]);
    return { currentBranch: stdout.trim() };
  });
}

export interface CommitOptions {
  message: string;
  all?: boolean;
}

export function commit(
  cwd: string,
  opts: CommitOptions,
): Effect.Effect<{ sha: string }, AnyGitError> {
  return Effect.gen(function* () {
    yield* ensureRepo(cwd);
    const args = opts.all ? ["commit", "-a", "-m", opts.message] : ["commit", "-m", opts.message];
    yield* run(cwd, args);
    const { stdout } = yield* run(cwd, ["rev-parse", "HEAD"]);
    return { sha: stdout.trim() };
  });
}

/** Reject absolute paths and `..` traversal — repo-relative only. */
function assertSafePaths(paths: ReadonlyArray<string>): Effect.Effect<void, AnyGitError> {
  for (const p of paths) {
    if (!p || p.startsWith("/") || p.startsWith("\\") || p.split("/").includes("..")) {
      return Effect.fail(new GitError({ message: `unsafe path: ${p}` }));
    }
  }
  return Effect.void;
}

export function stage(cwd: string, paths: ReadonlyArray<string>): Effect.Effect<void, AnyGitError> {
  return Effect.gen(function* () {
    yield* assertSafePaths(paths);
    yield* ensureRepo(cwd);
    yield* run(cwd, ["add", "--", ...paths]);
  });
}

export function unstage(
  cwd: string,
  paths: ReadonlyArray<string>,
): Effect.Effect<void, AnyGitError> {
  return Effect.gen(function* () {
    yield* assertSafePaths(paths);
    yield* ensureRepo(cwd);
    // `restore --staged` is the modern path; `reset HEAD --` works on
    // older git but is noisier. Both are idempotent.
    yield* run(cwd, ["restore", "--staged", "--", ...paths]);
  });
}

export interface PushOptions {
  remote?: string;
  branch?: string;
  setUpstream?: boolean;
}

export function push(
  cwd: string,
  opts: PushOptions = {},
): Effect.Effect<{ remote: string; branch: string }, AnyGitError> {
  return Effect.gen(function* () {
    yield* ensureRepo(cwd);
    // If the caller named a remote+branch, push exactly that. Otherwise
    // push the current branch to its upstream. The daemon never invents
    // a remote — that's a UI decision.
    const headRes = yield* run(cwd, ["symbolic-ref", "--short", "HEAD"]);
    const currentBranch = headRes.stdout.trim();
    const remote = opts.remote ?? "origin";
    const branch = opts.branch ?? currentBranch;
    const args = ["push"];
    if (opts.setUpstream) args.push("-u");
    args.push(remote, branch);
    yield* Effect.catchTag(
      run(cwd, args),
      "AuthFailed",
      // Bubble auth as-is — UI maps to a sign-in CTA.
      (e) => Effect.fail(new AuthFailed({ message: e.message })),
    );
    return { remote, branch };
  });
}

// ---------------------------------------------------------------------
// History / range diff (commit-browsing surface)
// ---------------------------------------------------------------------

/** The well-known empty-tree object. Used as the "before" side when a
 *  commit has no parent (the repo's root commit), so the dashboard's
 *  Monaco diff still renders (every line shows as an addition). */
export const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export interface CommitEntry {
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  authorEmail: string;
  /** Committer date, ISO-8601 (`%cI`). */
  date: string;
  parents: string[];
  /** True when `base` was supplied and this commit is in `base..HEAD`. */
  ahead: boolean;
}

export interface CommitsPayload {
  commits: CommitEntry[];
  /** Echo of the requested base ref, or null when none/unresolvable. */
  base: string | null;
  /** Resolved base commit SHA (merge-base with HEAD), or null. */
  baseSha: string | null;
  headSha: string;
  /** Count of commits in `base..HEAD` (0 when no base). */
  aheadCount: number;
}

export interface DiffFileStat {
  file: string;
  additions: number;
  deletions: number;
}

export interface CommitDiffPayload {
  sha: string;
  shortSha: string;
  /** First-parent SHA, or null for the root commit. */
  parent: string | null;
  subject: string;
  author: string;
  date: string;
  diff: string;
  files: DiffFileStat[];
}

export interface RangeDiffPayload {
  base: string | null;
  baseSha: string | null;
  headSha: string;
  diff: string;
  files: DiffFileStat[];
  aheadCount: number;
}

const LOG_FIELD_SEP = "\x1f";
const LOG_RECORD_SEP = "\x1e";

function parseNumstat(out: string): DiffFileStat[] {
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const [added, removed, ...rest] = line.split("\t");
      const file = rest.join("\t");
      return {
        file,
        // Binary files report "-" for both columns — coerce to 0.
        additions: Number.parseInt(added ?? "", 10) || 0,
        deletions: Number.parseInt(removed ?? "", 10) || 0,
      };
    })
    .filter((f) => f.file.length > 0);
}

/** Resolve `ref` to a full SHA. Fails as `GitError` when unknown. */
function revParse(cwd: string, ref: string): Effect.Effect<string, AnyGitError> {
  return run(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).pipe(
    Effect.map((r) => r.stdout.trim()),
  );
}

/**
 * Commit list for HEAD. When `base` is given, also reports the
 * `base..HEAD` ahead range (per-commit `ahead` flag + `aheadCount`)
 * so the UI can mark which commits a PR would contain.
 */
export function commits(
  cwd: string,
  opts: { base?: string; limit?: number } = {},
): Effect.Effect<CommitsPayload, AnyGitError> {
  return Effect.gen(function* () {
    yield* ensureRepo(cwd);
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000);

    const headSha = (yield* run(cwd, ["rev-parse", "HEAD"])).stdout.trim();

    let base: string | null = opts.base?.trim() || null;
    let baseSha: string | null = null;
    let aheadShas = new Set<string>();
    let aheadCount = 0;

    if (base) {
      // A base the local repo doesn't know about isn't an error — the
      // UI just won't get an ahead range. Resolve via merge-base so
      // the comparison matches what a PR would show.
      const baseResolved = yield* Effect.either(revParse(cwd, base));
      if (baseResolved._tag === "Right") {
        const mb = yield* Effect.either(run(cwd, ["merge-base", baseResolved.right, "HEAD"]));
        baseSha =
          mb._tag === "Right" ? mb.right.stdout.trim() || baseResolved.right : baseResolved.right;
        const aheadOut = yield* Effect.either(run(cwd, ["rev-list", `${baseSha}..HEAD`]));
        if (aheadOut._tag === "Right") {
          const shas = aheadOut.right.stdout
            .split("\n")
            .map((s) => s.trim())
            .filter(Boolean);
          aheadShas = new Set(shas);
          aheadCount = shas.length;
        }
      } else {
        base = null;
      }
    }

    const fmt = ["%H", "%h", "%s", "%an", "%ae", "%cI", "%P"].join(LOG_FIELD_SEP);
    const logOut = yield* run(cwd, [
      "log",
      `--max-count=${limit}`,
      `--format=${fmt}${LOG_RECORD_SEP}`,
      "HEAD",
    ]);

    const commitList: CommitEntry[] = logOut.stdout
      .split(LOG_RECORD_SEP)
      .map((r) => r.replace(/^\n+/, ""))
      .filter(Boolean)
      .map((record) => {
        const [sha, shortSha, subject, author, authorEmail, date, parents] =
          record.split(LOG_FIELD_SEP);
        return {
          sha: sha ?? "",
          shortSha: shortSha ?? "",
          subject: subject ?? "",
          author: author ?? "",
          authorEmail: authorEmail ?? "",
          date: date ?? "",
          parents: (parents ?? "")
            .split(" ")
            .map((s) => s.trim())
            .filter(Boolean),
          ahead: aheadShas.has((sha ?? "").trim()),
        };
      })
      .filter((c) => c.sha.length > 0);

    return { commits: commitList, base, baseSha, headSha, aheadCount };
  });
}

/** Unified diff + per-file numstat for a single commit (vs its first
 *  parent, or the empty tree for the root commit). */
export function commitDiff(
  cwd: string,
  sha: string,
): Effect.Effect<CommitDiffPayload, AnyGitError> {
  return Effect.gen(function* () {
    yield* ensureRepo(cwd);
    if (!/^[A-Za-z0-9_./-]+$/.test(sha)) {
      return yield* Effect.fail(new GitError({ message: `invalid commit ref: ${sha}` }));
    }
    const fullSha = yield* revParse(cwd, sha);

    const meta = yield* run(cwd, [
      "show",
      "--no-patch",
      `--format=%H${LOG_FIELD_SEP}%h${LOG_FIELD_SEP}%s${LOG_FIELD_SEP}%an${LOG_FIELD_SEP}%cI${LOG_FIELD_SEP}%P`,
      fullSha,
    ]);
    const [, shortSha, subject, author, date, parentsRaw] = meta.stdout.trim().split(LOG_FIELD_SEP);
    const parents = (parentsRaw ?? "")
      .split(" ")
      .map((s) => s.trim())
      .filter(Boolean);
    const parent = parents[0] ?? null;
    const beforeRef = parent ?? EMPTY_TREE_SHA;

    const diff = (yield* run(cwd, ["diff", beforeRef, fullSha])).stdout;
    const files = parseNumstat((yield* run(cwd, ["diff", "--numstat", beforeRef, fullSha])).stdout);

    return {
      sha: fullSha,
      shortSha: shortSha ?? fullSha.slice(0, 7),
      parent,
      subject: subject ?? "",
      author: author ?? "",
      date: date ?? "",
      diff,
      files,
    };
  });
}

/** The full `base...HEAD` diff — what a PR against `base` contains. */
export function rangeDiff(cwd: string, base: string): Effect.Effect<RangeDiffPayload, AnyGitError> {
  return Effect.gen(function* () {
    yield* ensureRepo(cwd);
    const trimmed = base.trim();
    if (!/^[A-Za-z0-9_./-]+$/.test(trimmed)) {
      return yield* Effect.fail(new GitError({ message: `invalid base ref: ${base}` }));
    }
    const headSha = (yield* run(cwd, ["rev-parse", "HEAD"])).stdout.trim();
    const baseResolved = yield* revParse(cwd, trimmed);
    const mb = yield* Effect.either(run(cwd, ["merge-base", baseResolved, "HEAD"]));
    const baseSha = mb._tag === "Right" ? mb.right.stdout.trim() || baseResolved : baseResolved;

    const diff = (yield* run(cwd, ["diff", `${baseSha}...HEAD`])).stdout;
    const files = parseNumstat(
      (yield* run(cwd, ["diff", "--numstat", `${baseSha}...HEAD`])).stdout,
    );
    const aheadOut = yield* Effect.either(run(cwd, ["rev-list", "--count", `${baseSha}..HEAD`]));
    const aheadCount =
      aheadOut._tag === "Right" ? Number.parseInt(aheadOut.right.stdout.trim(), 10) || 0 : 0;

    return { base: trimmed, baseSha, headSha, diff, files, aheadCount };
  });
}
