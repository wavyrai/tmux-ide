import { describe, expect, it, vi } from "vitest";
import * as fnv from "./terminal-fnv64-wasm.ts";
import type { TerminalReplicaColor, TerminalReplicaRow } from "@tmux-ide/contracts";
import {
  hashCanonicalTerminalValue,
  hashTerminalReplicaRowCached,
  hashTerminalReplicaRowCooperatively,
  TerminalReplicaRunEncodingCache,
} from "./terminal-replica-hash-cache.ts";
import { TERMINAL_REPLICA_DEFAULT_COLOR } from "./terminal-replica-owned-row.ts";

// #708: the row hash is part of every stateHash a client verifies, so a faster
// row hash must give byte-identical digests. The reference is the generic
// canonical encoder over the row's canonical shape, a separate implementation.
function reference(row: TerminalReplicaRow): string {
  return hashCanonicalTerminalValue([
    row.wrapped,
    row.cells.map((cell) => [
      cell.grapheme,
      cell.width,
      cell.foreground,
      cell.background,
      cell.attributes,
    ]),
  ]);
}

type Cell = TerminalReplicaRow["cells"][number];
const D = TERMINAL_REPLICA_DEFAULT_COLOR;
const cell = (
  grapheme: string,
  width: 0 | 1 | 2 = 1,
  foreground: TerminalReplicaColor = D,
  background: TerminalReplicaColor = D,
  attributes = 0,
): Cell => ({ grapheme, width, foreground, background, attributes });
const row = (cells: Cell[], wrapped = false): TerminalReplicaRow => ({ cells, wrapped });
const text = (value: string, cols: number): Cell[] =>
  Array.from({ length: cols }, (_, i) => cell(value[i] ?? " "));
function frozen(value: TerminalReplicaRow): TerminalReplicaRow {
  for (const c of value.cells) {
    Object.freeze(c.foreground);
    Object.freeze(c.background);
    Object.freeze(c);
  }
  Object.freeze(value.cells);
  return Object.freeze(value);
}

/** Deterministic pseudo-random cells: every colour kind, attribute and width. */
function noisy(seed: number, cols: number): TerminalReplicaRow {
  let state = seed;
  const next = () => (state = (state * 1103515245 + 12345) >>> 0);
  const graphemes = ["a", "Z", " ", "", "~", "é", "日", "🙂", "é", "\u0000", "\u007f", "ÿ"];
  const colors: TerminalReplicaColor[] = [
    D,
    { kind: "indexed", index: 0 },
    { kind: "indexed", index: 2 },
    { kind: "indexed", index: 255 },
    { kind: "rgb", value: 0 },
    { kind: "rgb", value: 1 },
    { kind: "rgb", value: 0xffffff },
    { kind: "rgb", value: 0x123456 },
  ];
  const cells: Cell[] = [];
  while (cells.length < cols) {
    const g = graphemes[next() % graphemes.length]!;
    const wide = g === "日" || g === "🙂";
    const style = [colors[next() % colors.length]!, colors[next() % colors.length]!] as const;
    const attributes = [0, 1, 2, 3, 17, 255, 65535][next() % 7]!;
    if (wide && cells.length + 2 <= cols) {
      cells.push(cell(g, 2, style[0], style[1], attributes));
      cells.push(cell("", 0, style[0], style[1], attributes));
    } else if (!wide) cells.push(cell(g, 1, style[0], style[1], attributes));
  }
  return row(cells, next() % 2 === 0);
}

