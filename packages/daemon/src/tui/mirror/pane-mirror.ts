/**
 * A pane mirror: a headless terminal emulator fed by tmux control-mode
 * `%output` bytes, exposing a renderable grid snapshot.
 *
 * @xterm/headless is xterm.js without a DOM — a full VT parser (SGR, cursor,
 * alt-screen, scroll regions) maintaining a cell buffer. We write raw pane
 * bytes in and read the grid out; the TUI draws the snapshot. This is the
 * seam between "tmux owns the PTYs" and "tmux-ide owns the pixels".
 *
 * Fidelity notes (M21.6 — the current truth):
 *  - Colors resolve to packed 0xRRGGBB here (256-palette + truecolor + the
 *    16 base colors), so the renderer never needs a palette.
 *  - Attributes carried, mapped onto OpenTUI's TextAttributes bitmask:
 *    bold, dim, italic, underline, blink, strikethrough. INVERSE is NOT set as
 *    an attribute — it renders as a fg/bg SWAP in the blit (a framebuffer cell
 *    carrying the INVERSE bit does not flush as reverse; see blit.ts), so it
 *    composes with the selection/cursor swaps.
 *  - Attributes DROPPED (no representation downstream): overline (xterm exposes
 *    `isOverline()`, OpenTUI has no overline attribute); extended underline
 *    STYLES (curly/double/dotted) and underline COLOR (not on xterm-headless's
 *    public cell API, and OpenTUI has only a single underline). Blink is passed
 *    through as the BLINK attribute — the real terminal decides whether to honor
 *    it (most modern terminals ignore or soften it); we don't down-map it.
 *  - CURSOR: not painted into the grid. The focused pane drives the REAL
 *    hardware cursor via the renderer (position + DECTCEM hide/show + DECSCUSR
 *    shape/blink, read through {@link cursorState}); unfocused panes get a quiet
 *    painted marker. See pane-surface.tsx.
 *  - Wide glyphs (CJK, emoji) occupy one cell + a zero-width spacer; the
 *    spacer is skipped so runs stay grid-aligned.
 *  - `scrollback` is real (5000 lines): `snapshot(offset)` renders `offset`
 *    lines above the live viewport, `scrollbackDepth()` says how far back
 *    a pane can go.
 */
import { Terminal } from "@xterm/headless";
import {
  writeCell,
  writeContinuation,
  SPACE_CODE,
  type CellArrays,
  type GraphemeOverride,
} from "./blit.ts";
import { AckWriter } from "./ack-writer.ts";

/** OpenTUI TextAttributes bit values (kept literal to avoid the dep here). */
const ATTR_BOLD = 1;
const ATTR_DIM = 2;
const ATTR_ITALIC = 4;
const ATTR_UNDERLINE = 8;
const ATTR_BLINK = 16;
const ATTR_INVERSE = 32;
const ATTR_STRIKETHROUGH = 128;

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

/** The standard xterm 256-color palette as packed 0xRRGGBB. */
export const XTERM_PALETTE: readonly number[] = buildXtermPalette();

