import { blankTerminalReplicaSnapshot, hashTerminalReplicaSnapshot } from "@tmux-ide/core";
import { describe, expect, it } from "vitest";
import { prepareCausalCellFixtureV1 } from "./causal-cell-input-fixture.ts";

const traceId = "00000000-0000-4000-8000-000000000099";
const generation = "11111111-1111-4111-8111-111111111111";

function state() {
  const blank = blankTerminalReplicaSnapshot(4, 2);
  const snapshot = {
    ...blank,
    cursor: { ...blank.cursor, x: 3, y: 1 },
    modes: { ...blank.modes, wraparound: false },
  };
  return {
    workspaceName: "workspace.test",
    semanticPaneId: "pane.alpha",
    generation,
    incarnation: `${generation}:0`,
    revision: 8,
    snapshot,
    tombstone: null,
    hash: hashTerminalReplicaSnapshot(snapshot),
    frameHash: "0000000000000000",
  };
}

describe("prepareCausalCellFixtureV1", () => {
  it.each([
    ["single key", "x", "eA==", "x"],
    ["paste burst", "\x1b[200~abcd\x1b[201~", "YWJjZA==", "d"],
  ])("builds a raw/noecho ASCII %s fixture", (_name, data, encoded, after) => {
    const result = prepareCausalCellFixtureV1(state(), { kind: "text", data }, traceId);
    expect(result).toMatchObject({
      input: { kind: "text", data: `${traceId};${encoded}\n` },
      probe: {
        traceId,
        geometry: { cols: 4, rows: 2, row: 1, column: 3 },
        after: { grapheme: after, width: 1 },
      },
    });
  });

  it("refuses an unfenced terminal mode, cursor, wide cell or non-ASCII input", () => {
    const current = state();
    expect(
      prepareCausalCellFixtureV1(
        {
          ...current,
          snapshot: {
            ...current.snapshot!,
            modes: { ...current.snapshot!.modes, wraparound: true },
          },
        },
        { kind: "text", data: "x" },
        traceId,
      ),
    ).toBeNull();
    expect(prepareCausalCellFixtureV1(current, { kind: "text", data: "é" }, traceId)).toBeNull();
    const row = current.snapshot!.grid[1]!;
    expect(
      prepareCausalCellFixtureV1(
        {
          ...current,
          snapshot: {
            ...current.snapshot!,
            grid: [
              current.snapshot!.grid[0]!,
              { ...row, cells: [...row.cells.slice(0, 3), { ...row.cells[3]!, width: 2 }] },
            ],
          },
        },
        { kind: "text", data: "x" },
        traceId,
      ),
    ).toBeNull();
  });
});
