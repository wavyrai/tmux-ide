import { describe, expect, it, vi } from "vitest";
import type { TerminalReplicaRow, TerminalReplicaSnapshot } from "@tmux-ide/contracts";
import * as rowHash from "./terminal-replica-hash-cache.ts";
import {
  applyTerminalReplicaPatch,
  blankTerminalReplicaSnapshot,
  hashTerminalReplicaSnapshot,
} from "./terminal-replica.ts";

function changed(row: TerminalReplicaRow, text: string): TerminalReplicaRow {
  return {
    wrapped: !row.wrapped,
    cells: row.cells.map((cell, index) => ({
      ...cell,
      grapheme: index === 0 ? text : cell.grapheme,
    })),
  };
}

// Fresh, unfrozen row arrays deliberately use the full sequence calculation.
function fullHash(snapshot: TerminalReplicaSnapshot): string {
  return hashTerminalReplicaSnapshot({
    ...snapshot,
    grid: [...snapshot.grid],
    history: [...snapshot.history],
  });
}

describe("incremental terminal grid digest", () => {
  it.each([1, 70, 1_000])(
    "matches a full digest across sparse and dense patches at %i rows",
    (rows) => {
      let snapshot = blankTerminalReplicaSnapshot(8, rows);
      hashTerminalReplicaSnapshot(snapshot);
      for (let step = 0; step < 20; step++) {
        const indices = [...new Set([step % rows, rows - 1, Math.floor(rows / 2)])];
        snapshot = applyTerminalReplicaPatch(snapshot, {
          rows: indices.map((index) => ({
            index,
            row: changed(snapshot.grid[index]!, `字${step}`),
          })),
          cursor: { ...snapshot.cursor, x: step % 8 },
        });
        expect(hashTerminalReplicaSnapshot(snapshot)).toBe(fullHash(snapshot));
      }
      snapshot = applyTerminalReplicaPatch(snapshot, {
        rows: snapshot.grid.map((row, index) => ({ index, row: changed(row, `${index}`) })),
      });
      expect(hashTerminalReplicaSnapshot(snapshot)).toBe(fullHash(snapshot));
    },
  );

  it("does not revisit untouched row hashes for a warm sparse commit", () => {
    const initial = blankTerminalReplicaSnapshot(80, 1000);
    hashTerminalReplicaSnapshot(initial);
    const spy = vi.spyOn(rowHash, "hashTerminalReplicaRowCached");
    try {
      const next = applyTerminalReplicaPatch(initial, {
        rows: [{ index: 499, row: changed(initial.grid[499]!, "x") }],
      });
      const digest = hashTerminalReplicaSnapshot(next);
      expect(spy.mock.calls.length).toBeLessThanOrEqual(2);
      spy.mockRestore();
      expect(digest).toBe(fullHash(next));
    } finally {
      spy.mockRestore();
    }
  });

  it("retains no-op row identity and hashes cursor-only updates", () => {
    const initial = blankTerminalReplicaSnapshot(8, 3);
    const before = hashTerminalReplicaSnapshot(initial);
    const next = applyTerminalReplicaPatch(initial, {
      rows: [{ index: 1, row: structuredClone(initial.grid[1]!) }],
      cursor: { ...initial.cursor, x: 2 },
    });
    expect(next.grid).toBe(initial.grid);
    expect(hashTerminalReplicaSnapshot(next)).not.toBe(before);
    expect(hashTerminalReplicaSnapshot(next)).toBe(fullHash(next));
  });

  it("falls back for cold, resized, and externally mutable snapshots", () => {
    for (const warm of [false, true]) {
      let snapshot = blankTerminalReplicaSnapshot(8, 3);
      if (warm) hashTerminalReplicaSnapshot(snapshot);
      snapshot = applyTerminalReplicaPatch(snapshot, {
        dimensions: { cols: 5, rows: 2 },
        rows: [],
      });
      expect(hashTerminalReplicaSnapshot(snapshot)).toBe(fullHash(snapshot));
      snapshot = applyTerminalReplicaPatch(snapshot, {
        dimensions: { cols: 9, rows: 7 },
        rows: [],
      });
      expect(hashTerminalReplicaSnapshot(snapshot)).toBe(fullHash(snapshot));
    }
    const mutable = structuredClone(blankTerminalReplicaSnapshot(8, 3));
    hashTerminalReplicaSnapshot(mutable);
    const next = applyTerminalReplicaPatch(mutable, {
      rows: [{ index: 1, row: changed(mutable.grid[1]!, "new") }],
    });
    const before = hashTerminalReplicaSnapshot(next);
    mutable.grid[0]!.cells[0]!.grapheme = "external mutation";
    expect(hashTerminalReplicaSnapshot(next)).not.toBe(before);
    expect(hashTerminalReplicaSnapshot(next)).toBe(fullHash(next));
  });
});
