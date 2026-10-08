import { describe, expect, it } from "vitest";
import type { TerminalReplicaCell } from "@tmux-ide/contracts";
import { blankTerminalReplicaSnapshot, hashTerminalReplicaSnapshot } from "./terminal-replica.ts";
import {
  decodeCompactSemanticTerminalUpdate,
  decodeVerifiedCompactSemanticTerminalUpdate,
  encodeCompactSemanticTerminalUpdate,
} from "./terminal-delivery.ts";
import {
  createDecodedTerminalReplicaRowBuilder,
  hashTerminalReplicaRowCached,
} from "./terminal-replica-hash-cache.ts";
const cell = (grapheme: string, width: 0 | 1 | 2 = 1): TerminalReplicaCell => ({
  grapheme,
  width,
  attributes: 0,
  foreground: { kind: "default" },
  background: { kind: "default" },
});
describe("verified synchronous decoded row construction", () => {
  it("keeps verified digests equivalent to fresh rows and plain decode lazy", () => {
    for (const cells of [
      [cell(""), cell(" "), cell(" "), cell("")],
      [cell("a"), cell("b"), cell("c"), cell("d")],
      [
        cell("界", 2),
        cell("", 0),
        { ...cell("é"), foreground: { kind: "rgb" as const, value: 0x123456 }, attributes: 1 },
        cell("e\u0301"),
      ],
    ]) {
      const snapshot = { ...blankTerminalReplicaSnapshot(4, 1), grid: [{ wrapped: true, cells }] };
      const bytes = encodeCompactSemanticTerminalUpdate({ frame: "seed", revision: 1, snapshot });
      const verified = decodeVerifiedCompactSemanticTerminalUpdate(
        bytes,
        null,
        hashTerminalReplicaSnapshot(snapshot),
      ).canonicalSnapshot!;
      let misses = 0;
      const digest = hashTerminalReplicaRowCached(verified.grid[0]!, () => misses++);
      expect(misses).toBe(0);
      expect(digest).toBe(hashTerminalReplicaRowCached(structuredClone(verified.grid[0]!)));
      expect(verified).toEqual(snapshot);
      const plain = decodeCompactSemanticTerminalUpdate(bytes);
      if (plain.frame !== "seed") throw new Error("missing seed");
      misses = 0;
      expect(hashTerminalReplicaRowCached(plain.snapshot.grid[0]!, () => misses++)).toBe(digest);
      expect(misses).toBe(1);
    }
  });
  it("preserves strict malformed and wrong-hash rejection", () => {
    const snapshot = {
      ...blankTerminalReplicaSnapshot(2, 1),
      grid: [{ wrapped: false, cells: [cell("a"), cell("b")] }],
    };
    const bytes = encodeCompactSemanticTerminalUpdate({ frame: "seed", revision: 1, snapshot });
    expect(() =>
      decodeVerifiedCompactSemanticTerminalUpdate(bytes, null, "0000000000000000"),
    ).toThrow("Canonical state hash mismatch");
    const original = JSON.parse(new TextDecoder().decode(bytes));
    const cases: [(run: unknown[]) => void, string][] = [
      [(w) => (w[2] = 2), "Malformed compact wide cell"],
      [(w) => (w[2] = 0), "Malformed compact continuation cell"],
      [(w) => (w[3] = [1, -1]), "indexed color"],
      [(w) => (w[4] = [3, 0]), "Invalid compact color kind"],
      [(w) => (w[5] = 256), "cell attributes"],
      [(w) => (w[0] = 0), "cell run count"],
    ];
    for (const [mutate, message] of cases) {
      const wire = structuredClone(original);
      mutate(wire.s[2][0][1][0]);
      const invalid = new TextEncoder().encode(JSON.stringify(wire));
      expect(() =>
        decodeVerifiedCompactSemanticTerminalUpdate(
          invalid,
          null,
          hashTerminalReplicaSnapshot(snapshot),
        ),
      ).toThrow(message);
    }
  });
  it("parses later runs before sum-width and continuation checks", () => {
    const snapshot = {
      ...blankTerminalReplicaSnapshot(2, 1),
      grid: [{ wrapped: false, cells: [cell("a"), cell("b")] }],
    };
    const original = JSON.parse(
      new TextDecoder().decode(
        encodeCompactSemanticTerminalUpdate({ frame: "seed", revision: 1, snapshot }),
      ),
    );
    for (const mode of ["width", "continuation"] as const) {
      const wire = structuredClone(original);
      if (mode === "width") {
        wire.s[2][0][1][0][0] = 3;
        wire.s[2][0][1][1][3] = [1, -1];
      } else {
        wire.s[2][0][1][0][2] = 2;
        wire.s[2][0][1][1][5] = 256;
      }
      const bytes = new TextEncoder().encode(JSON.stringify(wire));
      expect(() =>
        decodeVerifiedCompactSemanticTerminalUpdate(
          bytes,
          null,
          hashTerminalReplicaSnapshot(snapshot),
        ),
      ).toThrow(mode === "width" ? "indexed color" : "cell attributes");
    }
  });
  it("preserves negative zero in literal RGB wire values", () => {
    const snapshot = {
      ...blankTerminalReplicaSnapshot(1, 1),
      grid: [
        {
          wrapped: false,
          cells: [{ ...cell("a"), foreground: { kind: "rgb" as const, value: 0 } }],
        },
      ],
    };
    const text = new TextDecoder().decode(
      encodeCompactSemanticTerminalUpdate({ frame: "seed", revision: 1, snapshot }),
    );
    expect(text).toContain("[2,0]");
    const bytes = new TextEncoder().encode(text.replace("[2,0]", "[2,-0]"));
    const plain = decodeCompactSemanticTerminalUpdate(bytes);
    if (plain.frame !== "seed") throw new Error("missing seed");
    const verified = decodeVerifiedCompactSemanticTerminalUpdate(
      bytes,
      null,
      hashTerminalReplicaSnapshot(plain.snapshot),
    ).canonicalSnapshot!;
    expect(verified).toEqual(plain.snapshot);
    const foreground = verified.grid[0]!.cells[0]!.foreground;
    expect(foreground.kind).toBe("rgb");
    if (foreground.kind === "rgb") expect(Object.is(foreground.value, -0)).toBe(true);
  });
  it("preserves indexed negative zero and exposes no row after failed finish", () => {
    const snapshot = {
      ...blankTerminalReplicaSnapshot(1, 1),
      grid: [
        {
          wrapped: false,
          cells: [{ ...cell("a"), foreground: { kind: "indexed" as const, index: 0 } }],
        },
      ],
    };
    const text = new TextDecoder().decode(
      encodeCompactSemanticTerminalUpdate({ frame: "seed", revision: 1, snapshot }),
    );
    expect(text).toContain("[1,0]");
    const bytes = new TextEncoder().encode(text.replace("[1,0]", "[1,-0]"));
    const plain = decodeCompactSemanticTerminalUpdate(bytes);
    if (plain.frame !== "seed") throw new Error("missing seed");
    const verified = decodeVerifiedCompactSemanticTerminalUpdate(
      bytes,
      null,
      hashTerminalReplicaSnapshot(plain.snapshot),
    ).canonicalSnapshot!;
    expect(verified).toEqual(plain.snapshot);
    const color = verified.grid[0]!.cells[0]!.foreground;
    if (color.kind !== "indexed") throw new Error("missing indexed color");
    expect(Object.is(color.index, -0)).toBe(true);
    const builder = createDecodedTerminalReplicaRowBuilder();
    builder.appendRun(1, "界", 2, -1, -1, 0);
    let rejectedRow: unknown;
    expect(() => {
      rejectedRow = builder.finish(false, 1);
    }).toThrow("Malformed compact wide cell");
    expect(rejectedRow).toBeUndefined();
    builder.appendRun(1, "", 0, -1, -1, 0);
    const row = builder.finish(false, 2);
    expect(hashTerminalReplicaRowCached(row)).toBe(
      hashTerminalReplicaRowCached(structuredClone(row)),
    );
  });
  it("copies primitive run data and owns its immutable hash input", () => {
    const run: [number, string, 0 | 1 | 2, number, number, number] = [2, "é", 1, 0x1123456, 4, 1];
    const builder = createDecodedTerminalReplicaRowBuilder();
    builder.appendRun(...run);
    const row = builder.finish(false, 2);
    let misses = 0;
    hashTerminalReplicaRowCached(row, () => misses++);
    expect(misses).toBe(1);
    const expected = structuredClone(row);
    run[1] = "changed";
    run[3] = 2;
    expect(row).toEqual(expected);
    expect(Object.isFrozen(row)).toBe(true);
    expect(Object.isFrozen(row.cells)).toBe(true);
    expect(Object.isFrozen(row.cells[0]!.foreground)).toBe(true);
    expect(hashTerminalReplicaRowCached(row)).toBe(hashTerminalReplicaRowCached(expected));
    expect(() => builder.appendRun(...run)).toThrow("already finished");
    expect(() => builder.finish(false, 2)).toThrow("already finished");
    expect(() =>
      createDecodedTerminalReplicaRowBuilder().appendRun(2, {} as string, 1, -1, -1, 0),
    ).toThrow("Invalid decoded scalar run");
  });
});
