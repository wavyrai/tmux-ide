/**
 * Dialog primitives — the PURE model (M22.4). Types + geometry + filtering for
 * the three dialogs every setting is built from: {@link DialogSelectSpec} (a
 * filterable list with a ● current-value marker and per-row key actions),
 * {@link DialogPromptSpec} (one text input with validation), and
 * {@link DialogConfirmSpec} (two options). The STACK that runs them lives in
 * {@link ./dialog-stack.ts}; app.tsx mounts ONE overlay for whatever is on top.
 *
 * Geometry follows the palette's law (M21.9): the overlay is app-rendered, so
 * its full geometry is knowable by pure math shared between the RENDER
 * (placement) and the central mouse ROUTER (row hit-test / inside-vs-outside)
 * — a click can never land where a row isn't drawn. Layout, in screen rows
 * from `top`:
 *   border (top+0) · title (top+1) · [filter input, select only] · rule ·
 *   body rows (confirm only) · list/content rows … · footer hints · border.
 * Rows span the box interior in x: [left+1, left+width-1).
 */
import { fuzzyFilter } from "../team/fuzzy.ts";

// ── Specs ────────────────────────────────────────────────────────────────────

/** One row of a select dialog. */
export interface DialogSelectItem {
  /** Stable id the caller dispatches on. */
  id: string;
  /** What the list shows and the fuzzy filter scores. */
  label: string;
  /** Dim, right-aligned annotation (current value, key name, …). */
  detail?: string;
  /** The current value — rendered with the ● marker. */
  current?: boolean;
  /** Destructive — enter/click arms an inline "press again to confirm" first. */
  danger?: boolean;
  /** Optional RGB swatch rendered as a colored ● before the label (theme rows). */
  swatch?: [number, number, number];
}

/** A per-row action bound to a ctrl+key chord, shown in the footer. */
export interface DialogRowAction {
  /** The letter — triggered as ctrl+<key> so it never collides with filter typing. */
  key: string;
  /** Footer label, e.g. `^d delete`. */
  label: string;
}

export interface DialogSelectSpec {
  kind: "select";
  title: string;
  items: DialogSelectItem[];
  /** Type-to-filter (default true). Read-only viewers keep it on for search. */
  filterable?: boolean;
  /** Plain-language footer note (e.g. "applies after re-adopt — run tmux-ide adopt <session>"). */
  footerHint?: string;
  /** Per-row key-bound actions listed in the footer. */
  actions?: DialogRowAction[];
  /** Live-preview hook — fired by the stack whenever the SELECTION lands on a
   *  different item (keyboard and mouse both), never on open. */
  onMove?: (item: DialogSelectItem) => void;
  /** Start the selection here (defaults to the `current` item, else 0). */
  initialSel?: number;
}

export interface DialogPromptSpec {
  kind: "prompt";
  title: string;
  /** Dim example shown while the input is empty. */
  placeholder?: string;
  /** Pre-filled input. */
  initial?: string;
  /** Plain-language footer note shown while there is no error. */
  footerHint?: string;
  /** Return an error message to reject, null to accept. */
  validate?: (value: string) => string | null;
}

export interface DialogConfirmSpec {
  kind: "confirm";
  title: string;
  /** Optional explanation line(s) — wrapped to the box width. */
  body?: string;
  /** First option (the affirmative). Default "Yes". */
  yesLabel?: string;
  /** Second option. Default "No". */
  noLabel?: string;
  /** Start on the second option (the safe default for destructive asks). */
  defaultNo?: boolean;
}

export type DialogSpec = DialogSelectSpec | DialogPromptSpec | DialogConfirmSpec;

/** What a select resolves with: the chosen item, plus the action key when a
 *  per-row ctrl+key action (not enter/click) triggered it. */
export interface DialogSelectResult {
  item: DialogSelectItem;
  action?: string;
}

// ── Constants ────────────────────────────────────────────────────────────────

