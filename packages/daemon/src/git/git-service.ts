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
