/**
 * GitHub auth + create-PR service (G18-P2).
 *
 * Two backends, picked at call time:
 *   1. `gh` CLI delegation — preferred. Inherits the user's local
 *      keychain auth (HTTPS or SSH) without us touching credentials.
 *   2. REST fallback via `Authorization: token <gh auth token>`. Used
 *      when `gh pr create` is unavailable (older gh) or for the
 *      status/user-info probe.
 *
 * Errors surface as tagged classes. The REST layer maps each to a
 * `GitHubErrorPayload` for the wire so the UI can branch on intent
 * ("Sign in with gh", "Push your branch first", etc.).
 */

import { execFile } from "node:child_process";
import { Effect, Data } from "effect";
import type {
  CreatedPrSummary,
  CreatePrRequest,
  GitHubErrorPayload,
  GitHubRepositoryRef,
  GitHubStatusResponse,
  GitHubUser,
} from "@tmux-ide/contracts";
import { parseGitHubRepository } from "@tmux-ide/contracts";

// ---------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------

export class GhUnavailable extends Data.TaggedError("GhUnavailable")<Record<string, never>> {}
export class NotAuthenticated extends Data.TaggedError("NotAuthenticated")<Record<string, never>> {}
export class NoGithubRemote extends Data.TaggedError("NoGithubRemote")<Record<string, never>> {}
export class HeadNotPushed extends Data.TaggedError("HeadNotPushed")<{
  readonly branch: string;
}> {}
export class PrAlreadyExists extends Data.TaggedError("PrAlreadyExists")<{ readonly url?: string }> {}
export class GithubValidation extends Data.TaggedError("GithubValidation")<{
  readonly message: string;
}> {}
export class GithubNetwork extends Data.TaggedError("GithubNetwork")<{ readonly message: string }> {}
export class GithubError extends Data.TaggedError("GithubError")<{ readonly message: string }> {}

export type AnyGithubError =
  | GhUnavailable
  | NotAuthenticated
  | NoGithubRemote
  | HeadNotPushed
  | PrAlreadyExists
  | GithubValidation
  | GithubNetwork
  | GithubError;

export function toPayload(err: AnyGithubError): GitHubErrorPayload {
  switch (err._tag) {
    case "GhUnavailable":
      return { type: "gh_unavailable" };
    case "NotAuthenticated":
      return { type: "not_authenticated" };
    case "NoGithubRemote":
      return { type: "no_github_remote" };
    case "HeadNotPushed":
      return { type: "head_not_pushed", branch: err.branch };
    case "PrAlreadyExists":
      return err.url
        ? { type: "pr_already_exists", url: err.url }
        : { type: "pr_already_exists" };
    case "GithubValidation":
      return { type: "validation_failed", message: err.message };
    case "GithubNetwork":
      return { type: "network_error", message: err.message };
    case "GithubError":
      return { type: "error", message: err.message };
  }
}

// ---------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------

interface RunOk {
  stdout: string;
  stderr: string;
}
interface ExecFailure {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(
  cmd: string,
  args: ReadonlyArray<string>,
  cwd?: string,
): Promise<RunOk> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      {
        ...(cwd ? { cwd } : {}),
        encoding: "utf-8",
        maxBuffer: 8 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        const out = String(stdout ?? "");
        const errOut = String(stderr ?? "");
        if (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === "ENOENT") {
            reject({ code: -1, stdout: out, stderr: "ENOENT" } satisfies ExecFailure);
            return;
          }
          const exit = (err as NodeJS.ErrnoException & { code?: number }).code ?? 1;
          reject({
            code: typeof exit === "number" ? exit : 1,
            stdout: out,
            stderr: errOut,
          } satisfies ExecFailure);
          return;
        }
        resolve({ stdout: out, stderr: errOut });
      },
    );
  });
}

