import type { WorkspaceChangeEntry, WorkspaceChangeGroup } from "./workspace-changes-resource.ts";
import type { WorkspaceChangeResourceId } from "./workspace-resource-identity.ts";

/**
 * Pure presenter projections over a changes catalog's entries.
 *
 * The daemon returns a flat list of change entries; these functions group,
 * filter, summarize, and flatten them for a native changes panel. They never
 * touch git, the filesystem, or absolute paths — every input is an
 * already-validated contract value.
 */

/** Fixed render order: index-ward first, then working tree, then untracked. */
export const WORKSPACE_CHANGE_GROUP_ORDER: readonly WorkspaceChangeGroup[] = [
  "staged",
  "unstaged",
  "untracked",
];

export interface WorkspaceChangesSummary {
  staged: number;
  unstaged: number;
  untracked: number;
  total: number;
  additions: number;
  deletions: number;
  binary: number;
}

export interface WorkspaceChangesFilter {
  group?: WorkspaceChangeGroup | "all";
  query?: string;
}

export interface WorkspaceChangesGrouping {
  staged: WorkspaceChangeEntry[];
  unstaged: WorkspaceChangeEntry[];
  untracked: WorkspaceChangeEntry[];
}

export type WorkspaceChangesRowKind = "group" | "change";

export interface WorkspaceChangesRow {
  kind: WorkspaceChangesRowKind;
  group: WorkspaceChangeGroup;
  /** The change for `kind: "change"` rows; null for group-header rows. */
  entry: WorkspaceChangeEntry | null;
  /** Number of changes in the group; only meaningful on header rows. */
  count: number;
  selectable: boolean;
  selected: boolean;
}

export interface WorkspaceChangesView {
  rows: WorkspaceChangesRow[];
  selectedId: WorkspaceChangeResourceId | null;
  selectedIndex: number;
  summary: WorkspaceChangesSummary;
}

/** Stable order within a group: case-insensitive path, then id. */
export function compareWorkspaceChangeEntries(
  a: WorkspaceChangeEntry,
  b: WorkspaceChangeEntry,
): number {
  const aPath = a.relativePath.toLowerCase();
  const bPath = b.relativePath.toLowerCase();
  if (aPath < bPath) return -1;
  if (aPath > bPath) return 1;
  if (a.relativePath < b.relativePath) return -1;
  if (a.relativePath > b.relativePath) return 1;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

export function sortWorkspaceChangeEntries(
  entries: readonly WorkspaceChangeEntry[],
): WorkspaceChangeEntry[] {
  return [...entries].sort(compareWorkspaceChangeEntries);
}

export function groupWorkspaceChanges(
  entries: readonly WorkspaceChangeEntry[],
): WorkspaceChangesGrouping {
  const grouping: WorkspaceChangesGrouping = { staged: [], unstaged: [], untracked: [] };
  for (const entry of entries) grouping[entry.group].push(entry);
  grouping.staged.sort(compareWorkspaceChangeEntries);
  grouping.unstaged.sort(compareWorkspaceChangeEntries);
  grouping.untracked.sort(compareWorkspaceChangeEntries);
  return grouping;
}

export function summarizeWorkspaceChanges(
  entries: readonly WorkspaceChangeEntry[],
): WorkspaceChangesSummary {
  const summary: WorkspaceChangesSummary = {
    staged: 0,
    unstaged: 0,
    untracked: 0,
    total: 0,
    additions: 0,
    deletions: 0,
    binary: 0,
  };
  for (const entry of entries) {
    summary[entry.group] += 1;
    summary.total += 1;
    if (entry.binary) summary.binary += 1;
    summary.additions += entry.additions ?? 0;
    summary.deletions += entry.deletions ?? 0;
  }
  return summary;
}

export function filterWorkspaceChanges(
  entries: readonly WorkspaceChangeEntry[],
  filter: WorkspaceChangesFilter = {},
): WorkspaceChangeEntry[] {
  const group = filter.group ?? "all";
  const query = filter.query?.trim().toLowerCase() ?? "";
  return entries.filter((entry) => {
    if (group !== "all" && entry.group !== group) return false;
    if (query.length === 0) return true;
    if (entry.relativePath.toLowerCase().includes(query)) return true;
    return entry.originPath?.toLowerCase().includes(query) ?? false;
  });
}

export interface WorkspaceChangesViewInput {
  entries: readonly WorkspaceChangeEntry[];
  filter?: WorkspaceChangesFilter;
  selectedId?: WorkspaceChangeResourceId | null;
}

export function flattenWorkspaceChangesView(
  input: WorkspaceChangesViewInput,
): WorkspaceChangesView {
  const visible = filterWorkspaceChanges(input.entries, input.filter);
  const grouping = groupWorkspaceChanges(visible);
  const selectedId = input.selectedId ?? null;
  const rows: WorkspaceChangesRow[] = [];

  for (const group of WORKSPACE_CHANGE_GROUP_ORDER) {
    const groupEntries = grouping[group];
    if (groupEntries.length === 0) continue;
    rows.push({
      kind: "group",
      group,
      entry: null,
      count: groupEntries.length,
      selectable: false,
      selected: false,
    });
    for (const entry of groupEntries) {
      rows.push({
        kind: "change",
        group,
        entry,
        count: 0,
        selectable: true,
        selected: entry.id === selectedId,
      });
    }
  }

  const selectedIndex = rows.findIndex((row) => row.selected);
  return {
    rows,
    selectedId: selectedIndex === -1 ? null : selectedId,
    selectedIndex,
    summary: summarizeWorkspaceChanges(visible),
  };
}

/** Move the selection to the next/previous selectable change row. */
export function moveWorkspaceChangeSelection(
  rows: readonly WorkspaceChangesRow[],
  currentId: WorkspaceChangeResourceId | null,
  direction: "up" | "down",
): WorkspaceChangeResourceId | null {
  const selectable = rows.filter(
    (row): row is WorkspaceChangesRow & { entry: WorkspaceChangeEntry } =>
      row.selectable && row.entry !== null,
  );
  if (selectable.length === 0) return null;
  const step = direction === "down" ? 1 : -1;
  const currentIndex =
    currentId === null ? -1 : selectable.findIndex((row) => row.entry.id === currentId);
  if (currentIndex === -1) {
    return (direction === "down" ? selectable[0] : selectable[selectable.length - 1])!.entry.id;
  }
  const nextIndex = Math.min(selectable.length - 1, Math.max(0, currentIndex + step));
  return selectable[nextIndex]!.entry.id;
}
