import { it, expect } from "vitest";
import { blankTerminalReplicaSnapshot, hashTerminalReplicaSnapshot } from "@tmux-ide/core";
import { RendererProbe, type ProbeRecord } from "./renderer-probe.ts";
const nonce = "a".repeat(32),
  trial = { id: "input-0-tui", nonce };
function state(text = "") {
  const b = blankTerminalReplicaSnapshot(110, 3);
  const row = {
    ...b.grid[0]!,
    cells: b.grid[0]!.cells.map((c, i) => ({ ...c, grapheme: text[i] ?? " " })),
  };
  const snapshot = { ...b, grid: [row, ...b.grid.slice(1)] };
  return {
    workspaceName: "w",
    semanticPaneId: "pane.a",
    generation: "g",
    incarnation: "i",
    revision: 1,
    snapshot,
    tombstone: null,
    hash: hashTerminalReplicaSnapshot(snapshot),
    frameHash: "0000000000000000",
  };
}
it("times nonce workload and requires fully visible exact blitted row", () => {
  const records: ProbeRecord[] = [],
    p = new RendererProbe([trial], (r) => records.push(r)),
    s = state();
  expect(p.admit({ kind: "text", data: "!" }, s, 100)?.data).toBe(`PROBE-IN:${nonce}\n`);
  const done = state(`PROBE-OUTPUT:${nonce}`);
  p.row(done, done.snapshot.grid[0], 0, 10, 3, 0, 0, 500);
  expect(records).toHaveLength(0);
  p.row(done, done.snapshot.grid[0], 0, 110, 3, 1, 0, 500);
  expect(records).toHaveLength(0);
  p.row(done, done.snapshot.grid[0], 0, 110, 3, 0, 0, 500);
  expect(records[0]).toMatchObject({
    status: "completed",
    durationMicros: 400,
    sourceScope: { pane: "pane.a", generation: "g", incarnation: "i" },
    witness: { row: 0, column: 0, revision: 1 },
  });
  p.row(done, done.snapshot.grid[0], 0, 110, 3, 0, 0, 600);
  expect(records).toHaveLength(1);
});
it("fails replacement, timeout and stale negative control without replay", () => {
  for (const reason of ["scope-changed", "timeout", "negative-control"]) {
    const records: ProbeRecord[] = [],
      p = new RendererProbe([trial], (r) => records.push(r));
    p.admit(
      { kind: "text", data: "!" },
      state(reason === "negative-control" ? `PROBE-OUTPUT:${nonce}` : ""),
      100,
    );
    if (reason === "scope-changed") p.observe({ ...state(), incarnation: "new" }, 200);
    if (reason === "timeout") p.tick(5_000_101);
    expect(records[0]?.reason).toBe(reason);
    expect(p.pending).toBe(false);
  }
});
it("scroll preparation is not timed; new viewport row is witnessed", () => {
  const records: ProbeRecord[] = [],
    p = new RendererProbe([{ ...trial, kind: "scroll" }], (r) => records.push(r));
  const s = state();
  const h = state(`PROBE-ROW:${nonce}:0001`).snapshot.grid[0]!;
  s.snapshot = { ...s.snapshot, history: [h] };
  expect(p.admit({ kind: "text", data: "!" }, s, 100)?.data).toBe(
    `PROBE-PREPARE-SCROLL:${nonce}\n`,
  );
  expect(p.pending).toBe(false);
  p.scroll(
    { pane: "pane.a", generation: "g", incarnation: "i", cols: 110, rows: 3 },
    s.snapshot,
    0,
    1,
    200,
  );
  p.row(s, h, 0, 110, 3, 0, 0, 300);
  expect(records).toHaveLength(0);
  p.row(s, h, 0, 110, 3, 0, 1, 400);
  expect(records[0]).toMatchObject({ kind: "scroll", durationMicros: 200, expectedOffset: 1 });
});

it("output trials request the bounded burst and complete only on its final rendered marker", () => {
  const records: ProbeRecord[] = [];
  const p = new RendererProbe([{ ...trial, kind: "output" }], (r) => records.push(r));
  expect(p.admit({ kind: "text", data: "!" }, state(), 100)?.data).toBe(`PROBE-BURST:${nonce}\n`);
  const intermediate = state(`PROBE-BURST:${nonce}:16383`);
  p.row(intermediate, intermediate.snapshot.grid[0], 0, 110, 3, 0, 0, 300);
  expect(records).toHaveLength(0);
  const final = state(`PROBE-OUTPUT:${nonce}`);
  p.row(final, final.snapshot.grid[0], 0, 110, 3, 0, 0, 500);
  expect(records[0]).toMatchObject({ kind: "output", status: "completed", durationMicros: 400 });
});
