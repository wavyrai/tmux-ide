import { it, expect, vi } from "vitest";
import { TerminalReplicaCellSchemaZ } from "@tmux-ide/contracts";
import { blankTerminalReplicaSnapshot, hashTerminalReplicaSnapshot } from "./terminal-replica.ts";
import {
  freezeOwnedTerminalReplicaRow,
  TERMINAL_REPLICA_EMPTY_CELL as EMPTY,
  TERMINAL_REPLICA_SPACE_CELL as SPACE,
} from "./terminal-replica-owned-row.ts";
import {
  encodeCompactSemanticTerminalUpdate,
  encodeCompactSemanticTerminalUpdateCooperatively,
} from "./terminal-delivery.ts";
const blanks = () => ({
  ...blankTerminalReplicaSnapshot(128, 64),
  grid: Array.from({ length: 64 }, () =>
    freezeOwnedTerminalReplicaRow({
      wrapped: false,
      cells: Array.from({ length: 128 }, (_, i) => (i % 2 ? SPACE : EMPTY)),
    }),
  ),
});
const encode = (snapshot: ReturnType<typeof blanks>, yieldControl = async () => {}) =>
  encodeCompactSemanticTerminalUpdateCooperatively(
    { frame: "seed", revision: 0, snapshot },
    { yieldControl },
  );
it("validates exact trusted constants once across distinct owned blank rows, preserving bytes and yields", async () => {
  const a = blanks(),
    b = blanks();
  const expected = encodeCompactSemanticTerminalUpdate({
    frame: "seed",
    revision: 0,
    snapshot: structuredClone(a),
  });
  const calls = vi.spyOn(TerminalReplicaCellSchemaZ._zod, "run");
  let yields = 0;
  try {
    const validationFailure = new Error("constant validation interrupted");
    calls.mockImplementationOnce(() => {
      throw validationFailure;
    });
    await expect(encode(a)).rejects.toBe(validationFailure);
    calls.mockClear();
    expect(
      await encode(a, async () => {
        yields++;
      }),
    ).toEqual(expected);
    expect(calls).toHaveBeenCalledTimes(2);
    calls.mockClear();
    expect(await encode(b)).toEqual(expected);
    expect(calls).not.toHaveBeenCalled();
    expect(hashTerminalReplicaSnapshot(a)).toBe(hashTerminalReplicaSnapshot(b));
    expect(yields).toBe(32);
  } finally {
    calls.mockRestore();
  }
});
it("keeps foreign frozen lookalikes on the full strict path", async () => {
  const foreign = structuredClone(blanks());
  for (const row of foreign.grid) {
    for (const c of row.cells) Object.freeze(c);
    Object.freeze(row.cells);
    Object.freeze(row);
  }
  const calls = vi.spyOn(TerminalReplicaCellSchemaZ._zod, "run");
  try {
    for (let i = 0; i < 2; i++) {
      calls.mockClear();
      await encode(foreign);
      expect(calls).toHaveBeenCalledTimes(8192);
    }
  } finally {
    calls.mockRestore();
  }
});
it("keeps nontrusted mixed cells and owned extra fields strictly validated", async () => {
  const a = blanks();
  const styled = { ...EMPTY, grapheme: "X", foreground: { kind: "indexed" as const, index: 17 } };
  a.grid[0] = freezeOwnedTerminalReplicaRow({
    wrapped: false,
    cells: [styled, ...Array(127).fill(EMPTY)],
  });
  const calls = vi.spyOn(TerminalReplicaCellSchemaZ._zod, "run");
  try {
    await encode(a);
    expect(calls).toHaveBeenCalledTimes(1);
  } finally {
    calls.mockRestore();
  }
  const bad = blanks();
  bad.grid[0] = freezeOwnedTerminalReplicaRow({
    wrapped: false,
    cells: [{ ...EMPTY, extra: true }, ...Array(127).fill(EMPTY)],
  });
  await expect(encode(bad)).rejects.toThrow();
});
it("preserves foreign getter reads and cancellation without mutating source", async () => {
  const a = structuredClone(blanks());
  let reads = 0;
  const source = a.grid[0]!.cells[0]!;
  Object.defineProperty(source, "grapheme", {
    enumerable: true,
    get() {
      reads++;
      return "";
    },
  });
  const control = new AbortController(),
    reason = new Error("cancel");
  let yields = 0;
  await expect(
    encodeCompactSemanticTerminalUpdateCooperatively(
      { frame: "seed", revision: 0, snapshot: a },
      {
        signal: control.signal,
        yieldControl: async () => {
          yields++;
          control.abort(reason);
        },
      },
    ),
  ).rejects.toBe(reason);
  expect(yields).toBe(1);
  expect(reads).toBe(128);
  expect(Object.getOwnPropertyDescriptor(source, "grapheme")?.get).toBeDefined();
});

it("does not cache foreign validation across source mutation", async () => {
  const a = structuredClone(blanks());
  await encode(a);
  Object.assign(a.grid[0]!.cells[0]!, { extra: true });
  await expect(encode(a)).rejects.toThrow();
});

it("retains cancellation checkpoints on exact trusted blank slices", async () => {
  const control = new AbortController(),
    reason = new Error("blank encode cancelled");
  let yields = 0,
    published = false;
  const snapshot = blanks();
  const expected = encodeCompactSemanticTerminalUpdate({
    frame: "seed",
    revision: 0,
    snapshot: structuredClone(snapshot),
  });
  await expect(
    encodeCompactSemanticTerminalUpdateCooperatively(
      { frame: "seed", revision: 0, snapshot },
      {
        signal: control.signal,
        yieldControl: async () => {
          yields++;
          control.abort(reason);
        },
      },
    ).then((value) => {
      published = true;
      return value;
    }),
  ).rejects.toBe(reason);
  expect(yields).toBe(1);
  expect(published).toBe(false);
  expect(await encode(snapshot)).toEqual(expected);
});
