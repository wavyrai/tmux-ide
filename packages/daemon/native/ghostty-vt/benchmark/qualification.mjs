import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import headless from "@xterm/headless";
import unicode11 from "@xterm/addon-unicode11";
import { loadGhosttyVtProof } from "../load.mjs";

const { Terminal } = headless;
const { Unicode11Addon } = unicode11;
const addonPath = resolve(process.argv[2]);
const loaded = loadGhosttyVtProof(addonPath);
if (loaded.status !== "loaded") throw new Error(loaded.error);
const encoder = new TextEncoder();

function memory() {
  global.gc?.();
  return process.memoryUsage().rss;
}

function distribution(samples) {
  samples.sort((left, right) => left - right);
  const at = (percentile) =>
    samples[Math.min(samples.length - 1, Math.floor(samples.length * percentile))];
  return { p50Ms: at(0.5), p95Ms: at(0.95), p99Ms: at(0.99), maxMs: samples.at(-1) };
}

async function nativeScenario(cols, rows, history, seedLines) {
  const before = memory();
  const terminal = new loaded.binding.GhosttyVtProofTerminal(cols, rows, history);
  if (seedLines > 0)
    terminal.write(
      encoder.encode(Array.from({ length: seedLines }, (_, index) => `N${index}\r\n`).join("")),
    );
  const seedStart = performance.now();
  terminal.project();
  const seedMs = performance.now() - seedStart;
  const samples = [];
  let lastStats;
  for (let index = 0; index < 100; index += 1) {
    const start = performance.now();
    terminal.write(encoder.encode(`n${index}\r\n`));
    const projection = terminal.project();
    lastStats = projection.stats;
    samples.push(performance.now() - start);
  }
  const peak = memory();
  terminal.dispose();
  assert.equal(loaded.binding.liveHandles(), 0);
  return { seedMs, delta: distribution(samples), rssDeltaBytes: peak - before, lastStats };
}

function writeXterm(terminal, value) {
  return new Promise((resolveWrite) => terminal.write(value, resolveWrite));
}

function walkXterm(terminal, full) {
  const buffer = terminal.buffer.active;
  const start = full ? 0 : buffer.viewportY;
  const end = buffer.viewportY + terminal.rows;
  const cell = buffer.getNullCell();
  let cellsRead = 0;
  for (let row = start; row < end; row += 1) {
    const line = buffer.getLine(row);
    for (let column = 0; column < terminal.cols; column += 1) {
      line?.getCell(column, cell);
      cell.getChars();
      cell.getWidth();
      cell.getFgColor();
      cell.getBgColor();
      cellsRead += 1;
    }
  }
  return { cellsRead, historyRowsRead: full ? buffer.viewportY : 0 };
}

async function xtermScenario(cols, rows, history, seedLines) {
  const before = memory();
  const terminal = new Terminal({ cols, rows, scrollback: history, allowProposedApi: true });
  terminal.loadAddon(new Unicode11Addon());
  terminal.unicode.activeVersion = "11";
  if (seedLines > 0)
    await writeXterm(
      terminal,
      Array.from({ length: seedLines }, (_, index) => `X${index}\r\n`).join(""),
    );
  const seedStart = performance.now();
  walkXterm(terminal, true);
  const seedMs = performance.now() - seedStart;
  const samples = [];
  let lastStats;
  for (let index = 0; index < 100; index += 1) {
    const start = performance.now();
    await writeXterm(terminal, `x${index}\r\n`);
    lastStats = walkXterm(terminal, false);
    samples.push(performance.now() - start);
  }
  const peak = memory();
  terminal.dispose();
  return { seedMs, delta: distribution(samples), rssDeltaBytes: peak - before, lastStats };
}

const scenarios = {
  maxGeometry: { cols: 512, rows: 256, history: 5000, seedLines: 0 },
  cap5000: { cols: 80, rows: 24, history: 5000, seedLines: 5024 },
};
const output = {};
for (const [name, scenario] of Object.entries(scenarios)) {
  output[name] = {
    dimensions: scenario,
    native: await nativeScenario(
      scenario.cols,
      scenario.rows,
      scenario.history,
      scenario.seedLines,
    ),
    xterm: await xtermScenario(scenario.cols, scenario.rows, scenario.history, scenario.seedLines),
  };
}

assert.equal(output.cap5000.native.lastStats.historyRowsRead, 1);
console.log(JSON.stringify(output));
