import type { CausalCellProbeV1, TerminalReplicaSnapshot } from "@tmux-ide/contracts";
import { blankTerminalReplicaSnapshot, hashTerminalReplicaSnapshot } from "@tmux-ide/core";
import { describe, expect, it } from "vitest";
import { CAUSAL_CELL_OSC_PREFIX, CausalCellLedger } from "./causal-cell-ledger.ts";
import type { SessionRuntimeScheduler } from "./runtime-scheduler.ts";

const TRACE = "00000000-0000-4000-8000-000000000099";
const GENERATION = "11111111-1111-4111-8111-111111111111";

function rig(rows = 1) {
  const timers: Array<{ task: () => void; cancelled: boolean }> = [];
  const scheduler: SessionRuntimeScheduler = {
    nowMs: () => 0,
    createId: () => TRACE,
    microtask: (task) => task(),
    timer: (task) => {
      const timer = { task, cancelled: false };
      timers.push(timer);
      return { cancel: () => (timer.cancelled = true) };
    },
  };
  const baseline = blankTerminalReplicaSnapshot(2, rows);
  const before = baseline.grid[0]!.cells[1]!;
  const after = { ...before, grapheme: "X" };
  const probe: CausalCellProbeV1 = {
    version: 1,
    capability: "causal-cell-v1",
    traceId: TRACE,
    clientId: "client:test",
    transportNonce: "00000000-0000-4000-8000-000000000010",
    deliveryNonce: "00000000-0000-4000-8000-000000000011",
    inputSequence: 1,
    semanticPaneId: "pane.alpha",
    generation: GENERATION,
    incarnation: `${GENERATION}:0`,
    baselineRevision: 7,
    baselineStateHash: hashTerminalReplicaSnapshot(baseline),
    geometry: { cols: 2, rows, row: 0, column: 1 },
    before,
    after,
  };
  const candidate: TerminalReplicaSnapshot = {
    ...baseline,
    grid: baseline.grid.map((row, rowIndex) =>
      rowIndex === 0 ? { ...row, cells: [row.cells[0]!, after] } : row,
    ),
  };
  const results: unknown[] = [];
  const ledger = new CausalCellLedger({
    probe,
    baseline,
    scheduler,
    onResult: (result) => results.push(result),
  });
  return { ledger, probe, baseline, candidate, results, timers };
}

