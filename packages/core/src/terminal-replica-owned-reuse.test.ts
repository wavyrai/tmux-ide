import { expect, it, vi } from "vitest";
import { TerminalReplicaCellSchemaZ, type CanonicalTerminalReplicaSeed } from "@tmux-ide/contracts";
import {
  applyTerminalReplicaUpdate,
  applyTerminalReplicaUpdateCooperatively,
  blankTerminalReplicaSnapshot,
  hashTerminalReplicaSnapshot,
} from "./terminal-replica.ts";
import { encodeCompactSemanticTerminalUpdateCooperatively } from "./terminal-delivery.ts";
import {
  createOwnedTerminalReplicaRowBuilder,
  isOwnedTerminalReplicaRow,
} from "./terminal-replica-owned-row.ts";

it("reuses strict cell validation across repeated encoding after cooperative admission", async () => {
  let snapshot = blankTerminalReplicaSnapshot(128, 64);
  const update: CanonicalTerminalReplicaSeed = {
    type: "terminal.seed",
    workspaceName: "workspace",
    semanticPaneId: "pane",
    generation: "00000000-0000-4000-8000-000000000001",
    incarnation: "fixture:0",
    revision: 0,
    cols: 128,
    rows: 64,
    snapshot,
    stateHash: hashTerminalReplicaSnapshot(snapshot),
    hashAlgorithm: "fnv1a64-v1",
  };
  const original = applyTerminalReplicaUpdate(null, update);
  snapshot = original.state!.snapshot!;
  const ownedUpdate = { ...update, snapshot };
  const sync = applyTerminalReplicaUpdate(null, ownedUpdate);
  const cooperative = await applyTerminalReplicaUpdateCooperatively(null, ownedUpdate, {
    yieldControl: async () => {},
  });
  expect(sync.status).toBe("applied");
  expect(cooperative.status).toBe("applied");
  const syncSnapshot = sync.state!.snapshot!,
    cooperativeSnapshot = cooperative.state!.snapshot!;
  expect(hashTerminalReplicaSnapshot(syncSnapshot)).toBe(update.stateHash);
  expect(hashTerminalReplicaSnapshot(cooperativeSnapshot)).toBe(update.stateHash);
  const calls = vi.spyOn(TerminalReplicaCellSchemaZ._zod, "run");
  const measure = async (value: typeof snapshot) => {
    calls.mockClear();
    const bytes = await encodeCompactSemanticTerminalUpdateCooperatively(
      { frame: "seed", revision: 0, snapshot: value },
      { yieldControl: async () => {} },
    );
    return { bytes, cellValidationCalls: calls.mock.calls.length };
  };
  try {
    const originalFirst = await measure(snapshot);
    const syncFirst = await measure(syncSnapshot),
      syncRepeat = await measure(syncSnapshot);
    const cooperativeFirst = await measure(cooperativeSnapshot),
      cooperativeRepeat = await measure(cooperativeSnapshot);
    expect(cooperativeFirst.bytes).toEqual(syncFirst.bytes);
    expect(cooperativeRepeat.bytes).toEqual(syncFirst.bytes);
    expect(syncRepeat.bytes).toEqual(syncFirst.bytes);
    expect(originalFirst.cellValidationCalls).toBe(8192);
    expect(syncFirst.cellValidationCalls).toBe(0);
    expect(cooperativeFirst.cellValidationCalls).toBe(0);
    expect(syncSnapshot.grid[0]).toBe(snapshot.grid[0]);
    expect(cooperativeSnapshot.grid[0]).toBe(snapshot.grid[0]);
    expect(syncRepeat.cellValidationCalls).toBe(0);
    expect(cooperativeRepeat.cellValidationCalls).toBe(0);
  } finally {
    calls.mockRestore();
  }
});

it("foreign rows stay detached through both admissions and copied getters are evaluated", async () => {
  const snapshot = structuredClone(blankTerminalReplicaSnapshot(128, 64));
  let reads = 0;
  const cell = snapshot.grid[0]!.cells[0]!;
  Object.defineProperty(cell, "grapheme", {
    configurable: true,
    enumerable: true,
    get() {
      reads++;
      return "X";
    },
  });
  const update: CanonicalTerminalReplicaSeed = {
    type: "terminal.seed",
    workspaceName: "workspace",
    semanticPaneId: "pane",
    generation: "00000000-0000-4000-8000-000000000001",
    incarnation: "fixture:0",
    revision: 0,
    cols: 128,
    rows: 64,
    snapshot,
    stateHash: hashTerminalReplicaSnapshot(snapshot),
    hashAlgorithm: "fnv1a64-v1",
  };
  reads = 0;
  const sync = applyTerminalReplicaUpdate(null, update);
  const syncReads = reads;
  reads = 0;
  const coop = await applyTerminalReplicaUpdateCooperatively(null, update, {
    yieldControl: async () => {},
  });
  const coopReads = reads;
  expect(sync.status).toBe("applied");
  expect(coop.status).toBe("applied");
  const a = sync.state!.snapshot!,
    b = coop.state!.snapshot!;
  expect(a.grid[0]).not.toBe(snapshot.grid[0]);
  expect(b.grid[0]).not.toBe(snapshot.grid[0]);
  expect(a.grid[0]!.cells[0]).not.toBe(cell);
  expect(b.grid[0]!.cells[0]).not.toBe(cell);
  expect(syncReads).toBeGreaterThan(0);
  expect(coopReads).toBeGreaterThan(0);
  Object.defineProperty(cell, "grapheme", { value: "MUTATED", enumerable: true });
  expect(a.grid[0]!.cells[0]!.grapheme).toBe("X");
  expect(b.grid[0]!.cells[0]!.grapheme).toBe("X");
  expect(hashTerminalReplicaSnapshot(a)).toBe(update.stateHash);
  expect(hashTerminalReplicaSnapshot(b)).toBe(update.stateHash);
  const calls = vi.spyOn(TerminalReplicaCellSchemaZ._zod, "run");
  const counts: number[] = [];
  try {
    for (const v of [a, a, b, b]) {
      calls.mockClear();
      await encodeCompactSemanticTerminalUpdateCooperatively(
        { frame: "seed", revision: 0, snapshot: v },
        { yieldControl: async () => {} },
      );
      counts.push(calls.mock.calls.length);
    }
  } finally {
    calls.mockRestore();
  }
  expect(counts).toEqual([8192, 0, 8192, 0]);
});

