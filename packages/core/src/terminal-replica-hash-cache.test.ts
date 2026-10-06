import { describe, expect, it, vi } from "vitest";
import * as bufferedHash from "./terminal-fnv64-wasm.ts";
import type { TerminalReplicaRow, TerminalReplicaSnapshot } from "@tmux-ide/contracts";
import { blankTerminalReplicaSnapshot, hashTerminalReplicaSnapshot } from "./terminal-replica.ts";
import {
  hashCanonicalTerminalValue,
  hashCanonicalTerminalValueCooperatively,
  hashTerminalReplicaRowCached,
  hashTerminalReplicaRowRunsCooperatively,
  TerminalReplicaRunEncodingCache,
} from "./terminal-replica-hash-cache.ts";

const canonicalEncode = (value: unknown): string => {
  if (value === null) return "n;";
  if (typeof value === "boolean") return value ? "b1;" : "b0;";
  if (typeof value === "number") return `d${String(value).length}:${String(value)};`;
  if (typeof value === "string") {
    const length = new TextEncoder().encode(value).length;
    return `s${length}:${value};`;
  }
  if (Array.isArray(value)) return `a${value.length}:${value.map(canonicalEncode).join("")};`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `o${keys.length}:${keys
    .map((key) => `${canonicalEncode(key)}${canonicalEncode(record[key])}`)
    .join("")};`;
};

const referenceHash = (value: unknown): string => {
  const bytes = new TextEncoder().encode(canonicalEncode(value));
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
};

