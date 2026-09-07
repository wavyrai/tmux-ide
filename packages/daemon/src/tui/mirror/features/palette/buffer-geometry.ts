import { clampPaletteTop } from "../../palette.ts";

/** Shared by the buffer renderer and its pointer/keyboard routes. */
export function bufferPickerGeometry(columns: number, rows: number, count: number, top: number) {
  const width = Math.max(1, Math.min(64, Math.floor(columns) - (columns >= 8 ? 4 : 0)));
  const viewportHeight = Math.max(1, Math.floor(rows));
  const y = Math.min(Math.max(1, Math.floor(viewportHeight / 6)), viewportHeight - 1);
  const available = viewportHeight - y;
  const bordered = width >= 8 && available >= 5;
  const inset = bordered ? 1 : 0;
  const headerRows = bordered ? 3 : available >= 3 ? 1 : 0;
  const capacity = Math.max(1, Math.min(10, available - headerRows - inset));
  const scrollTop = clampPaletteTop(top, count, capacity);
  const visibleRows = Math.min(capacity, Math.max(0, count - scrollTop));
  return {
    left: Math.max(0, Math.floor((columns - width) / 2)),
    top: y,
    width,
    height: headerRows + Math.max(1, visibleRows) + inset,
    bordered,
    inset,
    headerRows,
    capacity,
    scrollTop,
    visibleRows,
    contentWidth: Math.max(1, width - inset * 2),
  };
}

export function bufferPickerContains(
  g: ReturnType<typeof bufferPickerGeometry>,
  x: number,
  y: number,
) {
  return x >= g.left && x < g.left + g.width && y >= g.top && y < g.top + g.height;
}

export function bufferPickerRowAt(
  g: ReturnType<typeof bufferPickerGeometry>,
  x: number,
  y: number,
) {
  if (x < g.left + g.inset || x >= g.left + g.width - g.inset) return -1;
  const row = y - g.top - g.headerRows;
  return row >= 0 && row < g.visibleRows ? row : -1;
}
