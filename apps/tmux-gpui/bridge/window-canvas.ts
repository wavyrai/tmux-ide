import { z } from "zod";
import {
  TerminalReplicaSnapshotSchemaZ,
  type TerminalReplicaSnapshot,
} from "../../../packages/contracts/src/terminal-replica.ts";
import { blankTerminalReplicaSnapshot } from "../../../packages/core/src/terminal-replica.ts";
import type { Layout } from "./topology.ts";

export const surfacesSchema = z
  .array(
    z
      .object({ paneId: z.string().min(1).max(512), snapshot: TerminalReplicaSnapshotSchemaZ })
      .strict(),
  )
  .max(24);

// Layout rectangles include an outer pane-border-status row; terminal grids do not.
// Matches the native geometry contract used by the TUI's terminal-layout-projection.
export function contentRect(layout: Layout, pane: Layout["panes"][number]) {
  const topStatus = layout.paneBorderStatus === "top" && pane.top === 0;
  const bottomStatus =
    layout.paneBorderStatus === "bottom" && pane.top + pane.height === layout.rows;
  return {
    top: pane.top + (topStatus ? 1 : 0),
    rows: pane.height - (topStatus || bottomStatus ? 1 : 0),
  };
}

/** Presentation only: canonical replicas and ACKs stay with their per-pane owners. */
export function windowCanvas(
  layout: Layout,
  selected: string,
  surfaces: z.infer<typeof surfacesSchema>,
): TerminalReplicaSnapshot | null {
  if (!layout.semanticWindowId || layout.cols > 1000 || layout.rows > 500) return null;
  const snapshots = new Map(surfaces.map((s) => [s.paneId, s.snapshot]));
  if (snapshots.size !== surfaces.length) throw new Error("Duplicate pane surface");
  const focus = layout.panes.find((p) => p.pane === selected);
  const selectedSnapshot = snapshots.get(selected);
  if (!focus || !selectedSnapshot) return null;
  const base = blankTerminalReplicaSnapshot(layout.cols, layout.rows);
  const grid = base.grid.map((row) => ({ ...row, cells: [...row.cells] }));
  const occupied = new Uint8Array(layout.cols * layout.rows);
  for (const pane of layout.panes) {
    if (!pane.pane) return null;
    const snapshot = snapshots.get(pane.pane);
    const content = contentRect(layout, pane);
    if (!snapshot || snapshot.cols !== pane.width || snapshot.rows !== content.rows) return null;
    if (
      pane.left + pane.width > layout.cols ||
      pane.top + pane.height > layout.rows ||
      snapshot.grid.length !== content.rows
    )
      return null;
    for (let y = 0; y < content.rows; y++) {
      const row = snapshot.grid[y]!;
      if (row.cells.length !== pane.width) return null;
      for (let x = 0; x < pane.width; x++) {
        const offset = (content.top + y) * layout.cols + pane.left + x;
        if (occupied[offset]) return null;
        occupied[offset] = 1;
        grid[content.top + y]!.cells[pane.left + x] = row.cells[x]!;
      }
    }
  }
  return {
    ...base,
    grid,
    modes: selectedSnapshot.modes,
    bootstrap: selectedSnapshot.bootstrap,
    cursor: {
      ...selectedSnapshot.cursor,
      x: focus.left + selectedSnapshot.cursor.x,
      y: contentRect(layout, focus).top + selectedSnapshot.cursor.y,
    },
  };
}
