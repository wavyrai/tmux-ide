import type { CausalCellProbeRequestV1, SessionRuntimeTerminalInput } from "@tmux-ide/contracts";
import type { TerminalReplicaState } from "@tmux-ide/core";

export interface PreparedCausalCellFixtureV1 {
  readonly input: SessionRuntimeTerminalInput;
  readonly probe: CausalCellProbeRequestV1;
}

/**
 * Build the ASCII request consumed by ProductRig's raw/noecho helper. The
 * helper has already disabled DECAWM and positioned the cursor in the last
 * column, so an arbitrary printable burst overwrites one stable width-1 cell.
 */
export function prepareCausalCellFixtureV1(
  state: TerminalReplicaState | null,
  input: SessionRuntimeTerminalInput,
  traceId: string,
): PreparedCausalCellFixtureV1 | null {
  const snapshot = state?.snapshot;
  const pasteStart = "\u001b[200~";
  const pasteEnd = "\u001b[201~";
  const text =
    input.data.startsWith(pasteStart) && input.data.endsWith(pasteEnd)
      ? input.data.slice(pasteStart.length, -pasteEnd.length)
      : input.data;
  if (!state || !snapshot || input.kind !== "text" || !/^[\x20-\x7e]{1,64}$/u.test(text))
    return null;
  const row = snapshot.cursor.y;
  const column = snapshot.cols - 1;
  if (snapshot.modes.wraparound || snapshot.cursor.x !== column || row < 0 || row >= snapshot.rows)
    return null;
  const before = snapshot.grid[row]?.cells[column];
  if (!before || before.width !== 1) return null;
  const last = text.at(-1)!;
  const after = { ...before, grapheme: last, width: 1 as const };
  return {
    input: {
      kind: "text",
      data: `${traceId};${Buffer.from(text, "ascii").toString("base64")}\n`,
    },
    probe: {
      version: 1,
      capability: "causal-cell-v1",
      traceId,
      semanticPaneId: state.semanticPaneId,
      generation: state.generation,
      incarnation: state.incarnation,
      baselineRevision: state.revision,
      baselineStateHash: state.hash,
      geometry: { cols: snapshot.cols, rows: snapshot.rows, row, column },
      before,
      after,
    },
  };
}
