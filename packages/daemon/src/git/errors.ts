/**
 * Tagged-error classes for the git service. Each maps onto a
 * `GitErrorPayload` variant in @tmux-ide/contracts so the REST layer
 * can serialize them with a stable `{type, ...}` shape.
 *
 * Consumers compose via `Effect.catchTag('AuthFailed', ...)` — the
 * tag is the string used by Effect's tag-routing helpers.
 */

import { Data } from "effect";
import type { GitErrorPayload } from "@tmux-ide/contracts";

export class NotGitRepo extends Data.TaggedError("NotGitRepo")<Record<string, never>> {}
export class NoRemote extends Data.TaggedError("NoRemote")<Record<string, never>> {}
export class AuthFailed extends Data.TaggedError("AuthFailed")<{ readonly message: string }> {}
export class NetworkError extends Data.TaggedError("NetworkError")<{ readonly message: string }> {}
export class PushRejected extends Data.TaggedError("PushRejected")<{ readonly message: string }> {}
export class HookRejected extends Data.TaggedError("HookRejected")<{ readonly message: string }> {}
export class NothingToCommit extends Data.TaggedError("NothingToCommit")<Record<string, never>> {}
export class BranchExists extends Data.TaggedError("BranchExists")<{ readonly name: string }> {}
export class BranchNotFound extends Data.TaggedError("BranchNotFound")<{ readonly name: string }> {}
export class InvalidBranchName extends Data.TaggedError("InvalidBranchName")<{
  readonly name: string;
}> {}
export class UncommittedChanges extends Data.TaggedError("UncommittedChanges")<{
  readonly message: string;
}> {}
export class GitError extends Data.TaggedError("GitError")<{ readonly message: string }> {}

export type AnyGitError =
  | NotGitRepo
  | NoRemote
  | AuthFailed
  | NetworkError
  | PushRejected
  | HookRejected
  | NothingToCommit
  | BranchExists
  | BranchNotFound
  | InvalidBranchName
  | UncommittedChanges
  | GitError;

/** Map a tagged-error instance to the wire payload shape. */
export function toPayload(err: AnyGitError): GitErrorPayload {
  switch (err._tag) {
    case "NotGitRepo":
      return { type: "not_git_repo" };
    case "NoRemote":
      return { type: "no_remote" };
    case "AuthFailed":
      return { type: "auth_failed", message: err.message };
    case "NetworkError":
      return { type: "network_error", message: err.message };
    case "PushRejected":
      return { type: "rejected", message: err.message };
    case "HookRejected":
      return { type: "hook_rejected", message: err.message };
    case "NothingToCommit":
      return { type: "nothing_to_commit" };
    case "BranchExists":
      return { type: "branch_exists", name: err.name };
    case "BranchNotFound":
      return { type: "branch_not_found", name: err.name };
    case "InvalidBranchName":
      return { type: "invalid_branch_name", name: err.name };
    case "UncommittedChanges":
      return { type: "uncommitted_changes", message: err.message };
    case "GitError":
      return { type: "error", message: err.message };
  }
}

/** Map a status code emitted by git to the right tagged error. The
 *  daemon's `child_process.execFile` rejection carries stdout/stderr +
 *  exit code; this classifier inspects stderr to pick the most useful
 *  intent error before falling back to plain `GitError`. */
export function classifyExitError(stderr: string): AnyGitError {
  const text = stderr || "";
  // Auth — both HTTPS + SSH paths.
  if (
    /Authentication failed|could not read Username|Permission denied|publickey|HTTP\s+401/i.test(
      text,
    )
  ) {
    return new AuthFailed({ message: text.trim() });
  }
  // Network — DNS / connection / repository-not-found.
  if (
    /Could not resolve host|Connection refused|Connection timed out|repository .*not found|Failed to connect|Operation timed out/i.test(
      text,
    )
  ) {
    return new NetworkError({ message: text.trim() });
  }
  // Push rejected (non-fast-forward / branch-protected).
  if (
    /\[rejected\]|! \[remote rejected\]|non-fast-forward|protected branch hook declined/i.test(text)
  ) {
    return new PushRejected({ message: text.trim() });
  }
  // Pre-push or commit hook bailed out.
  if (/hook declined|pre-commit hook failed|pre-push hook/i.test(text)) {
    return new HookRejected({ message: text.trim() });
  }
  // No remote at all.
  if (
    /No configured push destination|does not appear to be a git repository.*remote|no upstream/i.test(
      text,
    )
  ) {
    return new NoRemote({});
  }
  // Nothing-staged commit attempt.
  if (/nothing to commit|no changes added to commit/i.test(text)) {
    return new NothingToCommit({});
  }
  // Uncommitted-changes guard from checkout.
  if (
    /Your local changes to the following files would be overwritten|would be overwritten by checkout/i.test(
      text,
    )
  ) {
    return new UncommittedChanges({ message: text.trim() });
  }
  // Branch already present.
  if (/A branch named '.*' already exists/i.test(text)) {
    const m = /A branch named '(.*?)' already exists/i.exec(text);
    return new BranchExists({ name: m?.[1] ?? "" });
  }
  // Branch not found.
  if (
    /pathspec '.*' did not match|did not match any file\(s\) known to git|invalid reference: /i.test(
      text,
    )
  ) {
    return new BranchNotFound({ name: "" });
  }
  // Repo doesn't exist at the cwd.
  if (/not a git repository/i.test(text)) {
    return new NotGitRepo({});
  }
  return new GitError({ message: text.trim() || "git failed" });
}
