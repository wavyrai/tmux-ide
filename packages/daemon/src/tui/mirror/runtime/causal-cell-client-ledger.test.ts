import type { CausalCellProbeRequestV1, CausalCellProofV1 } from "@tmux-ide/contracts";
import { blankTerminalReplicaSnapshot, hashTerminalReplicaSnapshot } from "@tmux-ide/core";
import { describe, expect, it } from "vitest";
import { CausalCellClientLedger } from "./causal-cell-client-ledger.ts";

const traceId = "00000000-0000-4000-8000-000000000099";
const generation = "11111111-1111-4111-8111-111111111111";

function rig(scheduleTimeout?: (task: () => void, delayMs: number) => () => void) {
  const baseline = blankTerminalReplicaSnapshot(2, 1);
  const before = baseline.grid[0]!.cells[1]!;
  const after = { ...before, grapheme: "X", width: 1 as const };
  const request: CausalCellProbeRequestV1 = {
    version: 1,
    capability: "causal-cell-v1",
    traceId,
    semanticPaneId: "pane.alpha",
    generation,
    incarnation: `${generation}:0`,
    baselineRevision: 7,
    baselineStateHash: hashTerminalReplicaSnapshot(baseline),
    geometry: { cols: 2, rows: 1, row: 0, column: 1 },
    before,
    after,
  };
  const snapshot = {
    ...baseline,
    grid: [{ ...baseline.grid[0]!, cells: [baseline.grid[0]!.cells[0]!, after] }],
  };
  const stateHash = hashTerminalReplicaSnapshot(snapshot);
  const proof: CausalCellProofV1 = {
    ...request,
    clientId: "client:test",
    transportNonce: "00000000-0000-4000-8000-000000000010",
    deliveryNonce: "00000000-0000-4000-8000-000000000011",
    inputSequence: 1,
    semanticPaneId: "pane.alpha",
    committedRevision: 8,
    committedStateHash: stateHash,
  };
  const finalized: unknown[] = [];
  const failures: unknown[] = [];
  const ledger = new CausalCellClientLedger({
    onFinalized: (value) => finalized.push(value),
    onFailure: (...value) => failures.push(value),
    ...(scheduleTimeout ? { scheduleTimeout } : {}),
  });
  const delivery = {
    semanticPaneId: "pane.alpha",
    generation,
    incarnation: `${generation}:0`,
    revision: 8,
    stateHash,
    snapshot,
    atMicros: 20,
  };
  const paint = {
    semanticPaneId: "pane.alpha",
    ...delivery,
    viewport: { cols: 2, rows: 1 },
    activePaneRect: { x: 4, y: 3, width: 2, height: 1 },
    writtenRows: new Set([0]),
    scrollOffset: 0,
    atMicros: 30,
  };
  return { ledger, request, proof, delivery, paint, finalized, failures };
}

function clippedRig() {
  const baseline = blankTerminalReplicaSnapshot(2, 2);
  const before = baseline.grid[0]!.cells[1]!;
  const after = { ...before, grapheme: "X", width: 1 as const };
  const snapshot = {
    ...baseline,
    grid: [
      { ...baseline.grid[0]!, cells: [baseline.grid[0]!.cells[0]!, after] },
      baseline.grid[1]!,
    ],
  };
  const stateHash = hashTerminalReplicaSnapshot(snapshot);
  const input = rig();
  return {
    ...input,
    request: {
      ...input.request,
      baselineStateHash: hashTerminalReplicaSnapshot(baseline),
      geometry: { cols: 2, rows: 2, row: 0, column: 1 },
      before,
      after,
    },
    proof: {
      ...input.proof,
      baselineStateHash: hashTerminalReplicaSnapshot(baseline),
      geometry: { cols: 2, rows: 2, row: 0, column: 1 },
      before,
      after,
      committedStateHash: stateHash,
    },
    delivery: { ...input.delivery, snapshot, stateHash },
    paint: {
      ...input.paint,
      snapshot,
      stateHash,
      viewport: { cols: 2, rows: 1 },
      activePaneRect: { x: 4, y: 3, width: 2, height: 1 },
      writtenRows: new Set([0]),
    },
  };
}