describe("terminal canonical hash cache", () => {
  it("preserves large mixed frame hashes through acceleration, yields and JS fallback", async () => {
    const values = Array.from({ length: 3 }, (_, frame) => ({
      prefix: "x".repeat(65520 + frame),
      rows: Array.from({ length: 160 }, (_, index) => ({
        attributes: index % 16,
        foreground: { kind: "rgb", value: index * 17 },
        text: ["界", "😀", "\ud800", "\0;:", "ASCII"][index % 5],
        changed: frame + index,
      })),
      suffix: "tail".repeat(2048),
    }));
    const expected = values.map(referenceHash);
    const factory = vi.spyOn(bufferedHash, "createBufferedFnv64");
    try {
      for (const fallback of [false, true]) {
        if (fallback) factory.mockReturnValue(null);
        expect(values.map(hashCanonicalTerminalValue)).toEqual(expected);
        let yields = 0;
        const actual = await Promise.all(
          values.map((value) =>
            hashCanonicalTerminalValueCooperatively(
              value,
              async () => {
                yields++;
                await Promise.resolve();
              },
              128,
            ),
          ),
        );
        expect(actual).toEqual(expected);
        expect(yields).toBeGreaterThan(0);
      }
    } finally {
      factory.mockRestore();
    }
  });

  it("preserves canonical hashes across repeated, reordered and overflowing object shapes", async () => {
    const inherited = Object.assign(Object.create({ inherited: "excluded" }), { z: 7, a: "界" });
    Object.defineProperty(inherited, "hidden", { value: "excluded", enumerable: false });
    const values = [
      ...Array.from({ length: 80 }, (_, index) =>
        index % 2 ? { z: index, a: "界" } : { a: "界", z: index },
      ),
      ...Array.from({ length: 20 }, (_, index) => ({ ["shape" + index]: index, tail: true })),
      Object.fromEntries(Array.from({ length: 40 }, (_, index) => ["key" + (40 - index), index])),
      inherited,
      { z: 999, a: "changed" },
    ];
    const expected = referenceHash(values);
    expect(hashCanonicalTerminalValue(values)).toBe(expected);
    let yields = 0;
    expect(
      await hashCanonicalTerminalValueCooperatively(
        values,
        async () => {
          yields++;
        },
        32,
      ),
    ).toBe(expected);
    expect(yields).toBeGreaterThan(0);
    values[0] = { z: -1, a: "fresh call" };
    expect(hashCanonicalTerminalValue(values)).toBe(referenceHash(values));
  });

  it("preserves key byte encodings across token limits, Unicode and cache overflow", async () => {
    const keys = ["", "kind", "a;b:", "\0\n", "x".repeat(32), "x".repeat(33), "界", "😀", "\ud800"];
    const values = [
      ...Array.from({ length: 3 }, (_, pass) =>
        Object.fromEntries(keys.map((key, index) => [key, pass + index])),
      ),
      ...Array.from({ length: 24 }, (_, index) => ({ ["layout-" + index]: index, kind: "fresh" })),
      Object.fromEntries(Array.from({ length: 40 }, (_, index) => ["field-" + index, index])),
      Object.fromEntries(keys.map((key, index) => [key, "changed-" + index])),
    ];
    const expected = referenceHash(values);
    expect(hashCanonicalTerminalValue(values)).toBe(expected);
    let yields = 0;
    expect(
      await hashCanonicalTerminalValueCooperatively(
        values,
        async () => {
          yields++;
        },
        32,
      ),
    ).toBe(expected);
    expect(yields).toBeGreaterThan(0);
    values[0] = { kind: "next call" };
    expect(hashCanonicalTerminalValue(values)).toBe(referenceHash(values));
  });

  it("keeps batch row hashes canonical with bounded encoding reuse and a JS fallback", () => {
    const factory = vi.spyOn(bufferedHash, "createBufferedFnv64");
    const base = blankTerminalReplicaSnapshot(1, 1).grid[0]!.cells[0]!;
    try {
      for (const fallback of [false, true]) {
        if (fallback) factory.mockReturnValue(null);
        const cache = new TerminalReplicaRunEncodingCache();
        const first = { ...base, grapheme: "界e\u0301\ud800", width: 2 as const };
        expect(cache.prepare(first).cacheMiss).toBe(true);
        expect(cache.prepare(first).cacheMiss).toBe(false);
        for (let index = 0; index < 1_100; index++) {
          const cell = {
            ...base,
            grapheme: `row-${index}`,
            foreground: { kind: "rgb" as const, value: index },
            background: { kind: "indexed" as const, index: index % 256 },
          };
          const row = { wrapped: index % 2 === 0, cells: [first, cell, base] };
          expect(hashTerminalReplicaRowCached(row, undefined, cache)).toBe(
            hashTerminalReplicaRowCached(row),
          );
        }
        const uncached = { ...base, grapheme: "after-cache-cap" };
        expect(cache.prepare(uncached).cacheMiss).toBe(true);
        expect(cache.prepare(uncached).cacheMiss).toBe(true);
        expect(cache.prepare(first).cacheMiss).toBe(false);
        const oversized = { ...base, grapheme: "x".repeat(70_000) };
        const fresh = new TerminalReplicaRunEncodingCache();
        expect(fresh.prepare(oversized).cacheMiss).toBe(true);
        expect(fresh.prepare(oversized).cacheMiss).toBe(true);
      }
    } finally {
      factory.mockRestore();
    }
  });

  it("accelerates substantial transactions without changing hashes or cooperative checkpoints", async () => {
    const cache = new TerminalReplicaRunEncodingCache();
    const factory = vi.spyOn(bufferedHash, "createBufferedFnv64");
    const cell = {
      ...blankTerminalReplicaSnapshot(1, 1).grid[0]!.cells[0]!,
      grapheme: "界e\u0301\ud800",
    };
    const row = { wrapped: true, cells: Array.from({ length: 1_024 }, () => cell) };
    const expected = hashTerminalReplicaRowCached(row);
    const decode = async (encodingCache: TerminalReplicaRunEncodingCache) => {
      let checkpoints = 0;
      const digest = await hashTerminalReplicaRowRunsCooperatively(
        true,
        row.cells.length,
        [[row.cells.length, cell]],
        async () => {
          checkpoints += 1;
        },
        64,
        undefined,
        encodingCache,
      );
      expect(digest).toBe(expected);
      expect(checkpoints).toBe(16);
    };
    try {
      await decode(cache);
      expect(factory).not.toHaveBeenCalled();
      await Promise.all([decode(cache), decode(cache)]);
      expect(factory).toHaveBeenCalledTimes(2);
      expect(factory.mock.results.every((result) => result.value !== null)).toBe(true);
      // A separate client/delivery does not inherit another transaction's work.
      await decode(new TerminalReplicaRunEncodingCache());
      expect(factory).toHaveBeenCalledTimes(2);
      factory.mockReturnValue(null);
      await decode(cache);
      expect(factory).toHaveBeenCalledTimes(3);
    } finally {
      factory.mockRestore();
    }
  });

  it("preserves carries and wraparound over every indexed color and RGB byte extreme", () => {
    const colors = [
      { kind: "default" },
      ...Array.from({ length: 256 }, (_, index) => ({ kind: "indexed", index })),
      ...[0, 0xff, 0xff00, 0xff0000, 0xffffff].map((value) => ({ kind: "rgb", value })),
    ];
    const values = colors.map((foreground, index) => [
      String.fromCharCode(index % 128),
      index % 3,
      foreground,
      colors[colors.length - index - 1],
      index * 257,
    ]);
    expect(hashCanonicalTerminalValue([true, values])).toBe(referenceHash([true, values]));
  });

  it("preserves exact UTF-8 hashes across ASCII boundaries and malformed surrogates", () => {
    const values = [
      "",
      " ",
      Array.from({ length: 128 }, (_, index) => String.fromCharCode(index)).join(""),
      "a".repeat(1024),
      "\u007f\u0080",
      "ASCII界",
      "e\u0301",
      "😀",
      "\ud800",
      "\udc00",
      "a\ud800z",
    ];
    for (const value of values) {
      expect(hashCanonicalTerminalValue(value)).toBe(referenceHash(value));
      expect(hashCanonicalTerminalValue({ [value]: [value, "", "tail"] })).toBe(
        referenceHash({ [value]: [value, "", "tail"] }),
      );
    }
  });

  it("matches the prior canonical BigInt hash for nested UTF-8 values", () => {
    const corpus = [
      null,
      true,
      false,
      0,
      -17,
      "ASCII",
      "界e\u0301\ud800",
      [null, true, 17, "wide界"],
      { z: [1, 2], a: { kind: "rgb", value: 0xff00aa } },
    ];
    for (const value of corpus)
      expect(hashCanonicalTerminalValue(value)).toBe(referenceHash(value));
  });

  it("matches the prior row hash for indexed, RGB, wide and combining cells", () => {
    const blank = blankTerminalReplicaSnapshot(3, 1);
    const row = Object.freeze({
      wrapped: true,
      cells: Object.freeze([
        Object.freeze({
          ...blank.grid[0]!.cells[0]!,
          grapheme: "界",
          width: 2 as const,
          foreground: Object.freeze({ kind: "indexed" as const, index: 75 }),
        }),
        Object.freeze({
          ...blank.grid[0]!.cells[1]!,
          grapheme: "",
          width: 0 as const,
          background: Object.freeze({ kind: "rgb" as const, value: 0x112233 }),
        }),
        Object.freeze({ ...blank.grid[0]!.cells[2]!, grapheme: "e\u0301", attributes: 7 }),
      ]),
    }) as unknown as TerminalReplicaRow;
    const projected = [
      row.wrapped,
      row.cells.map((cell) => [
        cell.grapheme,
        cell.width,
        cell.foreground,
        cell.background,
        cell.attributes,
      ]),
    ];
    expect(hashTerminalReplicaRowCached(row)).toBe(referenceHash(projected));
    expect(hashTerminalReplicaRowCached(row)).toBe(referenceHash(projected));
  });

  it("replays one UTF-8 encoding per compact run with exhaustive row-hash parity", async () => {
    const blank = blankTerminalReplicaSnapshot(5, 1);
    const cells = [
      Object.freeze({
        ...blank.grid[0]!.cells[0]!,
        grapheme: "界",
        width: 2 as const,
        foreground: Object.freeze({ kind: "indexed" as const, index: 75 }),
      }),
      Object.freeze({
        ...blank.grid[0]!.cells[0]!,
        grapheme: "",
        width: 0 as const,
        background: Object.freeze({ kind: "rgb" as const, value: 0x112233 }),
      }),
      Object.freeze({
        ...blank.grid[0]!.cells[0]!,
        grapheme: "e\u0301",
        attributes: 0xff,
      }),
    ];
    const row = Object.freeze({
      wrapped: true,
      cells: Object.freeze([cells[0]!, cells[1]!, cells[2]!, cells[2]!, cells[2]!]),
    }) as unknown as TerminalReplicaRow;
    const encodedRuns: number[] = [];
    const digest = await hashTerminalReplicaRowRunsCooperatively(
      true,
      5,
      [
        [1, cells[0]!],
        [1, cells[1]!],
        [3, cells[2]!],
      ],
      async () => {},
      2,
      (bytes) => encodedRuns.push(bytes),
    );
    expect(digest).toBe(hashTerminalReplicaRowCached(row));
    expect(encodedRuns).toEqual([3, 0, 3]);
  });

  it("never caches a shallow-frozen snapshot whose nested canonical state remains mutable", () => {
    const blank = blankTerminalReplicaSnapshot(2, 1);
    const cursor = { ...blank.cursor };
    const modes = { ...blank.modes };
    const placements = [
      {
        id: "placement-a",
        kind: "image",
        row: 0,
        column: 0,
        columns: 1,
        rows: 1,
        contentDigest: "digest-a",
      },
    ];
    const history: TerminalReplicaRow[] = [];
    const snapshot = Object.freeze({
      ...blank,
      grid: [...blank.grid],
      history,
      cursor,
      modes,
      placements,
    }) as unknown as TerminalReplicaSnapshot;
    const initial = hashTerminalReplicaSnapshot(snapshot);
    cursor.x = 1;
    const cursorChanged = hashTerminalReplicaSnapshot(snapshot);
    expect(cursorChanged).not.toBe(initial);
    modes.insert = true;
    const modesChanged = hashTerminalReplicaSnapshot(snapshot);
    expect(modesChanged).not.toBe(cursorChanged);
    placements[0]!.contentDigest = "digest-b";
    const placementChanged = hashTerminalReplicaSnapshot(snapshot);
    expect(placementChanged).not.toBe(modesChanged);
    history.push(blank.grid[0]!);
    expect(hashTerminalReplicaSnapshot(snapshot)).not.toBe(placementChanged);
  });

  it("never caches frozen row arrays or rows with mutable nested cells and colors", () => {
    const blank = blankTerminalReplicaSnapshot(1, 1);
    const foreground = { kind: "rgb" as const, value: 0x112233 };
    const background = { kind: "rgb" as const, value: 0x445566 };
    const cell = {
      ...blank.grid[0]!.cells[0]!,
      foreground,
      background,
    };
    const row = Object.freeze({ wrapped: false, cells: Object.freeze([cell]) });
    const snapshot = Object.freeze({
      ...blank,
      grid: Object.freeze([row]),
    }) as unknown as TerminalReplicaSnapshot;
    const initial = hashTerminalReplicaSnapshot(snapshot);
    cell.grapheme = "x";
    const graphemeChanged = hashTerminalReplicaSnapshot(snapshot);
    expect(graphemeChanged).not.toBe(initial);
    cell.attributes = 7;
    const styleChanged = hashTerminalReplicaSnapshot(snapshot);
    expect(styleChanged).not.toBe(graphemeChanged);
    foreground.value = 0xaabbcc;
    const colorChanged = hashTerminalReplicaSnapshot(snapshot);
    expect(colorChanged).not.toBe(styleChanged);

    const mutableRow = { wrapped: false, cells: blank.grid[0]!.cells };
    const mutableRowSnapshot = Object.freeze({
      ...blank,
      grid: Object.freeze([mutableRow]),
    }) as unknown as TerminalReplicaSnapshot;
    const rowInitial = hashTerminalReplicaSnapshot(mutableRowSnapshot);
    mutableRow.wrapped = true;
    expect(hashTerminalReplicaSnapshot(mutableRowSnapshot)).not.toBe(rowInitial);
  });
});
