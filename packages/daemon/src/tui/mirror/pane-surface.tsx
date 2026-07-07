/**
 * PaneSurface — one framebuffer renderable per mirror pane (M21.3).
 *
 * The native-feel render core: instead of a triple-nested `<For>` (panes → rows →
 * styled runs → `<text>`) rebuilt every tick, each pane is ONE
 * `FrameBufferRenderable`. On a content/scroll/selection change it blits the
 * pane's xterm-headless grid straight into its `OptimizedBuffer`'s packed typed
 * arrays ({@link PaneMirror.blit}) — no `StyledRun[]`, no Solid subtree churn, no
 * per-run `RGBA`. This kills the three measured render taxes in one move.
 *
 * The blit is GATED: renderSelf only re-walks the grid when a reactive prop
 * actually changed (each setter flips `_needsWalk` + `requestRender`), so an idle
 * pane costs one native framebuffer composite, not a grid walk. Selection tint and
 * scrollback-search highlight are a post-pass over the blitted cells; the cursor
 * inverse rides inside the blit. Chrome (borders, the scroll badge, the scrollbar)
 * stays Solid JSX in the parent — only cell CONTENT lives here.
 *
 * MOUSE: no `onMouse` here. Per the app.tsx mouse-architecture header, the two
 * region containers own hit-testing via `routeMouse`; this renderable is a
 * handler-less content layer that bubbles (0.4.3 confirmed).
 */
import {
  FrameBufferRenderable,
  RGBA,
  type OptimizedBuffer,
  type RenderContext,
  type RenderableOptions,
} from "@opentui/core";
import { extend } from "@opentui/solid";
import { appendFileSync } from "node:fs";
import type { SessionMirror } from "./session-mirror.ts";
import { swapCells, paintBg, type GraphemeOverride } from "./blit.ts";
import { rowSelectionRange, type Cell } from "./selection.ts";
import type { SearchMatch } from "./search-model.ts";

/** The scrollback-search highlight payload for one pane: matches keyed by
 *  ABSOLUTE buffer line (mapped to a visible row via `baseY`), the query length,
 *  and which match index is the "current" (brighter) one. */
export interface PaneSearchHighlight {
  matches: readonly SearchMatch[];
  current: number;
  len: number;
  /** Visible row = `match.line − baseY` (pane depth − scroll offset). */
  baseY: number;
}

export interface PaneSurfaceOptions extends RenderableOptions<FrameBufferRenderable> {
  width: number;
  height: number;
  mirror: SessionMirror;
  paneId: string;
  /** Packed `0xRRGGBB` for the terminal default fg/bg (a cell whose color is null). */
  defaultFg: number;
  defaultBg: number;
  /** Packed `0xRRGGBB` for a search match bg / the current-match bg. */
  searchHl: number;
  searchCur: number;
  scrollOffset?: number;
  paneFocused?: boolean;
  /** Bumps (coalesced, once per state tick) when this pane's content changed. */
  contentVersion?: number;
  /** The drag selection on THIS pane (already surface/pane-filtered), or null. */
  selRange?: { start: Cell; end: Cell } | null;
  search?: PaneSearchHighlight | null;
}

const rgbaCache = new Map<number, RGBA>();
function packedRgba(packed: number): RGBA {
  let c = rgbaCache.get(packed);
  if (!c) {
    c = RGBA.fromInts((packed >> 16) & 0xff, (packed >> 8) & 0xff, packed & 0xff, 255);
    rgbaCache.set(packed, c);
  }
  return c;
}

const PERF = !!process.env.TMUX_IDE_ZZ_PERF;
/** Log the rows-blitted count per walk (M21.4 acceptance: flood repaints only
 *  dirty rows). Env-gated so it costs nothing in production. */
const ROW_TAP = !!process.env.TMUX_IDE_FB_ROWS;

/** Union of several row-index arrays into one deduped array (small arrays — a
 *  linear membership check is cheaper than a Set here). */
function unionRows(...groups: number[][]): number[] {
  const out: number[] = [];
  for (const g of groups) for (const r of g) if (!out.includes(r)) out.push(r);
  return out;
}

