import assert from "node:assert/strict";

export const MODE_FORMATS = Object.freeze({
  alternateScreen: "alternate_on",
  applicationCursor: "keypad_cursor_flag",
  applicationKeypad: "keypad_flag",
  bracketedPaste: "bracket_paste_flag",
  insert: "insert_flag",
  origin: "origin_flag",
  wraparound: "wrap_flag",
  mouseTracking: "mouse_any_flag",
  synchronizedOutput: "synchronized_output_flag",
});

// Caller supplies the already admitted, generation-fenced private-server runner.
// This module never creates or selects a server and does not infer capabilities.
export function collectStockOracle(run, pane) {
  assert.match(pane, /^%[0-9]+$/);
  const display = (formats) =>
    run("display-message", "-p", "-t", pane, formats.map((k) => `#{${k}}`).join("|"))
      .replace(/\r?\n$/, "")
      .split("|");
  const geometry = display([
    "window_width",
    "window_height",
    "pane_width",
    "pane_height",
    "pane-border-status",
    "status",
    "cursor_x",
    "cursor_y",
    "cursor_flag",
  ]);
  assert.equal(geometry.length, 9);
  const integer = (value) => {
    assert.match(value, /^(0|[1-9][0-9]*)$/);
    const n = Number(value);
    assert(Number.isSafeInteger(n));
    return n;
  };
  const bool = (value) => {
    assert(["0", "1"].includes(value), "Missing or invalid stock boolean format");
    return value === "1";
  };
  const [windowCols, windowRows, cols, rows] = geometry.slice(0, 4).map(integer);
  assert.equal(windowCols, 118);
  assert.equal(windowRows, 30);
  assert.equal(cols, windowCols);
  const border = geometry[4];
  assert(["off", "top", "bottom"].includes(border));
  assert.equal(rows, windowRows - (border === "off" ? 0 : 1));
  assert.equal(geometry[5], "off");
  const values = display(Object.values(MODE_FORMATS));
  assert.equal(values.length, Object.keys(MODE_FORMATS).length);
  const modes = {},
    unavailableFormats = [];
  Object.keys(MODE_FORMATS).forEach((key, i) => {
    if (key === "synchronizedOutput" && values[i] === "")
      unavailableFormats.push(MODE_FORMATS[key]);
    else modes[key] = bool(values[i]);
  });
  const rawVisible = run("capture-pane", "-p", "-N", "-t", pane);
  assert(rawVisible.endsWith("\n"), "Incomplete capture output");
  const visibleLines = rawVisible.slice(0, -1).split("\n");
  assert.equal(visibleLines.length, rows);
  const ansiCapture = run("capture-pane", "-p", "-e", "-N", "-t", pane);
  return {
    stock: {
      cols,
      rows,
      border,
      cursor: geometry.slice(6, 8).map(integer),
      cursorVisible: bool(geometry[8]),
      modes,
      visibleLines,
    },
    evidence: { windowCols, windowRows, rawVisible, ansiCapture, unavailableFormats },
  };
}
