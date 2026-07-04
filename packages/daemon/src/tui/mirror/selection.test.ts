import { describe, it, expect } from "vitest";
import {
  orderCells,
  rowSelectionRange,
  extractSelection,
  wordRangeAt,
  lineRangeAt,
  clickCount,
  tintRunsInverse,
  tintRunsBg,
  osc52Sequence,
  tmuxPassthrough,
  chunkByBytes,
  ATTR_INVERSE,
  type Cell,
} from "./selection.ts";

describe("orderCells", () => {
  it("keeps reading order when a precedes b", () => {
    expect(orderCells({ row: 0, col: 2 }, { row: 1, col: 0 })).toEqual({
      start: { row: 0, col: 2 },
      end: { row: 1, col: 0 },
    });
  });
  it("swaps when b precedes a (same row)", () => {
    expect(orderCells({ row: 3, col: 9 }, { row: 3, col: 4 })).toEqual({
      start: { row: 3, col: 4 },
      end: { row: 3, col: 9 },
    });
  });
  it("swaps when b precedes a (earlier row)", () => {
    const { start, end } = orderCells({ row: 5, col: 0 }, { row: 2, col: 8 });
    expect(start).toEqual({ row: 2, col: 8 });
    expect(end).toEqual({ row: 5, col: 0 });
  });
});

describe("rowSelectionRange", () => {
  const start: Cell = { row: 1, col: 3 };
  const end: Cell = { row: 3, col: 4 };
  it("returns null above/below the selection", () => {
    expect(rowSelectionRange(0, 10, start, end)).toBeNull();
    expect(rowSelectionRange(4, 10, start, end)).toBeNull();
  });
  it("first row runs from start.col to row end", () => {
    expect(rowSelectionRange(1, 10, start, end)).toEqual({ from: 3, to: 9 });
  });
  it("middle rows cover the whole row", () => {
    expect(rowSelectionRange(2, 10, start, end)).toEqual({ from: 0, to: 9 });
  });
  it("last row runs from 0 to end.col", () => {
    expect(rowSelectionRange(3, 10, start, end)).toEqual({ from: 0, to: 4 });
  });
  it("single-row selection is bounded both sides", () => {
    const s = { row: 2, col: 2 };
    const e = { row: 2, col: 6 };
    expect(rowSelectionRange(2, 20, s, e)).toEqual({ from: 2, to: 6 });
  });
  it("clamps columns to the row length", () => {
    expect(rowSelectionRange(1, 5, { row: 1, col: 99 }, { row: 1, col: 99 })).toEqual({
      from: 4,
      to: 4,
    });
  });
  it("returns null for an empty row", () => {
    expect(rowSelectionRange(2, 0, start, end)).toBeNull();
  });
});

describe("extractSelection", () => {
  it("extracts a single-row span", () => {
    expect(extractSelection(["hello world"], { row: 0, col: 0 }, { row: 0, col: 4 })).toBe("hello");
  });
  it("extracts a multi-row span with full middle rows", () => {
    const rows = ["abcdef", "ghijkl", "mnopqr"];
    const text = extractSelection(rows, { row: 0, col: 2 }, { row: 2, col: 2 });
    expect(text).toBe("cdef\nghijkl\nmno");
  });
  it("rstrips trailing pad by default (terminal snapshot rows)", () => {
    const rows = ["word      ", "next      "];
    const text = extractSelection(rows, { row: 0, col: 0 }, { row: 1, col: 9 });
    expect(text).toBe("word\nnext");
  });
  it("keeps trailing whitespace when trimTrailing is false (editor)", () => {
    const text = extractSelection(["a   ", "b"], { row: 0, col: 0 }, { row: 1, col: 0 }, false);
    expect(text).toBe("a   \nb");
  });
});

describe("wordRangeAt", () => {
  it("selects the whole word around the click", () => {
    expect(wordRangeAt("the quick brown", 6)).toEqual({ from: 4, to: 8 }); // "quick"
  });
  it("includes underscores and digits", () => {
    expect(wordRangeAt("foo_bar42 baz", 2)).toEqual({ from: 0, to: 8 });
  });
  it("selects a single non-word char", () => {
    expect(wordRangeAt("a - b", 2)).toEqual({ from: 2, to: 2 });
  });
  it("handles an empty line", () => {
    expect(wordRangeAt("", 0)).toEqual({ from: 0, to: 0 });
  });
  it("extracts exactly the word (double-click gate)", () => {
    const line = "  const answer = 42";
    const r = wordRangeAt(line, 9); // inside "answer"
    expect(line.slice(r.from, r.to + 1)).toBe("answer");
  });
});

describe("lineRangeAt", () => {
  it("covers up to the last non-blank char", () => {
    expect(lineRangeAt("hello   ")).toEqual({ from: 0, to: 4 });
  });
  it("returns {0,0} for a blank line", () => {
    expect(lineRangeAt("     ")).toEqual({ from: 0, to: 0 });
  });
});

