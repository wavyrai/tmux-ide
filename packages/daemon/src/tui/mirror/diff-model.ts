/**
 * Pure, io-free helpers for the built-in git diff panel (M18.3; grouped +
 * stage-aware M24.5).
 *
 * Like {@link ./editor-buffer.ts}, this imports NOTHING from @opentui/core: the
 * app runs the git subprocesses (async execFile) and reads untracked files, but
 * the PARSING and coordinate math live here so they unit-test as tables under
 * the Node/vitest runner while app.tsx keeps the OpenTUI wiring.
 *
 * Concerns: (1) parse `git status --porcelain` into display-ready entries —
 * flat ({@link parseStatusPorcelain}, legacy) or split into Staged / Unstaged /
 * Untracked components ({@link parseStatusGroups}: an `MM` file yields BOTH a
 * staged and an unstaged row, each diffing its own side of the index); (2) lay
 * the grouped entries out as list ROWS (section headers + files) whose math is
 * shared by the render and the mouse router ({@link buildDiffRows}); (3) merge
 * `git diff --numstat` ± counts into the entries; (4) classify each `git diff`
 * line so the renderer can color it; (5) hunk coordinate math — `]`/`[` jump
 * targets and the `^e` open-editor-at-line target parsed from `@@ -a,b +c,d`;
 * (6) turn an untracked file's contents into an all-additions pseudo-diff (git
 * diff prints nothing for untracked paths).
 */

/** One changed file from `git status --porcelain`, display-ready. */
export interface StatusEntry {
  /** Single status letter for the list: M(odified) · A(dded) · D(eleted) ·
   *  R(enamed) · ?(untracked) · etc. Worktree state wins over index state so a
   *  file staged-then-edited still reads as M. */
  status: string;
  /** Repo-relative path (the NEW path for renames). */
  path: string;
  /** True when the index carries a change (a staged component exists). */
  staged: boolean;
}

/**
 * PURE — parse porcelain v1 output. Each line is `XY<space>PATH`, where X is the
 * index state and Y the worktree state; renames/copies render as `orig -> new`.
 * Untracked files come through as `??`. Malformed/short lines are skipped.
 */
export function parseStatusPorcelain(out: string): StatusEntry[] {
  const entries: StatusEntry[] = [];
  for (const line of out.split("\n")) {
    if (line.length < 4) continue;
    const index = line[0]!;
    const work = line[1]!;
    let rest = line.slice(3);
    const arrow = rest.indexOf(" -> ");
    if (arrow !== -1) rest = rest.slice(arrow + 4);
    const untracked = index === "?" && work === "?";
    const status = untracked ? "?" : work !== " " ? work : index;
    entries.push({ status, path: rest, staged: !untracked && index !== " " });
  }
  return entries;
}

/** How a unified-diff line renders: added / removed / hunk header / file-meta
 *  (diff/index/+++/---/mode/rename) / plain context. */
export type DiffLineKind = "add" | "del" | "hunk" | "meta" | "context";

/** One classified diff line: its kind and its raw text (leading sigil kept). */
export interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

const META_PREFIXES = [
  "diff ",
  "index ",
  "new file",
  "deleted file",
  "old mode",
  "new mode",
  "similarity ",
  "dissimilarity ",
  "rename ",
  "copy ",
  "Binary ",
  "\\ No newline",
];

/**
 * PURE — classify one raw diff line. Order matters: the `+++`/`---` file headers
 * must be caught as meta BEFORE the bare `+`/`-` add/del checks.
 */
export function classifyDiffLine(line: string): DiffLineKind {
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+++") || line.startsWith("---")) return "meta";
  for (const p of META_PREFIXES) if (line.startsWith(p)) return "meta";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "context";
}

/**
 * PURE — split a `git diff --no-color` blob into classified lines, dropping the
 * single trailing empty produced by the final newline.
 */
export function classifyDiff(diff: string): DiffLine[] {
  if (!diff) return [];
  const lines = diff.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.map((text) => ({ kind: classifyDiffLine(text), text }));
}

/**
 * PURE — render an untracked file's contents as an all-additions pseudo-diff
 * (git diff emits nothing for untracked paths). Each content line is prefixed
 * with `+` so {@link classifyDiff} colors it as an addition.
 */
export function untrackedDiffText(content: string): string {
  const lines = content.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.map((l) => "+" + l).join("\n");
}

/** PURE — clamp a selection index into `[0, count)` (0 when the list is empty). */
export function clampSel(sel: number, count: number): number {
  if (count <= 0) return 0;
  return Math.max(0, Math.min(sel, count - 1));
}

// ── Grouped list (M24.5) ─────────────────────────────────────────────────────

/** Which section of the grouped list an entry belongs to. */
export type DiffGroup = "staged" | "unstaged" | "untracked";

