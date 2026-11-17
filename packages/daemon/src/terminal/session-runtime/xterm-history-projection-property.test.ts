// Property test written by review-393 for #430: the backend's
// incremental history projection (the historyDelta clients apply) must equal a
// full read of a replica that received the same bytes, after any mix of scrolls
// at the limit, ED2 (with and without home), ED3, the alternate screen and
// resizes.
import { describe, expect, it } from "vitest";
import { blankTerminalReplicaSnapshot } from "@tmux-ide/core";
import type { TerminalReplicaSnapshot } from "@tmux-ide/contracts";
import { createXtermTerminalInterpreterBackend } from "./xterm-terminal-interpreter-backend.ts";

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}
const text = (rows: readonly TerminalReplicaSnapshot["history"][number][]) =>
  rows.map((row) =>
    row.cells
      .map((c) => c.grapheme)
      .join("")
      .replace(/\s+$/u, ""),
  );

describe.each([
  [20, 6, 12],
  [50, 10, 16],
  [7, 4, 10],
])("history projection equals a fresh read: limit %i, %i rows, %i cols", (limit, rows0, cols0) => {
  it.each(Array.from({ length: 30 }, (_, i) => i + 1))(
    "seed %i",
    async (seed) => {
      const rand = rng(seed * 104729 + limit);
      const int = (n: number) => Math.floor(rand() * n);
      let cols = cols0;
      let rows = rows0;
      type Op = { bytes?: string; resize?: [number, number] };
      const ops: Op[] = [];
      const a = createXtermTerminalInterpreterBackend({
        cols,
        rows,
        scrollback: limit,
        historyLimit: limit,
      });
      a.startHistoryCollection?.();
      let prev: TerminalReplicaSnapshot = blankTerminalReplicaSnapshot(cols, rows);
      let line = 0;
      const stats = { deltas: 0, trims: 0, checks: 0 };
      try {
        for (let step = 0; step < 50; step++) {
          const r = int(100);
          let op: Op;
          if (r < 55) {
            const k = 1 + int(30);
            op = {
              bytes: Array.from(
                { length: k },
                () => `${line++}${"x".repeat(int(cols * 1.5))}\r\n`,
              ).join(""),
            };
          } else if (r < 65) op = { bytes: "\x1b[H\x1b[2J" };
          else if (r < 72) op = { bytes: "\x1b[2J" };
          else if (r < 76) op = { bytes: "\x1b[3J" };
          else if (r < 84)
            op = {
              bytes:
                "\x1b[?1049h" +
                Array.from({ length: 1 + int(20) }, () => `alt${line++}\r\n`).join("") +
                "\x1b[?1049l",
            };
          else if (r < 90) {
            cols = Math.max(4, cols0 - 3 + int(7));
            rows = Math.max(2, rows0 - 2 + int(5));
            op = { resize: [cols, rows] };
          } else op = { bytes: `\x1b[${1 + int(rows)};1H` };
          ops.push(op);
          if (op.bytes) await a.write(op.bytes);
          if (op.resize) a.resize(op.resize[0], op.resize[1]);
          const projection = a.project(prev);
          if (projection.historyDelta) {
            stats.deltas += 1;
            if (projection.historyDelta.trim > 0) stats.trims += 1;
            // What a client does with the delta, from the history it holds.
            expect(
              text([
                ...prev.history.slice(projection.historyDelta.trim),
                ...projection.historyDelta.append,
              ]),
            ).toEqual(text(projection.history));
          }
          // A fresh replica fed the same bytes, read in full.
          const fresh = createXtermTerminalInterpreterBackend({
            cols: cols0,
            rows: rows0,
            scrollback: limit,
            historyLimit: limit,
          });
          fresh.startHistoryCollection?.();
          try {
            for (const o of ops) {
              if (o.bytes) await fresh.write(o.bytes);
              if (o.resize) fresh.resize(o.resize[0], o.resize[1]);
            }
            const full = fresh.project(blankTerminalReplicaSnapshot(cols, rows));
            expect(text(projection.history), `step ${step} op ${JSON.stringify(op)}`).toEqual(
              text(full.history),
            );
            stats.checks += 1;
          } finally {
            fresh.dispose();
          }
          prev = {
            ...prev,
            cols: projection.cols,
            rows: projection.rows,
            grid: projection.grid as TerminalReplicaSnapshot["grid"],
            history: projection.history as TerminalReplicaSnapshot["history"],
            cursor: projection.cursor,
            modes: projection.modes,
          };
        }
      } finally {
        a.dispose();
      }
    },
    60_000,
  );
});
