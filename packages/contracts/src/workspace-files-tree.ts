import type {
  WorkspaceFileEntry,
  WorkspaceFileEntryKind,
  WorkspaceFileGitStatus,
} from "./workspace-files-resource.ts";
import type {
  WorkspaceFileResourceId,
  WorkspaceRelativeDisplayPath,
} from "./workspace-resource-identity.ts";

/**
 * Pure explorer-tree projection over daemon-issued file catalogs.
 *
 * The daemon returns one catalog of direct children per directory, each keyed
 * by an opaque id. These functions fold a set of loaded catalogs and the
 * renderer's expansion/selection state into a flat, ordered row list. They are
 * deliberately free of I/O, absolute paths, and host lifecycle: every input is
 * an already-validated contract value and every output is derived from it.
 */

export const WORKSPACE_FILE_TREE_MAX_ROWS = 20_000;

/** Direct children of one directory, as returned by a files catalog. */
export interface WorkspaceFileTreeCatalog {
  directoryId: WorkspaceFileResourceId;
  entries: readonly WorkspaceFileEntry[];
}

export interface WorkspaceFileTreeInput {
  rootId: WorkspaceFileResourceId;
  catalogs: readonly WorkspaceFileTreeCatalog[];
  expandedIds?: Iterable<WorkspaceFileResourceId>;
  selectedId?: WorkspaceFileResourceId | null;
}

export interface WorkspaceFileTreeRow {
  id: WorkspaceFileResourceId;
  parentId: WorkspaceFileResourceId;
  name: string;
  relativePath: WorkspaceRelativeDisplayPath;
  kind: WorkspaceFileEntryKind;
  depth: number;
  gitStatus: WorkspaceFileGitStatus | null;
  hidden: boolean;
  ignored: boolean;
  /** A directory that advertises children and can therefore be opened. */
  expandable: boolean;
  expanded: boolean;
  /** Whether this directory's own catalog is present in the input. */
  childrenLoaded: boolean;
  selected: boolean;
}

export interface WorkspaceFileTreeView {
  rows: WorkspaceFileTreeRow[];
  selectedId: WorkspaceFileResourceId | null;
  selectedIndex: number;
  /** True when the row cap or a cycle cut the walk short. */
  truncated: boolean;
}

/** Directories precede files, then a stable case-insensitive name order. */
export function compareWorkspaceFileEntries(a: WorkspaceFileEntry, b: WorkspaceFileEntry): number {
  const aDir = a.kind === "directory";
  const bDir = b.kind === "directory";
  if (aDir !== bDir) return aDir ? -1 : 1;
  const aName = a.name.toLowerCase();
  const bName = b.name.toLowerCase();
  if (aName < bName) return -1;
  if (aName > bName) return 1;
  if (a.name < b.name) return -1;
  if (a.name > b.name) return 1;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

export function sortWorkspaceFileEntries(
  entries: readonly WorkspaceFileEntry[],
): WorkspaceFileEntry[] {
  return [...entries].sort(compareWorkspaceFileEntries);
}

export function flattenWorkspaceFileTree(input: WorkspaceFileTreeInput): WorkspaceFileTreeView {
  const byDirectory = new Map<string, readonly WorkspaceFileEntry[]>();
  for (const catalog of input.catalogs) byDirectory.set(catalog.directoryId, catalog.entries);

  const expanded = new Set<string>(input.expandedIds ?? []);
  const selectedId = input.selectedId ?? null;
  const rows: WorkspaceFileTreeRow[] = [];
  const onPath = new Set<string>();
  let truncated = false;

  const walk = (directoryId: string, depth: number): void => {
    if (onPath.has(directoryId)) {
      truncated = true;
      return;
    }
    const entries = byDirectory.get(directoryId);
    if (entries === undefined) return;
    onPath.add(directoryId);
    for (const entry of sortWorkspaceFileEntries(entries)) {
      if (rows.length >= WORKSPACE_FILE_TREE_MAX_ROWS) {
        truncated = true;
        break;
      }
      const isDirectory = entry.kind === "directory";
      const isExpanded = isDirectory && entry.hasChildren && expanded.has(entry.id);
      rows.push({
        id: entry.id,
        parentId: entry.parentId,
        name: entry.name,
        relativePath: entry.relativePath,
        kind: entry.kind,
        depth,
        gitStatus: entry.gitStatus,
        hidden: entry.hidden,
        ignored: entry.ignored,
        expandable: isDirectory && entry.hasChildren,
        expanded: isExpanded,
        childrenLoaded: byDirectory.has(entry.id),
        selected: entry.id === selectedId,
      });
      if (isExpanded) walk(entry.id, depth + 1);
    }
    onPath.delete(directoryId);
  };

  walk(input.rootId, 0);

  const selectedIndex =
    selectedId === null ? -1 : rows.findIndex((row) => row.id === selectedId);
  return {
    rows,
    selectedId: selectedIndex === -1 ? null : selectedId,
    selectedIndex,
    truncated,
  };
}

/** Toggle (or force, via `next`) a directory's membership in the expanded set. */
export function toggleWorkspaceFileExpansion(
  expandedIds: Iterable<WorkspaceFileResourceId>,
  id: WorkspaceFileResourceId,
  next?: boolean,
): Set<WorkspaceFileResourceId> {
  const set = new Set<WorkspaceFileResourceId>(expandedIds);
  const shouldExpand = next ?? !set.has(id);
  if (shouldExpand) set.add(id);
  else set.delete(id);
  return set;
}

/** Move the selection one visible row up or down, clamping at the ends. */
export function moveWorkspaceFileSelection(
  rows: readonly WorkspaceFileTreeRow[],
  currentId: WorkspaceFileResourceId | null,
  direction: "up" | "down",
): WorkspaceFileResourceId | null {
  if (rows.length === 0) return null;
  const step = direction === "down" ? 1 : -1;
  const currentIndex = currentId === null ? -1 : rows.findIndex((row) => row.id === currentId);
  if (currentIndex === -1) {
    return (direction === "down" ? rows[0] : rows[rows.length - 1])!.id;
  }
  const nextIndex = Math.min(rows.length - 1, Math.max(0, currentIndex + step));
  return rows[nextIndex]!.id;
}