/** One stage-aware changed-file entry: a porcelain XY line is SPLIT into its
 *  index and worktree components, so an `MM` file yields two entries — the
 *  staged one diffs `--cached`, the unstaged one diffs the worktree. */
export interface DiffEntry {
  group: DiffGroup;
  /** Display letter for THIS component: the X (index) letter for staged rows,
   *  the Y (worktree) letter for unstaged rows, `?` for untracked. */
  status: string;
  /** Repo-relative path (the NEW path for renames). */
  path: string;
  /** ± line counts from `git diff --numstat` (untracked: the file's line
   *  count). `null` until loaded, and for binary/unreadable files. */
  additions: number | null;
  deletions: number | null;
}

/**
 * PURE — parse porcelain v1 output into grouped, stage-aware entries. Each
 * `XY PATH` line contributes: a STAGED entry when X is a real index state, an
 * UNSTAGED entry when Y is a real worktree state, or one UNTRACKED entry for
 * `??`. Ignored (`!!`) and malformed lines are skipped. Counts start `null`
 * ({@link applyCounts} fills them).
 */
export function parseStatusGroups(out: string): DiffEntry[] {
  const entries: DiffEntry[] = [];
  for (const line of out.split("\n")) {
    if (line.length < 4) continue;
    const index = line[0]!;
    const work = line[1]!;
    let rest = line.slice(3);
    const arrow = rest.indexOf(" -> ");
    if (arrow !== -1) rest = rest.slice(arrow + 4);
    if (index === "!" && work === "!") continue;
    if (index === "?" && work === "?") {
      entries.push({
        group: "untracked",
        status: "?",
        path: rest,
        additions: null,
        deletions: null,
      });
      continue;
    }
    if (index !== " " && index !== "?")
      entries.push({
        group: "staged",
        status: index,
        path: rest,
        additions: null,
        deletions: null,
      });
    if (work !== " " && work !== "?")
      entries.push({
        group: "unstaged",
        status: work,
        path: rest,
        additions: null,
        deletions: null,
      });
  }
  return entries;
}

/** PURE — narrow entries to paths containing `query` (case-insensitive
 *  substring). An empty/blank query returns the input unchanged. */
export function filterEntries(entries: DiffEntry[], query: string): DiffEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries;
  return entries.filter((e) => e.path.toLowerCase().includes(q));
}

/** One row of the grouped file list: a non-selectable section header or a file
 *  entry carrying its index into the flat selectable-file order. */
export type DiffRow =
  | { kind: "header"; group: DiffGroup; label: string }
  | { kind: "file"; entry: DiffEntry; fileIndex: number };

const GROUP_ORDER: { group: DiffGroup; label: string }[] = [
  { group: "staged", label: "Staged" },
  { group: "unstaged", label: "Unstaged" },
  { group: "untracked", label: "Untracked" },
];

/**
 * PURE — lay grouped entries out as list rows: per-group `Label (n)` headers
 * (only for non-empty groups, in Staged → Unstaged → Untracked order) followed
 * by that group's files. `files` is the flat selectable order — `fileIndex` on
 * each file row indexes it, so the selection model stays a plain integer while
 * the render/hit math walk ROWS. Shared render↔router, one source of truth.
 */
export function buildDiffRows(entries: DiffEntry[]): { rows: DiffRow[]; files: DiffEntry[] } {
  const rows: DiffRow[] = [];
  const files: DiffEntry[] = [];
  for (const { group, label } of GROUP_ORDER) {
    const members = entries.filter((e) => e.group === group);
    if (members.length === 0) continue;
    rows.push({ kind: "header", group, label: `${label} (${members.length})` });
    for (const entry of members) {
      rows.push({ kind: "file", entry, fileIndex: files.length });
      files.push(entry);
    }
  }
  return { rows, files };
}

/** PURE — the row index of selectable file `fileIndex` (for keeping the
 *  selection in view when the list scrolls over ROWS). -1 when absent. */
export function rowIndexOfFile(rows: DiffRow[], fileIndex: number): number {
  return rows.findIndex((r) => r.kind === "file" && r.fileIndex === fileIndex);
}

// ── numstat (M24.5) ──────────────────────────────────────────────────────────

/** ± line counts for one file. */
export interface Numstat {
  additions: number;
  deletions: number;
}

/** Resolve a numstat path cell to the NEW path: renames print either
 *  `pre{old => new}post` (common-prefix brace form) or a bare `old => new`. */
function numstatPath(raw: string): string {
  const brace = raw.match(/^(.*)\{(.*) => (.*)\}(.*)$/);
  if (brace) return `${brace[1]}${brace[3]}${brace[4]}`;
  const arrow = raw.indexOf(" => ");
  if (arrow !== -1) return raw.slice(arrow + 4);
  return raw;
}

