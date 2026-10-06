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
  const snapshot = structuredClone(blankTerminalReplicaSnapshot(128, 64));
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
  const sync = applyTerminalReplicaUpdate(null, update);
  const cooperative = await applyTerminalReplicaUpdateCooperatively(null, update, {
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
    const syncFirst = await measure(syncSnapshot),
      syncRepeat = await measure(syncSnapshot);
    const cooperativeFirst = await measure(cooperativeSnapshot),
      cooperativeRepeat = await measure(cooperativeSnapshot);
    expect(cooperativeFirst.bytes).toEqual(syncFirst.bytes);
    expect(cooperativeRepeat.bytes).toEqual(syncFirst.bytes);
    expect(syncRepeat.bytes).toEqual(syncFirst.bytes);
    console.log(
      JSON.stringify({
        diagnostic: "same-source-admission-encode-twice",
        syncOwned: syncSnapshot.grid.every(isOwnedTerminalReplicaRow),
        cooperativeOwned: cooperativeSnapshot.grid.every(isOwnedTerminalReplicaRow),
        syncFirst: syncFirst.cellValidationCalls,
        syncRepeat: syncRepeat.cellValidationCalls,
        cooperativeFirst: cooperativeFirst.cellValidationCalls,
        cooperativeRepeat: cooperativeRepeat.cellValidationCalls,
        cells: 128 * 64,
      }),
    );
    expect(syncFirst.cellValidationCalls).toBeGreaterThan(0);
    expect(syncRepeat.cellValidationCalls).toBe(0);
    expect(cooperativeRepeat.cellValidationCalls).toBe(0);
  } finally {
    calls.mockRestore();
  }
});

it("copies cells before late metadata reads and seals the builder after finish", () => {
  const snapshot = structuredClone(blankTerminalReplicaSnapshot(1, 1));
  let graphemeReads = 0,
    metadataReads = 0;
  const color = { kind: "indexed" as const, index: 17 };
  const cell = {
    ...snapshot.grid[0]!.cells[0]!,
    foreground: color,
    get grapheme() {
      graphemeReads++;
      return "A";
    },
  };
  const source = {
    cells: [cell],
    wrapped: false,
    get extra() {
      metadataReads++;
      return "preserved";
    },
  };
  const builder = createOwnedTerminalReplicaRowBuilder();
  const copied = builder.append(cell);
  expect(graphemeReads).toBe(1);
  expect(metadataReads).toBe(0);
  color.index = 99;
  source.wrapped = true;
  const row = builder.finish(source, false);
  expect(metadataReads).toBe(1);
  expect(row.wrapped).toBe(false);
  expect(row).toHaveProperty("extra", "preserved");
  expect(row.cells[0]).toBe(copied);
  expect(copied.foreground).toEqual({ kind: "indexed", index: 17 });
  expect(isOwnedTerminalReplicaRow(source)).toBe(false);
  expect(isOwnedTerminalReplicaRow(row)).toBe(true);
  expect(Object.isFrozen(row.cells)).toBe(true);
  expect(Object.isFrozen(copied)).toBe(true);
  expect(() => builder.append(cell)).toThrow("already finished");
  expect(() => builder.finish(source, false)).toThrow("already finished");
});

it.each(["row", "cell"])(
  "ownership does not bypass strict %s extra-field rejection",
  async (where) => {
    const snapshot = structuredClone(blankTerminalReplicaSnapshot(128, 64));
    Object.assign(where === "row" ? snapshot.grid[0]! : snapshot.grid[0]!.cells[0]!, {
      extra: true,
    });
    const result = await applyTerminalReplicaUpdateCooperatively(
      null,
      {
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
      },
      { yieldControl: async () => {} },
    );
    expect(result.status).toBe("applied");
    const admitted = result.state!.snapshot!;
    expect(isOwnedTerminalReplicaRow(admitted.grid[0])).toBe(true);
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(
        encodeCompactSemanticTerminalUpdateCooperatively(
          { frame: "seed", revision: 0, snapshot: admitted },
          { yieldControl: async () => {} },
        ),
      ).rejects.toThrow();
    }
  },
);

it("does not grant frozen foreign lookalikes validation reuse", async () => {
  const snapshot = structuredClone(blankTerminalReplicaSnapshot(1, 1));
  const row = Object.freeze({
    wrapped: false,
    cells: Object.freeze(snapshot.grid[0]!.cells.map((cell) => Object.freeze(cell))),
  });
  snapshot.grid[0] = row as (typeof snapshot.grid)[number];
  expect(isOwnedTerminalReplicaRow(row)).toBe(false);
  const calls = vi.spyOn(TerminalReplicaCellSchemaZ._zod, "run");
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      calls.mockClear();
      await encodeCompactSemanticTerminalUpdateCooperatively(
        { frame: "seed", revision: 0, snapshot },
        { yieldControl: async () => {} },
      );
      expect(calls).toHaveBeenCalledTimes(1);
    }
  } finally {
    calls.mockRestore();
  }
});

it("cancels before finishing a wide row without publishing or branding foreign data", async () => {
  const snapshot = structuredClone(blankTerminalReplicaSnapshot(4096, 2));
  const controller = new AbortController();
  const reason = new Error("owner retired during copy");
  let published = false;
  const pending = applyTerminalReplicaUpdateCooperatively(
    null,
    {
      type: "terminal.seed",
      workspaceName: "workspace",
      semanticPaneId: "pane",
      generation: "00000000-0000-4000-8000-000000000001",
      incarnation: "fixture:0",
      revision: 0,
      cols: 4096,
      rows: 2,
      snapshot,
      stateHash: hashTerminalReplicaSnapshot(snapshot),
      hashAlgorithm: "fnv1a64-v1",
    },
    {
      signal: controller.signal,
      yieldControl: async () => {
        controller.abort(reason);
      },
    },
  );
  await expect(
    pending.then((result) => {
      published = true;
      return result;
    }),
  ).rejects.toBe(reason);
  expect(published).toBe(false);
  expect(snapshot.grid.some(isOwnedTerminalReplicaRow)).toBe(false);
});