it("retains malformed width rejection and cancellation before publication", async () => {
  const snapshot = structuredClone(blankTerminalReplicaSnapshot(128, 64));
  const update = () => ({
    type: "terminal.seed" as const,
    workspaceName: "workspace",
    semanticPaneId: "pane",
    generation: "00000000-0000-4000-8000-000000000001",
    incarnation: "fixture:0",
    revision: 0,
    cols: 128,
    rows: 64,
    snapshot,
    stateHash: hashTerminalReplicaSnapshot(snapshot),
    hashAlgorithm: "fnv1a64-v1" as const,
  });
  snapshot.grid[0]!.cells[0]!.width = 0;
  expect(applyTerminalReplicaUpdate(null, update()).status).not.toBe("applied");
  expect(
    (
      await applyTerminalReplicaUpdateCooperatively(null, update(), {
        yieldControl: async () => {},
      })
    ).status,
  ).not.toBe("applied");
  snapshot.grid[0]!.cells[0]!.width = 1;
  const controller = new AbortController(),
    reason = new Error("cancel after slice");
  let yields = 0;
  await expect(
    applyTerminalReplicaUpdateCooperatively(null, update(), {
      signal: controller.signal,
      yieldControl: async () => {
        yields++;
        controller.abort(reason);
      },
    }),
  ).rejects.toBe(reason);
  expect(yields).toBe(1);
  expect(snapshot.grid.some(isOwnedTerminalReplicaRow)).toBe(false);
});

it("owned provenance does not bypass width, state hash, strict extras, or cancellation", async () => {
  const foreign = structuredClone(blankTerminalReplicaSnapshot(128, 64));
  const seed = (snapshot: typeof foreign) => ({
    type: "terminal.seed" as const,
    workspaceName: "workspace",
    semanticPaneId: "pane",
    generation: "00000000-0000-4000-8000-000000000001",
    incarnation: "fixture:0",
    revision: 0,
    cols: 128,
    rows: 64,
    snapshot,
    stateHash: hashTerminalReplicaSnapshot(snapshot),
    hashAlgorithm: "fnv1a64-v1" as const,
  });
  const own = (snapshot: typeof foreign) => ({
    ...snapshot,
    grid: snapshot.grid.map((row) => {
      const b = createOwnedTerminalReplicaRowBuilder();
      for (const c of row.cells) b.append(c);
      return b.finish(row, row.wrapped);
    }),
  });
  foreign.grid[0]!.cells[0]!.width = 0;
  const malformed = own(foreign);
  expect(isOwnedTerminalReplicaRow(malformed.grid[0])).toBe(true);
  expect(
    (
      await applyTerminalReplicaUpdateCooperatively(null, seed(malformed), {
        yieldControl: async () => {},
      })
    ).status,
  ).not.toBe("applied");
  foreign.grid[0]!.cells[0]!.width = 1;
  const valid = own(foreign),
    update = seed(valid);
  expect(
    (
      await applyTerminalReplicaUpdateCooperatively(
        null,
        { ...update, stateHash: "0000000000000000" },
        { yieldControl: async () => {} },
      )
    ).status,
  ).not.toBe("applied");
  const controller = new AbortController(),
    reason = new Error("owned row cancelled");
  let yielded = 0;
  await expect(
    applyTerminalReplicaUpdateCooperatively(null, update, {
      signal: controller.signal,
      yieldControl: async () => {
        yielded++;
        controller.abort(reason);
      },
    }),
  ).rejects.toBe(reason);
  expect(yielded).toBe(1);
  Object.assign(foreign.grid[0]!.cells[0]!, { extra: true });
  const extra = own(foreign);
  const admitted = await applyTerminalReplicaUpdateCooperatively(null, seed(extra), {
    yieldControl: async () => {},
  });
  expect(admitted.status).toBe("applied");
  expect(admitted.state!.snapshot!.grid[0]).toBe(extra.grid[0]);
  await expect(
    encodeCompactSemanticTerminalUpdateCooperatively(
      { frame: "seed", revision: 0, snapshot: admitted.state!.snapshot! },
      { yieldControl: async () => {} },
    ),
  ).rejects.toThrow();
});
