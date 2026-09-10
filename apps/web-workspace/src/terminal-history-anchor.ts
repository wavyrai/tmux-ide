import { terminalReplicaRowsEqual } from "@tmux-ide/core";
import type { MirrorPaneFrameContext } from "../../desktop-renderer/src/terminal/workspace-pane-compositor";

/** Physical canonical history coordinate, never a guessed text occurrence. */
export interface TerminalHistoryAnchor {
  readonly row: number;
}

export function captureTerminalHistoryAnchor(
  frame: MirrorPaneFrameContext | undefined,
  viewportY: number,
  baseY: number,
): TerminalHistoryAnchor | null {
  const snapshot = frame?.canonicalSnapshot;
  if (!frame?.canonical || !snapshot || snapshot.modes.alternateScreen || viewportY >= baseY)
    return null;
  const row = snapshot.history.length - baseY + viewportY;
  return Number.isSafeInteger(row) && row >= 0 && row < snapshot.history.length ? { row } : null;
}

/**
 * O(1) for ordinary patches. Reseeds require proof of retained physical rows;
 * repeated text is never searched for an apparent overlap. Width/height changes
 * need a separate native reflow map and deliberately invalidate this anchor.
 */
export function advanceTerminalHistoryAnchor(
  anchor: TerminalHistoryAnchor | null,
  previous: MirrorPaneFrameContext | undefined,
  next: MirrorPaneFrameContext | undefined,
): TerminalHistoryAnchor | null {
  const a = previous?.canonical;
  const b = next?.canonical;
  const old = previous?.canonicalSnapshot;
  const current = next?.canonicalSnapshot;
  if (
    !anchor ||
    !a ||
    !b ||
    !old ||
    !current ||
    a.generation !== b.generation ||
    a.incarnation !== b.incarnation ||
    b.revision < a.revision ||
    old.cols !== current.cols ||
    old.rows !== current.rows ||
    old.modes.alternateScreen ||
    current.modes.alternateScreen
  )
    return null;
  const update = next.canonicalUpdate;
  let trim = 0;
  if (
    update?.type === "terminal.patch" &&
    update.baseRevision === a.revision &&
    update.revision === b.revision &&
    !update.patch.history
  ) {
    trim = update.patch.historyDelta?.trim ?? 0;
  } else if (
    old.history === current.history ||
    (old.history.length <= current.history.length &&
      old.history.every((row, index) => terminalReplicaRowsEqual(row, current.history[index])))
  ) {
    // Every old coordinate is still the same row, even when new history follows.
  } else {
    trim = old.history.length - current.history.length;
    if (
      trim <= 0 ||
      current.history.length === 0 ||
      !old.grid.every((row, index) => terminalReplicaRowsEqual(row, current.grid[index])) ||
      !current.history.every((row, index) =>
        terminalReplicaRowsEqual(row, old.history[index + trim]),
      )
    )
      return null;
  }
  const row = anchor.row - trim;
  return row >= 0 && row < current.history.length ? { row } : null;
}

export function terminalHistoryViewport(
  anchor: TerminalHistoryAnchor | null,
  frame: MirrorPaneFrameContext | undefined,
  baseY: number,
): number | null {
  if (!anchor || !frame?.canonicalSnapshot) return null;
  const row = anchor.row - (frame.canonicalSnapshot.history.length - baseY);
  // Locally evicted scrollback is not the same row as the first retained row.
  return row >= 0 && row < baseY ? row : null;
}