function classifyGhFailure(failure: ExecFailure): AnyGithubError {
  if (failure.stderr === "ENOENT") return new GhUnavailable({});
  const text = failure.stderr || failure.stdout || "";
  if (/not logged into|gh auth login|authentication required/i.test(text)) {
    return new NotAuthenticated({});
  }
  if (/no such ref|src refspec .* does not match|head ref .* does not exist on the remote/i.test(text)) {
    const m = /\b([^\s/]+\/[^\s/]+)\b/.exec(text);
    return new HeadNotPushed({ branch: m?.[1] ?? "" });
  }
  if (/already exists\.|a pull request for branch .* already exists/i.test(text)) {
    const m = /https:\/\/github\.com\/[^\s]+\/pull\/\d+/.exec(text);
    return new PrAlreadyExists(m ? { url: m[0] } : {});
  }
  if (/validation failed|Validation Failed/i.test(text)) {
    return new GithubValidation({ message: text.trim() });
  }
  if (/network|connection refused|getaddrinfo|timed out/i.test(text)) {
    return new GithubNetwork({ message: text.trim() });
  }
  return new GithubError({ message: text.trim() || "gh failed" });
}

// ---------------------------------------------------------------------
// Auth probes
// ---------------------------------------------------------------------

/** True when `gh` resolves on $PATH. */
export function ghAvailable(): Effect.Effect<boolean, never> {
  return Effect.tryPromise({
    try: () => runCli("gh", ["--version"]),
    catch: () => null,
  }).pipe(
    Effect.match({
      onFailure: () => false,
      onSuccess: () => true,
    }),
  );
}

function readGhToken(): Effect.Effect<string, AnyGithubError> {
  return Effect.tryPromise({
    try: () => runCli("gh", ["auth", "token"]),
    catch: (cause) => classifyGhFailure(cause as ExecFailure),
  }).pipe(
    Effect.flatMap(({ stdout }) => {
      const tok = stdout.trim();
      if (!tok) return Effect.fail(new NotAuthenticated({}));
      return Effect.succeed(tok);
    }),
  );
}

