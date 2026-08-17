import { describe, expect, it } from "vitest";
import { CausalCellProbeV1SchemaZ } from "../causal-cell.ts";
import { TerminalReplicaCellSchemaZ } from "../terminal-replica.ts";

const cell = TerminalReplicaCellSchemaZ.parse({
  grapheme: " ",
  width: 1,
  foreground: { kind: "default" },
  background: { kind: "default" },
  attributes: 0,
});

function probe() {
  return {
    version: 1,
    capability: "causal-cell-v1",
    traceId: "00000000-0000-4000-8000-000000000099",
    clientId: "client:test",
    transportNonce: "00000000-0000-4000-8000-000000000010",
    deliveryNonce: "00000000-0000-4000-8000-000000000011",
    inputSequence: 1,
    semanticPaneId: "pane.alpha",
    generation: "11111111-1111-4111-8111-111111111111",
    incarnation: "one",
    baselineRevision: 7,
    baselineStateHash: "0000000000000000",
    geometry: { cols: 2, rows: 1, row: 0, column: 1 },
    before: cell,
    after: { ...cell, grapheme: "X" },
  };
}

describe("causal-cell-v1 contracts", () => {
  it("accepts an exact width-1 probe", () => {
    expect(CausalCellProbeV1SchemaZ.safeParse(probe()).success).toBe(true);
  });

  it.each([0, 2])("rejects non-canonical width %s before/after cells", (width) => {
    expect(
      CausalCellProbeV1SchemaZ.safeParse({ ...probe(), before: { ...cell, width } }).success,
    ).toBe(false);
    expect(
      CausalCellProbeV1SchemaZ.safeParse({ ...probe(), after: { ...cell, grapheme: "X", width } })
        .success,
    ).toBe(false);
  });
});
