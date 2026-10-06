import { describe, expect, it } from "vitest";
import type {
  CanonicalTerminalReplicaPatch,
  CanonicalTerminalReplicaSeed,
  TerminalReplicaPatchPayload,
  TerminalReplicaSnapshot,
} from "@tmux-ide/contracts";
import {
  applyTerminalReplicaPatch,
  applyTerminalReplicaUpdate,
  blankTerminalReplicaSnapshot,
  freezeTerminalReplicaRow,
  hashTerminalReplicaSnapshot,
  hashTerminalWidgetContent,
  TERMINAL_REPLICA_DEFAULT_COLOR,
  TERMINAL_REPLICA_EMPTY_CELL,
  TERMINAL_REPLICA_SPACE_CELL,
} from "./terminal-replica.ts";

const generation = "00000000-0000-4000-8000-000000000001";
const address = { workspaceName: "workspace", semanticPaneId: "pane-a" } as const;

function seed(snapshot: TerminalReplicaSnapshot, revision = 0): CanonicalTerminalReplicaSeed {
  return {
    type: "terminal.seed",
    ...address,
    generation,
    incarnation: "incarnation-a",
    revision,
    cols: snapshot.cols,
    rows: snapshot.rows,
    stateHash: hashTerminalReplicaSnapshot(snapshot),
    hashAlgorithm: "fnv1a64-v1",
    snapshot,
  };
}

function patch(
  current: TerminalReplicaSnapshot,
  payload: TerminalReplicaPatchPayload,
  revision = 1,
): CanonicalTerminalReplicaPatch {
  const next = applyTerminalReplicaPatch(current, payload);
  return {
    type: "terminal.patch",
    ...address,
    generation,
    incarnation: "incarnation-a",
    baseRevision: revision - 1,
    revision,
    cols: next.cols,
    rows: next.rows,
    stateHash: hashTerminalReplicaSnapshot(next),
    hashAlgorithm: "fnv1a64-v1",
    patch: payload,
  };
}

