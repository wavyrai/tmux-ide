/**
 * Files-rail helpers — lazy folder listing + git-status row colors
 * for the FilesSurface explorer.
 *
 * Lives outside `dashboard/src/lib/api.ts` to avoid colliding with
 * sibling work-in-progress on that file.
 */

import { Effect } from "effect";
import type { FullGitStatus, GitChange, GitChangeStatus } from "@tmux-ide/contracts";
import { API_BASE, type ProjectFileNode } from "@/lib/api";

interface FetchError {
  status: number;
  message: string;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    const err: FetchError = { status: res.status, message: res.statusText };
    throw err;
  }
  return (await res.json()) as T;
}

/**
 * Non-recursive list of one folder's immediate children. The daemon
 * sandboxes the path under the session's working directory (realpath
 * -aware). Empty `dirPath` lists the session root.
 */
export async function fetchFolderChildren(
  sessionName: string,
  dirPath: string,
): Promise<ProjectFileNode[]> {
  const params = new URLSearchParams({ path: dirPath });
  const data = await getJson<{ tree: ProjectFileNode[]; truncated: boolean }>(
    `${API_BASE}/api/project/${encodeURIComponent(sessionName)}/files?${params.toString()}`,
  );
  return data.tree ?? [];
}

/**
 * Fetch the workspace's coalesced git status. Returns null on
 * non-git workspaces or transient errors — the file tree just stays
 * uncolored in that case.
 */
export function fetchGitStatusForRail(
  sessionName: string,
): Effect.Effect<FullGitStatus | null, never> {
  return Effect.tryPromise({
    try: () =>
      getJson<{ status: FullGitStatus }>(
        `${API_BASE}/api/project/${encodeURIComponent(sessionName)}/git/status`,
      ).then((b) => b.status),
    catch: () => null as never,
  }).pipe(Effect.catchAll(() => Effect.succeed(null as FullGitStatus | null)));
}

/**
 * Coalesce staged + unstaged changes into a single Map keyed by
 * relative path. When the same path appears in both, the unstaged
 * status wins — it reflects the user's most recent edit and matches
 * what they'd see in `git status` row by row.
 */
export function buildGitStatusMap(status: FullGitStatus | null): Map<string, GitChangeStatus> {
  const out = new Map<string, GitChangeStatus>();
  if (!status) return out;
  const apply = (changes: readonly GitChange[]) => {
    for (const ch of changes) out.set(ch.path, ch.status);
  };
  apply(status.staged);
  apply(status.unstaged);
  return out;
}

/**
 * Pick a Tailwind text-color class for a row given its directly-
 * applicable git status (file) or aggregated descendant status (dir).
 * Returns null when the row has no status — the row keeps the default
 * `text-[var(--fg-secondary)]` styling.
 */
export function gitStatusTextClass(status: GitChangeStatus | undefined): string | null {
  switch (status) {
    case "added":
      return "text-[var(--green-foreground,var(--green))]";
    case "modified":
      return "text-[var(--yellow-foreground,var(--yellow))]";
    case "deleted":
      return "text-[var(--red-foreground,var(--red))] line-through";
    case "renamed":
      return "text-[var(--cyan-foreground,var(--cyan))]";
    case "conflicted":
      return "text-[var(--red-foreground,var(--red))]";
    default:
      return null;
  }
}

/**
 * For a directory row, pick the strongest descendant status. Order
 * (worst-first): conflicted > deleted > added > modified > renamed.
 * Returns undefined when no descendant has a status.
 */
export function aggregateDirStatus(
  dirPath: string,
  statusMap: Map<string, GitChangeStatus>,
): GitChangeStatus | undefined {
  if (statusMap.size === 0) return undefined;
  const prefix = dirPath === "" ? "" : dirPath + "/";
  let best: GitChangeStatus | undefined;
  const rank: Record<GitChangeStatus, number> = {
    conflicted: 5,
    deleted: 4,
    added: 3,
    modified: 2,
    renamed: 1,
  };
  for (const [p, s] of statusMap) {
    if (prefix !== "" && !p.startsWith(prefix)) continue;
    if (prefix === "" || p.startsWith(prefix)) {
      if (best === undefined || rank[s] > rank[best]) {
        best = s;
        if (best === "conflicted") return best;
      }
    }
  }
  return best;
}
