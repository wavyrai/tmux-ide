/** Renderer-facing terminal shapes. The canonical parser lives in the daemon. */
import type { GraphemeOverride } from "./blit.ts";
import type { TerminalPaletteProjection } from "./theme.ts";

/** A run of same-styled text within a row. Colors are packed 0xRRGGBB. */
export interface StyledRun {
  text: string;
  /** Foreground as packed RGB, or null for the terminal default. */
  fg: number | null;
  /** Background as packed RGB, or null for the terminal default. */
  bg: number | null;
  /** OpenTUI TextAttributes bitmask. */
  attributes: number;
}

export interface MirrorSnapshot {
  rows: StyledRun[][];
  cursorX: number;
  cursorY: number;
  /** How many lines above the live viewport this snapshot starts (0 = live). */
  scrollOffset: number;
}

/** The live cursor state a surface needs to drive the hardware cursor (M21.6). */
export interface CursorState {
  /** Grid column/row of the cursor within the visible viewport. */
  x: number;
  y: number;
  /** DECTCEM — the app hid the cursor (`CSI ?25 l`). */
  hidden: boolean;
  /** DECSCUSR shape, xterm's vocabulary. */
  style: "block" | "underline" | "bar";
  /** DECSCUSR blink flag. */
  blink: boolean;
}

/** Per-call inputs for incremental terminal cell projection. */
export interface BlitOptions {
  viewportOrigin?: { readonly x: number; readonly y: number };
  /** Stable retained surface identity. Semantic replicas permit one painter so
   * row dirtiness cannot be consumed by a sibling framebuffer. */
  consumerId?: object;
  /** Repaint every visible row and refill the shadow (first frame, resize, a
   *  scrolled/searching view, or any time the framebuffer may be out of sync). */
  full: boolean;
  /** Extra rows to repaint regardless of the content compare — the caller's
   *  selection/search churn (the union of the old and new highlighted rows). */
  forceRows?: readonly number[] | null;
  /** OUT — the rows actually written this call. The caller clears it first and
   *  re-applies its selection/search post-passes over exactly these rows. */
  dirtyRows: number[];
  /** OUT — multi-codepoint grapheme cells to re-write via `setCell`. */
  graphemes?: GraphemeOverride[];
  /** Optional renderer-owned palette projection. The xterm grid retains its
   *  source SGR values; this affects only the pixels written for this frame. */
  palette?: TerminalPaletteProjection;
}