function buildXtermPalette(): number[] {
  const base = [
    0x000000, 0xcd0000, 0x00cd00, 0xcdcd00, 0x0000ee, 0xcd00cd, 0x00cdcd, 0xe5e5e5, 0x7f7f7f,
    0xff0000, 0x00ff00, 0xffff00, 0x5c5cff, 0xff00ff, 0x00ffff, 0xffffff,
  ];
  const palette = [...base];
  const levels = [0, 95, 135, 175, 215, 255];
  for (let i = 16; i < 232; i++) {
    const n = i - 16;
    const r = levels[Math.floor(n / 36)]!;
    const g = levels[Math.floor(n / 6) % 6]!;
    const b = levels[n % 6]!;
    palette.push((r << 16) | (g << 8) | b);
  }
  for (let i = 232; i < 256; i++) {
    const v = 8 + 10 * (i - 232);
    palette.push((v << 16) | (v << 8) | v);
  }
  return palette;
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

/** The slice of xterm's internal coreService we read for cursor mode state. */
interface CoreServiceInternal {
  isCursorHidden?: boolean;
  decPrivateModes?: { cursorStyle?: "block" | "underline" | "bar"; cursorBlink?: boolean };
}

/** Per-call inputs for the incremental {@link PaneMirror.blit} (M21.4). */
export interface BlitOptions {
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
}

/** True iff the shadow slice at `off` equals `data` (an exact per-row cell-data
 *  compare — no hash, so no collision can strand a stale row). Early-exits on the
 *  first differing u32. */
function shadowMatches(shadow: Uint32Array, off: number, data: Uint32Array): boolean {
  if (data.length + off > shadow.length) return false;
  for (let k = 0; k < data.length; k++) {
    if (shadow[off + k] !== data[k]) return false;
  }
  return true;
}

export class PaneMirror {
  private readonly term: Terminal;
  /** Ack-paced writes (M21.5): xterm's `write` is async with a completion
   *  callback; chunks arriving mid-parse buffer here and follow as ONE joined
   *  write from the callback, so parser backpressure never queues unbounded
   *  entries — and never stalls the control-channel reader loop feeding us. */
  /** Fires when a paced write has actually PARSED into the grid — the dirty
   *  signal the render tick must re-arm on (enqueue-time dirty can be consumed
   *  before the parse lands, dropping the final frame; see AckWriter.onAck). */
  onParsed?: () => void;
  private readonly writer = new AckWriter(
    (data, done) => this.term.write(data, done),
    () => this.onParsed?.(),
  );
  cols: number;
  rows: number;

  // ── Incremental-blit state (M21.4) ─────────────────────────────────────────
  /** Per-pane content version — bumps on any grid change (parse/scroll/resize).
   *  A surface gates its walk on this: an unchanged pane never re-reads. */
  private _version = 0;
  /** Net forward scrolls (line count) since the last blit — drives the shift
   *  fast path. Counted from xterm's onScroll (which fires once per scrolled
   *  line and keeps firing at the scrollback cap, unlike the saturating payload). */
  private _pendingScroll = 0;
  /** The alt/normal buffer swapped (`?1049h/l`) — the whole grid is new. */
  private _bufferSwapped = false;
  /** Shadow of the last-blitted rows' raw xterm cell data (`_line._data`,
   *  cols×3 u32/row) — an EXACT compare finds changed rows with no getter cost
   *  and no hash-collision risk. Null until the capability probe or a resize. */
  private _shadow: Uint32Array | null = null;
  private _shadowValid = false;
  /** `_line._data` reachable (xterm-headless internal, pinned 6.0). When false,
   *  the blit degrades to a full repaint every walk — correct, just not
   *  incremental. */
  private _incremental = true;

  constructor(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
    this.term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 5000 });
    this.term.onWriteParsed(() => this._version++);
    this.term.onScroll(() => this._pendingScroll++);
    this.term.buffer.onBufferChange(() => {
      this._bufferSwapped = true;
      this._version++;
    });
    // Capability probe (once): can we reach xterm's raw per-line cell data for
    // the exact-compare dirty check? If not, the blit repaints in full.
    const probe = this.term.buffer.active.getLine(0) as { _line?: { _data?: unknown } } | undefined;
    this._incremental = probe?._line?._data instanceof Uint32Array;
  }

  /** The per-pane content version (M21.4) — see {@link _version}. */
  contentVersion(): number {
    return this._version;
  }

  /**
   * The live cursor: grid position + the app-driven DECTCEM visibility and
   * DECSCUSR shape/blink (M21.6). Position is public (`cursorX/Y`); the mode
   * state lives on xterm's internal coreService (no public getter), reached
   * defensively — if the internal is absent the cursor stays visible as a block,
   * which is the terminal default anyway. `style` is xterm's vocabulary
   * (`block`/`underline`/`bar`); the renderer maps it.
   */
  cursorState(): CursorState {
    const buf = this.term.buffer.active;
    const core = (this.term as unknown as { _core?: { coreService?: CoreServiceInternal } })._core;
    const cs = core?.coreService;
    const dec = cs?.decPrivateModes;
    return {
      x: buf.cursorX,
      y: buf.cursorY,
      hidden: cs?.isCursorHidden === true,
      style: dec?.cursorStyle ?? this.term.options.cursorStyle ?? "block",
      blink: dec?.cursorBlink ?? this.term.options.cursorBlink ?? false,
    };
  }

  /** Feed raw pane bytes (UTF-8) from a control-mode %output event. */
  write(data: Uint8Array | string): void {
    // Normalize to bytes so the pacer coalesces freely; a JS string encodes to
    // the same UTF-8 xterm would have decoded it from.
    this.writer.write(typeof data === "string" ? new TextEncoder().encode(data) : data);
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    this.term.resize(cols, rows);
    // Geometry changed — the shadow and any prior framebuffer are stale; the
    // next blit must repaint in full (the surface also forces it on its resize).
    this._shadow = null;
    this._pendingScroll = 0;
    this._bufferSwapped = false;
    this._version++;
  }

  /** Lines available above the live viewport (how far back scroll can go). */
  scrollbackDepth(): number {
    return this.term.buffer.active.viewportY;
  }

  /**
   * The WHOLE buffer (scrollback + live viewport) as plain text lines, top→bottom
   * — the search corpus. Read on demand (cheap; no per-frame cost). Uses xterm's
   * `translateToString(true)` so wide-glyph spacers collapse and trailing blanks
   * trim exactly the way the rendered snapshot rows do, keeping a match's column
   * aligned between the search hit and the highlight injection. Line index `y` is
   * absolute (0 = oldest scrollback line); the live viewport top sits at
   * `scrollbackDepth()`, so a match at line `y` maps to visible row
   * `y - (scrollbackDepth - scrollOffset)`.
   */
  bufferLines(): string[] {
    const buf = this.term.buffer.active;
    const out: string[] = [];
    for (let y = 0; y < buf.length; y++) {
      const line = buf.getLine(y);
      out.push(line ? line.translateToString(true) : "");
    }
    return out;
  }

  /**
   * Read a grid as rows of same-styled runs.
   *
   * @param scrollOffset Render this many lines above the live viewport
   *   (clamped to the available scrollback). 0 = live view.
   * @param withCursor Paint the cursor cell inverse (the focused pane).
   * @param includeRows Serialize the styled rows. `false` returns only the
   *   cursor/offset metadata (rows `[]`) — the framebuffer-blit path (M21.3)
   *   reads cells via {@link blit} instead, so it skips the run rebuild entirely.
   */
  snapshot(scrollOffset = 0, withCursor = false, includeRows = true): MirrorSnapshot {
    const buf = this.term.buffer.active;
    const offset = Math.max(0, Math.min(scrollOffset, buf.viewportY));
    if (!includeRows) {
      return { rows: [], cursorX: buf.cursorX, cursorY: buf.cursorY, scrollOffset: offset };
    }
    const baseY = buf.viewportY - offset;
    const live = offset === 0;
    const rows: StyledRun[][] = [];
    const cell = buf.getNullCell();

    for (let y = 0; y < this.rows; y++) {
      const line = buf.getLine(baseY + y);
      const runs: StyledRun[] = [];
      if (line) {
        let text = "";
        let fg: number | null = null;
        let bg: number | null = null;
        let attrs = 0;
        const isCursorRow = withCursor && live && y === buf.cursorY;
        for (let x = 0; x < this.cols; x++) {
          line.getCell(x, cell);
          if (cell.getWidth() === 0) continue; // spacer half of a wide glyph

          let cellFg: number | null = null;
          if (cell.isFgRGB()) cellFg = cell.getFgColor();
          else if (cell.isFgPalette()) cellFg = XTERM_PALETTE[cell.getFgColor()] ?? null;

          let cellBg: number | null = null;
          if (cell.isBgRGB()) cellBg = cell.getBgColor();
          else if (cell.isBgPalette()) cellBg = XTERM_PALETTE[cell.getBgColor()] ?? null;

          let cellAttrs = 0;
          if (cell.isBold()) cellAttrs |= ATTR_BOLD;
          if (cell.isDim()) cellAttrs |= ATTR_DIM;
          if (cell.isItalic()) cellAttrs |= ATTR_ITALIC;
          if (cell.isUnderline()) cellAttrs |= ATTR_UNDERLINE;
          if (cell.isBlink()) cellAttrs |= ATTR_BLINK;
          if (cell.isInverse()) cellAttrs |= ATTR_INVERSE;
          if (cell.isStrikethrough()) cellAttrs |= ATTR_STRIKETHROUGH;
          // The cursor renders as an inverse cell in the focused, live pane.
          if (isCursorRow && x === buf.cursorX) cellAttrs ^= ATTR_INVERSE;

          if (text.length > 0 && (cellFg !== fg || cellBg !== bg || cellAttrs !== attrs)) {
            runs.push({ text, fg, bg, attributes: attrs });
            text = "";
          }
          fg = cellFg;
          bg = cellBg;
          attrs = cellAttrs;
          const chars = cell.getChars() || " ";
          text += chars;
          // A wide glyph fills two columns with one string; pad the run's
          // grid alignment by skipping the spacer in the next iteration
          // (handled by the getWidth()===0 check above).
        }
        if (text.length > 0) runs.push({ text, fg, bg, attributes: attrs });
      }
      rows.push(runs);
    }
    return { rows, cursorX: buf.cursorX, cursorY: buf.cursorY, scrollOffset: offset };
  }

  /**
   * Blit the visible grid into a framebuffer's packed typed arrays — the
   * native-feel render path, now INCREMENTAL (M21.4). Same cell semantics as
   * {@link snapshot} (colors → `0xRRGGBB`, the OpenTUI attribute bitmask incl.
   * blink, wide-glyph spacers). The cursor is NOT painted here (M21.6): the
   * focused pane drives the real hardware cursor and the surface paints any
   * unfocused marker. Only the rows that actually changed are rewritten:
   *
   *  - A **scroll fast path** (xterm `onScroll` counted forward-scroll lines)
   *    shifts the already-correct pixels up with `copyWithin`, so a flood repaints
   *    only the new bottom rows, not the whole grid.
   *  - A **per-row exact compare** of xterm's raw cell data against a shadow finds
   *    in-place changes (alt-screen redraws) with no getter cost; unchanged rows
   *    are skipped (~78% of the blit cost is the writes we then avoid).
   *  - `opts.full` repaints everything (first frame, resize, scrolled/searching
   *    view), `opts.forceRows` repaints the caller's selection/search churn, and
   *    the cursor's old+new rows always repaint (the overlay isn't in the shadow).
   *
   * `opts.dirtyRows` is filled with the rows written (the caller re-applies its
   * post-passes there). `defaultFg`/`defaultBg` are packed `0xRRGGBB` for the
   * terminal default. When the raw-cell-data internal is unreachable the blit
   * degrades to a full repaint every call (still correct).
   */
  blit(
    buffers: CellArrays,
    width: number,
    height: number,
    scrollOffset: number,
    defaultFg: number,
    defaultBg: number,
    opts: BlitOptions,
  ): void {
    const buf = this.term.buffer.active;
    const offset = Math.max(0, Math.min(scrollOffset, buf.viewportY));
    const baseY = buf.viewportY - offset;
    const live = offset === 0;
    const cell = buf.getNullCell();
    const cols = Math.min(this.cols, width);
    const rowLen = this.cols * 3; // xterm packs 3 u32 per cell (content/fg/bg)

    // (Re)size the shadow to the current geometry; a fresh shadow is invalid, so
    // the first blit after it repaints in full and fills it.
    if (this._incremental) {
      if (this._shadow === null || this._shadow.length !== rowLen * height) {
        this._shadow = rowLen * height > 0 ? new Uint32Array(rowLen * height) : null;
        this._shadowValid = false;
      }
    }

    // A full repaint is forced on the first frame, a resize, a buffer swap, a
    // scrolled/searching view (offset > 0 — the whole window is different), or
    // when the incremental machinery is unavailable.
    const full =
      opts.full ||
      !live ||
      this._bufferSwapped ||
      !this._incremental ||
      !this._shadowValid ||
      this._shadow === null;
    this._bufferSwapped = false;

    // Scroll fast path: shift the already-correct pixels + shadow up so only the
    // newly exposed bottom rows fall out of sync.
    let shift = 0;
    if (!full && this._pendingScroll > 0) shift = Math.min(this._pendingScroll, height);
    this._pendingScroll = 0;
    if (shift > 0 && this._shadow) {
      const w4 = width * 4;
      buffers.char.copyWithin(0, shift * width, height * width);
      buffers.fg.copyWithin(0, shift * w4, height * w4);
      buffers.bg.copyWithin(0, shift * w4, height * w4);
      buffers.attributes.copyWithin(0, shift * width, height * width);
      this._shadow.copyWithin(0, shift * rowLen, height * rowLen);
    }
    const bottomDirtyFrom = full ? 0 : height - shift;

    const dfR = (defaultFg >> 16) & 0xff;
    const dfG = (defaultFg >> 8) & 0xff;
    const dfB = defaultFg & 0xff;
    const dbR = (defaultBg >> 16) & 0xff;
    const dbG = (defaultBg >> 8) & 0xff;
    const dbB = defaultBg & 0xff;
    const forceRows = opts.forceRows && opts.forceRows.length ? opts.forceRows : null;

    for (let y = 0; y < height; y++) {
      const data = this._incremental ? this.rowData(baseY, y) : null;
      let dirty = full || y >= bottomDirtyFrom || data === null; // no shadow info for this row → always repaint
      if (!dirty && this._shadow) dirty = !shadowMatches(this._shadow, y * rowLen, data!);
      if (!dirty && forceRows) {
        for (let i = 0; i < forceRows.length; i++)
          if (forceRows[i] === y) {
            dirty = true;
            break;
          }
      }
      if (!dirty) continue;

      this.blitRow(
        cell,
        buffers,
        y,
        baseY,
        width,
        cols,
        dfR,
        dfG,
        dfB,
        dbR,
        dbG,
        dbB,
        defaultFg,
        defaultBg,
        opts.graphemes,
      );
      if (this._shadow && data) this._shadow.set(data, y * rowLen);
      opts.dirtyRows.push(y);
    }
    if (this._incremental && this._shadow) this._shadowValid = true;
  }

  /** The raw xterm cell data for visible row `y` (`cols`×3 u32), or null when the
   *  row or the internal is unavailable. See the constructor's capability probe. */
  private rowData(baseY: number, y: number): Uint32Array | null {
    if (y >= this.rows) return null;
    const line = this.term.buffer.active.getLine(baseY + y) as
      | { _line?: { _data?: Uint32Array } }
      | undefined;
    const data = line?._line?._data;
    return data instanceof Uint32Array ? data : null;
  }

  /** Write one visible row's cells into the framebuffer (the M21.3 per-cell blit,
   *  extracted so the incremental path repaints a single row). */
  private blitRow(
    cell: ReturnType<Terminal["buffer"]["active"]["getNullCell"]>,
    buffers: CellArrays,
    y: number,
    baseY: number,
    width: number,
    cols: number,
    dfR: number,
    dfG: number,
    dfB: number,
    dbR: number,
    dbG: number,
    dbB: number,
    defaultFg: number,
    defaultBg: number,
    graphemes?: GraphemeOverride[],
  ): void {
    const buf = this.term.buffer.active;
    const line = y < this.rows ? buf.getLine(baseY + y) : null;
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (!line || x >= cols) {
        writeCell(buffers, idx, SPACE_CODE, null, null, 0, dfR, dfG, dfB, dbR, dbG, dbB);
        continue;
      }
      line.getCell(x, cell);
      if (cell.getWidth() === 0) {
        // Spacer half of the preceding wide glyph — inherit its colors.
        writeContinuation(buffers, idx);
        continue;
      }

      let fg: number | null = null;
      if (cell.isFgRGB()) fg = cell.getFgColor();
      else if (cell.isFgPalette()) fg = XTERM_PALETTE[cell.getFgColor()] ?? null;

      let bg: number | null = null;
      if (cell.isBgRGB()) bg = cell.getBgColor();
      else if (cell.isBgPalette()) bg = XTERM_PALETTE[cell.getBgColor()] ?? null;

      let attrs = 0;
      if (cell.isBold()) attrs |= ATTR_BOLD;
      if (cell.isDim()) attrs |= ATTR_DIM;
      if (cell.isItalic()) attrs |= ATTR_ITALIC;
      if (cell.isUnderline()) attrs |= ATTR_UNDERLINE;
      if (cell.isBlink()) attrs |= ATTR_BLINK;
      if (cell.isStrikethrough()) attrs |= ATTR_STRIKETHROUGH;
      // Reverse video (app INVERSE) renders as a fg/bg SWAP, not the INVERSE
      // attribute bit — a framebuffer cell carrying that bit does not flush as
      // reverse (see blit.ts). Resolve nulls to the defaults first so
      // default-on-default inverts to defaultBg-on-defaultFg.
      const inverted = !!cell.isInverse();

      const chars = cell.getChars();
      const codepoint = chars ? (chars.codePointAt(0) ?? SPACE_CODE) : SPACE_CODE;
      if (inverted) {
        const rFg = fg === null ? defaultFg : fg;
        const rBg = bg === null ? defaultBg : bg;
        writeCell(buffers, idx, codepoint, rBg, rFg, attrs, dfR, dfG, dfB, dbR, dbG, dbB);
      } else {
        writeCell(buffers, idx, codepoint, fg, bg, attrs, dfR, dfG, dfB, dbR, dbG, dbB);
      }
      // A grapheme wider than its base codepoint (ZWJ/flag emoji, combining marks)
      // can't live in a single u32 — record it for the native setCell re-write.
      if (graphemes && chars.length > (codepoint > 0xffff ? 2 : 1)) {
        graphemes.push({ x, y, chars, fg, bg, attrs });
      }
    }
  }

  /**
   * The visible rows as plain text (trailing blanks trimmed, wide spacers
   * collapsed) — the on-demand read the OSC52 copy path uses when the blit path
   * has omitted the styled rows. `scrollOffset` matches {@link snapshot}.
   */
  visibleRowTexts(scrollOffset = 0): string[] {
    const buf = this.term.buffer.active;
    const offset = Math.max(0, Math.min(scrollOffset, buf.viewportY));
    const baseY = buf.viewportY - offset;
    const out: string[] = [];
    for (let y = 0; y < this.rows; y++) {
      const line = buf.getLine(baseY + y);
      out.push(line ? line.translateToString(true) : "");
    }
    return out;
  }

  dispose(): void {
    this.term.dispose();
  }
}
