/**
 * Pure, io-free helpers for the built-in file editor panel (M18.2).
 *
 * Deliberately imports NOTHING from @opentui/core: the editing ENGINE is a
 * native `EditBuffer` (bun:ffi), which cannot load under Node/vitest. Everything
 * that can be unit-tested — binary sniffing, read-only classification, the
 * line-number gutter, viewport slicing, and click→cursor coordinate math —
 * lives here so it runs green under the Node test runner while app.tsx keeps
 * the bun-only EditBuffer wiring.
 */

/** Files at or above this byte length open read-only (no full-buffer edits on
 *  the render loop). */
export const MAX_EDITABLE_BYTES = 1_000_000;
/** How many leading bytes we sniff for a NUL before calling a file binary. */
export const BINARY_SNIFF_BYTES = 8000;

/** NUL-byte sniff: a single 0x00 in the leading window means "not text". */
export function isBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}

export type ReadOnlyReason = "binary" | "large" | null;

/** Decide whether a freshly-read file is editable, and why not. */
export function classifyFile(byteLength: number, binary: boolean): ReadOnlyReason {
  if (binary) return "binary";
  if (byteLength >= MAX_EDITABLE_BYTES) return "large";
  return null;
}

/** Human banner for a read-only reason (null = editable, no banner). */
export function readOnlyBanner(reason: ReadOnlyReason): string | null {
  if (reason === "binary") return "read-only · binary file (null byte detected)";
  if (reason === "large") return `read-only · file ≥ ${MAX_EDITABLE_BYTES / 1_000_000} MB`;
  return null;
}

/** Render a binary/undisplayable buffer as a safe ASCII preview: control and
 *  high bytes become "·" so the rope never carries NULs and the panel stays
 *  legible. Newlines/tabs are preserved so line structure survives. */
export function sanitizeForDisplay(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    if (b === 0x09 || b === 0x0a || b === 0x0d || (b >= 0x20 && b <= 0x7e)) {
      out += String.fromCharCode(b);
    } else {
      out += "·";
    }
  }
  return out;
}

/** Total width of the line-number gutter, including its trailing space. */
export function gutterWidth(totalLines: number): number {
  return Math.max(3, String(Math.max(1, totalLines)).length) + 1;
}

/** Right-aligned line number filling `width` (last column is the separator). */
export function formatGutter(lineNumber: number, width: number): string {
  return String(lineNumber).padStart(width - 1, " ") + " ";
}

/** Clamp the top (first-visible) line so the viewport never scrolls past the
 *  last screenful. `rows` is the number of text rows on screen. */
export function clampTop(top: number, totalLines: number, rows: number): number {
  const max = Math.max(0, totalLines - rows);
  if (top < 0) return 0;
  if (top > max) return max;
  return top;
}

/** The [start,end) line range visible for a given scroll position. */
export function visibleRange(
  totalLines: number,
  top: number,
  rows: number,
): { start: number; end: number } {
  const start = clampTop(top, totalLines, rows);
  return { start, end: Math.min(totalLines, start + rows) };
}

/** Ensure the cursor line sits inside [top, top+rows); returns the new top. */
export function scrollToCursor(
  cursorLine: number,
  top: number,
  rows: number,
  totalLines: number,
): number {
  let next = top;
  if (cursorLine < top) next = cursorLine;
  else if (cursorLine >= top + rows) next = cursorLine - rows + 1;
  return clampTop(next, totalLines, rows);
}

/**
 * Map a click at content-relative coordinates to a buffer (line, col).
 * `contentY` is rows below the editor header; `cx` is columns right of the
 * sidebar (gutter included). Both results are clamped to the buffer.
 */
export function clickToCursor(params: {
  cx: number;
  contentY: number;
  gutterW: number;
  top: number;
  lines: string[];
}): { line: number; col: number } {
  const { cx, contentY, gutterW, top, lines } = params;
  const total = Math.max(1, lines.length);
  const line = Math.max(0, Math.min(total - 1, top + contentY));
  const lineText = lines[line] ?? "";
  const col = Math.max(0, Math.min(lineText.length, cx - gutterW));
  return { line, col };
}