describe("CausalCellLedger", () => {
  it.each(["reply-first", "osc-first"])(
    "joins control acceptance and split OSC/canonical proof in %s order",
    (order) => {
      const { ledger, baseline, candidate, results, timers } = rig();
      if (order === "reply-first") ledger.observeControlReply(true);
      expect(ledger.observeOsc(`${CAUSAL_CELL_OSC_PREFIX};start;${TRACE}`)).toBe(true);
      // OSC start may arrive in its own parser write; an unchanged projection
      // is not a no-op failure until the matching end closes the epoch.
      ledger.observeCommit(baseline, 7, hashTerminalReplicaSnapshot(baseline));
      ledger.observeCommit(candidate, 8, hashTerminalReplicaSnapshot(candidate));
      expect(ledger.observeOsc(`${CAUSAL_CELL_OSC_PREFIX};end;${TRACE}`)).toBe(true);
      if (order === "osc-first") ledger.observeControlReply(true);
      expect(results).toEqual([
        expect.objectContaining({
          status: "proved",
          proof: expect.objectContaining({
            traceId: TRACE,
            baselineRevision: 7,
            committedRevision: 8,
            before: expect.objectContaining({ grapheme: " " }),
            after: expect.objectContaining({ grapheme: "X" }),
          }),
        }),
      ]);
      expect(timers[0]!.cancelled).toBe(true);
    },
  );

  it("fails closed for an extra canonical change", () => {
    const { ledger, candidate, results } = rig();
    const extra = {
      ...candidate,
      cursor: { ...candidate.cursor, hidden: !candidate.cursor.hidden },
    };
    ledger.observeControlReply(true);
    ledger.observeOsc(`${CAUSAL_CELL_OSC_PREFIX};start;${TRACE}`);
    ledger.observeCommit(extra, 8, hashTerminalReplicaSnapshot(extra));
    expect(results).toEqual([
      expect.objectContaining({
        status: "failed",
        traceId: TRACE,
        reason: "ambiguous-delta",
        diagnostic: expect.objectContaining({
          changedCellCount: 1,
          changedRowCount: 1,
          changedCoordinates: [{ row: 0, column: 1 }],
          targetMatched: true,
          cursorChanged: true,
          modesChanged: false,
        }),
      }),
    ]);
  });

  it("proves a semantically identical candidate with permuted object-key insertion order", () => {
    const { ledger, candidate, results } = rig();
    const permuted = {
      bootstrap: {
        hiddenState: candidate.bootstrap.hiddenState,
        kind: candidate.bootstrap.kind,
      },
      placements: candidate.placements.map((placement) => ({
        contentDigest: placement.contentDigest,
        rows: placement.rows,
        columns: placement.columns,
        column: placement.column,
        row: placement.row,
        kind: placement.kind,
        id: placement.id,
      })),
      modes: {
        synchronizedOutput: candidate.modes.synchronizedOutput,
        mouseTracking: candidate.modes.mouseTracking,
        wraparound: candidate.modes.wraparound,
        origin: candidate.modes.origin,
        insert: candidate.modes.insert,
        bracketedPaste: candidate.modes.bracketedPaste,
        applicationKeypad: candidate.modes.applicationKeypad,
        applicationCursor: candidate.modes.applicationCursor,
        alternateScreen: candidate.modes.alternateScreen,
      },
      cursor: {
        blink: candidate.cursor.blink,
        style: candidate.cursor.style,
        hidden: candidate.cursor.hidden,
        y: candidate.cursor.y,
        x: candidate.cursor.x,
      },
      history: candidate.history.map((row) => ({ wrapped: row.wrapped, cells: row.cells })),
      grid: candidate.grid.map((row) => ({ wrapped: row.wrapped, cells: row.cells })),
      rows: candidate.rows,
      cols: candidate.cols,
    } satisfies TerminalReplicaSnapshot;
    expect(JSON.stringify(permuted)).not.toBe(JSON.stringify(candidate));
    ledger.observeControlReply(true);
    ledger.observeOsc(`${CAUSAL_CELL_OSC_PREFIX};start;${TRACE}`);
    ledger.observeCommit(permuted, 8, hashTerminalReplicaSnapshot(permuted));
    ledger.observeOsc(`${CAUSAL_CELL_OSC_PREFIX};end;${TRACE}`);
    expect(results).toEqual([expect.objectContaining({ status: "proved" })]);
  });

  it("fails closed and names a changed wrapped row", () => {
    const { ledger, candidate, results } = rig();
    const wrapped = {
      ...candidate,
      grid: [{ ...candidate.grid[0]!, wrapped: !candidate.grid[0]!.wrapped }],
    };
    ledger.observeControlReply(true);
    ledger.observeOsc(`${CAUSAL_CELL_OSC_PREFIX};start;${TRACE}`);
    ledger.observeCommit(wrapped, 8, hashTerminalReplicaSnapshot(wrapped));
    expect(results).toEqual([
      expect.objectContaining({
        status: "failed",
        reason: "ambiguous-delta",
        diagnostic: expect.objectContaining({
          changedCellCount: 1,
          changedWrappedRowCount: 1,
          changedWrappedRows: [0],
          wrappedRowsTruncated: false,
          targetMatched: true,
          semanticSnapshotMatched: false,
          serializationOrderOnly: false,
        }),
      }),
    ]);
  });

  it("bounds changed wrapped-row coordinates", () => {
    const { ledger, candidate, results } = rig(10);
    const wrapped = {
      ...candidate,
      grid: candidate.grid.map((row) => ({ ...row, wrapped: !row.wrapped })),
    };
    ledger.observeControlReply(true);
    ledger.observeOsc(`${CAUSAL_CELL_OSC_PREFIX};start;${TRACE}`);
    ledger.observeCommit(wrapped, 8, hashTerminalReplicaSnapshot(wrapped));
    expect(results).toEqual([
      expect.objectContaining({
        diagnostic: expect.objectContaining({
          changedWrappedRowCount: 10,
          changedWrappedRows: [0, 1, 2, 3, 4, 5, 6, 7],
          wrappedRowsTruncated: true,
        }),
      }),
    ]);
  });

  it("bounds coordinates and exposes structural causes without cell content", () => {
    const { ledger, baseline, results } = rig();
    const candidate = {
      ...baseline,
      grid: baseline.grid.map((row) => ({
        ...row,
        cells: row.cells.map((cell, column) => ({
          ...cell,
          attributes: column + 1,
        })),
      })),
      modes: { ...baseline.modes, insert: !baseline.modes.insert },
    };
    ledger.observeControlReply(true);
    ledger.observeOsc(`${CAUSAL_CELL_OSC_PREFIX};start;${TRACE}`);
    ledger.observeCommit(candidate, 8, hashTerminalReplicaSnapshot(candidate));
    const diagnostic = (results[0] as { diagnostic: Record<string, unknown> }).diagnostic;
    expect(diagnostic).toMatchObject({
      changedCellCount: 2,
      changedRowCount: 1,
      targetMatched: false,
      modesChanged: true,
    });
    expect(JSON.stringify(diagnostic)).not.toContain("grapheme");
  });

  it("distinguishes target rendition mismatch from cursor drift", () => {
    const { ledger, baseline, candidate, results } = rig();
    const styled = {
      ...candidate,
      grid: [
        {
          ...candidate.grid[0]!,
          cells: [
            candidate.grid[0]!.cells[0]!,
            {
              ...candidate.grid[0]!.cells[1]!,
              foreground: { kind: "indexed" as const, index: 1 },
            },
          ],
        },
      ],
    };
    ledger.observeControlReply(true);
    ledger.observeOsc(`${CAUSAL_CELL_OSC_PREFIX};start;${TRACE}`);
    ledger.observeCommit(styled, 8, hashTerminalReplicaSnapshot(styled));
    expect(results).toEqual([
      expect.objectContaining({
        reason: "ambiguous-delta",
        diagnostic: expect.objectContaining({
          changedCellCount: 1,
          changedCoordinates: [{ row: 0, column: 1 }],
          targetMatched: false,
          cursorChanged: false,
        }),
      }),
    ]);
    expect(baseline.cursor).toEqual(styled.cursor);
  });

  it("bounds unchanged split commits while the diagnostic epoch is open", () => {
    const { ledger, baseline, results } = rig();
    ledger.observeControlReply(true);
    ledger.observeOsc(`${CAUSAL_CELL_OSC_PREFIX};start;${TRACE}`);
    for (let index = 0; index < 65; index += 1)
      ledger.observeCommit(baseline, 7, hashTerminalReplicaSnapshot(baseline));
    expect(results).toEqual([{ status: "failed", traceId: TRACE, reason: "capacity-exhausted" }]);
  });

  it("bounds private OSC marker bytes before parsing", () => {
    const { ledger, results } = rig();
    expect(ledger.observeOsc("x".repeat(129))).toBe(true);
    expect(results).toEqual([{ status: "failed", traceId: TRACE, reason: "capacity-exhausted" }]);
  });

  it.each([
    [
      "control error",
      (ledger: CausalCellLedger) => ledger.observeControlReply(false),
      "control-rejected",
    ],
    [
      "wrong marker",
      (ledger: CausalCellLedger) =>
        ledger.observeOsc(`${CAUSAL_CELL_OSC_PREFIX};start;00000000-0000-4000-8000-000000000001`),
      "marker-mismatch",
    ],
    [
      "nested marker",
      (ledger: CausalCellLedger) => {
        ledger.observeOsc(`${CAUSAL_CELL_OSC_PREFIX};start;${TRACE}`);
        ledger.observeOsc(`${CAUSAL_CELL_OSC_PREFIX};start;${TRACE}`);
      },
      "marker-order",
    ],
  ])("fails closed for %s", (_label, act, reason) => {
    const { ledger, results } = rig();
    act(ledger);
    expect(results).toEqual([{ status: "failed", traceId: TRACE, reason }]);
  });

  it("expires bounded state and ignores a late candidate", () => {
    const { ledger, candidate, results, timers } = rig();
    timers[0]!.task();
    ledger.observeControlReply(true);
    ledger.observeOsc(`${CAUSAL_CELL_OSC_PREFIX};start;${TRACE}`);
    ledger.observeCommit(candidate, 8, hashTerminalReplicaSnapshot(candidate));
    expect(results).toEqual([{ status: "failed", traceId: TRACE, reason: "timeout" }]);
  });
});
