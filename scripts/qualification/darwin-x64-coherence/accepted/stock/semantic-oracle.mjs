import assert from "node:assert/strict";

// Independent finite-producer oracle, not a terminal parser. Valid only for the
// canonical 500-record producer at its admitted nonwrapping geometry.
export function expectedVisibleLines(rows) {
  assert(Number.isSafeInteger(rows) && rows >= 2 && rows <= 31);
  return [
    ...Array.from({ length: 500 }, (_, i) => `REC_${String(i).padStart(4, "0")}`),
    "COLOR 界é",
    "DONE_C4",
  ].slice(-rows);
}

function rowText(row) {
  return row.cells
    .map((cell) => (cell.width === 0 ? "" : cell.grapheme || " "))
    .join("")
    .trimEnd();
}

export function verifyStockSemanticSnapshot(snapshot, stock) {
  assert.equal(stock.cols, 118, "Last admitted owning-PTY width");
  assert(["off", "top", "bottom"].includes(stock.border));
  const rows = 30 - (stock.border === "off" ? 0 : 1);
  // shapes[19] = [118, 30]; pane header consumes one row when enabled.
  assert.equal(stock.rows, rows);
  assert.equal(snapshot.cols, stock.cols);
  assert.equal(snapshot.rows, rows);
  assert.equal(snapshot.grid.length, rows);
  const lines = expectedVisibleLines(rows);
  assert.deepEqual(snapshot.grid.map(rowText), lines);
  assert.deepEqual(
    stock.visibleLines.map((line) => line.trimEnd()),
    lines,
  );
  const allText = [...snapshot.history, ...snapshot.grid].map(rowText).join("\n");
  assert.deepEqual(
    allText.match(/REC_\d{4}/g),
    Array.from({ length: 500 }, (_, i) => `REC_${String(i).padStart(4, "0")}`),
  );
  assert(!allText.includes("ALT"), "Alternate screen must not leak into primary history");
  for (let y = 0; y < rows; y++) {
    const row = snapshot.grid[y];
    assert.equal(row.cells.length, stock.cols);
    assert.equal(row.wrapped, false, "Finite producer never wraps");
    const colored = y === rows - 2;
    const expected = colored
      ? [..."COLOR "]
          .map((grapheme) => [grapheme, 1])
          .concat([
            ["界", 2],
            ["", 0],
            ["é", 1],
          ])
      : [...lines[y]].map((grapheme) => [grapheme, 1]);
    for (let x = 0; x < expected.length; x++) {
      const cell = row.cells[x];
      assert.equal(cell.grapheme, expected[x][0]);
      assert.equal(cell.width, expected[x][1]);
      assert.deepEqual(
        cell.foreground,
        colored && x < 5 ? { kind: "indexed", index: 196 } : { kind: "default" },
      );
      assert.deepEqual(cell.background, { kind: "default" });
      assert.equal(cell.attributes, 0);
    }
    // Stock does not expose hidden backing cell metadata. Check visible blank
    // semantics, without inventing a color/attribute oracle for padding cells.
    for (const cell of row.cells.slice(expected.length)) {
      assert(["", " "].includes(cell.grapheme));
      assert.equal(cell.width, 1);
    }
  }
  assert.deepEqual([snapshot.cursor.x, snapshot.cursor.y], [7, rows - 1]);
  assert.deepEqual(stock.cursor, [7, rows - 1]);
  assert.equal(typeof stock.cursorVisible, "boolean");
  assert.equal(snapshot.cursor.hidden, !stock.cursorVisible);
  const requiredModes = [
    "alternateScreen",
    "applicationCursor",
    "applicationKeypad",
    "bracketedPaste",
    "insert",
    "origin",
    "wraparound",
    "mouseTracking",
  ];
  for (const key of requiredModes)
    assert.equal(typeof stock.modes[key], "boolean", `Missing stock mode: ${key}`);
  for (const [key, value] of Object.entries(stock.modes)) {
    assert([...requiredModes, "synchronizedOutput"].includes(key), `Unknown stock mode: ${key}`);
    assert.equal(typeof value, "boolean", `Unsupported mode format: ${key}`);
    assert.equal(snapshot.modes[key], value, `Mode ${key}`);
  }
  for (const key of ["bracketedPaste", "applicationCursor", "applicationKeypad"])
    assert.equal(stock.modes[key], true);
  assert.equal(stock.modes.alternateScreen, false);
  return { scope: "finite-producer-stock-visible-semantics", records: 500, cols: stock.cols, rows };
}
