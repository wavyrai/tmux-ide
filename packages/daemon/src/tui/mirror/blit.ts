/**
 * Pure cell → framebuffer writers for the framebuffer pane-blit path (M21.3).
 *
 * These map a mirror grid straight into an OpenTUI `OptimizedBuffer`'s typed
 * arrays — no `StyledRun[]` intermediary, no per-run `RGBA` allocation, no Solid
 * subtree. One packed cell is `char[i]` (a codepoint), four `fg`/`bg` channels
 * (`r,g,b,a`, 0–255) at `i*4`, and one `attributes[i]` bitmask — the exact layout
 * `OptimizedBuffer.buffers` exposes.
 *
 * Kept dependency-free (plain typed arrays) so the packing is unit-testable
 * without the native render lib; {@link PaneMirror.blit} does the xterm walk and
 * feeds these.
 */

/** The spacer (second) half of a wide glyph: char `0`. The native renderer knows
 *  a cell is wide by MEASURING the lead cell's codepoint width and skips the
 *  spacer, so the spacer's char just needs to be empty — this is exactly what
 *  `OptimizedBuffer.setCell` writes for the trailing half (verified: a wide
 *  glyph → `char[i]=codepoint, char[i+1]=0`). NB the `0xC0000000`
 *  `CHAR_FLAG_CONTINUATION` seen in OptimizedBuffer is a DIFFERENT consumer (the
 *  JS `getSpanLines`/`getRealCharBytes` text reader, off our render path);
 *  writing it here blanks wide glyphs on screen (measured). */
export const CHAR_CONTINUATION = 0;

/** The space codepoint — the fill for blank / out-of-range cells. */
export const SPACE_CODE = 0x20;

/**
 * INVERSE is rendered by SWAPPING fg/bg, not by the OpenTUI INVERSE attribute
 * bit: a framebuffer cell carrying that bit composites (drawFrameBuffer preserves
 * it) but does NOT flush as reverse-video — the direct `<text>` path does, the
 * framebuffer path doesn't (measured). Swapping colors always renders (truecolor
 * channels propagate cleanly), and covers app-driven reverse (vim status line),
 * the cursor cell, and the drag selection uniformly. Swaps compose like the old
 * XOR: two swaps on a cell (selection over the cursor) return it to normal.
 */

/** The four packed arrays behind an `OptimizedBuffer` (or a plain-array stand-in
 *  for tests). `fg`/`bg` hold four `u16` channels (0–255) per cell at `i*4`. */
export interface CellArrays {
  char: Uint32Array;
  fg: Uint16Array;
  bg: Uint16Array;
  attributes: Uint32Array;
}

/**
 * A cell whose grapheme is more than one codepoint (ZWJ/flag emoji, combining
 * marks) — a single `char[i]` u32 can't hold it. The fast blit writes its base
 * codepoint; the caller (which owns the native `OptimizedBuffer`) re-writes these
 * few cells with the full string via `setCell`, keeping full parity for the rare
 * case without an allocation on the common path.
 */
export interface GraphemeOverride {
  x: number;
  y: number;
  chars: string;
  /** Packed `0xRRGGBB` or null (terminal default). */
  fg: number | null;
  bg: number | null;
  attrs: number;
}

/**
 * Write one styled cell at flat index `idx`. `fg`/`bg` are packed `0xRRGGBB` or
 * `null` for the terminal default (→ the supplied `d*` channels); alpha is always
 * opaque (panes never blend). No allocation — just eight typed-array stores.
 */
