import type { CausalCellProbeV1, TerminalReplicaSnapshot } from "@tmux-ide/contracts";
import { blankTerminalReplicaSnapshot, hashTerminalReplicaSnapshot } from "@tmux-ide/core";
import { describe, expect, it } from "vitest";
import { CAUSAL_CELL_OSC_PREFIX, CausalCellLedger } from "./causal-cell-ledger.ts";
import type { SessionRuntimeScheduler } from "./runtime-scheduler.ts";

const TRACE = "00000000-0000-4000-8000-000000000099";
const GENERATION = "11111111-1111-4111-8111-111111111111";

function rig() {
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
  const baseline = blankTerminalReplicaSnapshot(2, 1);
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
    geometry: { cols: 2, rows: 1, row: 0, column: 1 },
    before,
    after,
  };
  const candidate: TerminalReplicaSnapshot = {
    ...baseline,
    grid: [{ ...baseline.grid[0]!, cells: [baseline.grid[0]!.cells[0]!, after] }],
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
    expect(results).toEqual([{ status: "failed", traceId: TRACE, reason: "ambiguous-delta" }]);
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
