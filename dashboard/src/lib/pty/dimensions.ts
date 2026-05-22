/**
 * Pure cell-dimension measurement (G20-P1).
 *
 * Extracted from xterm's FitAddon.proposeDimensions but decoupled
 * from any specific terminal instance — accepts a container element
 * and cell metrics directly. Lets background sessions size against
 * the active pane's measurements without first mounting a Terminal.
 */

const MINIMUM_COLS = 2;
const MINIMUM_ROWS = 1;

export interface TerminalDimensions {
  cols: number;
  rows: number;
}

export function measureDimensions(
  container: HTMLElement,
  cellWidth: number,
  cellHeight: number,
  scrollbarWidth = 0,
): TerminalDimensions | null {
  if (cellWidth === 0 || cellHeight === 0) return null;
  const style = window.getComputedStyle(container);
  const width = Math.max(0, Number.parseInt(style.width));
  const height = Number.parseInt(style.height);
  if (Number.isNaN(width) || Number.isNaN(height) || height === 0) return null;
  return {
    cols: Math.max(MINIMUM_COLS, Math.floor((width - scrollbarWidth) / cellWidth)),
    rows: Math.max(MINIMUM_ROWS, Math.floor(height / cellHeight)),
  };
}
