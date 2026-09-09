import { describe, expect, it } from "vitest";
import {
  encodeCompactSemanticTerminalUpdate,
  encodeCompactSemanticTerminalUpdateCooperatively,
  terminalSemanticUpdateNeedsCooperativeEncoding,
  TerminalDeliveryStateTooLargeError,
} from "./terminal-delivery.ts";
import { blankTerminalReplicaSnapshot } from "./terminal-replica.ts";
import type { TerminalSemanticDeliveryPayload } from "@tmux-ide/contracts";
function seed(cols = 128, rows = 64) {
  return {
    frame: "seed" as const,
    revision: 2,
    snapshot: structuredClone(blankTerminalReplicaSnapshot(cols, rows)),
  };
}
const yielding = { yieldControl: async () => {} };
describe("cooperative compact seed encoding", () => {
  it("emits byte-identical dense style, Unicode, wide and history representations", async () => {
    const input = seed();
    for (let y = 0; y < input.snapshot.grid.length; y++) {
      const row = input.snapshot.grid[y]!;
      row.wrapped = y % 2 === 0;
      for (let x = 0; x < row.cells.length; x++)
        row.cells[x] = {
          ...row.cells[x]!,
          grapheme: x % 3 === 0 ? '界é🙂\\"\n' : String(x % 10),
          foreground: { kind: "rgb", value: 0x124578 + x },
          background: { kind: "indexed", index: y },
          attributes: x % 256,
        };
      row.cells[0]!.width = 2;
      row.cells[1]!.width = 0;
    }
    input.snapshot.history = input.snapshot.grid.slice(0, 3);
    input.snapshot.placements = [
      {
        id: "widget",
        kind: "plot",
        row: 0,
        column: 0,
        rows: 1,
        columns: 1,
        contentDigest: "digest",
      },
    ];
    expect(await encodeCompactSemanticTerminalUpdateCooperatively(input, yielding)).toEqual(
      encodeCompactSemanticTerminalUpdate(input),
    );
  });
  it("joins runs across validation slices and retains exact key order", async () => {
    const input = seed(4096, 2);
    expect(await encodeCompactSemanticTerminalUpdateCooperatively(input, yielding)).toEqual(
      encodeCompactSemanticTerminalUpdate(input),
    );
  });
  it.each(["envelope", "snapshot", "row", "width", "attributes", "color", "cursor", "placement"])(
    "rejects malformed %s with the strict schema",
    async (kind) => {
      const input = seed();
      if (kind === "envelope") Object.assign(input, { unknown: true });
      if (kind === "snapshot") Object.assign(input.snapshot, { unknown: true });
      if (kind === "row") Object.assign(input.snapshot.grid[0]!, { unknown: true });
      if (kind === "width") Object.assign(input.snapshot.grid[0]!.cells[0]!, { width: 3 });
      if (kind === "attributes") input.snapshot.grid[0]!.cells[0]!.attributes = 256;
      if (kind === "color")
        Object.assign(input.snapshot.grid[0]!.cells[0]!, {
          foreground: { kind: "indexed", index: 256 },
        });
      if (kind === "cursor") input.snapshot.cursor.x = -1;
      if (kind === "placement")
        input.snapshot.placements = [
          { id: "", kind: "x", row: 0, column: 0, rows: 1, columns: 1, contentDigest: "x" },
        ];
      expect(() => encodeCompactSemanticTerminalUpdate(input)).toThrow();
      await expect(
        encodeCompactSemanticTerminalUpdateCooperatively(input, yielding),
      ).rejects.toThrow();
    },
  );
  it("checks aggregate row/cell and representation limits", async () => {
    const rows = seed();
    rows.snapshot.history = Array.from({ length: 10001 }, () => rows.snapshot.grid[0]!);
    await expect(
      encodeCompactSemanticTerminalUpdateCooperatively(rows, yielding),
    ).rejects.toBeInstanceOf(TerminalDeliveryStateTooLargeError);
    const bytes = seed();
    for (const row of bytes.snapshot.grid)
      for (let i = 0; i < row.cells.length; i++)
        row.cells[i]!.grapheme = (i % 2 ? "a" : "b").repeat(4096);
    expect(() => encodeCompactSemanticTerminalUpdate(bytes)).toThrow(
      TerminalDeliveryStateTooLargeError,
    );
    await expect(
      encodeCompactSemanticTerminalUpdateCooperatively(bytes, yielding),
    ).rejects.toBeInstanceOf(TerminalDeliveryStateTooLargeError);
  });
  it("yields during validation before reading a whole seed and aborts without bytes", async () => {
    const input = seed();
    let reads = 0;
    for (const row of input.snapshot.grid)
      for (const cell of row.cells)
        Object.defineProperty(cell, "grapheme", {
          enumerable: true,
          get: () => {
            reads++;
            return "";
          },
        });
    const controller = new AbortController(),
      reason = new Error("client retired");
    await expect(
      encodeCompactSemanticTerminalUpdateCooperatively(input, {
        signal: controller.signal,
        yieldControl: async () => {
          expect(reads).toBe(256);
          controller.abort(reason);
        },
      }),
    ).rejects.toBe(reason);
    expect(reads).toBe(256);
  });
  it("keeps small updates on ordinary encoding with no task yield", async () => {
    let yields = 0;
    for (const input of [
      seed(4, 2),
      { frame: "patch", baseRevision: 0, revision: 1, patch: { rows: [] } },
    ] satisfies TerminalSemanticDeliveryPayload[]) {
      expect(terminalSemanticUpdateNeedsCooperativeEncoding(input)).toBe(false);
      expect(
        await encodeCompactSemanticTerminalUpdateCooperatively(input, {
          yieldControl: async () => {
            yields++;
          },
        }),
      ).toEqual(encodeCompactSemanticTerminalUpdate(input));
    }
    expect(yields).toBe(0);
  });
});
