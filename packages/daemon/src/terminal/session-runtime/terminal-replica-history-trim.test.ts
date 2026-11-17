import { describe, expect, it } from "vitest";
import type { CanonicalTerminalReplicaUpdate } from "@tmux-ide/contracts";
import { applyTerminalReplicaUpdate, hashTerminalReplicaSnapshot } from "@tmux-ide/core";
import { TerminalReplicaInterpreter } from "./terminal-replica-interpreter.ts";

const generation = "00000000-0000-4000-8000-000000000001";
const encoder = new TextEncoder();
const rowText = (row: { cells: readonly { grapheme: string }[] }) =>
  row.cells
    .map((cell) => cell.grapheme)
    .join("")
    .trimEnd();
const lines = (from: number, count: number) =>
  Array.from({ length: count }, (_, i) => `row${from + i}`).join("\r\n");

function interpreter(updates: CanonicalTerminalReplicaUpdate[], rows = 3) {
  return new TerminalReplicaInterpreter({
    generation,
    workspaceName: "workspace",
    semanticPaneId: "pane-a",
    incarnation: `${generation}:0`,
    cols: 12,
    rows,
    scrollback: 100,
    onUpdate: (update) => updates.push(update),
  });
}

describe("history drift trimmed instead of reseeded", () => {
  it.each([1, 7, 30])(
    "a %i-row trim is one patch, and equals what a fresh capture of tmux gives",
    async (trim) => {
      const updates: CanonicalTerminalReplicaUpdate[] = [];
      const replica = interpreter(updates);
      try {
        await replica.enqueue({
          type: "reseed",
          cols: 12,
          rows: 3,
          historyLimit: 100,
          chunks: [encoder.encode(lines(0, 43))],
          cursor: { x: 5, y: 2 },
          bootstrap: "authoritative-stream",
        });
        const before = replica.currentSnapshot();
        expect(before.history).toHaveLength(40);
        const baseline = applyTerminalReplicaUpdate(null, replica.currentSeed()!);
        await replica.enqueue({ type: "trim-history", rows: trim });
        const after = replica.currentSnapshot();
        // tmux dropped its oldest rows: the same rows go, the rest and the
        // screen stay.
        expect(after.history.map(rowText)).toEqual(before.history.slice(trim).map(rowText));
        expect(after.grid).toEqual(before.grid);
        const update = updates.at(-1)!;
        expect(update.type).toBe("terminal.patch");
        if (update.type !== "terminal.patch") return;
        expect(update.patch.historyDelta).toEqual({ trim, append: [] });
        expect(update.patch.history).toBeUndefined();
        // A client applying the patch holds exactly the replica's state.
        const applied = applyTerminalReplicaUpdate(baseline.state, update);
        expect(applied.status).toBe("applied");
        expect(hashTerminalReplicaSnapshot(applied.state!.snapshot!)).toBe(
          hashTerminalReplicaSnapshot(after),
        );
        // And a fresh capture of what tmux now holds gives the same rows.
        const fresh = interpreter([]);
        try {
          await fresh.enqueue({
            type: "reseed",
            cols: 12,
            rows: 3,
            historyLimit: 100,
            chunks: [encoder.encode(lines(trim, 43 - trim))],
            cursor: { x: 5, y: 2 },
            bootstrap: "authoritative-stream",
          });
          expect(fresh.currentSnapshot().history.map(rowText)).toEqual(after.history.map(rowText));
          expect(fresh.currentSnapshot().grid.map(rowText)).toEqual(after.grid.map(rowText));
        } finally {
          await fresh.enqueue({ type: "close", reason: "runtime-disposed" });
        }
      } finally {
        await replica.enqueue({ type: "close", reason: "runtime-disposed" });
      }
    },
  );

  it("refuses a trim deeper than the history", async () => {
    const replica = interpreter([]);
    try {
      await replica.enqueue({ type: "write", data: encoder.encode(lines(0, 5)) });
      await expect(replica.enqueue({ type: "trim-history", rows: 99 })).rejects.toThrow();
      // The FIFO keeps working.
      await replica.enqueue({ type: "write", data: encoder.encode("\r\nmore") });
    } finally {
      await replica.enqueue({ type: "close", reason: "runtime-disposed" });
    }
  });
});
