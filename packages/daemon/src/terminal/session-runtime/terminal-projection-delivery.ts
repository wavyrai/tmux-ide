import type {
  TerminalProjectionPayload,
  TerminalProjectionSnapshot,
  TerminalReplicaSnapshot,
} from "@tmux-ide/contracts";
import {
  hashTerminalProjection,
  projectAlternateSnapshot,
  terminalReplicaRowsEqual,
} from "@tmux-ide/core";

/** A projection receipt never becomes a complete canonical baseline. */
export interface ProjectionBaseline {
  readonly revision: number;
  readonly incarnation: string;
  readonly hash: string;
  readonly snapshot: TerminalProjectionSnapshot;
}

export function prepareProjection(
  snapshot: TerminalReplicaSnapshot,
  revision: number,
  incarnation: string,
  baseline: ProjectionBaseline | null,
): { payload: TerminalProjectionPayload; retained: ProjectionBaseline } {
  const projected = projectAlternateSnapshot(snapshot);
  const retained = {
    revision,
    incarnation,
    hash: hashTerminalProjection(projected),
    snapshot: projected,
  };
  if (
    !baseline ||
    baseline.incarnation !== incarnation ||
    baseline.snapshot.cols !== projected.cols ||
    baseline.snapshot.rows !== projected.rows
  )
    return { payload: { frame: "seed", revision, projection: projected }, retained };
  const rows = projected.grid.flatMap((row, index) =>
    terminalReplicaRowsEqual(row, baseline.snapshot.grid[index]!) ? [] : [{ index, row }],
  );
  return {
    retained,
    payload: {
      frame: "patch",
      baseRevision: baseline.revision,
      revision,
      patch: {
        rows,
        deferredHistory: projected.deferredHistory,
        cursor: projected.cursor,
        modes: projected.modes,
        placements: projected.placements,
        bootstrap: projected.bootstrap,
      },
    },
  };
}
