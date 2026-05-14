/**
 * Solid-side git client (G18-P1).
 *
 * Effect-wrapped fetchers + a thin `useGitStatus(sessionName)` /
 * `useBranches(sessionName)` resource pair. Each returns
 * `Effect.Effect<T, GitApiError>` so callers can `Effect.runPromise`
 * directly (the `useX` helpers do that internally and surface the
 * result via `createResource`).
 *
 * Error shape mirrors the daemon's `GitErrorPayload` so the UI can
 * branch on `err.type` for intent-specific copy ("Sign in to GitHub",
 * "Push was rejected", etc.).
 */

import { createResource, type Resource } from "solid-js";
import { Effect, Data } from "effect";
import type {
  BranchesPayload,
  ChecksResponse,
  CheckoutRequest,
  CommitRequest,
  CreatePrRequest,
  CreatedPrSummary,
  FullGitStatus,
  GitErrorPayload,
  GitHubErrorPayload,
  GitHubStatusResponse,
  PushRequest,
} from "@tmux-ide/contracts";
import { API_BASE } from "@/lib/api";

export class GitApiError extends Data.TaggedError("GitApiError")<{
  readonly status: number;
  readonly payload: GitErrorPayload;
}> {}

interface ErrorBody {
  error?: GitErrorPayload | string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { cache: "no-store", ...init });
  const body = (await res.json().catch(() => ({}))) as T & ErrorBody;
  if (!res.ok) {
    const payload =
      body.error && typeof body.error === "object"
        ? body.error
        : {
            type: "error" as const,
            message: typeof body.error === "string" ? body.error : `HTTP ${res.status}`,
          };
    throw new GitApiError({ status: res.status, payload });
  }
  return body as T;
}

function effect<T>(path: string, init?: RequestInit): Effect.Effect<T, GitApiError> {
  return Effect.tryPromise({
    try: () => request<T>(path, init),
    catch: (cause) =>
      cause instanceof GitApiError
        ? cause
        : new GitApiError({
            status: 0,
            payload: {
              type: "error",
              message: cause instanceof Error ? cause.message : String(cause),
            },
          }),
  });
}

// ---------------------------------------------------------------------
// Effect-wrapped operations
// ---------------------------------------------------------------------

export function fetchGitStatus(sessionName: string): Effect.Effect<FullGitStatus, GitApiError> {
  return effect<{ status: FullGitStatus }>(
    `/api/project/${encodeURIComponent(sessionName)}/git/status`,
  ).pipe(Effect.map((b) => b.status));
}

export function fetchBranches(sessionName: string): Effect.Effect<BranchesPayload, GitApiError> {
  return effect<BranchesPayload>(`/api/project/${encodeURIComponent(sessionName)}/git/branches`);
}

export function checkoutBranch(
  sessionName: string,
  body: CheckoutRequest,
): Effect.Effect<{ currentBranch: string }, GitApiError> {
  return effect<{ ok: true; currentBranch: string }>(
    `/api/project/${encodeURIComponent(sessionName)}/git/checkout`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  ).pipe(Effect.map((b) => ({ currentBranch: b.currentBranch })));
}

export function commitChanges(
  sessionName: string,
  body: CommitRequest,
): Effect.Effect<{ sha: string }, GitApiError> {
  return effect<{ ok: true; sha: string }>(
    `/api/project/${encodeURIComponent(sessionName)}/git/commit`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  ).pipe(Effect.map((b) => ({ sha: b.sha })));
}

export function pushBranch(
  sessionName: string,
  body: PushRequest = {},
): Effect.Effect<{ remote: string; branch: string }, GitApiError> {
  return effect<{ ok: true; remote: string; branch: string }>(
    `/api/project/${encodeURIComponent(sessionName)}/git/push`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  ).pipe(Effect.map((b) => ({ remote: b.remote, branch: b.branch })));
}

export function stagePaths(
  sessionName: string,
  paths: ReadonlyArray<string>,
): Effect.Effect<void, GitApiError> {
  return effect<{ ok: true }>(`/api/project/${encodeURIComponent(sessionName)}/git/stage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paths }),
  }).pipe(Effect.map(() => undefined));
}

export function unstagePaths(
  sessionName: string,
  paths: ReadonlyArray<string>,
): Effect.Effect<void, GitApiError> {
  return effect<{ ok: true }>(`/api/project/${encodeURIComponent(sessionName)}/git/unstage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paths }),
  }).pipe(Effect.map(() => undefined));
}

