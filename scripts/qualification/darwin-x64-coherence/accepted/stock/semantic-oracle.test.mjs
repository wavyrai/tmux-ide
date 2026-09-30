import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyStockSemanticSnapshot } from "./semantic-oracle.mjs";

function fixture() {
  const cols = 118,
    rows = 29;
  const cell = (grapheme, width = 1, foreground = { kind: "default" }) => ({
    grapheme,
    width,
    foreground,
    background: { kind: "default" },
    attributes: 0,
  });
  const row = (text) => ({
    cells: [...text]
      .map((c) => cell(c))
      .concat(Array.from({ length: cols - text.length }, () => cell(""))),
    wrapped: false,
  });
  const history = Array.from({ length: 473 }, (_, i) => row(`REC_${String(i).padStart(4, "0")}`));
  const grid = Array.from({ length: 27 }, (_, i) => row(`REC_${String(i + 473).padStart(4, "0")}`));
  const color = row("");
  color.cells.splice(
    0,
    9,
    ...[..."COLOR"].map((c) => cell(c, 1, { kind: "indexed", index: 196 })),
    cell(" "),
    cell("界", 2),
    cell("", 0),
    cell("é"),
  );
  grid.push(color, row("DONE_C4"));
  const modes = {
    alternateScreen: false,
    applicationCursor: true,
    applicationKeypad: true,
    bracketedPaste: true,
    insert: false,
    origin: false,
    wraparound: true,
    mouseTracking: false,
  };
  return {
    snapshot: {
      cols,
      rows,
      history,
      grid,
      cursor: { x: 7, y: 28, hidden: false },
      modes: { ...modes },
    },
    stock: {
      cols,
      rows,
      border: "top",
      cursor: [7, 28],
      cursorVisible: true,
      modes,
      visibleLines: [
        ...Array.from({ length: 27 }, (_, i) => `REC_${String(i + 473).padStart(4, "0")}`),
        "COLOR 界é",
        "DONE_C4",
      ],
    },
  };
}

test("finite producer visible text, Unicode, colors, cursor and modes pass", () => {
  const { snapshot, stock } = fixture();
  assert.equal(verifyStockSemanticSnapshot(snapshot, stock).records, 500);
});

test("bottom pane header keeps the same 29-row content geometry", () => {
  const { snapshot, stock } = fixture();
  stock.border = "bottom";
  assert.equal(verifyStockSemanticSnapshot(snapshot, stock).rows, 29);
});

test("no pane header exposes all 30 content rows", () => {
  const { snapshot, stock } = fixture();
  snapshot.grid.unshift(snapshot.history.pop());
  snapshot.rows = stock.rows = 30;
  stock.border = "off";
  snapshot.cursor.y = stock.cursor[1] = 29;
  stock.visibleLines.unshift("REC_0472");
  assert.equal(verifyStockSemanticSnapshot(snapshot, stock).rows, 30);
});

for (const [name, mutate] of [
  ["missing history ID", ({ snapshot }) => snapshot.history.splice(50, 1)],
  ["duplicate history ID", ({ snapshot }) => snapshot.history.push(snapshot.history[0])],
  ["reordered history", ({ snapshot }) => snapshot.history.reverse()],
  ["wrong visible stock text", ({ stock }) => (stock.visibleLines[0] = "wrong")],
  ["wrong foreground", ({ snapshot }) => (snapshot.grid[27].cells[0].foreground.index = 1)],
  [
    "reset missing",
    ({ snapshot }) => (snapshot.grid[27].cells[5].foreground = { kind: "indexed", index: 196 }),
  ],
  ["wide width lost", ({ snapshot }) => (snapshot.grid[27].cells[6].width = 1)],
  ["combining mark lost", ({ snapshot }) => (snapshot.grid[27].cells[8].grapheme = "e")],
  ["attributes changed", ({ snapshot }) => (snapshot.grid[0].cells[0].attributes = 1)],
  ["residual alternate screen", ({ snapshot }) => (snapshot.history[0].cells[0].grapheme = "ALT")],
  ["stale cursor", ({ snapshot }) => (snapshot.cursor.y = 27)],
  ["stale mode", ({ snapshot }) => (snapshot.modes.applicationCursor = false)],
  ["unsupported required mode", ({ stock }) => delete stock.modes.wraparound],
  ["unknown mode", ({ stock }) => (stock.modes.madeUp = false)],
])
  test(`rejects ${name}`, () => {
    const input = fixture();
    mutate(input);
    assert.throws(() => verifyStockSemanticSnapshot(input.snapshot, input.stock));
  });
