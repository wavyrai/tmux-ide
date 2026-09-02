import { describe, expect, it } from "vitest";
import type { TerminalReplicaRow, TerminalReplicaSnapshot } from "@tmux-ide/contracts";
import { blankTerminalReplicaSnapshot, hashTerminalReplicaSnapshot } from "./terminal-replica.ts";
import {
  hashCanonicalTerminalValue,
  hashTerminalReplicaRowCached,
  hashTerminalReplicaRowRunsCooperatively,
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
