/**
 * Git history / range-diff fetchers for the Diffs view.
 *
 * Lives beside the diff components (not in `@/lib/api`) because it's
 * the commit-browsing surface's private wire client. Effect-wrapped
 * to match the rest of the diffs surface; all fetches go through
 * `${API_BASE}` (never a relative `/api`, which breaks when the
 * dashboard is served from a different origin than the daemon).
 */

import { Effect, Data } from "effect";
import { API_BASE } from "@/lib/api";

export class GitHistoryError extends Data.TaggedError("GitHistoryError")<{
  readonly status: number;
  readonly message: string;
}> {}

export interface CommitEntry {
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  authorEmail: string;
  /** Committer date, ISO-8601. */
  date: string;
  parents: string[];
  /** True when a base was requested and this commit is in base..HEAD. */
  ahead: boolean;
}

export interface CommitsPayload {
  commits: CommitEntry[];
  base: string | null;
  baseSha: string | null;
  headSha: string;
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

/** The empty-tree object the daemon reports as a root commit's parent. */
export const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

function getJson<T>(path: string): Effect.Effect<T, GitHistoryError> {
  return Effect.tryPromise({
    try: async () => {
      const res = await fetch(`${API_BASE}${path}`, { cache: "no-store" });
      if (!res.ok) {
        let message = `HTTP ${res.status}`;
        try {
          const body = (await res.json()) as { error?: unknown };
          if (typeof body?.error === "string") message = body.error;
          else if (body?.error) message = JSON.stringify(body.error);
        } catch {
          // Non-JSON body — the status-only message stands.
        }
        throw new GitHistoryError({ status: res.status, message });
      }
      return (await res.json()) as T;
    },
    catch: (cause) =>
      cause instanceof GitHistoryError
        ? cause
        : new GitHistoryError({
            status: 0,
            message: cause instanceof Error ? cause.message : String(cause),
          }),
  });
}

export function fetchCommits(
  sessionName: string,
  base?: string,
  limit?: number,
): Effect.Effect<CommitsPayload, GitHistoryError> {
  const params = new URLSearchParams();
  if (base) params.set("base", base);
  if (limit) params.set("limit", String(limit));
  const qs = params.toString();
  return getJson<CommitsPayload>(
    `/api/project/${encodeURIComponent(sessionName)}/git/commits${qs ? `?${qs}` : ""}`,
  );
}

export function fetchCommitDiff(
  sessionName: string,
  sha: string,
): Effect.Effect<CommitDiffPayload, GitHistoryError> {
  return getJson<CommitDiffPayload>(
    `/api/project/${encodeURIComponent(sessionName)}/git/commit/${encodeURIComponent(sha)}/diff`,
  );
}

export function fetchRangeDiff(
  sessionName: string,
  base = "main",
): Effect.Effect<RangeDiffPayload, GitHistoryError> {
  const params = new URLSearchParams({ base });
  return getJson<RangeDiffPayload>(
    `/api/project/${encodeURIComponent(sessionName)}/git/range-diff?${params.toString()}`,
  );
}

/** "3 minutes ago" style relative label from an ISO date. */
export function relativeDate(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const secs = Math.round((Date.now() - then) / 1000);
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.round(months / 12)}y ago`;
}