/**
 * PURE — parse `git diff --numstat` output (`added<TAB>deleted<TAB>path`) into
 * a path → counts map. Binary files print `-	-	path` and are SKIPPED (their
 * entries keep `null` counts); rename cells resolve to the new path.
 */
export function parseNumstat(out: string): Map<string, Numstat> {
  const counts = new Map<string, Numstat>();
  for (const line of out.split("\n")) {
    if (!line) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const additions = parseInt(parts[0]!, 10);
    const deletions = parseInt(parts[1]!, 10);
    if (Number.isNaN(additions) || Number.isNaN(deletions)) continue; // binary: "-"
    counts.set(numstatPath(parts.slice(2).join("\t")), { additions, deletions });
  }
  return counts;
}

/** PURE — the line count an untracked file shows as its `+` count: content
 *  lines, with the single trailing newline's empty not counted (mirrors
 *  {@link untrackedDiffText}); empty content counts 0. */
export function untrackedLineCount(content: string): number {
  if (content === "") return 0;
  const lines = content.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.length;
}

/**
 * PURE — merge per-group counts into entries (staged entries read the
 * `--cached` numstat, unstaged the worktree numstat, untracked the line-count
 * map). Entries without a match keep `null` counts (binary/unreadable).
 */
export function applyCounts(
  entries: DiffEntry[],
  staged: Map<string, Numstat>,
  unstaged: Map<string, Numstat>,
  untrackedLines: Map<string, number>,
): DiffEntry[] {
  return entries.map((e) => {
    if (e.group === "untracked") {
      const lines = untrackedLines.get(e.path);
      return lines === undefined ? e : { ...e, additions: lines, deletions: 0 };
    }
    const n = (e.group === "staged" ? staged : unstaged).get(e.path);
    return n === undefined ? e : { ...e, additions: n.additions, deletions: n.deletions };
  });
}

/** PURE — sum the loaded ± counts across entries (nulls contribute 0), for the
 *  header totals. */
export function totalCounts(entries: DiffEntry[]): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const e of entries) {
    additions += e.additions ?? 0;
    deletions += e.deletions ?? 0;
  }
  return { additions, deletions };
}

// ── Hunk math (M24.5) ────────────────────────────────────────────────────────

/** A parsed `@@ -a,b +c,d @@` header (counts default 1 when omitted). */
export interface HunkHeader {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
}

/** PURE — parse a hunk header line; null for anything else. */
export function parseHunkHeader(text: string): HunkHeader | null {
  const m = text.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
  if (!m) return null;
  return {
    oldStart: parseInt(m[1]!, 10),
    oldCount: m[2] !== undefined ? parseInt(m[2], 10) : 1,
    newStart: parseInt(m[3]!, 10),
    newCount: m[4] !== undefined ? parseInt(m[4], 10) : 1,
  };
}

/** PURE — the indices of all hunk-header lines in a classified diff. */
export function hunkLineIndices(lines: DiffLine[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < lines.length; i++) if (lines[i]!.kind === "hunk") out.push(i);
  return out;
}

/** PURE — the `]`/`[` jump target: the first hunk-line index strictly after
 *  (`dir` 1) or before (`dir` -1) the current view top. null = no further hunk
 *  in that direction (the view stays put). */
export function nextHunkTop(lines: DiffLine[], top: number, dir: 1 | -1): number | null {
  const hunks = hunkLineIndices(lines);
  if (dir === 1) {
    for (const i of hunks) if (i > top) return i;
    return null;
  }
  for (let j = hunks.length - 1; j >= 0; j--) if (hunks[j]! < top) return hunks[j]!;
  return null;
}

/**
 * PURE — the `^e` open-editor target: the 0-based NEW-file line of the first
 * changed (add/del) line of the SELECTED hunk — the hunk whose header is at or
 * nearest above the current view top (the first hunk when the view is above
 * them all). Walks from `+c` counting context/add lines; a del line targets
 * the new-file position where the removal happened. Falls back to `c` itself
 * for a hunk with no explicit ± lines, and null when the diff has no hunks
 * (binary/meta-only/pseudo-diff — the caller opens at 0).
 */
export function hunkEditTarget(lines: DiffLine[], top: number): number | null {
  const hunks = hunkLineIndices(lines);
  if (hunks.length === 0) return null;
  let h = hunks[0]!;
  for (const i of hunks) {
    if (i <= top) h = i;
    else break;
  }
  const hdr = parseHunkHeader(lines[h]!.text);
  if (!hdr) return null;
  let newLine = hdr.newStart; // 1-based
  for (let i = h + 1; i < lines.length; i++) {
    const kind = lines[i]!.kind;
    if (kind === "hunk" || kind === "meta") break;
    if (kind === "add" || kind === "del") return Math.max(0, newLine - 1);
    newLine++; // context
  }
  return Math.max(0, hdr.newStart - 1);
}
