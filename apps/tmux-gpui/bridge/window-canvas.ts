import { z } from "zod";
import {
  TerminalReplicaSnapshotSchemaZ,
  type TerminalReplicaSnapshot,
  type TerminalReplicaRow,
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

type Contributor = { left: number; row: TerminalReplicaRow };
type Surfaces = z.infer<typeof surfacesSchema>;

/** One presentation lifetime. Source rows/cells must be immutable, as canonical replicas are. */
export function createWindowCanvasComposer() {
  let prior: {
    key: string;
    contributors: Contributor[][];
    snapshot: TerminalReplicaSnapshot;
    metadata: string;
  } | null = null;
  const reset = () => {
    prior = null;
  };
  const invalid = () => {
    reset();
    return null;
  };
  const integer = (value: number, min: number, max: number) =>
    Number.isInteger(value) && value >= min && value <= max;
  return {
    reset,
    compose(
      layout: Layout,
      selected: string,
      surfaces: Surfaces,
      basis = "",
    ): TerminalReplicaSnapshot | null {
      if (
        !layout.semanticWindowId ||
        !integer(layout.cols, 1, 1000) ||
        !integer(layout.rows, 1, 500) ||
        layout.panes.length < 1 ||
        layout.panes.length > 24 ||
        surfaces.length > 24
      )
        return invalid();
      const snapshots = new Map(surfaces.map((s) => [s.paneId, s.snapshot]));
      if (snapshots.size !== surfaces.length) {
        reset();
        throw new Error("Duplicate pane surface");
      }
      const focus = layout.panes.find((p) => p.pane === selected),
        selectedSnapshot = snapshots.get(selected);
      if (!focus || !selectedSnapshot) return invalid();
      const contributors: Contributor[][] = Array.from({ length: layout.rows }, () => []);
      const paneIds = new Set<string>();
      for (const pane of layout.panes) {
        if (
          !pane.pane ||
          paneIds.has(pane.pane) ||
          !integer(pane.left, 0, layout.cols - 1) ||
          !integer(pane.top, 0, layout.rows - 1) ||
          !integer(pane.width, 1, layout.cols) ||
          !integer(pane.height, 1, layout.rows) ||
          pane.left + pane.width > layout.cols ||
          pane.top + pane.height > layout.rows
        )
          return invalid();
        paneIds.add(pane.pane);
        const content = contentRect(layout, pane),
          snapshot = snapshots.get(pane.pane);
        if (
          content.rows < 1 ||
          !snapshot ||
          snapshot.cols !== pane.width ||
          snapshot.rows !== content.rows ||
          snapshot.grid.length !== content.rows
        )
          return invalid();
        for (let y = 0; y < content.rows; y++) {
          const row = snapshot.grid[y]!;
          if (row.cells.length !== pane.width) return invalid();
          contributors[content.top + y]!.push({ left: pane.left, row });
        }
      }
      for (const rows of contributors) {
        rows.sort((a, b) => a.left - b.left);
        let end = 0;
        for (const contributor of rows) {
          if (contributor.left < end) return invalid();
          end = contributor.left + contributor.row.cells.length;
        }
      }
      const key = JSON.stringify([
        basis,
        layout.semanticWindowId,
        layout.cols,
        layout.rows,
        layout.paneBorderStatus,
        layout.panes.map((p) => [p.pane, p.left, p.top, p.width, p.height]),
      ]);
      const old = prior?.key === key ? prior : null;
      const cursor = {
        ...selectedSnapshot.cursor,
        x: focus.left + selectedSnapshot.cursor.x,
        y: contentRect(layout, focus).top + selectedSnapshot.cursor.y,
      };
      const metadata = JSON.stringify([cursor, selectedSnapshot.modes, selectedSnapshot.bootstrap]);
      let blank: TerminalReplicaSnapshot | undefined;
      const blankSnapshot = () => (blank ??= blankTerminalReplicaSnapshot(layout.cols, 1));
      let changed = !old;
      const grid = contributors.map((rows, y) => {
        const previous = old?.contributors[y];
        if (
          previous &&
          previous.length === rows.length &&
          rows.every((part, i) => part.left === previous[i]!.left && part.row === previous[i]!.row)
        )
          return old!.snapshot.grid[y]!;
        changed = true;
        const cells = [...(old?.snapshot.grid[y] ?? blankSnapshot().grid[0]!).cells];
        for (const [index, { left, row }] of rows.entries()) {
          if (previous?.[index]?.row === row && previous[index]!.left === left) continue;
          for (let x = 0; x < row.cells.length; x++) cells[left + x] = row.cells[x]!;
        }
        // Canvas wrapped state has always been false; per-pane copy regions carry source wrapping.
        return { wrapped: false, cells };
      });
      if (old && !changed && old.metadata === metadata) return old.snapshot;
      const snapshot: TerminalReplicaSnapshot = {
        ...(old?.snapshot ?? blankSnapshot()),
        rows: layout.rows,
        grid: old && !changed ? old.snapshot.grid : grid,
        cursor,
        modes: selectedSnapshot.modes,
        bootstrap: selectedSnapshot.bootstrap,
      };
      prior = { key, contributors, snapshot, metadata };
      return snapshot;
    },
  };
}

/** Pure compatibility entry: canonical replicas and ACKs stay with per-pane owners. */
export function windowCanvas(
  layout: Layout,
  selected: string,
  surfaces: Surfaces,
): TerminalReplicaSnapshot | null {
  return createWindowCanvasComposer().compose(layout, selected, surfaces);
}
