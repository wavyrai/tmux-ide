import { describe, expect, it } from "vitest";
import type { CanonicalTerminalReplicaSeed } from "@tmux-ide/contracts";
import {
  TERMINAL_REPLICA_EMPTY_CELL,
  TERMINAL_REPLICA_SPACE_CELL,
  TERMINAL_REPLICA_DEFAULT_COLOR,
  applyTerminalReplicaUpdate,
  applyTerminalReplicaUpdateCooperatively,
  blankTerminalReplicaSnapshot,
  hashTerminalReplicaSnapshot,
  terminalReplicaUpdateNeedsCooperativeReduction,
} from "./terminal-replica.ts";
import {
  decodeVerifiedCompactSemanticTerminalUpdate,
  encodeCompactSemanticTerminalUpdate,
} from "./terminal-delivery.ts";

function seed(cols = 128, rows = 64): CanonicalTerminalReplicaSeed {
  const snapshot = blankTerminalReplicaSnapshot(cols, rows);
  return {
    type: "terminal.seed",
    workspaceName: "workspace",
    semanticPaneId: "pane",
    generation: "00000000-0000-4000-8000-000000000001",
    incarnation: "00000000-0000-4000-8000-000000000001:0",
    revision: 0,
    cols,
    rows,
    snapshot,
    stateHash: hashTerminalReplicaSnapshot(snapshot),
    hashAlgorithm: "fnv1a64-v1",
  };
}
const yielding = { yieldControl: async () => {} };
describe("cooperative terminal seed reduction", () => {
  it("preserves only trusted blank identities while validating a large seed", async () => {
    const update = { ...structuredClone(seed()) };
    for (const row of update.snapshot.grid)
      row.cells = row.cells.map((_, i) =>
        i % 2 ? TERMINAL_REPLICA_SPACE_CELL : TERMINAL_REPLICA_EMPTY_CELL,
      );
    update.stateHash = hashTerminalReplicaSnapshot(update.snapshot);
    let yields = 0;
    const result = await applyTerminalReplicaUpdateCooperatively(null, update, {
      yieldControl: async () => {
        yields++;
      },
    });
    expect(result.status).toBe("applied");
    expect(yields).toBeGreaterThan(0);
    expect(result.state!.snapshot!.grid[0]!.cells[0]).toBe(TERMINAL_REPLICA_EMPTY_CELL);
    expect(result.state!.snapshot!.grid[0]!.cells[1]).toBe(TERMINAL_REPLICA_SPACE_CELL);
    expect(hashTerminalReplicaSnapshot(result.state!.snapshot!)).toBe(update.stateHash);
  });
  it("detaches foreign blank, getter, extra fields and styled color cells", async () => {
    const update = { ...structuredClone(seed()) };
    const foreign = {
      ...TERMINAL_REPLICA_EMPTY_CELL,
      foreground: { kind: "default" as const },
      extra: "retained",
    };
    const frozenForeign = Object.freeze({ ...TERMINAL_REPLICA_SPACE_CELL });
    let reads = 0;
    const styled = {
      ...TERMINAL_REPLICA_SPACE_CELL,
      attributes: 1,
      foreground: { kind: "indexed" as const, index: 17 },
    };
    Object.defineProperty(foreign, "grapheme", {
      enumerable: true,
      get: () => {
        reads++;
        return "";
      },
    });
    update.snapshot.grid[0]!.cells[0] = foreign;
    update.snapshot.grid[0]!.cells[1] = foreign;
    update.snapshot.grid[0]!.cells[2] = frozenForeign;
    update.snapshot.grid[0]!.cells[3] = styled;
    update.stateHash = hashTerminalReplicaSnapshot(update.snapshot);
    reads = 0;
    const result = await applyTerminalReplicaUpdateCooperatively(null, update, yielding);
    expect(result.status).toBe("applied");
    expect(reads).toBe(2);
    const cells = result.state!.snapshot!.grid[0]!.cells;
    expect(cells[0]).not.toBe(foreign);
    expect(cells[0]).not.toBe(cells[1]);
    expect(cells[2]).not.toBe(frozenForeign);
    expect(cells[0]).toHaveProperty("extra", "retained");
    expect(cells[0]!.foreground).toBe(TERMINAL_REPLICA_DEFAULT_COLOR);
    expect(cells[3]!.foreground).not.toBe(styled.foreground);
    styled.foreground.index = 99;
    foreign.extra = "changed";
    expect(cells[3]!.foreground).toEqual({ kind: "indexed", index: 17 });
    expect(cells[0]).toHaveProperty("extra", "retained");
    expect(Object.isFrozen(cells[0])).toBe(true);
    expect(hashTerminalReplicaSnapshot(result.state!.snapshot!)).toBe(update.stateHash);
  });

  it("matches ordinary state and exact frame hash for large seeds and replay", async () => {
    const update = seed();
    const sync = applyTerminalReplicaUpdate(null, update);
    const asyncResult = await applyTerminalReplicaUpdateCooperatively(null, update, yielding);
    expect(asyncResult).toEqual(sync);
    expect(Object.isFrozen(asyncResult.state!.snapshot!.grid[0]!.cells[0])).toBe(true);
    expect(
      await applyTerminalReplicaUpdateCooperatively(asyncResult.state, update, yielding),
    ).toEqual(applyTerminalReplicaUpdate(sync.state, update));
  });
  it.each([
    "hash",
    "dimensions",
    "cursor",
    "wide",
    "placement",
    "generation",
    "incarnation",
    "stale",
  ])("preserves %s rejection/order semantics", async (kind) => {
    const initial = seed();
    const current = applyTerminalReplicaUpdate(null, initial).state;
    const update = { ...structuredClone(initial) };
    update.revision = 1;
    if (kind === "hash") update.stateHash = "0000000000000000";
    if (kind === "dimensions") update.cols++;
    if (kind === "cursor") update.snapshot.cursor.x = update.cols;
    if (kind === "wide") update.snapshot.grid[0]!.cells[0]!.width = 2;
    if (kind === "placement")
      update.snapshot.placements.push({
        id: "p",
        kind: "test",
        row: 1000,
        column: 0,
        rows: 1,
        columns: 1,
        contentDigest: "x",
      });
    if (kind === "generation") update.generation = "00000000-0000-4000-8000-000000000002";
    if (kind === "incarnation") update.incarnation = "other";
    const baseline = kind === "stale" ? { ...current!, revision: 5 } : current;
    expect(await applyTerminalReplicaUpdateCooperatively(baseline, update, yielding)).toEqual(
      applyTerminalReplicaUpdate(baseline, update),
    );
  });
  it("preserves existing upstream-validated boundary rather than silently changing schemas", async () => {
    const update = { ...structuredClone(seed()) };
    update.snapshot.cursor.x = -1;
    update.stateHash = hashTerminalReplicaSnapshot(update.snapshot);
    expect(await applyTerminalReplicaUpdateCooperatively(null, update, yielding)).toEqual(
      applyTerminalReplicaUpdate(null, update),
    );
  });
  it("yields during cell copying before traversing the complete snapshot and aborts cleanly", async () => {
    const update = { ...structuredClone(seed()) };
    let reads = 0;
    for (const row of update.snapshot.grid)
      for (const cell of row.cells)
        Object.defineProperty(cell, "grapheme", {
          enumerable: true,
          get: () => {
            reads++;
            return "";
          },
        });
    update.stateHash = hashTerminalReplicaSnapshot(update.snapshot);
    reads = 0;
    const controller = new AbortController();
    const reason = new Error("owner retired");
    await expect(
      applyTerminalReplicaUpdateCooperatively(null, update, {
        signal: controller.signal,
        yieldControl: async () => {
          expect(reads).toBe(256);
          controller.abort(reason);
        },
      }),
    ).rejects.toBe(reason);
    expect(reads).toBe(256);
  });
  it("permits actual I/O turns while reducing wide rows and supports cancellation during hashing", async () => {
    const update = seed(4096, 2);
    let turns = 0;
    const result = await applyTerminalReplicaUpdateCooperatively(null, update, {
      yieldControl: () =>
        new Promise<void>((resolve) =>
          setImmediate(() => {
            turns++;
            resolve();
          }),
        ),
    });
    expect(result.status).toBe("applied");
    expect(turns).toBeGreaterThan(32);
    const controller = new AbortController();
    let slices = 0;
    await expect(
      applyTerminalReplicaUpdateCooperatively(null, update, {
        signal: controller.signal,
        yieldControl: async () => {
          if (++slices === 40) controller.abort();
        },
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
  it("keeps small seed/patch reduction synchronous within the wrapper", async () => {
    const update = seed(4, 2);
    let yields = 0;
    expect(terminalReplicaUpdateNeedsCooperativeReduction(update)).toBe(false);
    const result = await applyTerminalReplicaUpdateCooperatively(null, update, {
      yieldControl: async () => {
        yields++;
      },
    });
    expect(result).toEqual(applyTerminalReplicaUpdate(null, update));
    expect(yields).toBe(0);
  });
  it("preserves verified compact adoption and authenticated frame hash", async () => {
    const original = seed();
    const verified = decodeVerifiedCompactSemanticTerminalUpdate(
      encodeCompactSemanticTerminalUpdate({
        frame: "seed",
        revision: 0,
        snapshot: original.snapshot,
      }),
      null,
      original.stateHash,
      { grantReducerAdoption: true },
    );
    const update = { ...original, snapshot: verified.canonicalSnapshot! };
    const result = await applyTerminalReplicaUpdateCooperatively(null, update, {
      ...yielding,
      authenticatedFrameHash: "1234567890abcdef",
    });
    expect(result.state!.snapshot).toBe(verified.canonicalSnapshot);
    expect(result.state!.frameHash).toBe("1234567890abcdef");
  });
});
