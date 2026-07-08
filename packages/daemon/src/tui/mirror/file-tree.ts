/**
 * Pure model for the Files tab's one-level-expandable file list (M18.4). Like
 * {@link ./diff-model.ts}, the io (async `fs.readdir`) stays in app.tsx; the
 * ORDERING and the flat-tree splice/prune math live here so they unit-test as
 * tables.
 *
 * The list is a FLAT array of {@link FileNode}s carrying a `depth`; a directory
 * "expands" by splicing its freshly-read children in right after it and
 * "collapses" by removing the contiguous run of deeper rows. Dirs sort before
 * files, each group alphabetical (case-insensitive), so the tree reads the way
 * a file manager does.
 */

/** One row in the flat file list. `path` is absolute; `depth` is the indent
 *  level (0 = the context dir's immediate children). */
export interface FileNode {
  name: string;
  path: string;
  isDir: boolean;
  depth: number;
  expanded: boolean;
}

/** A raw `fs.readdir(..., { withFileTypes: true })` entry, reduced to what we
 *  need (kept minimal so callers can map Dirent → this trivially). */
export interface RawEntry {
  name: string;
  isDir: boolean;
}

/**
 * PURE — sort raw entries into display order: directories first, then files,
 * each group alphabetical case-insensitively (ties broken by raw name for
 * determinism). Dotfiles are kept (a hidden `.env` still matters to editing).
 */
export function sortEntries(entries: RawEntry[]): RawEntry[] {
  return [...entries].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    const an = a.name.toLowerCase();
    const bn = b.name.toLowerCase();
    if (an < bn) return -1;
    if (an > bn) return 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
}

/**
 * PURE — build the flat node list for a directory's `entries` at `depth`,
 * joining each name onto `dir` with a "/" (absolute-path aware; no node:path
 * dependency so this stays trivially testable).
 */
export function buildNodes(dir: string, entries: RawEntry[], depth: number): FileNode[] {
  const base = dir.endsWith("/") ? dir.slice(0, -1) : dir;
  return sortEntries(entries).map((e) => ({
    name: e.name,
    path: `${base}/${e.name}`,
    isDir: e.isDir,
    depth,
    expanded: false,
  }));
}

/**
 * PURE — expand the directory at `index` by marking it expanded and splicing
 * its `children` (already built at the parent's depth+1) in right after it.
 * A no-op (returns the list unchanged) when the row is missing, is not a
 * directory, or is already expanded.
 */
export function insertChildrenAt(
  list: FileNode[],
  index: number,
  children: FileNode[],
): FileNode[] {
  const parent = list[index];
  if (!parent || !parent.isDir || parent.expanded) return list;
  const next = [...list];
  next[index] = { ...parent, expanded: true };
  next.splice(index + 1, 0, ...children);
  return next;
}

/**
 * PURE — collapse the directory at `index` by marking it un-expanded and
 * removing the contiguous run of rows deeper than it (its whole subtree,
 * however many levels were expanded). A no-op when the row is missing, is not a
 * directory, or is not expanded.
 */
export function removeSubtreeAt(list: FileNode[], index: number): FileNode[] {
  const parent = list[index];
  if (!parent || !parent.isDir || !parent.expanded) return list;
  let end = index + 1;
  while (end < list.length && list[end]!.depth > parent.depth) end++;
  const next = [...list];
  next.splice(index + 1, end - (index + 1));
  next[index] = { ...parent, expanded: false };
  return next;
}
