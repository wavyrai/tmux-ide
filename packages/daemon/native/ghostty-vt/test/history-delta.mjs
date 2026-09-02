import assert from "node:assert/strict";
import { resolve } from "node:path";
import { loadGhosttyVtProof } from "../load.mjs";

const addonPath = resolve(process.argv[2]);
const loaded = loadGhosttyVtProof(addonPath);
assert.equal(loaded.status, "loaded", loaded.error);
const { GhosttyVtProofTerminal } = loaded.binding;
const encoder = new TextEncoder();
const lines = (start, count) =>
  encoder.encode(
    Array.from(
      { length: count },
      (_, offset) => `L${String(start + offset).padStart(5, "0")}\r\n`,
    ).join(""),
  );

for (const cap of [0, 100, 500, 5000]) {
  const terminal = new GhosttyVtProofTerminal(8, 2, cap);
  const seed = terminal.project();
  assert.equal(seed.historyAppend.length, 0);

  terminal.write(lines(0, 5));
  let delta = terminal.project();
  assert.equal(delta.kind, "delta");
  assert.equal(delta.historyAppend.length, cap === 0 ? 0 : 4);
  assert.equal(delta.historyTrim, 0);

  terminal.write(lines(5, 7000));
  delta = terminal.project();
  assert.equal(delta.historyAppend.length, cap);
  assert.equal(delta.historyTrim, cap === 0 ? 0 : 4);
  if (cap > 0) {
    assert.equal(
      delta.historyAppend[0].cells
        .slice(0, 6)
        .map((cell) => cell.grapheme)
        .join(""),
      `L${String(7004 - cap).padStart(5, "0")}`,
    );
  }

  terminal.write(lines(7005, 10));
  delta = terminal.project();
  assert.equal(delta.historyAppend.length, cap === 0 ? 0 : 10);
  assert.equal(delta.historyTrim, cap === 0 ? 0 : 10);
  assert.equal(delta.stats.historyRowsRead, cap === 0 ? 0 : 10);

  terminal.write(lines(7015, 1));
  delta = terminal.project();
  assert.equal(delta.historyAppend.length, cap === 0 ? 0 : 1);
  assert.equal(delta.historyTrim, cap === 0 ? 0 : 1);
  assert.equal(delta.stats.historyRowsRead, cap === 0 ? 0 : 1);
  terminal.dispose();
}

console.log(JSON.stringify({ ok: true, caps: [0, 100, 500, 5000], multiLineScroll: true }));
