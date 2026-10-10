import { test } from "node:test";
import assert from "node:assert/strict";
import { visualScreen } from "./native-visual-screen.mjs";
test("specimen keeps Unicode, colored blanks, wrap and cursor explicit at multiple sizes", () => {
  for (const [cols, rows] of [
    [64, 20],
    [80, 24],
    [132, 40],
  ]) {
    const { bytes, expected } = visualScreen(cols, rows);
    assert.ok(bytes.includes("e\u0301 A\u030a"));
    assert.ok(bytes.includes("界語") && bytes.includes("😀 🚀"));
    assert.ok(bytes.includes("WRAP>" + "w".repeat(cols - 5) + "WRAP_END"));
    assert.ok(bytes.includes("\x1b[48;2;192;32;160m        \x1b[0m"));
    assert.ok(bytes.endsWith("\x1b[17;9H\x1b[?25h"));
    assert.deepEqual(expected.cursor, { x: 8, y: 16, visible: true });
    assert.ok(Buffer.byteLength(bytes) < 8192);
    assert.match(expected.visualVerdict, /unassessed/);
  }
});
test("unsupported geometry fails instead of silently clipping the specimen", () => {
  for (const [cols, rows] of [
    [63, 20],
    [80, 19],
    [513, 24],
    [80, 257],
    [NaN, 24],
    [80.5, 24],
  ])
    assert.throws(() => visualScreen(cols, rows), /requires/);
});
