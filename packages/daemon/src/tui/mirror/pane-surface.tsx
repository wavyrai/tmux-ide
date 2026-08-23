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
import type { CursorState } from "./pane-mirror.ts";
import type { BlitOptions } from "./pane-mirror.ts";
import {
  CHAR_CONTINUATION,
  swapCells,
  paintBg,
  type CellArrays,
  type GraphemeOverride,
} from "./blit.ts";
import { rowSelectionRange, visibleSelRows, type Cell } from "./selection.ts";
import type { SearchMatch } from "./search-model.ts";
import type { TerminalPaletteProjection } from "./theme.ts";
import {
  currentTuiPerformanceEventSink,
  type TuiTerminalFocusPaintEvent,
} from "./performance-events.ts";

function framebufferColor(channels: Uint16Array, offset: number, defaultColor: number): string {
  const value = (channels[offset]! << 16) | (channels[offset + 1]! << 8) | channels[offset + 2]!;
  return value === defaultColor ? "default" : `rgb:${value.toString(16).padStart(6, "0")}`;
}

/** Detailed-only normalized projection of the cells actually handed to OpenTUI. */
export function projectPaneFramebufferCells(
  buffers: CellArrays,
  width: number,
  height: number,
  graphemes: readonly GraphemeOverride[],
  defaultFg: number,
  defaultBg: number,
): readonly Readonly<Record<string, unknown>>[] {
  const overrides = new Map(graphemes.map((value) => [`${value.x}:${value.y}`, value.chars]));
  const projection: Readonly<Record<string, unknown>>[] = [];
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const index = row * width + column;
      const codepoint = buffers.char[index]!;
      const continuation =
        codepoint === CHAR_CONTINUATION && column > 0 && buffers.char[index - 1] !== 0x20;
      if (codepoint === 0x20 || (codepoint === CHAR_CONTINUATION && !continuation)) continue;
      const nextContinuation = column + 1 < width && buffers.char[index + 1] === CHAR_CONTINUATION;
      const chars = continuation
        ? ""
        : (overrides.get(`${column}:${row}`) ?? String.fromCodePoint(codepoint));
      const colorOffset = index * 4;
      projection.push(
        Object.freeze({
          row,
          column,
          chars,
          width: continuation ? 0 : nextContinuation ? 2 : 1,
          foreground: framebufferColor(buffers.fg, colorOffset, defaultFg),
          background: framebufferColor(buffers.bg, colorOffset, defaultBg),
          attributes: buffers.attributes[index]!,
        }),
      );
    }
  }
  return Object.freeze(projection);
}

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
  mirror: TerminalPaneRenderSource;
  paneId: string;
  /** Packed `0xRRGGBB` for the terminal default fg/bg (a cell whose color is null). */
  defaultFg: number;
  defaultBg: number;
  /** Theme-owned ANSI/truecolor projection applied during the framebuffer blit. */
  terminalPalette: TerminalPaletteProjection;
  /** Packed `0xRRGGBB` for a search match bg / the current-match bg. */
  searchHl: number;
  searchCur: number;
  scrollOffset?: number;
  paneFocused?: boolean;
  /** Bumps (coalesced, once per state tick) when this pane's content changed. */
  contentVersion?: number;
  /** Bumps when canonical presentation changed without terminal cell damage. */
  presentationVersion?: number;
  /** Retained-source generation; forces a full blit even when content version restarts equal. */
  sourceEpoch?: number;
  /** Generation-host renderer epoch, distinct from the pane source epoch sum. */
  rendererEpoch?: number;
  hostFocusTransitionOwner?: PaneSurfaceHostFocusTransitionOwner;
  /** The drag selection on THIS pane (already surface/pane-filtered and
   *  ordered), or null. ABSOLUTE buffer lines (M25.6): the walk maps them to
   *  visible rows per-frame against the pane's live baseY (depth − offset), so
   *  the highlight stays glued to its content while the view scrolls. */
  selRange?: { start: Cell; end: Cell } | null;
  search?: PaneSearchHighlight | null;
}

/**
 * Renderer-facing hot-path port implemented by the semantic runtime delivery
 * adapter. Keeping this port deliberately tiny prevents transport or immutable
 * replica snapshots from entering Solid.
 */
