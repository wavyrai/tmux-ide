/**
 * A pane mirror: a headless terminal emulator fed by tmux control-mode
 * `%output` bytes, exposing a renderable grid snapshot.
 *
 * @xterm/headless is xterm.js without a DOM — a full VT parser (SGR, cursor,
 * alt-screen, scroll regions) maintaining a cell buffer. We write raw pane
 * bytes in and read the grid out; the TUI draws the snapshot. This is the
 * seam between "tmux owns the PTYs" and "tmux-ide owns the pixels".
 *
 * Fidelity notes:
 *  - Colors resolve to packed 0xRRGGBB here (256-palette + truecolor + the
 *    16 base colors), so the renderer never needs a palette.
 *  - Attributes map onto OpenTUI's TextAttributes bitmask (bold/dim/italic/
 *    underline/inverse/strikethrough) — inverse also carries the cursor.
 *  - Wide glyphs (CJK, emoji) occupy one cell + a zero-width spacer; the
 *    spacer is skipped so runs stay grid-aligned.
 *  - `scrollback` is real (5000 lines): `snapshot(offset)` renders `offset`
 *    lines above the live viewport, `scrollbackDepth()` says how far back
 *    a pane can go.
 */
import { Terminal } from "@xterm/headless";
import { AckWriter } from "./ack-writer.ts";

/** OpenTUI TextAttributes bit values (kept literal to avoid the dep here). */
const ATTR_BOLD = 1;
const ATTR_DIM = 2;
const ATTR_ITALIC = 4;
const ATTR_UNDERLINE = 8;
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

export class PaneMirror {
  private readonly term: Terminal;
  /** Ack-paced writes (M21.5): xterm's `write` is async with a completion
   *  callback; chunks arriving mid-parse buffer here and follow as ONE joined
   *  write from the callback, so parser backpressure never queues unbounded
   *  entries — and never stalls the control-channel reader loop feeding us. */
  private readonly writer = new AckWriter((data, done) => this.term.write(data, done));
  cols: number;
  rows: number;

  constructor(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
    this.term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 5000 });
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
   */
  snapshot(scrollOffset = 0, withCursor = false): MirrorSnapshot {
    const buf = this.term.buffer.active;
    const offset = Math.max(0, Math.min(scrollOffset, buf.viewportY));
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

  dispose(): void {
    this.term.dispose();
  }
}
