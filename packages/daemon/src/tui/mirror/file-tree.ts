/**
 * Pure model for the Files tab's expandable file list (M18.4, uplifted M24.6).
 * Like {@link ./diff-model.ts}, the io (async `fs.readdir`, git subprocesses,
 * the `ignore` matcher fed from .gitignore) stays in app.tsx; the ORDERING, the
 * flat-tree splice/prune math, the ignore/hidden FILTERING, the git-status
 * DECORATION merge, the changed-file WALK for `[`/`]`, the `/` FILTER view and
 * the expansion-preserving REBUILD all live here so they unit-test as tables.
 *
 * The list is a FLAT array of {@link FileNode}s carrying a `depth`; a directory
 * "expands" by splicing its freshly-read children in right after it and
 * "collapses" by removing the contiguous run of deeper rows. Dirs sort before
 * files, each group alphabetical (case-insensitive), so the tree reads the way
 * a file manager does.
 */

/** Names that are NEVER listed, whatever the toggles say (the explorer
 *  widget's battle-tested list — build artifacts and VCS internals that would
 *  only bury the code). */
export const ALWAYS_IGNORE: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  "dist",
  "build",
  "out",
  ".next",
  ".turbo",
  ".cache",
  "__pycache__",
  "coverage",
  ".nyc_output",
  "target",
  "vendor",
  "bower_components",
]);

/** One row in the flat file list. `path` is absolute; `depth` is the indent
 *  level (0 = the context dir's immediate children). `ignored` marks a
 *  gitignored entry — visible only when the I toggle shows them, dimmed. */
export interface FileNode {
  name: string;
  path: string;
  isDir: boolean;
  depth: number;
  expanded: boolean;
  ignored: boolean;
}

/** A raw `fs.readdir(..., { withFileTypes: true })` entry, reduced to what we
 *  need (kept minimal so callers can map Dirent → this trivially). `ignored`
 *  is stamped by the caller's gitignore matcher (io stays outside). */
export interface RawEntry {
  name: string;
  isDir: boolean;
  ignored?: boolean;
}

/** The two Files-surface visibility toggles (both default OFF = filtered). */
export interface ListFilter {
  /** Show dotfiles (H). */
  showHidden: boolean;
  /** Show gitignored entries (I) — they render dimmed. */
  showIgnored: boolean;
}

/**
 * PURE — drop the entries the current toggles hide: {@link ALWAYS_IGNORE}
 * names always, dotfiles unless `showHidden`, gitignored entries (as stamped
 * by the caller) unless `showIgnored`.
 */
