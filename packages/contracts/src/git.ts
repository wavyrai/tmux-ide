/**
 * Shared git types — daemon ↔ dashboard wire shapes.
 *
 * Subset landed for G18-P1 (status, branches, checkout, commit, push).
 * Larger surface (cat-file, fetch-service, watcher, diff modes) waits
 * for G18-P2 per the audit at docs/goal-18-git-ops.md §G18-P1.
 */

import { z } from "zod";

// ---------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------

export type GitChangeStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "conflicted";

export interface GitChange {
  path: string;
  status: GitChangeStatus;
  additions: number;
  deletions: number;
}

/** Coalesced workspace status (staged + unstaged + branch). */
export interface FullGitStatus {
  staged: GitChange[];
  unstaged: GitChange[];
  currentBranch: string | null;
  totalAdded: number;
  totalDeleted: number;
  ahead: number;
  behind: number;
  isUnborn: boolean;
}

export interface Remote {
  name: string;
  url: string;
}

export interface LocalBranch {
  type: "local";
  branch: string;
  upstream?: string;
  ahead?: number;
  behind?: number;
}

export interface RemoteBranch {
  type: "remote";
  branch: string;
  remote: Remote;
}

export interface BranchesPayload {
  local: LocalBranch[];
  remote: RemoteBranch[];
  remotes: Remote[];
  currentBranch: string | null;
  isUnborn: boolean;
}

// ---------------------------------------------------------------------
// Request schemas (zod) — daemon validates inbound bodies with these.
// ---------------------------------------------------------------------

export const checkoutRequestSchema = z.object({
  branch: z
    .string()
    .trim()
    .min(1, "branch is required")
    .max(255, "branch name is too long")
    // git refs disallow these chars + leading dash + double-dot.
    .refine((s) => !/[\x00-\x1f\x7f \\~^:?*\[]/.test(s), "invalid branch name")
    .refine((s) => !s.startsWith("-"), "branch name cannot start with '-'")
    .refine((s) => !s.includes(".."), "branch name cannot contain '..'"),
  create: z.boolean().optional(),
});
export type CheckoutRequest = z.infer<typeof checkoutRequestSchema>;

export const commitRequestSchema = z.object({
  message: z.string().trim().min(1, "commit message is required"),
  /** When true: `git commit -a -m <msg>` (stages tracked changes). */
  all: z.boolean().optional(),
});
export type CommitRequest = z.infer<typeof commitRequestSchema>;

/** Stage / unstage a list of paths. The daemon resolves them against
 *  the session dir; absolute paths are rejected by the handler. */
export const stageRequestSchema = z.object({
  paths: z.array(z.string().trim().min(1)).min(1, "paths is required"),
});
export type StageRequest = z.infer<typeof stageRequestSchema>;

export const unstageRequestSchema = stageRequestSchema;
export type UnstageRequest = StageRequest;

export const pushRequestSchema = z.object({
  /** When omitted: push the current branch to its upstream. */
  remote: z.string().trim().min(1).optional(),
  branch: z.string().trim().min(1).optional(),
  setUpstream: z.boolean().optional(),
});
export type PushRequest = z.infer<typeof pushRequestSchema>;

// ---------------------------------------------------------------------
// Response envelopes (success + tagged-error variants)
// ---------------------------------------------------------------------

/** Discriminated union of failure modes that surface to the UI with
 *  intent-specific copy. Keep aligned with the daemon's
 *  `GitError` tagged classes in `packages/daemon/src/git/errors.ts`. */
export type GitErrorPayload =
  | { type: "not_git_repo" }
  | { type: "no_remote" }
  | { type: "auth_failed"; message: string }
  | { type: "network_error"; message: string }
  | { type: "rejected"; message: string }
  | { type: "hook_rejected"; message: string }
  | { type: "nothing_to_commit" }
  | { type: "branch_exists"; name: string }
  | { type: "branch_not_found"; name: string }
  | { type: "invalid_branch_name"; name: string }
  | { type: "uncommitted_changes"; message: string }
  | { type: "error"; message: string };

export interface GitStatusResponse {
  status: FullGitStatus;
}

export interface BranchesResponse extends BranchesPayload {}

export interface CheckoutResponse {
  ok: true;
  currentBranch: string;
}

export interface CommitResponse {
  ok: true;
  sha: string;
}

export interface PushResponse {
  ok: true;
  remote: string;
  branch: string;
}
