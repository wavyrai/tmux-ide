/**
 * Pure, io-free helpers for the built-in git diff panel (M18.3).
 *
 * Like {@link ./editor-buffer.ts}, this imports NOTHING from @opentui/core: the
 * app runs the git subprocesses (async execFile) and reads untracked files, but
 * the PARSING and coordinate math live here so they unit-test as tables under
 * the Node/vitest runner while app.tsx keeps the OpenTUI wiring.
 *
 * Three concerns: (1) parse `git status --porcelain` into a flat, display-ready
 * file list; (2) classify each `git diff` line so the renderer can color it; and
 * (3) turn an untracked file's contents into an all-additions pseudo-diff (git
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