export interface TerminalPaneRenderSource {
  scrollbackDepth(paneId: string): number;
  cursorState(paneId: string): CursorState | null;
  blitPane(
    paneId: string,
    buffers: CellArrays,
    width: number,
    height: number,
    scrollOffset: number,
    defaultFg: number,
    defaultBg: number,
    options: BlitOptions,
  ): TerminalPaintTrace | null;
  releasePane?(paneId: string, consumerId: object): void;
  /** Called only after the exact canonical cells/cursor have been applied. */
  acknowledgePresentation?(paneId: string, viewportCols: number, viewportRows: number): void;
  cursorPresentationTrace?(paneId: string): TerminalPaintTrace | null;
  paneCanonicalIdentity?(paneId: string): Readonly<{
    generation: string;
    incarnation: string;
    revision: number;
    stateHash: string;
    cols: number;
    rows: number;
    sourceEpoch: number;
    /** Generation-local count of canonical history rows trimmed after the retained seed. */
    historyTrim?: number;
  }> | null;
}

export interface TerminalPaintTrace {
  readonly traceId: string;
  readonly generation: string;
  readonly incarnation: string;
  readonly semanticPaneId: string;
  readonly revision: number;
  readonly stateHash: string;
}

const hardwareCursorOwner = new WeakMap<RenderContext, PaneSurfaceRenderable>();
export type PaneSurfaceHostFocusTransition = Readonly<{
  token: number;
  diagnosticEpoch: number;
  semanticPaneId: string;
  focused: boolean;
  rendererEpoch: number;
  sourceEpoch: number;
  generation: string;
  daemonGeneration: string;
  clientGeneration: number;
  incarnation: string;
  revision: number;
  stateHash: string;
  cols: number;
  rows: number;
}>;

export interface PaneSurfaceHostFocusTransitionOwner {
  arm(transition: Omit<PaneSurfaceHostFocusTransition, "token">): number | null;
  pending(token: number): boolean;
  cancel(token?: number): void;
  cancelPane(semanticPaneId: string): void;
  claim(
    transition: Omit<
      PaneSurfaceHostFocusTransition,
      "token" | "diagnosticEpoch" | "daemonGeneration" | "clientGeneration"
    >,
  ): PaneSurfaceHostFocusTransition | null;
  complete(token: number, event: TuiTerminalFocusPaintEvent): boolean;
  completed(token: number): Readonly<{
    transition: PaneSurfaceHostFocusTransition;
    event: TuiTerminalFocusPaintEvent;
  }> | null;
  retire(token: number): void;
  dispose(): void;
}

export function qualifiesPaneSurfaceHostFocusFrame(
  completed: NonNullable<ReturnType<PaneSurfaceHostFocusTransitionOwner["completed"]>>,
  current: Readonly<{
    semanticPaneId: string;
    focused: boolean;
    rendererEpoch: number;
    daemonGeneration: string;
    clientGeneration: number;
    identity: NonNullable<
      ReturnType<NonNullable<TerminalPaneRenderSource["paneCanonicalIdentity"]>>
    >;
  }>,
): boolean {
  const { event, transition } = completed;
  const { identity } = current;
  return (
    current.semanticPaneId === event.semanticPaneId &&
    current.focused === event.focused &&
    current.rendererEpoch === event.rendererEpoch &&
    current.daemonGeneration === transition.daemonGeneration &&
    current.clientGeneration === transition.clientGeneration &&
    identity.generation === event.generation &&
    identity.incarnation === event.incarnation &&
    identity.revision === event.revision &&
    identity.stateHash === event.stateHash &&
    identity.cols === event.cols &&
    identity.rows === event.rows &&
    identity.sourceEpoch === event.sourceEpoch
  );
}