export function writeCell(
  buf: CellArrays,
  idx: number,
  codepoint: number,
  fg: number | null,
  bg: number | null,
  attrs: number,
  dfR: number,
  dfG: number,
  dfB: number,
  dbR: number,
  dbG: number,
  dbB: number,
): void {
  buf.char[idx] = codepoint;
  const o = idx * 4;
  if (fg === null) {
    buf.fg[o] = dfR;
    buf.fg[o + 1] = dfG;
    buf.fg[o + 2] = dfB;
  } else {
    buf.fg[o] = (fg >> 16) & 0xff;
    buf.fg[o + 1] = (fg >> 8) & 0xff;
    buf.fg[o + 2] = fg & 0xff;
  }
  buf.fg[o + 3] = 255;
  if (bg === null) {
    buf.bg[o] = dbR;
    buf.bg[o + 1] = dbG;
    buf.bg[o + 2] = dbB;
  } else {
    buf.bg[o] = (bg >> 16) & 0xff;
    buf.bg[o + 1] = (bg >> 8) & 0xff;
    buf.bg[o + 2] = bg & 0xff;
  }
  buf.bg[o + 3] = 255;
  buf.attributes[idx] = attrs;
}

/**
 * Mark cell `idx` as the continuation (spacer) half of the wide glyph at `idx-1`,
 * inheriting the glyph's colors so a colored wide glyph's background spans both
 * cells. The renderer emits nothing for a continuation cell but still paints its
 * background.
 */
export function writeContinuation(buf: CellArrays, idx: number): void {
  buf.char[idx] = CHAR_CONTINUATION;
  const o = idx * 4;
  const p = (idx - 1) * 4;
  buf.fg[o] = buf.fg[p]!;
  buf.fg[o + 1] = buf.fg[p + 1]!;
  buf.fg[o + 2] = buf.fg[p + 2]!;
  buf.fg[o + 3] = buf.fg[p + 3]!;
  buf.bg[o] = buf.bg[p]!;
  buf.bg[o + 1] = buf.bg[p + 1]!;
  buf.bg[o + 2] = buf.bg[p + 2]!;
  buf.bg[o + 3] = buf.bg[p + 3]!;
  buf.attributes[idx] = buf.attributes[idx - 1]!;
}

/**
 * Swap fg/bg across cells `[from,to]` (inclusive, clamped to the row) of row `y`
 * — the drag-selection reverse-video post-pass. A swap over the cursor cell (also
 * swapped in the blit) returns it to normal, matching the run path's XOR.
 */
export function swapCells(
  buf: CellArrays,
  width: number,
  y: number,
  from: number,
  to: number,
): void {
  const lo = Math.max(0, from);
  const hi = Math.min(width - 1, to);
  const base = y * width;
  for (let x = lo; x <= hi; x++) {
    const o = (base + x) * 4;
    const r = buf.fg[o]!;
    const g = buf.fg[o + 1]!;
    const b = buf.fg[o + 2]!;
    const a = buf.fg[o + 3]!;
    buf.fg[o] = buf.bg[o]!;
    buf.fg[o + 1] = buf.bg[o + 1]!;
    buf.fg[o + 2] = buf.bg[o + 2]!;
    buf.fg[o + 3] = buf.bg[o + 3]!;
    buf.bg[o] = r;
    buf.bg[o + 1] = g;
    buf.bg[o + 2] = b;
    buf.bg[o + 3] = a;
  }
}

/**
 * Paint the background of cells `[from,to]` (inclusive, clamped) of row `y` to
 * packed `bg` — the scrollback-search highlight post-pass (the twin of
 * {@link invertCells}; distinct treatment so a match and the selection coexist).
 */
export function paintBg(
  buf: CellArrays,
  width: number,
  y: number,
  from: number,
  to: number,
  bg: number,
): void {
  const lo = Math.max(0, from);
  const hi = Math.min(width - 1, to);
  const r = (bg >> 16) & 0xff;
  const g = (bg >> 8) & 0xff;
  const b = bg & 0xff;
  for (let x = lo; x <= hi; x++) {
    const o = (y * width + x) * 4;
    buf.bg[o] = r;
    buf.bg[o + 1] = g;
    buf.bg[o + 2] = b;
    buf.bg[o + 3] = 255;
  }
}
