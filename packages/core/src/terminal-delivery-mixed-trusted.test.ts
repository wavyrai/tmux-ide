import { it, expect, vi } from "vitest";

import { TerminalReplicaCellSchemaZ } from "@tmux-ide/contracts";
import { blankTerminalReplicaSnapshot, hashTerminalReplicaSnapshot } from "./terminal-replica.ts";
import {
  freezeOwnedTerminalReplicaRow,
  TERMINAL_REPLICA_EMPTY_CELL as EMPTY,
  TERMINAL_REPLICA_SPACE_CELL as SPACE,
} from "./terminal-replica-owned-row.ts";
import {
  encodeCompactSemanticTerminalUpdate as sync,
  encodeCompactSemanticTerminalUpdateCooperatively as coop,
} from "./terminal-delivery.ts";
const make = () => ({
  ...blankTerminalReplicaSnapshot(128, 64),
  grid: Array.from({ length: 64 }, () =>
    freezeOwnedTerminalReplicaRow({
      wrapped: false,
      cells: [
        { ...EMPTY, grapheme: "X", foreground: { kind: "indexed" as const, index: 17 } },
        { ...EMPTY, grapheme: "界", width: 2 as const },
        { ...EMPTY, width: 0 as const },
        ...Array.from({ length: 125 }, (_, i) => (i % 2 ? SPACE : EMPTY)),
      ],
    }),
  ),
});
it("reuses only exact trusted cells in fresh mixed owned rows with identical wire and hashes", async () => {
  const reference = make();
  const expected = sync({ frame: "seed", revision: 0, snapshot: structuredClone(reference) });
  const original = TerminalReplicaCellSchemaZ._zod.run;
  const calls = vi.spyOn(TerminalReplicaCellSchemaZ._zod, "run");
  try {
    const interrupted = new Error("trusted pair validation interrupted");
    calls.mockImplementation((...args) => {
      if (args[0].value === EMPTY) throw interrupted;
      return original(...args);
    });
    expect(() => sync({ frame: "seed", revision: 0, snapshot: make() })).toThrow(interrupted);
    calls.mockImplementation(original);
    for (const route of ["sync", "cooperative"] as const)
      for (const ownership of ["owned", "foreign"] as const) {
        const a = ownership === "owned" ? make() : structuredClone(make());
        let yields = 0;
        const encode = () =>
          route === "sync"
            ? sync({ frame: "seed", revision: 0, snapshot: a })
            : coop(
                { frame: "seed", revision: 0, snapshot: a },
                {
                  yieldControl: async () => {
                    yields++;
                  },
                },
              );
        calls.mockClear();
        const first = await encode();
        const firstCalls = calls.mock.calls.length;
        calls.mockClear();
        const second = await encode();
        const repeatCalls = calls.mock.calls.length;
        expect(first).toEqual(expected);
        expect(second).toEqual(expected);
        expect(hashTerminalReplicaSnapshot(a)).toBe(hashTerminalReplicaSnapshot(reference));
        expect(firstCalls).toBe(ownership === "owned" ? (route === "sync" ? 194 : 192) : 8192);
        expect(repeatCalls).toBe(ownership === "owned" ? 0 : 8192);
        if (route === "cooperative") expect(yields).toBe(64);
      }
  } finally {
    calls.mockRestore();
  }
});