export function createPaneSurfaceHostFocusTransitionOwner(
  onCompleted: (() => void) | null = null,
): PaneSurfaceHostFocusTransitionOwner {
  let pending: PaneSurfaceHostFocusTransition | null = null;
  let completed: Readonly<{
    token: number;
    transition: PaneSurfaceHostFocusTransition;
    event: TuiTerminalFocusPaintEvent;
  }> | null = null;
  let nextToken = 0;
  let disposed = false;
  const exact = (
    candidate: Omit<
      PaneSurfaceHostFocusTransition,
      "token" | "diagnosticEpoch" | "daemonGeneration" | "clientGeneration"
    >,
  ) =>
    pending !== null &&
    pending.semanticPaneId === candidate.semanticPaneId &&
    pending.focused === candidate.focused &&
    pending.rendererEpoch === candidate.rendererEpoch &&
    pending.sourceEpoch === candidate.sourceEpoch &&
    pending.generation === candidate.generation &&
    pending.incarnation === candidate.incarnation &&
    pending.revision === candidate.revision &&
    pending.stateHash === candidate.stateHash &&
    pending.cols === candidate.cols &&
    pending.rows === candidate.rows;
  return Object.freeze({
    arm(transition: Omit<PaneSurfaceHostFocusTransition, "token">) {
      if (
        disposed ||
        !Number.isSafeInteger(transition.diagnosticEpoch) ||
        transition.diagnosticEpoch <= 0 ||
        typeof transition.semanticPaneId !== "string" ||
        transition.semanticPaneId.length === 0 ||
        transition.semanticPaneId.length > 128 ||
        !Number.isSafeInteger(transition.rendererEpoch) ||
        transition.rendererEpoch < 0 ||
        !Number.isSafeInteger(transition.sourceEpoch) ||
        transition.sourceEpoch < 0 ||
        typeof transition.generation !== "string" ||
        transition.generation.length === 0 ||
        transition.generation.length > 128 ||
        transition.daemonGeneration !== transition.generation ||
        !Number.isSafeInteger(transition.clientGeneration) ||
        transition.clientGeneration < 0 ||
        typeof transition.incarnation !== "string" ||
        transition.incarnation.length === 0 ||
        transition.incarnation.length > 128 ||
        !Number.isSafeInteger(transition.revision) ||
        transition.revision < 0 ||
        typeof transition.stateHash !== "string" ||
        !/^[0-9a-f]{16}$/u.test(transition.stateHash) ||
        !Number.isSafeInteger(transition.cols) ||
        transition.cols <= 0 ||
        !Number.isSafeInteger(transition.rows) ||
        transition.rows <= 0 ||
        nextToken >= Number.MAX_SAFE_INTEGER
      )
        return null;
      nextToken += 1;
      completed = null;
      pending = Object.freeze({ ...transition, token: nextToken });
      return nextToken;
    },
    pending(token: number) {
      return pending?.token === token;
    },
    cancel(token?: number) {
      if (token === undefined || pending?.token === token) pending = null;
      if (token === undefined || completed?.token === token) completed = null;
    },
    cancelPane(semanticPaneId: string) {
      if (pending?.semanticPaneId === semanticPaneId) pending = null;
      if (completed?.event.semanticPaneId === semanticPaneId) completed = null;
    },
    claim(
      candidate: Omit<
        PaneSurfaceHostFocusTransition,
        "token" | "diagnosticEpoch" | "daemonGeneration" | "clientGeneration"
      >,
    ) {
      if (!exact(candidate)) return null;
      return pending;
    },
    complete(token: number, event: TuiTerminalFocusPaintEvent) {
      if (pending?.token !== token) return false;
      const transition = pending;
      pending = null;
      completed = Object.freeze({ token, transition, event });
      try {
        onCompleted?.();
      } catch {
        // Diagnostic follow-up rendering never owns focus presentation.
      }
      return true;
    },
    completed(token: number) {
      return completed?.token === token
        ? Object.freeze({ transition: completed.transition, event: completed.event })
        : null;
    },
    retire(token: number) {
      if (completed?.token === token) completed = null;
    },
    dispose() {
      disposed = true;
      pending = null;
      completed = null;
    },
  });
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
  private _mirror: TerminalPaneRenderSource | null = null;
  private _paneId = "";
  private _defaultFg = 0xd4d4d8;
  private _defaultBg = 0x101016;
  private _defaultFgRgba: RGBA = packedRgba(0xd4d4d8);
  private _defaultBgRgba: RGBA = packedRgba(0x101016);
  private _terminalPalette: TerminalPaletteProjection | undefined;
  private _searchHl = 0;
  private _searchCur = 0;
  private _cursorMarker = 0x3b4250;
  private _scrollOffset = 0;
  private _focusedPane = false;
  private _contentVersion = -1;
  private _presentationVersion = -1;
  private _sourceEpoch = -1;
  private _rendererEpoch = -1;
  private _hostFocusTransitionOwner: PaneSurfaceHostFocusTransitionOwner | null = null;
  private _sel: { start: Cell; end: Cell } | null = null;
  private _search: PaneSearchHighlight | null = null;
  private _needsWalk = true;
  private _needsCursorPresentation = false;
  private _gridRowsReadTotal = 0;
  private _fullWalkTotal = 0;
  private _presentationCount = 0;
  private readonly _graphemes: GraphemeOverride[] = [];
  // ── Incremental walk state (M21.4) ─────────────────────────────────────────
  /** Force a full repaint next walk (first frame, resize — the framebuffer is
   *  blank so the mirror's shadow must be refilled). */
  private _forceFull = true;
  private _lastScroll = -1;
  /** Rows the selection/search highlighted last walk — repainted this walk so a
   *  vacated highlight's fg/bg swap is cleared, not stranded. */
  private _prevSelRows: number[] = [];
  private _prevSearchRows: number[] = [];
  /** Reused out-array for the rows the blit wrote (its content-dirty ∪ forced). */
  private readonly _dirtyRows: number[] = [];
  /** The row an unfocused cursor marker last painted on, so a move/clear repaints
   *  the vacated row (M21.6). */
  private _lastMarkerRow = -1;
  private _pendingFocusTransition: PaneSurfaceHostFocusTransition | null = null;

  constructor(ctx: RenderContext, options: PaneSurfaceOptions) {
    // Default 1×1 — the real size arrives as the width/height layout props (base
    // Renderable setters) which drive onResize → framebuffer resize.
    const width = typeof options.width === "number" ? Math.max(1, options.width) : 1;
    const height = typeof options.height === "number" ? Math.max(1, options.height) : 1;
    super(ctx, { ...options, width, height, respectAlpha: false });
  }

  // ── Constant props (delivered via setters post-construction, then stable). ──
  set mirror(v: TerminalPaneRenderSource) {
    if (v === this._mirror) return;
    this.cancelPendingFocusTransition();
    this._mirror?.releasePane?.(this._paneId, this);
    this._mirror = v;
    this._forceFull = true;
    this.invalidate();
  }
  set paneId(v: string) {
    if (v === this._paneId) return;
    this.cancelPendingFocusTransition();
    this._mirror?.releasePane?.(this._paneId, this);
    this._paneId = v;
    this._forceFull = true;
    this.invalidate();
  }
  set defaultFg(v: number) {
    if (v === this._defaultFg) return;
    this._defaultFg = v;
    this._defaultFgRgba = packedRgba(v);
    this._forceFull = true;
    this.invalidate();
  }
  set defaultBg(v: number) {
    if (v === this._defaultBg) return;
    this._defaultBg = v;
    this._defaultBgRgba = packedRgba(v);
    this._forceFull = true;
    this.invalidate();
  }
  set terminalPalette(v: TerminalPaletteProjection) {
    if (v === this._terminalPalette) return;
    this._terminalPalette = v;
    this._cursorMarker = v.cursorMarker;
    // The xterm cell-data shadow intentionally contains source colors, so its
    // bytes do not change with the theme. Force one repaint to recolor every
    // existing cell and scrollback row visible in this surface.
    this._forceFull = true;
    this.invalidate();
  }
  set searchHl(v: number) {
    if (v === this._searchHl) return;
    this._searchHl = v;
    this.invalidate();
  }
  set searchCur(v: number) {
    if (v === this._searchCur) return;
    this._searchCur = v;
    this.invalidate();
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
    let transition: PaneSurfaceHostFocusTransition | null = null;
    const focusOwner = this._hostFocusTransitionOwner;
    if (focusOwner) {
      try {
        const identity = this._mirror?.paneCanonicalIdentity?.(this._paneId);
        transition = identity
          ? focusOwner.claim({
              semanticPaneId: this._paneId,
              focused: v,
              rendererEpoch: this._rendererEpoch,
              ...identity,
            })
          : null;
      } catch {
        // Detailed focus correlation never owns the renderer's focus transition.
      }
    }
    if (transition) this._pendingFocusTransition = transition;
    if (!v) this.releaseHardwareCursor();
    this.invalidate();
  }
  set contentVersion(v: number) {
    if (v === this._contentVersion) return;
    this._contentVersion = v;
    this.invalidate();
  }
  set presentationVersion(v: number) {
    if (v === this._presentationVersion) return;
    this._presentationVersion = v;
    this._needsCursorPresentation = true;
    this.requestRender();
  }
  set sourceEpoch(v: number) {
    if (v === this._sourceEpoch) return;
    this._pendingFocusTransition = null;
    try {
      this._hostFocusTransitionOwner?.cancelPane(this._paneId);
    } catch {
      // Detailed focus correlation never owns source replacement.
    }
    this._sourceEpoch = v;
    this._forceFull = true;
    this.invalidate();
  }
  set rendererEpoch(v: number) {
    if (v === this._rendererEpoch) return;
    this._pendingFocusTransition = null;
    try {
      this._hostFocusTransitionOwner?.cancelPane(this._paneId);
    } catch {
      // Detailed focus correlation never owns renderer replacement.
    }
    this._rendererEpoch = v;
  }
  set hostFocusTransitionOwner(v: PaneSurfaceHostFocusTransitionOwner | null | undefined) {
    if (v !== this._hostFocusTransitionOwner) this.cancelPendingFocusTransition();
    this._hostFocusTransitionOwner = v ?? null;
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
    } else if (this._needsCursorPresentation) {
      this.applyCursorOnlyPresentation();
    }
    super.renderSelf(buffer);
  }

  /** The gated grid walk (M21.4 — incremental): the mirror repaints only the
   *  changed rows (content compare + scroll shift); we force-repaint the rows the
   *  selection/search touched (old ∪ new) so a vacated highlight's fg/bg swap is
   *  cleared, then re-apply the search + selection post-passes over the current
   *  highlighted rows. */
  private walk(): void {
    if (!this._mirror) return;
    const performanceSink = currentTuiPerformanceEventSink();
    const paintStartedAt = performanceSink ? performance.now() : 0;
    const fb = this.frameBuffer;
    const buffers = fb.buffers;
    const w = fb.width;
    const h = fb.height;

    // View-wide changes force a full repaint; content dirtiness is the mirror's
    // job. Focus is deliberately NOT view-wide: the old/new cursor-marker rows
    // below are the only framebuffer cells it can change, while pane chrome and
    // the hardware cursor live outside the terminal cell buffer.
    const full = this._forceFull || this._scrollOffset !== this._lastScroll;
    this._forceFull = false;
    this._lastScroll = this._scrollOffset;

    // The view's absolute→visible mapping (M25.6), re-read every walk: both the
    // selection (absolute cells) and the search matches (absolute lines) resolve
    // to visible rows against the CURRENT baseY, so a scroll — or new content
    // pushing the depth — moves the highlights with their text. Same clamping as
    // the blit's own offset math (depth here == viewportY there).
    const depth = this._mirror.scrollbackDepth(this._paneId);
    const baseY = depth - Math.min(Math.max(0, this._scrollOffset), depth);
    const newSelRows = this.selRows(h, baseY);
    const newSearchRows = this.searchRows(h);
    // The live cursor (M21.6): the focused pane drives the hardware cursor; an
    // unfocused pane paints a quiet marker on its cursor cell. Read once.
    const cur = this._mirror.cursorState(this._paneId);
    const markerRow =
      cur && !this._focusedPane && !cur.hidden && this._scrollOffset === 0 && cur.x < w && cur.y < h
        ? cur.y
        : -1;
    // Rows that must repaint so their swap/highlight/marker is cleared then
    // re-applied (old ∪ new selection/search + old ∪ new marker row).
    const forceRows = full
      ? null
      : unionRows(
          this._prevSelRows,
          newSelRows,
          this._prevSearchRows,
          newSearchRows,
          markerRow >= 0 ? [markerRow] : [],
          this._lastMarkerRow >= 0 ? [this._lastMarkerRow] : [],
        );

    this._graphemes.length = 0;
    this._dirtyRows.length = 0;
    const paintTrace = this._mirror.blitPane(
      this._paneId,
      buffers,
      w,
      h,
      this._scrollOffset,
      this._defaultFg,
      this._defaultBg,
      {
        consumerId: this,
        full,
        forceRows,
        dirtyRows: this._dirtyRows,
        graphemes: this._graphemes,
        palette: this._terminalPalette,
      },
    );
    if (performanceSink?.terminalCursorPresentation) {
      this._gridRowsReadTotal += full ? h : this._dirtyRows.length;
      if (full) this._fullWalkTotal += 1;
    }

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
        paintBg(
          buffers,
          w,
          row,
          m.col,
          m.col + s.len - 1,
          i === s.current ? this._searchCur : this._searchHl,
        );
      }
    }
    const sel = this._sel;
    if (sel) {
      for (let i = 0; i < newSelRows.length; i++) {
        const y = newSelRows[i]!;
        const r = rowSelectionRange(baseY + y, w, sel.start, sel.end);
        if (r) swapCells(buffers, w, y, r.from, r.to);
      }
    }
    // Unfocused quiet cursor marker — a muted block on the cursor cell (its row
    // is in forceRows, so it was freshly repainted this walk).
    if (markerRow >= 0 && cur) {
      paintBg(buffers, w, markerRow, cur.x, cur.x, this._cursorMarker);
    }
    this._lastMarkerRow = markerRow;
    this._prevSelRows = newSelRows;
    this._prevSearchRows = newSearchRows;

    const framebufferProjectionSink = performanceSink?.terminalFramebufferProjection;
    if (framebufferProjectionSink) {
      try {
        const identity = this._mirror.paneCanonicalIdentity?.(this._paneId);
        if (identity) {
          const projection = projectPaneFramebufferCells(
            buffers,
            w,
            h,
            this._graphemes,
            this._defaultFg,
            this._defaultBg,
          );
          framebufferProjectionSink({
            traceId: paintTrace?.traceId ?? null,
            processId: `opentui:${process.pid}`,
            clockId: "opentui-performance-now",
            clockKind: "performance-now",
            atMicros: Math.floor(performance.now() * 1_000),
            semanticPaneId: this._paneId,
            generation: identity.generation,
            incarnation: identity.incarnation,
            revision: identity.revision,
            stateHash: identity.stateHash,
            cols: identity.cols,
            rows: identity.rows,
            sourceEpoch: identity.sourceEpoch,
            rendererEpoch: this._rendererEpoch,
            cellCount: projection.length,
            wideContinuationCount: projection.filter(({ width }) => width === 0).length,
            combiningCount: projection.filter(
              ({ chars }) => typeof chars === "string" && /\p{Mark}/u.test(chars),
            ).length,
            styledCellCount: projection.filter(
              ({ foreground, background, attributes }) =>
                foreground !== "default" || background !== "default" || attributes !== 0,
            ).length,
            projection: JSON.stringify(projection),
          });
        }
      } catch {
        // Detailed framebuffer evidence never owns native presentation.
      }
    }

    this.updateHardwareCursor(cur, w, h);
    this.publishCursorPresentation(
      cur,
      w,
      h,
      full ? h : this._dirtyRows.length,
      full,
      paintTrace?.traceId ?? null,
    );
    this._needsCursorPresentation = false;
    try {
      this._mirror.acknowledgePresentation?.(this._paneId, w, h);
    } catch {
      // A diagnostic acknowledgment can never own framebuffer publication.
    }

    const focusPaintSink = performanceSink?.terminalFocusPaint;
    const focusFenceSink = performanceSink?.terminalFocusFence;
    const focusTransition = this._pendingFocusTransition;
    if (focusTransition) {
      this._pendingFocusTransition = null;
      if (focusPaintSink && focusFenceSink) {
        try {
          const identity = this._mirror.paneCanonicalIdentity?.(this._paneId);
          if (
            identity &&
            focusTransition.semanticPaneId === this._paneId &&
            focusTransition.focused === this._focusedPane &&
            focusTransition.rendererEpoch === this._rendererEpoch &&
            focusTransition.sourceEpoch === identity.sourceEpoch &&
            focusTransition.generation === identity.generation &&
            focusTransition.incarnation === identity.incarnation &&
            focusTransition.revision === identity.revision &&
            focusTransition.stateHash === identity.stateHash &&
            focusTransition.cols === identity.cols &&
            focusTransition.rows === identity.rows
          ) {
            const event = {
              processId: `opentui:${process.pid}`,
              clockId: "opentui-performance-now",
              clockKind: "performance-now",
              atMicros: Math.floor(performance.now() * 1_000),
              semanticPaneId: this._paneId,
              ...identity,
              sourceEpoch: identity.sourceEpoch,
              rendererEpoch: this._rendererEpoch,
              viewportCols: w,
              viewportRows: h,
              focused: this._focusedPane,
              diagnosticEpoch: focusTransition.diagnosticEpoch,
              full,
              writtenRows: Object.freeze([...this._dirtyRows]),
            } as const;
            if (this._hostFocusTransitionOwner?.complete(focusTransition.token, event) === true) {
              try {
                focusPaintSink(event);
              } catch {
                this._hostFocusTransitionOwner.cancel(focusTransition.token);
              }
            }
          }
        } catch {
          // Opt-in focus diagnostics never own framebuffer publication.
        }
      }
    }

    if (performanceSink) {
      try {
        const paintEndedAt = performance.now();
        performanceSink.terminalPaint(this._dirtyRows.length, paintEndedAt - paintStartedAt);
        if (paintTrace && performanceSink.terminalTraceSpan) {
          performanceSink.terminalTraceSpan({
            traceId: paintTrace.traceId,
            scenario: "terminal-input-to-paint",
            stage: "paint",
            processId: `opentui:${process.pid}`,
            clockId: "opentui-performance-now",
            clockKind: "performance-now",
            startedAtMicros: Math.floor(paintStartedAt * 1_000),
            endedAtMicros: Math.floor(paintEndedAt * 1_000),
            generation: paintTrace.generation,
            incarnation: paintTrace.incarnation,
            semanticPaneId: paintTrace.semanticPaneId,
            revision: paintTrace.revision,
            stateHash: paintTrace.stateHash,
            paintStateIdentity: "latest-canonical-state-blitted",
          });
          performanceSink.terminalInputFence?.({
            traceId: paintTrace.traceId,
            processId: `opentui:${process.pid}`,
            clockId: "opentui-performance-now",
            clockKind: "performance-now",
            atMicros: Math.floor(performance.now() * 1_000),
            generation: paintTrace.generation,
            incarnation: paintTrace.incarnation,
            semanticPaneId: paintTrace.semanticPaneId,
            revision: paintTrace.revision,
            stateHash: paintTrace.stateHash,
          });
        }
      } catch {
        // Diagnostics are observational and can never break terminal paint.
      }
    }
  }

  /**
   * Drive the REAL terminal cursor (M21.6). Only the focused, live pane owns the
   * single hardware cursor: it positions it at the pane's cursor cell (absolute
   * screen coords), honoring the app's DECTCEM hide and DECSCUSR shape/blink, so
   * vim/claude/htop cursors behave natively. A focused pane that is scrolled up
   * or whose app hid the cursor hides it; unfocused panes never touch it (they
   * carry a painted marker instead).
   */
  private updateHardwareCursor(c: CursorState | null, w: number, h: number): void {
    if (!this._focusedPane) return;
    hardwareCursorOwner.set(this._ctx, this);
    if (!c) {
      this._ctx.setCursorPosition(this.x + 1, this.y + 1, false);
      return;
    }
    const inBounds = c.x >= 0 && c.x < w && c.y >= 0 && c.y < h;
    const live = this._scrollOffset === 0;
    const visible = live && inBounds && !c.hidden;
    // Absolute screen position of the pane's cursor cell. setCursorPosition is
    // 1-based (matches OpenTUI's own editor: screenX + visualCol + 1).
    const gx = this.x + Math.min(c.x, w - 1) + 1;
    const gy = this.y + Math.min(c.y, h - 1) + 1;
    this._ctx.setCursorPosition(gx, gy, visible);
    if (visible) {
      this._ctx.setCursorStyle({
        style: c.style === "bar" ? "line" : c.style,
        blinking: c.blink,
      });
    }
  }

  private applyCursorOnlyPresentation(): void {
    if (!this._mirror) return;
    const trace = this._mirror.cursorPresentationTrace?.(this._paneId) ?? null;
    const startedAt = trace ? performance.now() : 0;
    const w = this.frameBuffer.width;
    const h = this.frameBuffer.height;
    const cursor = this._mirror.cursorState(this._paneId);
    this.updateHardwareCursor(cursor, w, h);
    this.publishCursorPresentation(cursor, w, h, 0, false, trace?.traceId ?? null);
    if (trace) {
      try {
        const endedAt = performance.now();
        const sink = currentTuiPerformanceEventSink();
        sink?.terminalTraceSpan?.({
          traceId: trace.traceId,
          scenario: "terminal-input-to-paint",
          stage: "paint",
          processId: `opentui:${process.pid}`,
          clockId: "opentui-performance-now",
          clockKind: "performance-now",
          startedAtMicros: Math.floor(startedAt * 1_000),
          endedAtMicros: Math.floor(endedAt * 1_000),
          generation: trace.generation,
          incarnation: trace.incarnation,
          semanticPaneId: trace.semanticPaneId,
          revision: trace.revision,
          stateHash: trace.stateHash,
          paintStateIdentity: "latest-canonical-state-blitted",
        });
        sink?.terminalInputFence?.({
          traceId: trace.traceId,
          processId: `opentui:${process.pid}`,
          clockId: "opentui-performance-now",
          clockKind: "performance-now",
          atMicros: Math.floor(performance.now() * 1_000),
          generation: trace.generation,
          incarnation: trace.incarnation,
          semanticPaneId: trace.semanticPaneId,
          revision: trace.revision,
          stateHash: trace.stateHash,
        });
      } catch {
        // Detailed causal timing never owns cursor presentation.
      }
    }
    this._needsCursorPresentation = false;
    try {
      this._mirror.acknowledgePresentation?.(this._paneId, w, h);
    } catch {
      // A diagnostic acknowledgment can never own cursor presentation.
    }
  }

  private publishCursorPresentation(
    cursor: CursorState | null,
    width: number,
    height: number,
    gridRowsRead: number,
    fullWalk: boolean,
    traceId: string | null = null,
  ): void {
    const sink = currentTuiPerformanceEventSink()?.terminalCursorPresentation;
    if (!sink || !cursor || !this._focusedPane || !this._mirror) return;
    try {
      const identity = this._mirror.paneCanonicalIdentity?.(this._paneId);
      if (!identity) return;
      const inBounds = cursor.x >= 0 && cursor.x < width && cursor.y >= 0 && cursor.y < height;
      const visible = this._scrollOffset === 0 && inBounds && !cursor.hidden;
      this._presentationCount += 1;
      sink({
        traceId,
        processId: `opentui:${process.pid}`,
        clockId: "opentui-performance-now",
        clockKind: "performance-now",
        atMicros: Math.floor(performance.now() * 1_000),
        semanticPaneId: this._paneId,
        generation: identity.generation,
        incarnation: identity.incarnation,
        revision: identity.revision,
        stateHash: identity.stateHash,
        cols: identity.cols,
        rows: identity.rows,
        sourceEpoch: identity.sourceEpoch,
        rendererEpoch: this._rendererEpoch,
        viewportCols: width,
        viewportRows: height,
        cursorX: cursor.x,
        cursorY: cursor.y,
        screenX: this.x + Math.min(Math.max(cursor.x, 0), Math.max(width - 1, 0)) + 1,
        screenY: this.y + Math.min(Math.max(cursor.y, 0), Math.max(height - 1, 0)) + 1,
        visible,
        style: cursor.style === "bar" ? "line" : cursor.style,
        blink: cursor.blink,
        gridWalked: gridRowsRead > 0,
        gridRowsRead,
        fullWalk,
        gridRowsReadTotal: this._gridRowsReadTotal,
        fullWalkTotal: this._fullWalkTotal,
        presentationCount: this._presentationCount,
      });
    } catch {
      // Detailed cursor diagnostics are fail-open and never own presentation.
    }
  }

  private releaseHardwareCursor(): void {
    if (hardwareCursorOwner.get(this._ctx) !== this) return;
    hardwareCursorOwner.delete(this._ctx);
    this._ctx.setCursorPosition(1, 1, false);
  }

  private cancelPendingFocusTransition(): void {
    const transition = this._pendingFocusTransition;
    this._pendingFocusTransition = null;
    if (!transition) return;
    try {
      this._hostFocusTransitionOwner?.cancel(transition.token);
    } catch {
      // Detailed focus correlation never owns pane replacement or disposal.
    }
  }

  override destroy(): void {
    this.releaseHardwareCursor();
    this.cancelPendingFocusTransition();
    try {
      this._hostFocusTransitionOwner?.cancelPane(this._paneId);
    } catch {
      // Detailed focus correlation never owns pane disposal.
    }
    this._mirror?.releasePane?.(this._paneId, this);
    super.destroy();
  }

  /** Visible rows covered by the current drag selection (clamped), or []. The
   *  range arrives ordered (app.tsx passes `orderCells`) in ABSOLUTE buffer
   *  lines; `baseY` is the view's current absolute top (M25.6). */
  private selRows(height: number, baseY: number): number[] {
    const sel = this._sel;
    if (!sel) return [];
    return visibleSelRows(sel.start, sel.end, baseY, height);
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