describe("clickCount", () => {
  it("starts at 1 with no history", () => {
    expect(clickCount(null, { row: 1, col: 1 }, 1000, 400)).toBe(1);
  });
  it("increments on the same cell within the window", () => {
    const prev = { row: 1, col: 1, ts: 1000, count: 1 };
    expect(clickCount(prev, { row: 1, col: 1 }, 1300, 400)).toBe(2);
  });
  it("reaches triple then cycles back to 1", () => {
    const two = { row: 1, col: 1, ts: 1000, count: 2 };
    expect(clickCount(two, { row: 1, col: 1 }, 1100, 400)).toBe(3);
    const three = { row: 1, col: 1, ts: 1000, count: 3 };
    expect(clickCount(three, { row: 1, col: 1 }, 1100, 400)).toBe(1);
  });
  it("resets when the cell moves", () => {
    const prev = { row: 1, col: 1, ts: 1000, count: 2 };
    expect(clickCount(prev, { row: 2, col: 1 }, 1100, 400)).toBe(1);
  });
  it("resets after the window elapses", () => {
    const prev = { row: 1, col: 1, ts: 1000, count: 1 };
    expect(clickCount(prev, { row: 1, col: 1 }, 1500, 400)).toBe(1);
  });
});

describe("tintRunsInverse", () => {
  const run = (text: string, attributes = 0) => ({ text, fg: 1, bg: 2, attributes });
  it("splits a run and inverts the selected span", () => {
    const out = tintRunsInverse([run("hello world")], 0, 4);
    expect(out).toEqual([
      { text: "hello", fg: 1, bg: 2, attributes: ATTR_INVERSE },
      { text: " world", fg: 1, bg: 2, attributes: 0 },
    ]);
  });
  it("inverts a middle span keeping colors on the flanks", () => {
    const out = tintRunsInverse([run("abcdef")], 2, 3);
    expect(out.map((r) => r.text)).toEqual(["ab", "cd", "ef"]);
    expect(out[1]!.attributes).toBe(ATTR_INVERSE);
    expect(out[0]!.attributes).toBe(0);
    expect(out[2]!.attributes).toBe(0);
  });
  it("spans across multiple runs", () => {
    const out = tintRunsInverse([run("abc"), run("def")], 1, 4);
    // "a"|"bc" then "de"|"f"
    expect(out.map((r) => `${r.text}:${r.attributes}`)).toEqual([
      `a:0`,
      `bc:${ATTR_INVERSE}`,
      `de:${ATTR_INVERSE}`,
      `f:0`,
    ]);
  });
  it("xor flips an already-inverse cell back (cursor under selection)", () => {
    const out = tintRunsInverse([run("x", ATTR_INVERSE)], 0, 0);
    expect(out[0]!.attributes).toBe(0);
  });
  it("returns runs unchanged when to < from", () => {
    const runs = [run("abc")];
    expect(tintRunsInverse(runs, 5, 3)).toBe(runs);
  });
});

describe("tintRunsBg", () => {
  const run = (text: string, bg: number | null = 2) => ({ text, fg: 1, bg, attributes: 0 });
  it("splits a run and paints the spanned bg, keeping colors on the flanks", () => {
    const out = tintRunsBg([run("hello world")], 0, 4, 0x82aaff);
    expect(out).toEqual([
      { text: "hello", fg: 1, bg: 0x82aaff, attributes: 0 },
      { text: " world", fg: 1, bg: 2, attributes: 0 },
    ]);
  });
  it("paints a middle span across multiple runs", () => {
    const out = tintRunsBg([run("abc"), run("def")], 1, 4, 0x99);
    expect(out.map((r) => `${r.text}:${r.bg}`)).toEqual([`a:2`, `bc:153`, `de:153`, `f:2`]);
  });
  it("returns runs unchanged when to < from", () => {
    const runs = [run("abc")];
    expect(tintRunsBg(runs, 5, 3, 0x1)).toBe(runs);
  });
});

describe("osc52Sequence / tmuxPassthrough", () => {
  it("builds a BEL-terminated OSC52 set", () => {
    const b64 = Buffer.from("hi").toString("base64");
    expect(osc52Sequence(b64)).toBe(`\x1b]52;c;${b64}\x07`);
  });
  it("wraps in the tmux passthrough envelope with doubled ESCs", () => {
    const wrapped = tmuxPassthrough("\x1b]52;c;AA==\x07");
    expect(wrapped.startsWith("\x1bPtmux;")).toBe(true);
    expect(wrapped.endsWith("\x1b\\")).toBe(true);
    // the inner OSC's leading ESC is doubled.
    expect(wrapped).toContain("\x1b\x1b]52;c;AA==\x07");
  });
});

describe("chunkByBytes", () => {
  it("returns one chunk when it fits", () => {
    expect(chunkByBytes("hello", 100)).toEqual(["hello"]);
  });
  it("splits on the byte budget", () => {
    expect(chunkByBytes("abcdefgh", 3)).toEqual(["abc", "def", "gh"]);
  });
  it("never breaks a multi-byte code point", () => {
    // "é" is 2 bytes; with a 3-byte budget each chunk holds one "é".
    const chunks = chunkByBytes("ééé", 3);
    expect(chunks).toEqual(["é", "é", "é"]);
    for (const c of chunks) expect(Buffer.byteLength(c, "utf8")).toBeLessThanOrEqual(3);
  });
  it("reassembles to the original", () => {
    const s = "the quick brown fox — jumped over 42 lazy dogs";
    expect(chunkByBytes(s, 5).join("")).toBe(s);
  });
});
