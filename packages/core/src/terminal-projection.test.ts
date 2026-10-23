import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  TerminalDeliveryAckSchemaZ,
  TerminalProjectionReceiptSchemaZ,
  TerminalProjectionSnapshotSchemaZ,
  TerminalProjectionPatchSchemaZ,
  type TerminalProjectionPayload,
  type TerminalProjectionSnapshot,
  type TerminalProjectionEnvelope,
} from "@tmux-ide/contracts";
import {
  blankTerminalReplicaSnapshot,
  freezeTerminalReplicaSnapshot,
  hashTerminalReplicaSnapshot,
} from "./terminal-replica.ts";
import { hashTerminalDeliveryRepresentation } from "./terminal-delivery.ts";
import {
  projectAlternateSnapshot,
  hashTerminalProjection,
  hashSourceSnapshotFromProjection,
  encodeTerminalProjection,
  decodeTerminalProjection,
  encodeTerminalProjectionCooperatively,
  applyTerminalProjectionPatch,
  commitTerminalProjection,
  hashTerminalProjectionTombstone,
} from "./terminal-projection.ts";
function source(cols = 2, rows = 2) {
  const base = blankTerminalReplicaSnapshot(cols, rows);
  return freezeTerminalReplicaSnapshot({
    ...base,
    modes: { ...base.modes, alternateScreen: true },
    history: [base.grid[0]!],
  });
}
function envelope(
  payload: TerminalProjectionPayload,
  projection: TerminalProjectionSnapshot,
): TerminalProjectionEnvelope {
  const bytes = encodeTerminalProjection(payload);
  return {
    type: "terminal.projection",
    workspaceName: "workspace",
    semanticPaneId: "pane-a",
    generation: "00000000-0000-4000-8000-000000000001",
    incarnation: "pane:1",
    deliveryNonce: "00000000-0000-4000-8000-000000000002",
    transactionId: "00000000-0000-4000-8000-000000000003",
    protocolVersion: 1,
    encoding: "alternate-projection-binary-v1",
    frame: payload.frame,
    baseRevision: payload.frame === "seed" ? null : payload.baseRevision,
    canonicalRevision: payload.revision,
    canonicalStateHash: hashSourceSnapshotFromProjection(projection),
    projectionStateHash: hashTerminalProjection(projection),
    representationHash: hashTerminalDeliveryRepresentation(bytes),
    representationBytes: bytes.length,
    chunkCount: Math.ceil(bytes.length / (256 * 1024)),
    canonicalEquivalent: false,
    history: "deferred",
    richPlacements: true,
  };
}
describe("explicit alternate projection", () => {
  it("matches shared Rust vectors through seed, patch and terminal closure", () => {
    const fixture = JSON.parse(
      readFileSync(new URL("fixtures/terminal-projection-vectors.json", import.meta.url), "utf8"),
    ) as {
      vectors: {
        payload: TerminalProjectionPayload;
        bytes: number[];
        representationHash: string;
        projectionStateHash: string;
        canonicalStateHash: string;
      }[];
    };
    let state: ReturnType<typeof commitTerminalProjection> | null = null;
    for (const vector of fixture.vectors) {
      const bytes = encodeTerminalProjection(vector.payload);
      expect([...bytes]).toEqual(vector.bytes);
      expect(decodeTerminalProjection(bytes)).toEqual(vector.payload);
      const template = envelope(
        { frame: "seed", revision: 0, projection: projectAlternateSnapshot(source()) },
        projectAlternateSnapshot(source()),
      );
      const frame = {
        ...template,
        frame: vector.payload.frame,
        baseRevision: vector.payload.frame === "seed" ? null : vector.payload.baseRevision,
        canonicalRevision: vector.payload.revision,
        canonicalStateHash: vector.canonicalStateHash,
        projectionStateHash: vector.projectionStateHash,
        representationHash: vector.representationHash,
        representationBytes: bytes.length,
        chunkCount: Math.ceil(bytes.length / (256 * 1024)),
      };
      const previous = state;
      state = commitTerminalProjection(state, frame, bytes);
      if (vector.payload.frame === "patch")
        expect(state.projection!.grid[0]).toBe(previous!.projection!.grid[0]);
    }
    expect(state!.projection).toBeNull();
    expect(state!.receipt.projectionStateHash).toBe(hashTerminalProjectionTombstone("pane-closed"));
  });
  it("yields across many short rows as well as within wide rows", async () => {
    const projection = projectAlternateSnapshot(source(1, 512));
    let checkpoints = 0;
    await encodeTerminalProjectionCooperatively(
      { frame: "seed", revision: 1, projection },
      {
        yieldControl: async () => {
          checkpoints++;
        },
      },
    );
    expect(checkpoints).toBeGreaterThanOrEqual(2);
  });

  it("omits history while preserving owned row identities and exact source root", () => {
    const original = source();
    const projection = projectAlternateSnapshot(original);
    expect("history" in projection).toBe(false);
    expect(projection.deferredHistory.rows).toBe(1);
    expect(projection.grid).toBe(original.grid);
    expect(projection.grid[0]).toBe(original.grid[0]);
    expect(hashSourceSnapshotFromProjection(projection)).toBe(
      hashTerminalReplicaSnapshot(original),
    );
    expect(hashTerminalProjection(projection)).not.toBe(hashTerminalReplicaSnapshot(original));
  });
  it("roundtrips bounded typed cells and applies only changed rows", () => {
    const projection = projectAlternateSnapshot(source());
    const seed = { frame: "seed" as const, revision: 3, projection };
    expect(decodeTerminalProjection(encodeTerminalProjection(seed))).toEqual(seed);
    const row = {
      ...projection.grid[1]!,
      cells: projection.grid[1]!.cells.map((cell, i) => (i ? cell : { ...cell, grapheme: "X" })),
    };
    const patch = { rows: [{ index: 1, row }], deferredHistory: projection.deferredHistory };
    const next = applyTerminalProjectionPatch(projection, patch);
    expect(next.grid[0]).toBe(projection.grid[0]);
    expect(next.grid[1]).not.toBe(projection.grid[1]);
    const delta = { frame: "patch" as const, baseRevision: 3, revision: 4, patch };
    expect(decodeTerminalProjection(encodeTerminalProjection(delta))).toEqual(delta);
  });
  it("never accepts canonical ACK substitution or forged history materialization", () => {
    const projection = projectAlternateSnapshot(source());
    const payload = { frame: "seed" as const, revision: 3, projection };
    const frame = envelope(payload, projection);
    const state = commitTerminalProjection(null, frame, encodeTerminalProjection(payload));
    expect(TerminalDeliveryAckSchemaZ.safeParse(state.receipt).success).toBe(false);
    expect(
      TerminalProjectionReceiptSchemaZ.safeParse({
        ...state.receipt,
        type: "terminal.delivery.ack",
      }).success,
    ).toBe(false);
    expect(
      TerminalProjectionSnapshotSchemaZ.safeParse({ ...projection, history: [] }).success,
    ).toBe(false);
    expect(
      TerminalProjectionPatchSchemaZ.safeParse({
        rows: [],
        history: [],
        deferredHistory: projection.deferredHistory,
      }).success,
    ).toBe(false);
    expect(() => projectAlternateSnapshot(blankTerminalReplicaSnapshot(2, 2))).toThrow();
  });
  it("rejects representation, source root, projection root, revision and lifetime changes atomically", () => {
    const projection = projectAlternateSnapshot(source());
    const payload = { frame: "seed" as const, revision: 3, projection };
    const frame = envelope(payload, projection),
      bytes = encodeTerminalProjection(payload);
    const current = commitTerminalProjection(null, frame, bytes);
    for (const change of [
      { canonicalStateHash: "f".repeat(16) },
      { projectionStateHash: "f".repeat(16) },
      { representationHash: "f".repeat(16) },
      { canonicalRevision: 4 },
      { incarnation: "pane:2" },
    ])
      expect(() => commitTerminalProjection(current, { ...frame, ...change }, bytes)).toThrow();
    expect(current.projection).toEqual(projection);
    for (let end = 0; end < bytes.length; end++)
      expect(() => decodeTerminalProjection(bytes.subarray(0, end))).toThrow();
  });
  it("cooperates and cancels inside both giant seed and patch rows", async () => {
    const projection = projectAlternateSnapshot(source(4096, 1));
    const giant = {
      ...projection.grid[0]!,
      cells: projection.grid[0]!.cells.map((cell) => ({ ...cell, grapheme: "x".repeat(1024) })),
    };
    for (const payload of [
      { frame: "seed" as const, revision: 1, projection: { ...projection, grid: [giant] } },
      {
        frame: "patch" as const,
        revision: 2,
        baseRevision: 1,
        patch: { rows: [{ index: 0, row: giant }], deferredHistory: projection.deferredHistory },
      },
    ]) {
      let yields = 0;
      expect(
        await encodeTerminalProjectionCooperatively(payload, {
          yieldControl: async () => {
            yields++;
          },
        }),
      ).toEqual(encodeTerminalProjection(payload));
      expect(yields).toBeGreaterThan(16);
      const abort = new AbortController();
      await expect(
        encodeTerminalProjectionCooperatively(payload, {
          signal: abort.signal,
          yieldControl: async () => abort.abort(),
        }),
      ).rejects.toThrow();
    }
  });
  it("requires a new complete visible grid on dimensions changes and rejects leaving alternate mode", () => {
    const projection = projectAlternateSnapshot(source());
    expect(() =>
      applyTerminalProjectionPatch(projection, {
        dimensions: { cols: 3, rows: 2 },
        rows: [],
        deferredHistory: projection.deferredHistory,
      }),
    ).toThrow();
    expect(
      TerminalProjectionPatchSchemaZ.safeParse({
        rows: [],
        deferredHistory: projection.deferredHistory,
        modes: { ...projection.modes, alternateScreen: false },
      }).success,
    ).toBe(false);
  });
});