describe("terminal replica reducer", () => {
  it("reconstructs the uninterrupted state from one seed and ordered patches", () => {
    const initial = blankTerminalReplicaSnapshot(4, 2);
    const row = {
      wrapped: false,
      cells: initial.grid[0]!.cells.map((cell, index) =>
        index === 0
          ? { ...cell, grapheme: "λ", foreground: { kind: "indexed", index: 174 } as const }
          : cell,
      ),
    };
    const payload: TerminalReplicaPatchPayload = {
      rows: [{ index: 0, row }],
      cursor: { x: 1, y: 0, hidden: false, style: "bar", blink: true },
    };
    const expected = applyTerminalReplicaPatch(initial, payload);
    const seeded = applyTerminalReplicaUpdate(null, seed(initial));
    expect(seeded.status).toBe("applied");
    const applied = applyTerminalReplicaUpdate(seeded.state, patch(initial, payload));
    expect(applied.status).toBe("applied");
    if (!applied.state) throw new Error("expected applied state");
    expect(applied.state.snapshot).toEqual(expected);
    expect(applied.state.hash).toBe(hashTerminalReplicaSnapshot(expected));
  });

  it("fails closed for cross-pane updates, gaps, and same-tuple hash corruption", () => {
    const initial = blankTerminalReplicaSnapshot(2, 2);
    const boot = applyTerminalReplicaUpdate(null, seed(initial));
    const valid = patch(initial, { rows: [] });
    expect(
      applyTerminalReplicaUpdate(boot.state, { ...valid, semanticPaneId: "pane-b" }).status,
    ).toBe("conflict");
    expect(
      applyTerminalReplicaUpdate(boot.state, { ...valid, baseRevision: 4, revision: 5 }).status,
    ).toBe("gap");
    const once = applyTerminalReplicaUpdate(boot.state, valid);
    expect(
      applyTerminalReplicaUpdate(once.state, { ...valid, stateHash: "0000000000000000" }).status,
    ).toBe("conflict");
    expect(
      applyTerminalReplicaUpdate(once.state, {
        ...valid,
        patch: { rows: [], cursor: { ...initial.cursor, x: 1 } },
      }).status,
    ).toBe("conflict");
  });

  it("uses only authenticated representation identity for strict wire replay", () => {
    const initial = blankTerminalReplicaSnapshot(2, 2);
    const boot = applyTerminalReplicaUpdate(null, seed(initial), {
      authenticatedFrameHash: "1111111111111111",
    });
    expect(boot.state?.frameHash).toBe("1111111111111111");
    const valid = patch(initial, { rows: [] });
    const once = applyTerminalReplicaUpdate(boot.state, valid, {
      authenticatedFrameHash: "2222222222222222",
    });
    expect(once.status).toBe("applied");
    expect(once.state?.frameHash).toBe("2222222222222222");
    expect(
      applyTerminalReplicaUpdate(once.state, valid, {
        authenticatedFrameHash: "2222222222222222",
      }).status,
    ).toBe("idempotent");
    expect(
      applyTerminalReplicaUpdate(once.state, valid, {
        authenticatedFrameHash: "3333333333333333",
      }).status,
    ).toBe("conflict");
  });

  it("reuses internally validated row identities without weakening replay or geometry checks", () => {
    const initial = blankTerminalReplicaSnapshot(2, 2);
    const row = {
      wrapped: false,
      cells: initial.grid[0]!.cells.map((cell) => ({ ...cell, grapheme: "x" })),
    };
    const next = applyTerminalReplicaPatch(initial, { rows: [{ index: 0, row }] });
    const update = patch(initial, { rows: [{ index: 0, row: next.grid[0]! }] });
    const boot = applyTerminalReplicaUpdate(null, seed(initial));
    let profile: unknown;
    const applied = applyTerminalReplicaUpdate(boot.state, update, {
      instrumentation: {
        nowMicros: () => 0,
        onComplete: (value) => {
          profile = value;
        },
      },
    });
    expect(applied.status).toBe("applied");
    expect(applied.state?.snapshot?.grid[0]).toBe(next.grid[0]);
    expect(applied.state?.hash).toBe(hashTerminalReplicaSnapshot(next));
    expect(profile).toMatchObject({
      counts: { patchedRows: 1, validatedCells: 0, frozenCells: 0, rowHashMisses: 0 },
    });
    expect(applyTerminalReplicaUpdate(applied.state, update).status).toBe("idempotent");
    expect(() =>
      applyTerminalReplicaPatch(initial, {
        dimensions: { cols: 1, rows: 2 },
        rows: [{ index: 0, row: next.grid[0]! }],
      }),
    ).toThrow();
    expect(() =>
      applyTerminalReplicaPatch(initial, { rows: [{ index: 2, row: next.grid[0]! }] }),
    ).toThrow();
    expect(() =>
      applyTerminalReplicaPatch(initial, {
        rows: [
          { index: 0, row: next.grid[0]! },
          { index: 0, row: next.grid[0]! },
        ],
      }),
    ).toThrow();
  });

  it("retains core-owned patch rows through subsequent seed admission", () => {
    const initial = blankTerminalReplicaSnapshot(4, 2);
    const row = freezeTerminalReplicaRow({
      wrapped: false,
      cells: initial.grid[0]!.cells.map((cell) => ({ ...cell, grapheme: "p" })),
    });
    const next = applyTerminalReplicaPatch(initial, { rows: [{ index: 0, row }] });
    expect(next.grid[0]).toBe(row);
    const admitted = applyTerminalReplicaUpdate(null, seed(next));
    expect(admitted.status).toBe("applied");
    expect(admitted.state?.snapshot?.grid[0]).toBe(row);
    expect(admitted.state?.hash).toBe(hashTerminalReplicaSnapshot(next));
    const external = structuredClone(row);
    const detached = applyTerminalReplicaPatch(initial, { rows: [{ index: 0, row: external }] });
    external.cells[0]!.grapheme = "mutated";
    expect(detached.grid[0]!.cells[0]!.grapheme).toBe("p");
  });

  it("retains owned immutable rows through seed admission without trusting the seed hash or geometry", () => {
    const initial = blankTerminalReplicaSnapshot(2, 2);
    const row = freezeTerminalReplicaRow({
      wrapped: false,
      cells: initial.grid[0]!.cells.map((cell) => ({ ...cell, grapheme: "x" })),
    });
    const snapshot = { ...initial, grid: [row, initial.grid[1]!], history: [row] };
    const update = seed(snapshot);
    const applied = applyTerminalReplicaUpdate(null, update);
    expect(applied.status).toBe("applied");
    expect(applied.state?.snapshot?.grid[0]).toBe(row);
    expect(applied.state?.snapshot?.history[0]).toBe(row);
    expect(applied.state?.hash).toBe(update.stateHash);
    expect(
      applyTerminalReplicaUpdate(null, { ...update, stateHash: "0000000000000000" }).status,
    ).toBe("conflict");
    expect(
      applyTerminalReplicaUpdate(null, { ...update, snapshot: { ...snapshot, cols: 1 } }).status,
    ).toBe("conflict");
  });

  it("copies caller-frozen rows before marking them reusable", () => {
    const initial = blankTerminalReplicaSnapshot(2, 1);
    const foreground = { kind: "indexed" as const, index: 42 };
    const external = Object.freeze({
      wrapped: false,
      cells: initial.grid[0]!.cells.map((cell) => Object.freeze({ ...cell, foreground })),
    });
    const owned = freezeTerminalReplicaRow(external);
    expect(owned).not.toBe(external);
    foreground.index = 99;
    expect(owned.cells[0]!.foreground).toEqual({ kind: "indexed", index: 42 });
    expect(Object.isFrozen(owned.cells[0]!.foreground)).toBe(true);
    expect(freezeTerminalReplicaRow(owned)).toBe(owned);
  });

  it("shares immutable default colors while detaching foreign cells and preserving semantics", () => {
    const initial = blankTerminalReplicaSnapshot(2, 1);
    const external = structuredClone(initial.grid[0]!);
    const before = hashTerminalReplicaSnapshot({ ...initial, history: [external] });
    const owned = freezeTerminalReplicaRow(external);
    const other = freezeTerminalReplicaRow(structuredClone(external));
    expect(owned).not.toBe(external);
    expect(owned.cells[0]).not.toBe(external.cells[0]);
    expect(owned.cells[0]).not.toBe(owned.cells[1]);
    expect(owned.cells[0]!.foreground).toBe(owned.cells[1]!.background);
    expect(owned.cells[0]!.foreground).toBe(other.cells[0]!.foreground);
    expect(Object.isFrozen(owned.cells[0]!.foreground)).toBe(true);
    expect(Reflect.set(owned.cells[0]!.foreground, "kind", "rgb")).toBe(false);
    Reflect.set(external.cells[0]!.foreground, "kind", "rgb");
    Reflect.set(external.cells[0]!.foreground, "value", 0xff00ff);
    external.cells[0]!.grapheme = "changed";
    expect(owned.cells[0]!.foreground).toEqual({ kind: "default" });
    expect(owned.cells[0]!.grapheme).toBe(" ");
    expect(hashTerminalReplicaSnapshot({ ...initial, history: [owned] })).toBe(before);
    expect(freezeTerminalReplicaRow(owned)).toBe(owned);
  });

  it("shares the core-owned default through blank and admitted rows without trusting foreign getters", () => {
    const initial = blankTerminalReplicaSnapshot(2, 1);
    expect(initial.grid[0]!.cells[0]!.foreground).toBe(TERMINAL_REPLICA_DEFAULT_COLOR);
    expect(initial.grid[0]!.cells[0]!.background).toBe(TERMINAL_REPLICA_DEFAULT_COLOR);
    let reads = 0;
    const foreign = Object.freeze({
      get kind() {
        reads += 1;
        return "default" as const;
      },
    });
    const external = {
      wrapped: false,
      cells: initial.grid[0]!.cells.map((cell) => ({ ...cell, foreground: foreign })),
    };
    const admitted = freezeTerminalReplicaRow(external);
    expect(reads).toBe(2);
    expect(admitted.cells[0]).not.toBe(external.cells[0]);
    expect(admitted.cells[0]!.foreground).not.toBe(foreign);
    expect(admitted.cells[0]!.foreground).toBe(TERMINAL_REPLICA_DEFAULT_COLOR);
    expect(admitted.cells[0]!.background).toBe(TERMINAL_REPLICA_DEFAULT_COLOR);
    expect(Object.isFrozen(TERMINAL_REPLICA_DEFAULT_COLOR)).toBe(true);
    expect(hashTerminalReplicaSnapshot({ ...initial, grid: [admitted] })).toBe(
      hashTerminalReplicaSnapshot(initial),
    );
  });

  it("reuses only trusted blank cells while preserving foreign detachment and empty-space distinction", () => {
    const cells = [TERMINAL_REPLICA_EMPTY_CELL, TERMINAL_REPLICA_SPACE_CELL];
    const owned = freezeTerminalReplicaRow({ wrapped: false, cells });
    expect(owned.cells).not.toBe(cells);
    expect(Object.isFrozen(owned.cells)).toBe(true);
    expect(owned.cells[0]).toBe(TERMINAL_REPLICA_EMPTY_CELL);
    expect(owned.cells[1]).toBe(TERMINAL_REPLICA_SPACE_CELL);
    expect(Reflect.set(owned.cells[0]!, "grapheme", "changed")).toBe(false);
    const foreign = cells.map((cell) => ({ ...cell }));
    const detached = freezeTerminalReplicaRow({ wrapped: false, cells: foreign });
    expect(detached.cells[0]).not.toBe(cells[0]);
    foreign[0]!.grapheme = "changed";
    expect(detached).toEqual(owned);
    const blank = blankTerminalReplicaSnapshot(2, 1);
    const edited = structuredClone(blank);
    edited.grid[0]!.cells[0]!.grapheme = "X";
    expect(edited.grid[0]!.cells[1]!.grapheme).toBe(" ");
    expect(hashTerminalReplicaSnapshot({ ...blank, grid: [owned] })).toBe(
      hashTerminalReplicaSnapshot({ ...blank, grid: [detached] }),
    );
    expect(hashTerminalReplicaSnapshot({ ...blank, grid: [owned] })).not.toBe(
      hashTerminalReplicaSnapshot(blank),
    );
  });

  it("keeps RGB colors detached and does not discard extra foreign default-color fields", () => {
    const initial = blankTerminalReplicaSnapshot(2, 1);
    const rgb = { kind: "rgb" as const, value: 0x123456 };
    const extraDefault = { kind: "default" as const, annotation: "preserved" };
    const external = {
      wrapped: false,
      cells: initial.grid[0]!.cells.map((cell) => ({
        ...cell,
        foreground: rgb,
        background: extraDefault,
      })),
    };
    const owned = freezeTerminalReplicaRow(external);
    rgb.value = 0;
    extraDefault.annotation = "mutated";
    expect(owned.cells[0]!.foreground).toEqual({ kind: "rgb", value: 0x123456 });
    expect(Object.isFrozen(owned.cells[0]!.foreground)).toBe(true);
    expect(owned.cells[0]!.background).toEqual({ kind: "default", annotation: "preserved" });
  });

  it("does not trust external frozen rows, including malformed wide cells", () => {
    const initial = blankTerminalReplicaSnapshot(2, 2);
    const external = {
      wrapped: false,
      cells: initial.grid[0]!.cells.map((cell) => Object.freeze({ ...cell, grapheme: "z" })),
    };
    Object.freeze(external.cells);
    Object.freeze(external);
    const next = applyTerminalReplicaPatch(initial, { rows: [{ index: 0, row: external }] });
    expect(next.grid[0]).not.toBe(external);
    const malformed = {
      wrapped: false,
      cells: external.cells.map((cell) => Object.freeze({ ...cell, width: 0 as const })),
    };
    Object.freeze(malformed.cells);
    Object.freeze(malformed);
    expect(() =>
      applyTerminalReplicaPatch(initial, { rows: [{ index: 0, row: malformed }] }),
    ).toThrow("Malformed terminal replica row");
  });

  it("keeps reducer semantics independent from absent or throwing profiling", () => {
    const initial = blankTerminalReplicaSnapshot(2, 2);
    const boot = applyTerminalReplicaUpdate(null, seed(initial));
    const valid = patch(initial, { rows: [] });
    const applied = applyTerminalReplicaUpdate(boot.state, valid, {
      instrumentation: {
        nowMicros: () => {
          throw new Error("clock unavailable");
        },
        onComplete: () => {
          throw new Error("observer unavailable");
        },
      },
    });
    expect(applied.status).toBe("applied");
  });

  it("pins opaque daemon generations so delayed seeds cannot roll state backward", () => {
    const initial = blankTerminalReplicaSnapshot(2, 2);
    const boot = applyTerminalReplicaUpdate(null, seed(initial));
    const foreign = {
      ...seed(initial),
      generation: "00000000-0000-4000-8000-000000000002",
    };
    expect(applyTerminalReplicaUpdate(boot.state, foreign).status).toBe("conflict");
  });

  it("accepts only a higher revision from a newer ordered pane incarnation", () => {
    const initial = blankTerminalReplicaSnapshot(2, 2);
    const first = { ...seed(initial, 2), incarnation: `${generation}:0` };
    const boot = applyTerminalReplicaUpdate(null, first);
    const next = { ...seed(initial, 4), incarnation: `${generation}:1` };
    const advanced = applyTerminalReplicaUpdate(boot.state, next);
    expect(advanced.status).toBe("applied");
    expect(applyTerminalReplicaUpdate(advanced.state, { ...first, revision: 5 }).status).toBe(
      "conflict",
    );
  });

  it("rejects malformed rows and cursors rather than clipping them", () => {
    const initial = blankTerminalReplicaSnapshot(2, 2);
    expect(() =>
      applyTerminalReplicaPatch(initial, {
        rows: [
          { index: 0, row: initial.grid[0]! },
          { index: 0, row: initial.grid[0]! },
        ],
      }),
    ).toThrow(/Malformed/u);
    expect(() =>
      applyTerminalReplicaPatch(initial, {
        rows: [],
        cursor: { x: 2, y: 0, hidden: false, style: "block", blink: false },
      }),
    ).toThrow(/out of bounds/u);
  });

  it("fails closed when a dimension change retains incompatible history or placements", () => {
    const base = blankTerminalReplicaSnapshot(4, 2);
    const withHistory = applyTerminalReplicaPatch(base, { rows: [], history: [base.grid[0]!] });
    expect(() =>
      applyTerminalReplicaPatch(withHistory, {
        dimensions: { cols: 2, rows: 2 },
        rows: [],
        historyDelta: { trim: 0, append: [] },
      }),
    ).toThrow(/old-width/u);
    const withPlacement = applyTerminalReplicaPatch(base, {
      rows: [],
      placements: [
        {
          id: "x",
          kind: "widget",
          row: 0,
          column: 2,
          rows: 1,
          columns: 2,
          contentDigest: "fixture",
        },
      ],
    });
    expect(() =>
      applyTerminalReplicaPatch(withPlacement, {
        dimensions: { cols: 2, rows: 2 },
        rows: [],
      }),
    ).toThrow(/out-of-bounds/u);
  });

  it("retains snapshot, grid, and row identity for a semantic no-op", () => {
    const initial = blankTerminalReplicaSnapshot(2, 2);
    const next = applyTerminalReplicaPatch(initial, {
      rows: [{ index: 0, row: initial.grid[0]! }],
    });
    expect(next).toBe(initial);
    expect(next.grid).toBe(initial.grid);
    expect(next.grid[0]).toBe(initial.grid[0]);
  });

  it("deep-freezes applied arrays while retaining unchanged row identity", () => {
    const initial = blankTerminalReplicaSnapshot(2, 2);
    const next = applyTerminalReplicaPatch(initial, {
      rows: [{ index: 1, row: { ...initial.grid[1]!, wrapped: true } }],
    });
    expect(Object.isFrozen(next)).toBe(true);
    expect(Object.isFrozen(next.grid)).toBe(true);
    expect(Object.isFrozen(next.history)).toBe(true);
    expect(Object.isFrozen(next.placements)).toBe(true);
    expect(next.history).toBe(initial.history);
    expect(next.grid[0]).toBe(initial.grid[0]);
    expect(() => ((next.grid as TerminalReplicaSnapshot["grid"])[0] = next.grid[1]!)).toThrow();
  });

  it("hashes UTF-8 canonically and distinguishes default from explicit black", () => {
    const defaults = blankTerminalReplicaSnapshot(1, 1);
    const explicit = applyTerminalReplicaPatch(defaults, {
      rows: [
        {
          index: 0,
          row: {
            wrapped: false,
            cells: [
              {
                ...defaults.grid[0]!.cells[0]!,
                grapheme: "界",
                background: { kind: "indexed", index: 16 },
              },
            ],
          },
        },
      ],
    });
    expect(hashTerminalReplicaSnapshot(explicit)).toMatch(/^[0-9a-f]{16}$/u);
    expect(hashTerminalReplicaSnapshot(explicit)).not.toBe(hashTerminalReplicaSnapshot(defaults));
  });

  it("derives the same rolling history hash for trim/append as a full reconstruction", () => {
    const base = blankTerminalReplicaSnapshot(2, 1);
    const seeded = applyTerminalReplicaPatch(base, {
      rows: [],
      history: [base.grid[0]!, { ...base.grid[0]!, wrapped: true }],
    });
    const next = applyTerminalReplicaPatch(seeded, {
      rows: [],
      historyDelta: { trim: 1, append: [base.grid[0]!] },
    });
    const reconstructed = { ...next, history: [...next.history] };
    expect(hashTerminalReplicaSnapshot(next)).toBe(hashTerminalReplicaSnapshot(reconstructed));
  });

  it("shares the canonical widget-content digest used by rich placements", () => {
    expect(hashTerminalWidgetContent("markdown", { text: "# Plan" })).toMatch(/^[0-9a-f]{16}$/u);
    expect(hashTerminalWidgetContent("markdown", { text: "# Plan" })).not.toBe(
      hashTerminalWidgetContent("markdown", { text: "# Other" }),
    );
  });
});