class PaneSurfaceRenderable extends FrameBufferRenderable {
  // The OpenTUI/Solid reconciler constructs `new PaneSurfaceRenderable(ctx, {id})`
  // and applies EVERY other prop afterward via these setters — so the constructor
  // must default the framebuffer size (like the reference renderable) and each
  // field must have a safe default until its setter fires.
  private _mirror: SessionMirror | null = null;
  private _paneId = "";
  private _defaultFg = 0xd4d4d8;
  private _defaultBg = 0x101016;
  private _defaultFgRgba: RGBA = packedRgba(0xd4d4d8);
  private _defaultBgRgba: RGBA = packedRgba(0x101016);
  private _searchHl = 0;
  private _searchCur = 0;
  private _scrollOffset = 0;
  private _focusedPane = false;
  private _contentVersion = -1;
  private _sel: { start: Cell; end: Cell } | null = null;
  private _search: PaneSearchHighlight | null = null;
  private _needsWalk = true;
  private readonly _graphemes: GraphemeOverride[] = [];
  // ── Incremental walk state (M21.4) ─────────────────────────────────────────
  /** Force a full repaint next walk (first frame, resize — the framebuffer is
   *  blank so the mirror's shadow must be refilled). */
  private _forceFull = true;
  private _lastScroll = -1;
  private _lastFocused = false;
  /** Rows the selection/search highlighted last walk — repainted this walk so a
   *  vacated highlight's fg/bg swap is cleared, not stranded. */
  private _prevSelRows: number[] = [];
  private _prevSearchRows: number[] = [];
  /** Reused out-array for the rows the blit wrote (its content-dirty ∪ forced). */
  private readonly _dirtyRows: number[] = [];

  constructor(ctx: RenderContext, options: PaneSurfaceOptions) {
    // Default 1×1 — the real size arrives as the width/height layout props (base
    // Renderable setters) which drive onResize → framebuffer resize.
    const width = typeof options.width === "number" ? Math.max(1, options.width) : 1;
    const height = typeof options.height === "number" ? Math.max(1, options.height) : 1;
    super(ctx, { ...options, width, height, respectAlpha: false });
  }

  // ── Constant props (delivered via setters post-construction, then stable). ──
  set mirror(v: SessionMirror) {
    this._mirror = v;
    this._needsWalk = true;
  }
  set paneId(v: string) {
    if (v === this._paneId) return;
    this._paneId = v;
    this.invalidate();
  }
  set defaultFg(v: number) {
    this._defaultFg = v;
    this._defaultFgRgba = packedRgba(v);
  }
  set defaultBg(v: number) {
    this._defaultBg = v;
    this._defaultBgRgba = packedRgba(v);
  }
  set searchHl(v: number) {
    this._searchHl = v;
  }
  set searchCur(v: number) {
    this._searchCur = v;
  }

  // ── Reactive props: a change flips _needsWalk so the next paint re-blits. ──
  set scrollOffset(v: number) {
    if (v === this._scrollOffset) return;
    this._scrollOffset = v;
    this.invalidate();
  }
  set paneFocused(v: boolean) {
    if (v === this._focusedPane) return;
    this._focusedPane = v;
    this.invalidate();
  }
  set contentVersion(v: number) {
    if (v === this._contentVersion) return;
    this._contentVersion = v;
    this.invalidate();
  }
  set selRange(v: { start: Cell; end: Cell } | null) {
    // Objects arrive only when selection() actually changed (or cleared to null).
    if (v === null && this._sel === null) return;
    this._sel = v;
    this.invalidate();
  }
  set search(v: PaneSearchHighlight | null) {
    if (v === null && this._search === null) return;
    this._search = v;
    this.invalidate();
  }

  private invalidate(): void {
    this._needsWalk = true;
    this.requestRender();
  }

  protected override onResize(width: number, height: number): void {
    super.onResize(width, height);
    // The framebuffer was reallocated (blank) — the next paint must repaint it
    // in full (and the mirror refills its shadow).
    this._needsWalk = true;
    this._forceFull = true;
  }

  protected override renderSelf(buffer: OptimizedBuffer): void {
    if (!this.visible || this.isDestroyed) return;
    if (this._needsWalk) {
      this._needsWalk = false;
      this.walk();
    }
    super.renderSelf(buffer);
  }