/** Box width — matches the palette so the two overlays read as one family. */
export const DIALOG_W = 60;
/** Visible list rows before the wheel/follow-scroll windows the slice. */
export const DIALOG_ROWS = 10;
/** The inline destructive re-arm suffix (plain language, no modal). */
export const DIALOG_CONFIRM_SUFFIX = " — press again to confirm";
/** The current-value marker. */
export const DIALOG_CURRENT_MARK = "●";

// ── Filtering / selection ────────────────────────────────────────────────────

/** PURE — the visible rows for a query: fuzzy-filtered + score-sorted (the
 *  palette's idiom); an empty query returns every item in natural order. */
export function filterDialogItems(
  query: string,
  items: readonly DialogSelectItem[],
): DialogSelectItem[] {
  const q = query.trim();
  if (q.length === 0) return [...items];
  return fuzzyFilter(q, [...items], (i) => i.label).map((m) => m.item);
}

/** PURE — where the selection starts: `initialSel` when valid, else the
 *  `current` item, else 0. */
export function initialSelIndex(spec: DialogSelectSpec): number {
  if (
    spec.initialSel !== undefined &&
    spec.initialSel >= 0 &&
    spec.initialSel < spec.items.length
  ) {
    return spec.initialSel;
  }
  const cur = spec.items.findIndex((i) => i.current);
  return cur >= 0 ? cur : 0;
}

/** PURE — keep `sel` visible: the window `top` that contains it, moving as
 *  little as possible (keyboard follow-scroll; the wheel moves `top` alone). */
export function followTop(sel: number, top: number, pageRows: number): number {
  if (sel < top) return sel;
  if (sel > top + pageRows - 1) return sel - pageRows + 1;
  return top;
}

/** PURE — clamp a wheel-scrolled list top into [0, count - pageRows]. */
export function clampDialogTop(top: number, count: number, pageRows: number): number {
  return Math.max(0, Math.min(top, count - pageRows));
}

// ── Geometry ─────────────────────────────────────────────────────────────────

/** The placed box + the row bands the router hit-tests. */
export interface DialogGeom {
  left: number;
  top: number;
  width: number;
  /** Chrome rows above the first hit-testable row: top border + title +
   *  (filter input) + rule + (confirm body). */
  headerRows: number;
  /** Hit-testable rows on screen right now (select window / confirm options /
   *  the prompt's input row). 0 renders one non-hittable placeholder row. */
  visibleRows: number;
  /** Footer hint rows (always 1 — hints/errors live there). */
  footerRows: number;
}

/** PURE — placement: horizontally centered, top at a sixth of the height
 *  (min 1 — below the surface tab bar). Same law as the palette. */
export function dialogPos(
  termW: number,
  termH: number,
  width: number,
): { left: number; top: number } {
  return {
    left: Math.max(0, Math.floor((termW - width) / 2)),
    top: Math.max(1, Math.floor(termH / 6)),
  };
}

/** PURE — greedy word-wrap for the confirm body (never returns empty for
 *  non-empty text; words longer than the width hard-break). */
export function wrapText(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const out: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (line.length === 0) {
        let w = word;
        while (w.length > width) {
          out.push(w.slice(0, width));
          w = w.slice(width);
        }
        line = w;
      } else if (line.length + 1 + word.length <= width) {
        line += ` ${word}`;
      } else {
        out.push(line);
        let w = word;
        while (w.length > width) {
          out.push(w.slice(0, width));
          w = w.slice(width);
        }
        line = w;
      }
    }
    if (line.length > 0 || para.length === 0) out.push(line);
  }
  return out.length > 0 ? out : [""];
}

/** PURE — the interior text width of the box (borders + 1-cell padding each side). */
export function dialogInnerW(width: number): number {
  return width - 4;
}