export function filterEntries(entries: readonly RawEntry[], filter: ListFilter): RawEntry[] {
  return entries.filter((e) => {
    if (ALWAYS_IGNORE.has(e.name)) return false;
    if (!filter.showHidden && e.name.startsWith(".")) return false;
    if (!filter.showIgnored && e.ignored) return false;
    return true;
  });
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
    ignored: e.ignored ?? false,
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

// ── M24.6 — decoration, changed walk, filter view, rebuild ──────────────────

/** PURE — `abs` relative to `root` ("" when equal or not under root). Both are
 *  plain string paths; a trailing slash on root is tolerated. */
export function relPath(root: string, abs: string): string {
  const base = root.endsWith("/") ? root.slice(0, -1) : root;
  if (abs === base) return "";
  return abs.startsWith(base + "/") ? abs.slice(base.length + 1) : "";
}

/** PURE — every ancestor DIRECTORY of a repo-relative path, outermost first:
 *  `a/b/c.ts` → `["a", "a/b"]`. A top-level path has none. */
export function ancestorDirs(rel: string): string[] {
  const out: string[] = [];
  let idx = rel.indexOf("/");
  while (idx !== -1) {
    out.push(rel.slice(0, idx));
    idx = rel.indexOf("/", idx + 1);
  }
  return out;
}

/**
 * PURE — the per-path git status map from parsed porcelain entries
 * (repo-relative `path` + one-letter `status`), with the explorer widget's
 * parent-dir propagation: every ancestor directory inherits the FIRST child
 * status seen, so a collapsed dir still shows that something changed inside.
 */
export function statusMapFromEntries(
  entries: readonly { path: string; status: string }[],
): Map<string, string> {
  const map = new Map<string, string>();
  for (const file of entries) {
    map.set(file.path, file.status);
    let parent = file.path;
    while (parent.includes("/")) {
      parent = parent.slice(0, parent.lastIndexOf("/"));
      if (!map.has(parent)) map.set(parent, file.status);
    }
  }
  return map;
}

/** PURE — compare two repo-relative paths in TREE DISPLAY order: walk the
 *  segments; where they diverge, a directory component (more segments follow)
 *  sorts before a terminal file segment — matching {@link sortEntries}'
 *  dirs-first, case-insensitive ordering. */
export function treePathCompare(a: string, b: string): number {
  const as = a.split("/");
  const bs = b.split("/");
  const n = Math.min(as.length, bs.length);
  for (let i = 0; i < n; i++) {
    const aDir = i < as.length - 1;
    const bDir = i < bs.length - 1;
    const av = as[i]!;
    const bv = bs[i]!;
    if (av === bv && aDir && bDir) continue;
    // At the divergence point a directory component sorts before a file
    // segment, regardless of name (dirs-first display order).
    if (aDir !== bDir) return aDir ? -1 : 1;
    const al = av.toLowerCase();
    const bl = bv.toLowerCase();
    if (al !== bl) return al < bl ? -1 : 1;
    if (av !== bv) return av < bv ? -1 : 1;
  }
  return as.length - bs.length;
}

/**
 * PURE — the ordered changed-FILE walk for `[`/`]`: the porcelain entries'
 * paths, deduped, minus anything the surface can never show (a DELETED file
 * has no row at all, an {@link ALWAYS_IGNORE} segment or a dot segment while
 * hidden files are off is filtered out — hopping to an unrevealable row would
 * strand the selection and wedge the chain), sorted in tree display order.
 */
export function changedFileWalk(
  entries: readonly { path: string; status?: string }[],
  opts: { showHidden: boolean },
): string[] {
  const seen = new Set<string>();
  for (const e of entries) {
    if (!e.path) continue;
    if (e.status === "D") continue;
    const segs = e.path.split("/");
    if (segs.some((s) => ALWAYS_IGNORE.has(s))) continue;
    if (!opts.showHidden && segs.some((s) => s.startsWith("."))) continue;
    seen.add(e.path);
  }
  return [...seen].sort(treePathCompare);
}

/**
 * PURE — the next/previous changed path from `current` (repo-relative, or null
 * when the selection is nowhere useful), wrapping around. `current` need not
 * be IN the walk — the step lands on the nearest entry in walk order, so a hop
 * from an unchanged file between two changed ones does the right thing.
 */
export function nextChangedPath(
  walk: readonly string[],
  current: string | null,
  dir: 1 | -1,
): string | null {
  if (walk.length === 0) return null;
  if (current === null) return dir === 1 ? walk[0]! : walk[walk.length - 1]!;
  if (dir === 1) {
    for (const p of walk) if (treePathCompare(p, current) > 0) return p;
    return walk[0]!;
  }
  for (let i = walk.length - 1; i >= 0; i--) {
    if (treePathCompare(walk[i]!, current) < 0) return walk[i]!;
  }
  return walk[walk.length - 1]!;
}

/** One visible row of the `/`-filtered tree: the node plus its index into the
 *  UNDERLYING flat list (so activation/expansion math still applies there). */
export interface FilteredRow {
  node: FileNode;
  index: number;
}

/**
 * PURE — the `/` filter view over the flat list: rows whose NAME contains the
 * query case-insensitively, each carrying its underlying index. A null or
 * empty query is "filter off" — every row, in order. The list itself is never
 * touched, so expanded state trivially survives the filter.
 */
export function filterView(list: readonly FileNode[], query: string | null): FilteredRow[] {
  if (!query) return list.map((node, index) => ({ node, index }));
  const q = query.toLowerCase();
  const out: FilteredRow[] = [];
  for (let index = 0; index < list.length; index++) {
    const node = list[index]!;
    if (node.name.toLowerCase().includes(q)) out.push({ node, index });
  }
  return out;
}

/** PURE — the index of `path` in the flat list, or -1. */
export function indexOfPath(list: readonly FileNode[], path: string): number {
  for (let i = 0; i < list.length; i++) if (list[i]!.path === path) return i;
  return -1;
}

/**
 * PURE — rebuild the whole flat tree from fresh directory listings while
 * PRESERVING expansion: `listing` maps a directory's absolute path → its
 * fresh (already filtered/annotated) entries, `expanded` is the set of dir
 * paths that were expanded before the refresh. A dir stays expanded only when
 * it survived the refresh AND its fresh listing was provided; a vanished or
 * newly-hidden dir simply drops out. Keys must be the exact `FileNode.path`
 * strings (and the root exactly as passed).
 */
export function rebuildTree(
  rootDir: string,
  listing: ReadonlyMap<string, readonly RawEntry[]>,
  expanded: ReadonlySet<string>,
): FileNode[] {
  const walk = (dir: string, depth: number): FileNode[] => {
    const ents = listing.get(dir);
    if (!ents) return [];
    const out: FileNode[] = [];
    for (const node of buildNodes(dir, [...ents], depth)) {
      if (node.isDir && expanded.has(node.path) && listing.has(node.path)) {
        out.push({ ...node, expanded: true }, ...walk(node.path, depth + 1));
      } else {
        out.push(node);
      }
    }
    return out;
  };
  return walk(rootDir, 0);
}