  /** The gated grid walk (M21.4 — incremental): the mirror repaints only the
   *  changed rows (content compare + scroll shift); we force-repaint the rows the
   *  selection/search touched (old ∪ new) so a vacated highlight's fg/bg swap is
   *  cleared, then re-apply the search + selection post-passes over the current
   *  highlighted rows. Timed to /tmp/zz-perf.log under TMUX_IDE_ZZ_PERF (the blit
   *  path's "snapshot ms/tick"); the rows-blitted count taps to a debug log. */
  private walk(): void {
    if (!this._mirror) return;
    const t0 = PERF ? performance.now() : 0;
    const fb = this.frameBuffer;
    const buffers = fb.buffers;
    const w = fb.width;
    const h = fb.height;

    // View-wide changes force a full repaint; content dirtiness is the mirror's job.
    const full =
      this._forceFull || this._scrollOffset !== this._lastScroll || this._focusedPane !== this._lastFocused;
    this._forceFull = false;
    this._lastScroll = this._scrollOffset;
    this._lastFocused = this._focusedPane;

    const newSelRows = this.selRows(h);
    const newSearchRows = this.searchRows(h);
    // Rows that must repaint so their swap/highlight is cleared then re-applied.
    const forceRows = full ? null : unionRows(this._prevSelRows, newSelRows, this._prevSearchRows, newSearchRows);

    this._graphemes.length = 0;
    this._dirtyRows.length = 0;
    this._mirror.blitPane(this._paneId, buffers, w, h, this._scrollOffset, this._focusedPane, this._defaultFg, this._defaultBg, {
      full,
      forceRows,
      dirtyRows: this._dirtyRows,
      graphemes: this._graphemes,
    });

    // Multi-codepoint graphemes (ZWJ/flag emoji, combining marks) — the native
    // setCell handles the full string + its width; rare, so the RGBA is fine.
    for (let i = 0; i < this._graphemes.length; i++) {
      const g = this._graphemes[i]!;
      fb.setCell(
        g.x,
        g.y,
        g.chars,
        g.fg === null ? this._defaultFgRgba : packedRgba(g.fg),
        g.bg === null ? this._defaultBgRgba : packedRgba(g.bg),
        g.attrs,
      );
    }
    // Post-passes re-apply over the current highlighted rows — all of which were
    // just repainted (they're in forceRows, or full covered them).
    const s = this._search;
    if (s && s.len > 0) {
      for (let i = 0; i < s.matches.length; i++) {
        const m = s.matches[i]!;
        const row = m.line - s.baseY;
        if (row < 0 || row >= h) continue;
        paintBg(buffers, w, row, m.col, m.col + s.len - 1, i === s.current ? this._searchCur : this._searchHl);
      }
    }
    const sel = this._sel;
    if (sel) {
      for (let i = 0; i < newSelRows.length; i++) {
        const y = newSelRows[i]!;
        const r = rowSelectionRange(y, w, sel.start, sel.end);
        if (r) swapCells(buffers, w, y, r.from, r.to);
      }
    }
    this._prevSelRows = newSelRows;
    this._prevSearchRows = newSearchRows;

    if (PERF) {
      try {
        appendFileSync("/tmp/zz-perf.log", `${(performance.now() - t0).toFixed(2)}\n`);
      } catch {
        /* perf tap only */
      }
    }
    if (ROW_TAP) {
      try {
        appendFileSync("/tmp/zz-fb-rows.log", `${this._paneId} ${this._dirtyRows.length}/${h}${full ? " full" : ""}\n`);
      } catch {
        /* debug tap only */
      }
    }
  }

  /** Visible rows covered by the current drag selection (clamped), or []. The
   *  range arrives ordered (app.tsx passes `orderCells`). */
  private selRows(height: number): number[] {
    const sel = this._sel;
    if (!sel) return [];
    const lo = Math.max(0, sel.start.row);
    const hi = Math.min(height - 1, sel.end.row);
    const out: number[] = [];
    for (let y = lo; y <= hi; y++) out.push(y);
    return out;
  }

  /** Distinct visible rows carrying a search match (clamped), or []. */
  private searchRows(height: number): number[] {
    const s = this._search;
    if (!s || s.len === 0) return [];
    const out: number[] = [];
    for (let i = 0; i < s.matches.length; i++) {
      const row = s.matches[i]!.line - s.baseY;
      if (row >= 0 && row < height && !out.includes(row)) out.push(row);
    }
    return out;
  }
}

declare module "@opentui/solid" {
  interface OpenTUIComponents {
    pane_surface: typeof PaneSurfaceRenderable;
  }
}

let registered = false;
/** Register `<pane_surface>` in the OpenTUI component catalogue. Idempotent, and
 *  exported as a real value call so app.tsx can invoke it — a bare side-effect
 *  `import "./pane-surface"` gets dead-code-eliminated by the transpiler, which
 *  left the tag unregistered and the reconciler throwing "Unknown component
 *  type: pane_surface" at render (measured). A value call can't be elided. */
export function registerPaneSurface(): void {
  if (registered) return;
  registered = true;
  extend({ pane_surface: PaneSurfaceRenderable });
}

export { PaneSurfaceRenderable };
