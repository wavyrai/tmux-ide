import { DesktopWorkspaceNameSchemaZ } from "@tmux-ide/contracts";

/**
 * Renderer-neutral workspace selection policy.
 *
 * Core deliberately deals only in durable workspace identifiers. It knows
 * nothing about DOM nodes, OpenTUI renderables, tmux geometry, or canvas
 * documents. GUI and TUI adapters can therefore make the same recovery
 * decision when a remembered workspace disappears.
 */
export type WorkspaceSelectionSource = "explicit" | "current" | "persisted";

export type WorkspaceSelectionFallback = "none" | "only-live" | "first-live";

export type WorkspaceSelectionReason =
  | WorkspaceSelectionSource
  | "only-live-workspace"
  | "first-live-workspace"
  | "no-live-workspaces"
  | "selection-not-found";

export interface WorkspaceSelectionInput {
  readonly liveWorkspaceIds: readonly unknown[];
  readonly explicitWorkspaceId?: unknown;
  readonly currentWorkspaceId?: unknown;
  readonly persistedWorkspaceId?: unknown;
  readonly fallback?: WorkspaceSelectionFallback;
}

export interface WorkspaceSelectionResult {
  readonly workspaceId: string | null;
  readonly reason: WorkspaceSelectionReason;
  /** Preferred source that was present but invalid or no longer live. */
  readonly rejectedSource: WorkspaceSelectionSource | null;
}

function exactWorkspaceId(value: unknown): string | null {
  const parsed = DesktopWorkspaceNameSchemaZ.safeParse(value);
  return parsed.success && parsed.data === value ? parsed.data : null;
}

function liveWorkspaceIds(values: readonly unknown[]): string[] {
  const unique = new Set<string>();
  for (const value of values) {
    const id = exactWorkspaceId(value);
    if (id !== null) unique.add(id);
  }
  return [...unique];
}

/**
 * Choose a live workspace without retaining a stale persisted identifier.
 * Priority is explicit navigation, the current live selection, then persisted
 * state. The caller controls whether an absent preference stays unselected,
 * selects a sole live workspace, or falls back to the first live workspace.
 */
export function reconcileWorkspaceSelection(
  input: WorkspaceSelectionInput,
): WorkspaceSelectionResult {
  const live = liveWorkspaceIds(input.liveWorkspaceIds);
  if (live.length === 0) {
    return { workspaceId: null, reason: "no-live-workspaces", rejectedSource: null };
  }

  const liveSet = new Set(live);
  const candidates: readonly [WorkspaceSelectionSource, unknown][] = [
    ["explicit", input.explicitWorkspaceId],
    ["current", input.currentWorkspaceId],
    ["persisted", input.persistedWorkspaceId],
  ];
  let rejectedSource: WorkspaceSelectionSource | null = null;
  for (const [source, raw] of candidates) {
    if (raw === undefined || raw === null || raw === "") continue;
    const id = exactWorkspaceId(raw);
    if (id !== null && liveSet.has(id)) {
      return { workspaceId: id, reason: source, rejectedSource };
    }
    rejectedSource ??= source;
  }

  const fallback = input.fallback ?? "none";
  if (fallback === "first-live") {
    return {
      workspaceId: live[0]!,
      reason: "first-live-workspace",
      rejectedSource,
    };
  }
  if (fallback === "only-live" && live.length === 1) {
    return {
      workspaceId: live[0]!,
      reason: "only-live-workspace",
      rejectedSource,
    };
  }
  return { workspaceId: null, reason: "selection-not-found", rejectedSource };
}