/** PURE — chrome rows above the first hit-testable row, per kind. */
export function dialogHeaderRows(spec: DialogSpec): number {
  // top border + title + rule = 3 …
  if (spec.kind === "select") return spec.filterable === false ? 3 : 4; // … + filter input
  if (spec.kind === "prompt") return 3;
  return 3 + (spec.body ? wrapText(spec.body, dialogInnerW(DIALOG_W)).length : 0);
}

/** PURE — total box height for a geometry (empty lists still show one
 *  placeholder row) — used for inside/outside containment. */
export function dialogHeight(g: DialogGeom): number {
  return g.headerRows + Math.max(1, g.visibleRows) + g.footerRows + 1;
}

/** PURE — the VISIBLE hit-testable row index under (x, y), or -1. x must be
 *  inside the box interior (borders excluded); only real rows hit. */
export function dialogRowAt(g: DialogGeom, x: number, y: number): number {
  if (x < g.left + 1 || x >= g.left + g.width - 1) return -1;
  const row = y - (g.top + g.headerRows);
  return row >= 0 && row < g.visibleRows ? row : -1;
}

/** PURE — whether (x, y) falls anywhere on the box (border included). A press
 *  outside pops ONE stack level; inside-but-not-a-row is a no-op. */
export function dialogContains(g: DialogGeom, x: number, y: number): boolean {
  return x >= g.left && x < g.left + g.width && y >= g.top && y < g.top + dialogHeight(g);
}

// ── Row / footer text ────────────────────────────────────────────────────────

/** PURE — a select row's leading marker: `● ` on the current value (kept even
 *  while selected — the value marker is the point), else `› `/2 spaces. */
export function dialogMarker(item: { current?: boolean }, selected: boolean): string {
  if (item.current) return `${DIALOG_CURRENT_MARK} `;
  return selected ? "› " : "  ";
}

/** PURE — a select row's body text: marker + label (+ the inline destructive
 *  re-arm suffix when armed), with `detail` right-aligned in the interior
 *  width; overlong labels truncate before the detail. */
export function dialogRowText(
  item: DialogSelectItem,
  opts: { selected: boolean; armed: boolean; innerW: number },
): string {
  const marker = dialogMarker(item, opts.selected);
  const label = opts.armed ? `${item.label}${DIALOG_CONFIRM_SUFFIX}` : item.label;
  const detail = opts.armed ? "" : (item.detail ?? "");
  const bodyW = opts.innerW - marker.length;
  if (detail.length === 0) return marker + label.slice(0, bodyW).padEnd(bodyW);
  const labelW = Math.max(1, bodyW - detail.length - 2);
  return `${marker}${label.slice(0, labelW).padEnd(labelW)}  ${detail}`.slice(0, opts.innerW);
}

/** PURE — the select footer: key hints first, then the per-row actions, then
 *  the caller's plain-language note. */
export function selectFooter(spec: DialogSelectSpec): string {
  const parts = ["enter select", "esc cancel"];
  for (const a of spec.actions ?? []) parts.push(`^${a.key} ${a.label}`);
  if (spec.footerHint) parts.push(spec.footerHint);
  return parts.join(" · ");
}

/** PURE — the prompt footer: a busy note wins, then the validation error, then
 *  the hint, then the default keys line. The `error` flag tells the render to
 *  tint it as a problem. */
export function promptFooter(
  spec: DialogPromptSpec,
  state: { error: string | null; busy: boolean },
): { text: string; error: boolean } {
  if (state.busy) return { text: "saving…", error: false };
  if (state.error) return { text: state.error, error: true };
  return { text: spec.footerHint ?? "enter save · esc cancel", error: false };
}

/** PURE — the confirm footer. */
export function confirmFooter(): string {
  return "enter choose · y/n · esc cancel";
}

/** PURE — the confirm option labels in row order (affirmative first). */
export function confirmOptions(spec: DialogConfirmSpec): [string, string] {
  return [spec.yesLabel ?? "Yes", spec.noLabel ?? "No"];
}
