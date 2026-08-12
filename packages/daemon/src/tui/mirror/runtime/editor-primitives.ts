/**
 * Small viewport/cursor primitives shared by the terminal shell, Changes, and
 * the optional Files feature. Keeping them here prevents the shell from
 * evaluating the Files editor module during terminal-first startup.
 */

export function gutterWidth(totalLines: number): number {
  return Math.max(3, String(Math.max(1, totalLines)).length) + 1;
}

export function formatGutter(lineNumber: number, width: number): string {
  return String(lineNumber).padStart(width - 1, " ") + " ";
}

export function clampTop(top: number, totalLines: number, rows: number): number {
  const max = Math.max(0, totalLines - rows);
  if (top < 0) return 0;
  if (top > max) return max;
  return top;
}

export function visibleRange(
  totalLines: number,
  top: number,
  rows: number,
): { start: number; end: number } {
  const start = clampTop(top, totalLines, rows);
  return { start, end: Math.min(totalLines, start + rows) };
}

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
