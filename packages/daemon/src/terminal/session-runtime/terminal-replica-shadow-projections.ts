import type { TerminalReplicaSnapshot } from "@tmux-ide/contracts";
import { resolveTerminalReplicaColor, XTERM_PALETTE } from "@tmux-ide/core";

export interface TerminalReplicaShadowTheme {
  readonly foreground: number;
  readonly background: number;
}

/** Test/shadow-only web projection; production xterm parsing remains until m56.5. */
export function projectTerminalReplicaForWeb(snapshot: TerminalReplicaSnapshot) {
  return snapshot.grid.map((row) =>
    row.cells.map((cell) => ({
      text: cell.grapheme,
      width: cell.width,
      foreground: cell.foreground,
      background: cell.background,
      attributes: cell.attributes,
    })),
  );
}

/** Test/shadow-only OpenTUI projection; production PaneMirror remains until m56.4. */
export function projectTerminalReplicaForOpenTui(
  snapshot: TerminalReplicaSnapshot,
  theme: TerminalReplicaShadowTheme,
) {
  return snapshot.grid.map((row) =>
    row.cells.map((cell) => ({
      text: cell.grapheme,
      width: cell.width,
      fg: resolveTerminalReplicaColor(cell.foreground, theme, "foreground", XTERM_PALETTE),
      bg: resolveTerminalReplicaColor(cell.background, theme, "background", XTERM_PALETTE),
      attributes: cell.attributes,
    })),
  );
}
