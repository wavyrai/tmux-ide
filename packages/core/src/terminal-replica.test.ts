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
  hashTerminalReplicaSnapshot,
  hashTerminalWidgetContent,
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