/** GitHub auth probe — branches the UI between "Sign in with gh",
 *  "Install gh", and "Create PR as @login". */
export class GitHubApiError extends Data.TaggedError("GitHubApiError")<{
  readonly status: number;
  readonly payload: GitHubErrorPayload;
}> {}

interface GhErrorBody {
  error?: GitHubErrorPayload | string;
}

async function ghRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { cache: "no-store", ...init });
  const body = (await res.json().catch(() => ({}))) as T & GhErrorBody;
  if (!res.ok) {
    const payload =
      body.error && typeof body.error === "object"
        ? body.error
        : {
            type: "error" as const,
            message: typeof body.error === "string" ? body.error : `HTTP ${res.status}`,
          };
    throw new GitHubApiError({ status: res.status, payload });
  }
  return body as T;
}

function ghEffect<T>(path: string, init?: RequestInit): Effect.Effect<T, GitHubApiError> {
  return Effect.tryPromise({
    try: () => ghRequest<T>(path, init),
    catch: (cause) =>
      cause instanceof GitHubApiError
        ? cause
        : new GitHubApiError({
            status: 0,
            payload: {
              type: "error",
              message: cause instanceof Error ? cause.message : String(cause),
            },
          }),
  });
}

export function fetchGitHubStatus(
  sessionName: string,
): Effect.Effect<GitHubStatusResponse, GitHubApiError> {
  return ghEffect<GitHubStatusResponse>(
    `/api/project/${encodeURIComponent(sessionName)}/git/github-status`,
  );
}

export function fetchChecks(
  sessionName: string,
  ref?: string,
): Effect.Effect<ChecksResponse, GitHubApiError> {
  const qs = ref ? `?ref=${encodeURIComponent(ref)}` : "";
  return ghEffect<ChecksResponse>(
    `/api/project/${encodeURIComponent(sessionName)}/git/checks${qs}`,
  );
}

/** Reactive checks resource. Re-keyed on (sessionName, ref) so swapping
 *  branches or commits refetches without manual orchestration. */
export function useChecks(sessionName: () => string | null, ref: () => string | null = () => null) {
  const key = () => {
    const name = sessionName();
    if (!name) return null;
    return { name, ref: ref() ?? undefined };
  };
  const [resource, { refetch }] = createResource(key, async (k) => {
    if (!k) return null;
    return Effect.runPromise(
      fetchChecks(k.name, k.ref).pipe(
        Effect.catchAll(() => Effect.succeed(null as ChecksResponse | null)),
      ),
    );
  });
  (
    resource as Resource<ChecksResponse | null> & {
      refetch: () => Promise<ChecksResponse | null | undefined>;
    }
  ).refetch = async () => refetch();
  return resource as Resource<ChecksResponse | null> & {
    refetch: () => Promise<ChecksResponse | null | undefined>;
  };
}

export function createPullRequest(
  sessionName: string,
  body: CreatePrRequest,
): Effect.Effect<CreatedPrSummary, GitHubApiError> {
  return ghEffect<{ ok: true; pr: CreatedPrSummary }>(
    `/api/project/${encodeURIComponent(sessionName)}/git/pr`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  ).pipe(Effect.map((r) => r.pr));
}

// ---------------------------------------------------------------------
// Solid resource hooks
// ---------------------------------------------------------------------

export type GitStatusResource = Resource<FullGitStatus | null> & {
  refetch: () => Promise<FullGitStatus | null | undefined>;
};

/** Reactive git status for the current session. Pass an accessor so the
 *  resource re-fetches when the session changes. */
export function useGitStatus(sessionName: () => string | null): GitStatusResource {
  const [resource, { refetch }] = createResource(sessionName, async (name) => {
    if (!name) return null;
    return Effect.runPromise(
      fetchGitStatus(name).pipe(
        Effect.catchAll(() => Effect.succeed(null as FullGitStatus | null)),
      ),
    );
  });
  (resource as GitStatusResource).refetch = async () => refetch();
  return resource as GitStatusResource;
}

/** Reactive branch list for the current session. */
export function useBranches(sessionName: () => string | null): {
  resource: Resource<BranchesPayload | null>;
  refetch: () => Promise<BranchesPayload | null | undefined>;
} {
  const [resource, { refetch }] = createResource(sessionName, async (name) => {
    if (!name) return null;
    return Effect.runPromise(
      fetchBranches(name).pipe(
        Effect.catchAll(() => Effect.succeed(null as BranchesPayload | null)),
      ),
    );
  });
  return { resource, refetch: async () => refetch() };
}
