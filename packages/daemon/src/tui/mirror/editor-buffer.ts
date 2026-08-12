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
export { BINARY_SNIFF_BYTES, isBinary } from "./runtime/file-content-primitives.ts";

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

export {
  clampTop,
  clickToCursor,
  formatGutter,
  gutterWidth,
  scrollToCursor,
  visibleRange,
} from "./runtime/editor-primitives.ts";