const corpus: [string, TerminalReplicaRow][] = [
  ["empty row", row([])],
  ["one blank cell", row([cell(" ")])],
  ["empty grapheme", row([cell("")])],
  ["80 cols of text", row(text("$ seq 1 2000000", 80))],
  ["wrapped 200 cols", row(text("x".repeat(200), 200), true)],
  ["wide and combining", row([cell("日", 2), cell("", 0), cell("é"), cell("🙂", 2), cell("", 0)])],
  ["lone surrogate", row([cell("\ud800")])],
  [
    "every colour kind",
    row([cell("a", 1, { kind: "indexed", index: 9 }, { kind: "rgb", value: 0xabcdef }, 7)]),
  ],
  [
    "large numbers",
    row([cell("a", 1, { kind: "rgb", value: 16777215 }, { kind: "indexed", index: 1000 }, 123456)]),
  ],
  // 4096 cols crosses the WASM scratch buffer several times.
  ["4096 cols", row(text("0123456789abcdef".repeat(256), 4096))],
  ...Array.from({ length: 40 }, (_, i): [string, TerminalReplicaRow] => [
    `noisy ${i}`,
    noisy(i + 1, [1, 7, 80, 200, 333, 1024][i % 6]!),
  ]),
];

describe("row hash stays byte-identical (#708)", () => {
  it.each(corpus)("%s: mutable row", (_, value) => {
    expect(hashTerminalReplicaRowCached(structuredClone(value))).toBe(reference(value));
  });

  it.each(corpus)("%s: frozen row, cached and recomputed", (_, value) => {
    const copy = frozen(structuredClone(value));
    expect(hashTerminalReplicaRowCached(copy)).toBe(reference(value));
    expect(hashTerminalReplicaRowCached(copy)).toBe(reference(value));
  });

  it.each(corpus)("%s: cooperative path", async (_, value) => {
    const copy = structuredClone(value);
    expect(await hashTerminalReplicaRowCooperatively(copy, async () => {})).toBe(reference(value));
  });

  it("does not cache a row that can still change", () => {
    const value = row(text("before", 20));
    expect(hashTerminalReplicaRowCached(value)).toBe(reference(value));
    value.cells[0] = cell("X");
    expect(hashTerminalReplicaRowCached(value)).toBe(reference(value));
  });

  it("does not reuse a shared cell's bytes after that cell changes", () => {
    const shared = cell("q");
    const first = row([shared, shared]);
    expect(hashTerminalReplicaRowCached(first)).toBe(reference(first));
    shared.grapheme = "r";
    const second = row([shared, shared]);
    expect(hashTerminalReplicaRowCached(second)).toBe(reference(second));
  });

  it("keeps the same digests without WebAssembly", () => {
    const native = vi.spyOn(fnv, "nativeFnv64").mockReturnValue(null);
    try {
      for (const [, value] of corpus)
        expect(hashTerminalReplicaRowCached(structuredClone(value))).toBe(reference(value));
      // Batches of 64+ rows take the run-encoding cache path (prefix, grapheme
      // bytes, suffix); a client without WebAssembly hashes through it.
      const cache = new TerminalReplicaRunEncodingCache();
      for (const [, value] of corpus)
        expect(hashTerminalReplicaRowCached(structuredClone(value), undefined, cache)).toBe(
          reference(value),
        );
      expect(native).toHaveBeenCalled();
    } finally {
      native.mockRestore();
    }
  });

  it("keeps the same digests when WebAssembly does not exist at all", async () => {
    vi.stubGlobal("WebAssembly", undefined);
    vi.resetModules();
    try {
      const fresh = await import("./terminal-replica-hash-cache.ts");
      const freshReference = (value: TerminalReplicaRow) =>
        fresh.hashCanonicalTerminalValue([
          value.wrapped,
          value.cells.map((c) => [c.grapheme, c.width, c.foreground, c.background, c.attributes]),
        ]);
      const cache = new fresh.TerminalReplicaRunEncodingCache();
      for (const [, value] of corpus) {
        expect(fresh.hashTerminalReplicaRowCached(structuredClone(value))).toBe(reference(value));
        expect(fresh.hashTerminalReplicaRowCached(structuredClone(value), undefined, cache)).toBe(
          reference(value),
        );
        expect(freshReference(value)).toBe(reference(value));
      }
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });
});