function fetchAuthenticatedUser(token: string): Effect.Effect<GitHubUser, AnyGithubError> {
  return Effect.tryPromise({
    try: async () => {
      const res = await fetch("https://api.github.com/user", {
        headers: {
          Authorization: `token ${token}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "tmux-ide-daemon",
        },
      });
      if (res.status === 401) throw new NotAuthenticated({});
      if (!res.ok) {
        throw new GithubError({
          message: `GET /user failed (${res.status})`,
        });
      }
      const body = (await res.json()) as Partial<GitHubUser>;
      return {
        id: typeof body.id === "number" ? body.id : 0,
        login: body.login ?? "",
        name: body.name ?? "",
        email: body.email ?? "",
        avatar_url: body.avatar_url ?? "",
      };
    },
    catch: (cause) => {
      if (cause instanceof NotAuthenticated || cause instanceof GithubError) return cause;
      const msg = cause instanceof Error ? cause.message : String(cause);
      return new GithubNetwork({ message: msg });
    },
  });
}

export function status(): Effect.Effect<GitHubStatusResponse, never> {
  return Effect.gen(function* () {
    const available = yield* ghAvailable();
    if (!available) {
      return {
        authenticated: false,
        user: null,
        tokenSource: null,
        ghAvailable: false,
      };
    }
    const result = yield* Effect.either(readGhToken());
    if (result._tag === "Left") {
      return {
        authenticated: false,
        user: null,
        tokenSource: null,
        ghAvailable: true,
      };
    }
    const userResult = yield* Effect.either(fetchAuthenticatedUser(result.right));
    if (userResult._tag === "Left") {
      return {
        authenticated: false,
        user: null,
        tokenSource: "cli",
        ghAvailable: true,
      };
    }
    return {
      authenticated: true,
      user: userResult.right,
      tokenSource: "cli",
      ghAvailable: true,
    };
  });
}

// ---------------------------------------------------------------------
// Repo discovery
// ---------------------------------------------------------------------

/** Resolve the GitHub repo this workspace points at by reading the
 *  configured push remote (origin by default). Returns NoGithubRemote
 *  when no remote URL parses as a GitHub repo. */
export function detectRepo(cwd: string): Effect.Effect<GitHubRepositoryRef, AnyGithubError> {
  return Effect.tryPromise({
    try: () => runCli("git", ["remote", "get-url", "--push", "origin"], cwd),
    catch: () => new NoGithubRemote({}),
  }).pipe(
    Effect.flatMap(({ stdout }) => {
      const parsed = parseGitHubRepository(stdout.trim());
      if (!parsed) return Effect.fail(new NoGithubRemote({}));
      return Effect.succeed(parsed);
    }),
  );
}

// ---------------------------------------------------------------------
// Create PR
// ---------------------------------------------------------------------

export function createPullRequest(
  cwd: string,
  input: CreatePrRequest,
): Effect.Effect<CreatedPrSummary, AnyGithubError> {
  return Effect.gen(function* () {
    const repo = yield* detectRepo(cwd);
    const available = yield* ghAvailable();
    if (available) {
      return yield* createPrWithGh(cwd, repo, input);
    }
    return yield* createPrWithRest(repo, input);
  });
}

function createPrWithGh(
  cwd: string,
  repo: GitHubRepositoryRef,
  input: CreatePrRequest,
): Effect.Effect<CreatedPrSummary, AnyGithubError> {
  return Effect.gen(function* () {
    const args = [
      "pr",
      "create",
      "--repo",
      repo.nameWithOwner,
      "--title",
      input.title,
      "--body",
      input.body ?? "",
      "--base",
      input.base,
    ];
    if (input.head) args.push("--head", input.head);
    if (input.draft) args.push("--draft");
    const { stdout } = yield* Effect.tryPromise({
      try: () => runCli("gh", args, cwd),
      catch: (cause) => classifyGhFailure(cause as ExecFailure),
    });
    // gh prints the PR URL on stdout. Pull it out + GET the metadata.
    const url = (stdout.split("\n").find((l) => l.startsWith("https://")) ?? "").trim();
    if (!url) return yield* Effect.fail(new GithubError({ message: "gh pr create did not return a URL" }));
    const number = parseInt(url.split("/").pop() ?? "0", 10) || 0;
    return {
      url,
      number,
      title: input.title,
      base: input.base,
      head: input.head ?? "",
      isDraft: Boolean(input.draft),
    };
  });
}

function createPrWithRest(
  repo: GitHubRepositoryRef,
  input: CreatePrRequest,
): Effect.Effect<CreatedPrSummary, AnyGithubError> {
  return Effect.gen(function* () {
    const token = yield* readGhToken();
    const res = yield* Effect.tryPromise({
      try: () =>
        fetch(`https://api.github.com/repos/${repo.owner}/${repo.repo}/pulls`, {
          method: "POST",
          headers: {
            Authorization: `token ${token}`,
            Accept: "application/vnd.github+json",
            "Content-Type": "application/json",
            "User-Agent": "tmux-ide-daemon",
          },
          body: JSON.stringify({
            title: input.title,
            body: input.body ?? "",
            base: input.base,
            head: input.head,
            draft: Boolean(input.draft),
          }),
        }),
      catch: (cause) => new GithubNetwork({ message: cause instanceof Error ? cause.message : String(cause) }),
    });
    const body = (yield* Effect.tryPromise({
      try: () => res.json() as Promise<Record<string, unknown>>,
      catch: () => new GithubError({ message: "could not parse PR response body" }),
    })) as { html_url?: string; number?: number; message?: string; errors?: unknown };
    if (res.status === 401 || res.status === 403) {
      return yield* Effect.fail(new NotAuthenticated({}));
    }
    if (res.status === 422) {
      const msg = String(body.message ?? "Validation failed");
      // 422 with "A pull request already exists" is the dedup hit.
      if (/already exists/i.test(msg)) return yield* Effect.fail(new PrAlreadyExists({}));
      return yield* Effect.fail(new GithubValidation({ message: msg }));
    }
    if (!res.ok || !body.html_url || typeof body.number !== "number") {
      return yield* Effect.fail(
        new GithubError({
          message: String(body.message ?? `POST /pulls failed (${res.status})`),
        }),
      );
    }
    return {
      url: body.html_url,
      number: body.number,
      title: input.title,
      base: input.base,
      head: input.head ?? "",
      isDraft: Boolean(input.draft),
    };
  });
}
