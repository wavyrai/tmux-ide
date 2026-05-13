/**
 * GitHub auth + repository contracts (G18-P2 subset).
 *
 * P2 ships the create-PR / push / commit flow with `gh` CLI delegation
 * and a REST fallback. Full PR sync engine + SQLite cache + filter UI
 * lives under docs/goal-18-git-ops.md §G18-P2 / §G18-P3 and is
 * intentionally not in this slice.
 */

import { z } from "zod";

// ---------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------

export interface GitHubUser {
  id: number;
  login: string;
  name: string;
  email: string;
  avatar_url: string;
}

export type GitHubTokenSource = "cli" | "env" | null;

export interface GitHubStatusResponse {
  authenticated: boolean;
  user: GitHubUser | null;
  tokenSource: GitHubTokenSource;
  /** Whether the `gh` binary is available on $PATH. */
  ghAvailable: boolean;
}

// ---------------------------------------------------------------------
// Repository parsing
// ---------------------------------------------------------------------

export interface GitHubRepositoryRef {
  owner: string;
  repo: string;
  nameWithOwner: string;
  repositoryUrl: string;
}

function stripGitSuffix(value: string): string {
  return value.endsWith(".git") ? value.slice(0, -4) : value;
}

function toRepositoryRef(
  owner: string | undefined,
  repo: string | undefined,
): GitHubRepositoryRef | null {
  const o = owner?.trim();
  const r = stripGitSuffix(repo?.trim() ?? "");
  if (!o || !r) return null;
  const nameWithOwner = `${o}/${r}`;
  return { owner: o, repo: r, nameWithOwner, repositoryUrl: `https://github.com/${nameWithOwner}` };
}

/** Parse `owner/repo`, `https://github.com/owner/repo[.git]`, or
 *  `git@github.com:owner/repo[.git]` into a structured ref. */
export function parseGitHubRepository(input?: string | null): GitHubRepositoryRef | null {
  const value = input?.trim();
  if (!value) return null;

  const ssh = /^git@github\.com:([^/\s]+)\/([^/\s?#]+?)(?:\.git)?$/i.exec(value);
  if (ssh) return toRepositoryRef(ssh[1], ssh[2]);

  const url =
    /^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s?#]+?)(?:\.git)?(?:[/?#].*)?$/i.exec(value);
  if (url) return toRepositoryRef(url[1], url[2]);

  const canonical = /^([^/\s:]+)\/([^/\s?#]+?)(?:\.git)?$/.exec(value);
  if (canonical) return toRepositoryRef(canonical[1], canonical[2]);

  return null;
}

export function splitNameWithOwner(nameWithOwner: string): { owner: string; repo: string } {
  const parsed = parseGitHubRepository(nameWithOwner);
  if (!parsed || parsed.nameWithOwner !== nameWithOwner.trim()) {
    throw new Error(`Invalid nameWithOwner: "${nameWithOwner}" (expected "owner/repo")`);
  }
  return { owner: parsed.owner, repo: parsed.repo };
}

// ---------------------------------------------------------------------
// Create PR
// ---------------------------------------------------------------------

export const createPrRequestSchema = z.object({
  title: z.string().trim().min(1, "title is required").max(256),
  /** Body is markdown. Empty string is OK — GitHub renders the diff
   *  alone — but we strip whitespace so the daemon sees real intent. */
  body: z.string().optional(),
  /** Target branch. Required because PRs need a base. */
  base: z.string().trim().min(1, "base branch is required").max(255),
  /** Source branch. Defaults to the current branch when omitted. */
  head: z.string().trim().min(1).max(255).optional(),
  /** Open as a draft PR. */
  draft: z.boolean().optional(),
});
export type CreatePrRequest = z.infer<typeof createPrRequestSchema>;

export interface CreatedPrSummary {
  url: string;
  number: number;
  title: string;
  base: string;
  head: string;
  isDraft: boolean;
}

export interface CreatePrResponse {
  ok: true;
  pr: CreatedPrSummary;
}

/** Failure modes specific to the GitHub side of the flow. The general
 *  git push/auth errors come back as `GitErrorPayload` already. */
export type GitHubErrorPayload =
  | { type: "not_authenticated" }
  | { type: "gh_unavailable" }
  | { type: "no_github_remote" }
  | { type: "head_not_pushed"; branch: string }
  | { type: "pr_already_exists"; url?: string }
  | { type: "validation_failed"; message: string }
  | { type: "network_error"; message: string }
  | { type: "error"; message: string };
