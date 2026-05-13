/**
 * Pure terminal-search engine tests (G20-P3).
 *
 * Drives `collectTerminalSearchMatches` + `getNextTerminalSearchIndex`
 * against synthetic buffers that mimic the xterm shape via a
 * structural duck-type. Covers wrapped lines, multiple matches per
 * line, the empty-query short-circuit, and the prev/next cycle.
 */

import { describe, expect, it } from "vitest";
import {
  collectTerminalSearchMatches,
  getNextTerminalSearchIndex,
  type TerminalSearchBufferLike,
} from "@/lib/pty/terminalSearch";

function buf(rows: ReadonlyArray<{ text: string; wrapped?: boolean }>): TerminalSearchBufferLike {
  return {
    length: rows.length,
    getLine: (i) => {
      const r = rows[i];
      if (!r) return undefined;
      return {
        isWrapped: r.wrapped,
        translateToString: () => r.text,
      };
    },
  };
}

describe("collectTerminalSearchMatches", () => {
  it("returns [] for an empty query", () => {
    expect(
      collectTerminalSearchMatches(buf([{ text: "hello world" }]), ""),
    ).toEqual([]);
  });

  it("matches case-insensitively in a single line", () => {
    const matches = collectTerminalSearchMatches(
      buf([{ text: "ERROR: something failed" }]),
      "error",
    );
    expect(matches).toEqual([{ row: 0, col: 0, length: 5 }]);
  });

  it("returns multiple matches on the same logical line", () => {
    const matches = collectTerminalSearchMatches(
      buf([{ text: "foo bar foo baz foo" }]),
      "foo",
    );
    expect(matches).toHaveLength(3);
    expect(matches.map((m) => m.col)).toEqual([0, 8, 16]);
    for (const m of matches) {
      expect(m.row).toBe(0);
      expect(m.length).toBe(3);
    }
  });

  it("matches across wrapped physical rows but reports the physical row+col", () => {
    // Two physical rows that xterm flagged as wrap-continuation form
    // one logical line. A match that spans the wrap boundary should
    // map back to the starting physical row.
    const matches = collectTerminalSearchMatches(
      buf([
        { text: "long-line-prefix-with-" }, // logical 0..21
        { text: "needle-suffix", wrapped: true }, // logical 22..34
      ]),
      "needle",
    );
    expect(matches).toEqual([{ row: 1, col: 0, length: 6 }]);
  });

  it("matches that BEGIN on row 0 but extend over the wrap still report row 0", () => {
    const matches = collectTerminalSearchMatches(
      buf([
        { text: "aaa-need" }, // logical 0..7
        { text: "le-bbb", wrapped: true }, // logical 8..13
      ]),
      "needle",
    );
    expect(matches).toEqual([{ row: 0, col: 4, length: 6 }]);
  });

  it("returns [] when the query is whitespace-only and the buffer is empty", () => {
    expect(collectTerminalSearchMatches(buf([]), "foo")).toEqual([]);
  });
});

describe("getNextTerminalSearchIndex", () => {
  const matches = [
    { row: 0, col: 0, length: 3 },
    { row: 1, col: 4, length: 3 },
    { row: 5, col: 2, length: 3 },
  ];

  it("returns -1 when there are no matches", () => {
    expect(getNextTerminalSearchIndex([], null, "next")).toBe(-1);
  });

  it("returns 0 on first 'next' when no current match", () => {
    expect(getNextTerminalSearchIndex(matches, null, "next")).toBe(0);
  });

  it("returns last index on first 'prev' when no current match", () => {
    expect(getNextTerminalSearchIndex(matches, null, "prev")).toBe(2);
  });

  it("cycles forward through the list", () => {
    expect(getNextTerminalSearchIndex(matches, matches[0]!, "next")).toBe(1);
    expect(getNextTerminalSearchIndex(matches, matches[1]!, "next")).toBe(2);
    expect(getNextTerminalSearchIndex(matches, matches[2]!, "next")).toBe(0);
  });

  it("cycles backward through the list", () => {
    expect(getNextTerminalSearchIndex(matches, matches[0]!, "prev")).toBe(2);
    expect(getNextTerminalSearchIndex(matches, matches[2]!, "prev")).toBe(1);
  });

  it("falls back to nearest-position when current is gone from the list", () => {
    const ghost = { row: 3, col: 0, length: 3 };
    // 'next' from row=3 lands on row=5.
    expect(getNextTerminalSearchIndex(matches, ghost, "next")).toBe(2);
    // 'prev' from row=3 lands on row=1.
    expect(getNextTerminalSearchIndex(matches, ghost, "prev")).toBe(1);
  });
});