describe("CausalCellClientLedger", () => {
  it.each([
    ["proof-delivery-paint", ["proof", "delivery", "paint"]],
    ["paint-proof-delivery", ["paint", "proof", "delivery"]],
    ["delivery-paint-proof", ["delivery", "paint", "proof"]],
  ])("joins %s without relying on latest trace", (_name, order) => {
    const input = rig();
    input.ledger.arm(input.request, 10);
    for (const item of order) {
      if (item === "proof") input.ledger.noteProof(input.proof);
      if (item === "delivery") input.ledger.noteDelivery(input.delivery);
      if (item === "paint") input.ledger.notePaint(input.paint);
    }
    expect(input.finalized).toEqual([
      expect.objectContaining({ inputAtMicros: 10, deliveredAtMicros: 20, paintedAtMicros: 30 }),
    ]);
    expect(input.failures).toEqual([]);
  });

  it("fails closed when the exact target row was not written in the active pane", () => {
    const input = rig();
    input.ledger.arm(input.request, 10);
    input.ledger.noteProof(input.proof);
    input.ledger.noteDelivery(input.delivery);
    input.ledger.notePaint({ ...input.paint, writtenRows: new Set() });
    expect(input.finalized).toEqual([]);
    expect(input.failures).toEqual([[traceId, "geometry-drift"]]);
  });

  it("rejects an otherwise exact proof delivered and painted for another pane", () => {
    const input = rig();
    input.ledger.arm(input.request, 10);
    const semanticPaneId = "pane.beta";
    input.ledger.noteProof({ ...input.proof, semanticPaneId });
    input.ledger.noteDelivery({ ...input.delivery, semanticPaneId });
    input.ledger.notePaint({ ...input.paint, semanticPaneId });
    expect(input.finalized).toEqual([]);
    expect(input.failures).toEqual([[traceId, "marker-mismatch"]]);
  });

  it("retires every pending proof on disconnect and ignores late evidence", () => {
    const input = rig();
    input.ledger.arm(input.request, 10);
    input.ledger.dispose();
    input.ledger.noteProof(input.proof);
    expect(input.failures).toEqual([[traceId, "transport-closed"]]);
    expect(input.finalized).toEqual([]);
  });

  it("fails a skipped revision on the bounded client deadline", () => {
    let expire = () => undefined;
    const input = rig((task) => {
      expire = task;
      return () => undefined;
    });
    expect(input.ledger.arm(input.request, 10)).toBe(true);
    input.ledger.noteProof(input.proof);
    expire();
    expect(input.failures).toEqual([[traceId, "timeout"]]);
  });

  it("preserves a bounded daemon structural diagnostic on failure", () => {
    const input = rig();
    const diagnostic = {
      version: 1 as const,
      baselineRevision: 7,
      baselineStateHash: input.request.baselineStateHash,
      candidateRevision: 8,
      candidateStateHash: input.proof.committedStateHash,
      dimensionsChanged: false,
      changedCellCount: 2,
      changedRowCount: 1,
      changedCoordinates: [
        { row: 0, column: 0 },
        { row: 0, column: 1 },
      ],
      coordinatesTruncated: false,
      targetMatched: true,
      cursorChanged: false,
      modesChanged: false,
      historyChanged: false,
      placementsChanged: false,
      bootstrapChanged: false,
    };
    input.ledger.arm(input.request, 10);
    input.ledger.fail(traceId, "ambiguous-delta", diagnostic);
    expect(input.failures).toEqual([[traceId, "ambiguous-delta", diagnostic]]);
  });

  it("rejects a scrolled paint even when the target row was dirty", () => {
    const input = rig();
    input.ledger.arm(input.request, 10);
    input.ledger.noteProof(input.proof);
    input.ledger.noteDelivery(input.delivery);
    input.ledger.notePaint({ ...input.paint, scrollOffset: 1 });
    expect(input.failures).toEqual([[traceId, "geometry-drift"]]);
  });

  it("accepts an exact visible target in a viewport clipped below the canonical snapshot", () => {
    const input = clippedRig();
    input.ledger.arm(input.request, 10);
    input.ledger.noteProof(input.proof);
    input.ledger.noteDelivery(input.delivery);
    input.ledger.notePaint(input.paint);
    expect(input.failures).toEqual([]);
    expect(input.finalized).toHaveLength(1);
  });

  it("rejects a canonical target outside the exact painted viewport", () => {
    const input = clippedRig();
    const request = { ...input.request, geometry: { ...input.request.geometry, row: 1 } };
    const snapshot = {
      ...input.delivery.snapshot,
      grid: [
        {
          ...input.delivery.snapshot.grid[0]!,
          cells: [input.delivery.snapshot.grid[0]!.cells[0]!, request.before],
        },
        {
          ...input.delivery.snapshot.grid[1]!,
          cells: [input.delivery.snapshot.grid[1]!.cells[0]!, request.after],
        },
      ],
    };
    const stateHash = hashTerminalReplicaSnapshot(snapshot);
    const proof = {
      ...input.proof,
      geometry: request.geometry,
      committedStateHash: stateHash,
    };
    input.ledger.arm(request, 10);
    input.ledger.noteProof(proof);
    input.ledger.noteDelivery({ ...input.delivery, snapshot, stateHash });
    input.ledger.notePaint({ ...input.paint, snapshot, stateHash });
    expect(input.finalized).toEqual([]);
    expect(input.failures).toEqual([[traceId, "geometry-drift"]]);
  });

  it("admits only one pending diagnostic probe per pane", () => {
    const input = rig();
    expect(input.ledger.arm(input.request, 10)).toBe(true);
    expect(
      input.ledger.arm({ ...input.request, traceId: "00000000-0000-4000-8000-000000000100" }, 11),
    ).toBe(false);
    expect(input.failures).toContainEqual(["00000000-0000-4000-8000-000000000100", "busy"]);
  });
});
