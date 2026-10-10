import type { z } from "zod";
import type { TerminalReplicaSnapshot } from "../../../packages/contracts/src/terminal-replica.ts";
import type { Layout } from "./topology.ts";
import { contentRect, surfacesSchema, windowCanvas } from "./window-canvas.ts";

type Surfaces = z.infer<typeof surfacesSchema>;
type Region = { id: string; left: number; top: number; width: number; height: number };
export type WindowPresentation = {
  snapshot: TerminalReplicaSnapshot;
  copyRegion: Region & { wrapped: boolean[] };
  regions: Region[];
};

// Incoming fields are schema validated. These relational checks distinguish resize
// skew from missing surfaces, malformed rectangles, or inconsistent snapshot grids.
function inspect(layout: Layout | undefined, selected: string, surfaces: Surfaces) {
  if (
    !layout?.semanticWindowId ||
    !Number.isInteger(layout.cols) ||
    layout.cols < 1 ||
    layout.cols > 1000 ||
    !Number.isInteger(layout.rows) ||
    layout.rows < 1 ||
    layout.rows > 500 ||
    layout.panes.length < 1 ||
    layout.panes.length > 24
  )
    return null;
  const snapshots = new Map(surfaces.map((s) => [s.paneId, s.snapshot]));
  if (snapshots.size !== surfaces.length) return null;
  const ids = new Set<string>();
  let skew = false;
  for (const [index, pane] of layout.panes.entries()) {
    if (!pane.pane || ids.has(pane.pane)) return null;
    ids.add(pane.pane);
    if (
      ![pane.left, pane.top, pane.width, pane.height].every(Number.isInteger) ||
      pane.left < 0 ||
      pane.top < 0 ||
      pane.width < 1 ||
      pane.height < 1 ||
      pane.left + pane.width > layout.cols ||
      pane.top + pane.height > layout.rows
    )
      return null;
    for (const prior of layout.panes.slice(0, index)) {
      if (
        pane.left < prior.left + prior.width &&
        prior.left < pane.left + pane.width &&
        pane.top < prior.top + prior.height &&
        prior.top < pane.top + pane.height
      )
        return null;
    }
    const content = contentRect(layout, pane);
    const snapshot = snapshots.get(pane.pane);
    if (
      content.rows < 1 ||
      !snapshot ||
      snapshot.grid.length !== snapshot.rows ||
      snapshot.grid.some((row) => row.cells.length !== snapshot.cols)
    )
      return null;
    if (snapshot.cols !== pane.width || snapshot.rows !== content.rows) skew = true;
  }
  if (!ids.has(selected)) return null;
  return { layout, snapshots, skew, membership: JSON.stringify([...ids].sort()) };
}

/** One instance per selected-pane helper lifetime; never carries state across reselect. */
export function createWindowPresentation(selectedPaneId: string) {
  let cached: { window: string; membership: string; value: WindowPresentation } | undefined;
  return {
    update(
      layout: Layout | undefined,
      surfaces: Surfaces,
      allowRetention: boolean,
    ): WindowPresentation | null {
      if (!allowRetention) cached = undefined;
      const checked = inspect(layout, selectedPaneId, surfaces);
      if (!checked) {
        cached = undefined;
        return null;
      }
      const sameScope =
        cached?.window === checked.layout.semanticWindowId &&
        cached.membership === checked.membership;
      if (!sameScope) cached = undefined;
      if (checked.skew) return allowRetention && sameScope ? cached!.value : null;
      const snapshot = windowCanvas(checked.layout, selectedPaneId, surfaces);
      if (!snapshot) {
        cached = undefined;
        return null;
      }
      const focus = checked.layout.panes.find((p) => p.pane === selectedPaneId)!;
      const surface = checked.snapshots.get(selectedPaneId)!;
      const value: WindowPresentation = {
        snapshot,
        copyRegion: {
          id: selectedPaneId,
          left: focus.left,
          top: contentRect(checked.layout, focus).top,
          width: surface.cols,
          height: surface.rows,
          wrapped: surface.grid.map((row) => row.wrapped),
        },
        regions: checked.layout.panes.map((p) => ({
          id: p.pane!,
          left: p.left,
          top: p.top,
          width: p.width,
          height: p.height,
        })),
      };
      if (allowRetention)
        cached = {
          window: checked.layout.semanticWindowId!,
          membership: checked.membership,
          value,
        };
      return value;
    },
  };
}
