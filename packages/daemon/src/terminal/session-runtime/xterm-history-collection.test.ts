import { describe, expect, it } from "vitest";
import { blankTerminalReplicaSnapshot } from "@tmux-ide/core";
import { createXtermTerminalInterpreterBackend } from "./xterm-terminal-interpreter-backend.ts";

/**
 * tmux at its history-limit collects the oldest tenth of history before each
 * scroll that would exceed it (grid_collect_history, grid-view.c), so its
 * history_size moves between 0.9 and 1.0 of the limit. A replica that
 * recycled one line at a time sat at the limit instead, and the owner's
 * history-size check reseeded the pane, full history, every time output
 * paused.
 */
function tmuxHistorySize(limit: number, scrolls: number): number {
  let size = 0;
  for (let n = 0; n < scrolls; n++) {
    if (size > 0 && size >= limit) size -= Math.min(size, Math.max(1, Math.floor(limit / 10)));
    size += 1;
  }
  return size;
}

const lines = (from: number, count: number) =>
  Array.from({ length: count }, (_, i) => `L${from + i}\r\n`).join("");

describe("replica history at tmux's history-limit", () => {
  it.each([
    [20, 2, 30],
    [20, 2, 57],
    [2000, 10, 2400],
    [5, 3, 41],
  ])(
    "limit %i, %i rows, %i lines: history size and rows match tmux",
    async (limit, rows, count) => {
      const backend = createXtermTerminalInterpreterBackend({
        cols: 12,
        rows,
        scrollback: limit,
        historyLimit: limit,
      });
      backend.startHistoryCollection?.();
      try {
        await backend.write(lines(0, count));
        // The cursor ends on the blank line after the last one, so one more scrolled.
        const scrolls = count + 1 - rows;
        const expected = tmuxHistorySize(limit, scrolls);
        const projection = backend.project(blankTerminalReplicaSnapshot(12, rows));
        expect(projection.history).toHaveLength(expected);
        // The newest rows survive, in order; the oldest are the ones collected.
        const text = (row: (typeof projection.history)[number]) =>
          row.cells
            .map((cell) => cell.grapheme)
            .join("")
            .trim();
        expect(text(projection.history.at(-1)!)).toBe(`L${count - rows}`);
        expect(text(projection.history[0]!)).toBe(`L${scrolls - expected}`);
      } finally {
        backend.dispose();
      }
    },
  );

  it("replays a capture as it is: collection starts only afterwards", async () => {
    const backend = createXtermTerminalInterpreterBackend({
      cols: 12,
      rows: 2,
      scrollback: 25,
      historyLimit: 20,
    });
    try {
      await backend.write(lines(0, 26));
      expect(backend.project(blankTerminalReplicaSnapshot(12, 2)).history).toHaveLength(25);
    } finally {
      backend.dispose();
    }
  });

  it("projects a collection as one trim patch, not a full history", async () => {
    const limit = 20;
    const backend = createXtermTerminalInterpreterBackend({
      cols: 12,
      rows: 2,
      scrollback: limit,
      historyLimit: limit,
    });
    backend.startHistoryCollection?.();
    try {
      await backend.write(lines(0, 21));
      const before = backend.project(blankTerminalReplicaSnapshot(12, 2));
      expect(before.history).toHaveLength(limit);
      await backend.write(lines(21, 1));
      const after = backend.project(before);
      expect(after.history).toHaveLength(limit - 2 + 1);
      expect(after.historyDelta).toMatchObject({ trim: 2 });
      expect(after.historyDelta!.append).toHaveLength(1);
    } finally {
      backend.dispose();
    }
  });
});
