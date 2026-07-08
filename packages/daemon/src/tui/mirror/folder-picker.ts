/**
 * The "open a folder" picker's PURE model (M22.5) — the filesystem browser
 * behind the home screen's non-technical entry point. The picker is a
 * {@link ../mirror/dialog-stack.ts} DialogSelect flow: app.tsx does the async
 * `readdir`/`stat` (the header's async-only fs law) and drives the browse loop;
 * everything here — how a directory's entries become rows, how the breadcrumb
 * reads, how a typed path expands, how an invalid path is explained — is pure so
 * it unit-tests without OpenTUI or a filesystem.
 *
 * Row id scheme (what a chosen row dispatches on):
 *   picker:open            → open the folder we are browsing
 *   picker:hidden          → toggle whether dot-leading folders show
 *   picker:up              → ascend to the parent
 *   picker:type            → the "type a path…" escape hatch (a DialogPrompt)
 *   picker:dir:<name>      → descend into <name>
 *
 * The hidden-folders toggle is a ROW (not a ctrl chord): terminal-native,
 * `ctrl+h` is byte-identical to Backspace, so a chord can't carry it — and a
 * row is mouse-clickable and keyboard-selectable, which suits the audience.
 */
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { DialogSelectItem } from "./dialog-model.ts";

export const PICKER_OPEN_ID = "picker:open";
export const PICKER_HIDDEN_ID = "picker:hidden";
export const PICKER_UP_ID = "picker:up";
export const PICKER_TYPE_ID = "picker:type";
export const PICKER_DIR_PREFIX = "picker:dir:";

/** How many breadcrumb segments the title keeps before eliding the front with
 *  an ellipsis (deep paths stay one readable line). */
const BREADCRUMB_MAX_SEGMENTS = 4;

/** PURE — expand a user-typed path: a leading `~` (or `~/…`) becomes `home`,
 *  then relative paths resolve against `base`. An absolute path is returned as
 *  given (normalized). Blank input resolves to `base`. */
export function expandUserPath(input: string, home: string, base: string): string {
  const raw = input.trim();
  if (raw.length === 0) return base;
  if (raw === "~") return home;
  if (raw.startsWith("~/")) return join(home, raw.slice(2));
  if (isAbsolute(raw)) return resolve(raw);
  return resolve(base, raw);
}

/** PURE — the parent directory, stopping at the filesystem root (dirname of
 *  `/` is `/`). */
export function pickerParent(dir: string): string {
  return dirname(dir);
}

/** PURE — whether `dir` is the filesystem root (no higher parent). */
export function isPickerRoot(dir: string): boolean {
  return dirname(dir) === dir;
}

/** PURE — the subdirectory names to show: hidden (dot-leading) folders are
 *  dropped unless `showHidden`, `.`/`..` never appear, and the rest sort
 *  case-insensitively so the list reads like a file manager. */
export function filterDirs(names: readonly string[], showHidden: boolean): string[] {
  return names
    .filter((n) => n !== "." && n !== "..")
    .filter((n) => showHidden || !n.startsWith("."))
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

/** PURE — a compact breadcrumb for the dialog title: the home prefix collapses
 *  to `~`, segments join with ` › `, and a path deeper than
 *  {@link BREADCRUMB_MAX_SEGMENTS} elides its front with `…`. The root shows as
 *  `/`. */
export function pickerBreadcrumb(dir: string, home: string): string {
  let rest = dir;
  let head = "";
  if (home.length > 0 && (dir === home || dir.startsWith(`${home}/`))) {
    head = "~";
    rest = dir.slice(home.length);
  }
  const segs = rest.split("/").filter(Boolean);
  const parts = head ? [head, ...segs] : segs;
  if (parts.length === 0) return "/";
  if (parts.length <= BREADCRUMB_MAX_SEGMENTS) return parts.join(" › ");
  return ["…", ...parts.slice(parts.length - BREADCRUMB_MAX_SEGMENTS)].join(" › ");
}

/** PURE — the picker rows for a directory: an explicit "open this folder" row
 *  first, then the hidden-folders toggle, the ascend row (unless at the root),
 *  the subdirectories (already filtered/sorted by {@link filterDirs}), and the
 *  "type a path…" escape hatch last. Descending happens on a `picker:dir:*` /
 *  `picker:up` row; opening on `picker:open`; the toggle flips `showHidden`. */
export function pickerRows(
  dir: string,
  subdirs: readonly string[],
  showHidden: boolean,
): DialogSelectItem[] {
  const rows: DialogSelectItem[] = [
    { id: PICKER_OPEN_ID, label: "＋ Open this folder", detail: basename(dir) || dir },
    {
      id: PICKER_HIDDEN_ID,
      label: showHidden ? "Hide hidden folders" : "Show hidden folders",
      detail: showHidden ? "on" : "off",
    },
  ];
  if (!isPickerRoot(dir)) rows.push({ id: PICKER_UP_ID, label: "..", detail: "up a level" });
  for (const name of subdirs) rows.push({ id: `${PICKER_DIR_PREFIX}${name}`, label: `${name}/` });
  rows.push({ id: PICKER_TYPE_ID, label: "Type a path…", detail: "enter a folder path" });
  return rows;
}

/** PURE — the subdirectory name a `picker:dir:*` row descends into, or null for
 *  any other id. */
export function pickerDirName(id: string): string | null {
  return id.startsWith(PICKER_DIR_PREFIX) ? id.slice(PICKER_DIR_PREFIX.length) : null;
}

/** The three outcomes of stat-ing a typed path. */
export type PathKind = "dir" | "file" | "missing";

/** PURE — the plain-language footer error for a typed path that isn't a folder
 *  (never called for `"dir"` — that path is accepted). */
export function pathKindHint(kind: "file" | "missing"): string {
  return kind === "file"
    ? "That's a file, not a folder — pick a directory"
    : "No folder there — check the path and try again";
}
