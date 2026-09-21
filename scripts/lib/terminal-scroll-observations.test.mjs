import assert from "node:assert/strict";
import test from "node:test";
import { TerminalScrollObservations } from "./terminal-scroll-observations.mjs";

const cell = (grapheme, fg = "white") => ({ grapheme, fg });
const snapshot = (lines) => ({
  grid: lines.map((line) => ({ cells: [...line].map((char) => cell(char)) })),
});
const options = {
  scrollRect: { x: 1, y: 1, width: 4, height: 2 },
  readRowIndex: (cells) => {
    const match = /^R(\d{3})$/.exec(cells.map((cell) => cell.grapheme).join(""));
    return match ? Number(match[1]) : null;
  },
};
const screen = (a, b) => snapshot(["header", `|R${a}`, `|R${b}`]);

test("retains transient mixed rows and styled static damage after recovery", () => {
  const analyzer = new TerminalScrollObservations({
    ...options,
    staticCells: [{ x: 0, y: 0, cell: cell("h") }],
  });
  analyzer.observe(0, screen("010", "011"));
  const damaged = screen("005", "011");
  damaged.grid[0].cells[0].fg = "red";
  analyzer.observe(2, damaged);
  analyzer.observe(7, screen("005", "006"));
  const report = analyzer.close(10);
  assert.equal(report.mixedDurationMs, 5);
  assert.equal(report.longestIncoherentIntervalMs, 5);
  assert.equal(report.staticViolationDurationMs, 5);
  assert.equal(report.staticViolationObservationCount, 1);
  assert.equal(report.final.classification, "coherent");
  assert.deepEqual(report.observations[1].staticViolations, [{ x: 0, y: 0 }]);
});

test("ignores misleading markers outside the exact rectangle and rejects absent rows", () => {
  const analyzer = new TerminalScrollObservations(options);
  const value = snapshot(["R001R002", "|xxxxR001", "|R002R003"]);
  assert.equal(analyzer.observe(0, value).classification, "missing");
  assert.equal(analyzer.observe(1, { grid: [] }).classification, "missing");
  const report = analyzer.close(4);
  assert.equal(report.missingDurationMs, 4);
  assert.equal(report.longestIncoherentIntervalMs, 4);
});

test("enforces monotonic finite timestamps and single final close", () => {
  const analyzer = new TerminalScrollObservations(options);
  analyzer.observe(2, screen("010", "011"));
  for (const at of [1, -1, NaN, Infinity])
    assert.throws(() => analyzer.observe(at, screen("010", "011")), RangeError);
  assert.throws(() => analyzer.close(1), RangeError);
  analyzer.observe(2, screen("005", "006"));
  analyzer.close(3);
  assert.throws(() => analyzer.observe(4, screen("005", "006")), /already closed/);
  assert.throws(() => analyzer.close(4), /already closed/);
});

test("weights the final state through close and combines mixed/missing intervals", () => {
  const analyzer = new TerminalScrollObservations(options);
  analyzer.observe(10, screen("010", "015"));
  analyzer.observe(12, screen("xxx", "015"));
  const report = analyzer.close(20);
  assert.equal(report.mixedDurationMs, 2);
  assert.equal(report.missingDurationMs, 8);
  assert.equal(report.incoherentDurationMs, 10);
  assert.deepEqual(report.incoherentIntervals, [{ startAt: 10, endAt: 20, durationMs: 10 }]);
});

test("caller excludes dynamic cells and baseline values are captured before mutation", () => {
  const baselineCell = cell("h");
  const analyzer = new TerminalScrollObservations({
    ...options,
    staticCells: [{ x: 0, y: 0, cell: baselineCell }],
  });
  baselineCell.fg = "red";
  const value = screen("010", "011");
  value.grid[0].cells[1] = cell("9", "green");
  assert.deepEqual(analyzer.observe(0, value).staticViolations, []);
  assert.equal(analyzer.close(1).staticViolationDurationMs, 0);
});
