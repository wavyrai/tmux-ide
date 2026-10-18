import { createHash } from "node:crypto";
import type {
  TerminalReplicaSnapshot,
  TerminalReplicaRow,
} from "../../../packages/contracts/src/terminal-replica.ts";
import type { HistoryFrame } from "./history-restoration.ts";
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sameRows = (a: readonly TerminalReplicaRow[], b: readonly TerminalReplicaRow[]) =>
  a.length === b.length && a.every((row, index) => row === b[index]);
const identity = (frame: HistoryFrame) =>
  JSON.stringify([
    frame.proof.workspaceName,
    frame.proof.semanticPaneId,
    frame.proof.generation,
    frame.proof.incarnation,
    frame.snapshot.cols,
    frame.snapshot.rows,
    frame.snapshot.modes.alternateScreen,
  ]);
/** Display proof only. Retain at most one viewport's immutable row references, never a terminal capability. */
export function createSelectionIdentity() {
  let lineage:
    | { token: string; identity: string; rows: TerminalReplicaRow[]; valid: boolean }
    | undefined;
  let cached: { key: string; rows: TerminalReplicaRow[]; value: string | null } | undefined;
  return (
    frame: HistoryFrame | null,
    viewport: TerminalReplicaSnapshot | null,
    offset: number,
    index: number | null,
    anchor: { state: string; token: string | null } | null,
  ): string | null => {
    if (!frame || !viewport) {
      if (lineage) lineage.valid = false;
      cached = undefined;
      return null;
    }
    const scope = identity(frame);
    if (lineage && lineage.identity !== scope) lineage.valid = false;
    if (
      viewport.cols !== frame.snapshot.cols ||
      viewport.rows !== frame.snapshot.rows ||
      viewport.grid.length !== viewport.rows ||
      viewport.rows > 500 ||
      viewport.cols > 1000
    )
      return null;
    if (
      anchor?.state === "restoring" ||
      (offset > 0 && (anchor?.state !== "historical" || !anchor.token))
    )
      return null;
    let key: string;
    if (
      offset >= viewport.rows &&
      anchor?.state === "historical" &&
      anchor.token &&
      index !== null
    ) {
      // Token is established only by successful exact capture or owner resolve.
      // The entire interval must still be immutable history, not a mixed live grid.
      const raw = frame.snapshot.history;
      const rows = raw.slice(index, index + viewport.rows);
      const seen = new Map(rows.map((row) => [row, 0]));
      for (const row of raw) if (seen.has(row)) seen.set(row, seen.get(row)! + 1);
      const unique =
        index >= 0 &&
        index + viewport.rows <= raw.length &&
        rows.every((row) => seen.get(row) === 1);
      if (!lineage || lineage.token !== anchor.token)
        lineage = { token: anchor.token, identity: scope, rows: [...viewport.grid], valid: true };
      if (!unique || !sameRows(rows, viewport.grid) || !sameRows(lineage.rows, viewport.grid))
        lineage.valid = false;
      if (!lineage.valid) return null;
      key = JSON.stringify(["history-v1", scope, anchor.token]);
    } else {
      // Live or mixed content has no cross-revision row identity proof.
      key = JSON.stringify([
        "canonical-v1",
        scope,
        frame.proof.revision,
        frame.proof.stateHash,
        offset,
      ]);
    }
    if (cached?.key === key && sameRows(cached.rows, viewport.grid)) return cached.value;
    const serialized = JSON.stringify(viewport.grid);
    if (Buffer.byteLength(serialized) > 2 * 1024 * 1024) {
      lineage = undefined;
      cached = undefined;
      return null;
    }
    const value = digest([key, serialized]);
    cached = { key, rows: [...viewport.grid], value };
    return value;
  };
}
/** Browser adds verified routing and the final selected content/canvas geometry. */
export function scopeSelectionIdentity(
  proof: string | null,
  route: string | null,
  window: string | undefined,
  region: { id: string; left: number; top: number; width: number; height: number },
  canvas: { cols: number; rows: number },
): string | null {
  return proof && /^[a-f0-9]{64}$/.test(proof) && route && window
    ? digest([
        "selection-v1",
        proof,
        route,
        window,
        region.id,
        region.left,
        region.top,
        region.width,
        region.height,
        canvas.cols,
        canvas.rows,
      ])
    : null;
}