it("preserves strict issues for invalid owned mixed slices", async () => {
  for (const bad of [
    { ...EMPTY, extra: true },
    { ...EMPTY, width: 3 },
    { ...EMPTY, foreground: { kind: "default", extra: 1 } },
  ]) {
    const a = make();
    a.grid[0] = freezeOwnedTerminalReplicaRow({
      wrapped: false,
      cells: [bad as typeof EMPTY, ...a.grid[0]!.cells.slice(1)],
    });
    const failure = async (snapshot: typeof a) => {
      try {
        await coop({ frame: "seed", revision: 0, snapshot }, { yieldControl: async () => {} });
        throw Error("accepted");
      } catch (e) {
        return (e as { issues: unknown }).issues;
      }
    };
    const actual = await failure(a);
    expect(actual).toBeDefined();
    expect(actual).toEqual(await failure(structuredClone(a)));
    expect(() => sync({ frame: "seed", revision: 0, snapshot: a })).toThrow();
  }
});
it("keeps styled blank validation and foreign getter and mutation semantics", async () => {
  const a = make();
  a.grid[0] = freezeOwnedTerminalReplicaRow({
    wrapped: false,
    cells: [{ ...SPACE, attributes: 1 }, ...a.grid[0]!.cells.slice(1)],
  });
  const foreign = structuredClone(a);
  let reads = 0;
  Object.defineProperty(foreign.grid[0]!.cells[0]!, "grapheme", {
    enumerable: true,
    get() {
      reads++;
      return " ";
    },
  });
  const expected = sync({ frame: "seed", revision: 0, snapshot: structuredClone(a) });
  expect(
    await coop({ frame: "seed", revision: 0, snapshot: foreign }, { yieldControl: async () => {} }),
  ).toEqual(expected);
  expect(reads).toBe(1);
  expect(
    await coop({ frame: "seed", revision: 0, snapshot: a }, { yieldControl: async () => {} }),
  ).toEqual(expected);
  Object.assign(foreign.grid[0]!.cells[1]!, { extra: true });
  await expect(
    coop({ frame: "seed", revision: 0, snapshot: foreign }, { yieldControl: async () => {} }),
  ).rejects.toThrow();
});
it("aborts mixed owned encoding at the same first checkpoint and retries completely", async () => {
  const a = make(),
    controller = new AbortController(),
    reason = new Error("mixed abort");
  let yields = 0,
    published = false;
  const expected = sync({ frame: "seed", revision: 0, snapshot: structuredClone(a) });
  await expect(
    coop(
      { frame: "seed", revision: 0, snapshot: a },
      {
        signal: controller.signal,
        yieldControl: async () => {
          yields++;
          controller.abort(reason);
        },
      },
    ).then((value) => {
      published = true;
      return value;
    }),
  ).rejects.toBe(reason);
  expect(yields).toBe(1);
  expect(published).toBe(false);
  expect(
    await coop({ frame: "seed", revision: 0, snapshot: a }, { yieldControl: async () => {} }),
  ).toEqual(expected);
});

it.each([
  {
    name: "sparse",
    cols: 128,
    rows: 64,
    nontrusted: (i: number) => i !== 0,
    syncCalls: 8192,
    coopCalls: 8192,
  },
  {
    name: "half",
    cols: 128,
    rows: 64,
    nontrusted: (i: number) => i % 2 === 0,
    syncCalls: 8192,
    coopCalls: 8192,
  },
  {
    name: "exact threshold",
    cols: 256,
    rows: 32,
    nontrusted: (i: number) => i < 64,
    syncCalls: 2048,
    coopCalls: 2048,
  },
  {
    name: "below threshold",
    cols: 256,
    rows: 32,
    nontrusted: (i: number) => i < 65,
    syncCalls: 8192,
    coopCalls: 8192,
  },
  {
    name: "short residual at threshold",
    cols: 300,
    rows: 28,
    nontrusted: (i: number) => i < 64 || (i >= 256 && i < 267),
    syncCalls: 2100,
    coopCalls: 2100,
  },
  {
    name: "short residual below threshold",
    cols: 300,
    rows: 28,
    nontrusted: (i: number) => i < 64 || (i >= 256 && i < 268),
    syncCalls: 8400,
    coopCalls: 3024,
  },
])(
  "strictly validates $name with exact bytes",
  async ({ cols, rows, nontrusted, syncCalls, coopCalls }) => {
    const fresh = () => ({
      ...blankTerminalReplicaSnapshot(cols, rows),
      grid: Array.from({ length: rows }, () =>
        freezeOwnedTerminalReplicaRow({
          wrapped: false,
          cells: Array.from({ length: cols }, (_, i) =>
            nontrusted(i) ? { ...EMPTY, grapheme: "x" } : EMPTY,
          ),
        }),
      ),
    });
    const reference = fresh();
    const expected = sync({ frame: "seed", revision: 0, snapshot: structuredClone(reference) });
    const hash = hashTerminalReplicaSnapshot(reference);
    const calls = vi.spyOn(TerminalReplicaCellSchemaZ._zod, "run");
    try {
      const a = fresh();
      expect(sync({ frame: "seed", revision: 0, snapshot: a })).toEqual(expected);
      expect(calls).toHaveBeenCalledTimes(syncCalls);
      expect(hashTerminalReplicaSnapshot(a)).toBe(hash);
      calls.mockClear();
      const b = fresh();
      let yields = 0;
      expect(
        await coop(
          { frame: "seed", revision: 0, snapshot: b },
          {
            yieldControl: async () => {
              yields++;
            },
          },
        ),
      ).toEqual(expected);
      expect(calls).toHaveBeenCalledTimes(coopCalls);
      expect(yields).toBe(Math.floor((cols * rows) / 256));
      expect(hashTerminalReplicaSnapshot(b)).toBe(hash);
    } finally {
      calls.mockRestore();
    }
  },
);
