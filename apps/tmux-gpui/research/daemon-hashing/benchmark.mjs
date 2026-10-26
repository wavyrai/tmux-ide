import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
if (process.argv.length !== 4)
  throw Error("Usage: node --import tsx benchmark.mjs BASELINE_MODULE OUTPUT_JSON");
const before = await import(pathToFileURL(resolve(process.argv[2])).href);
import * as after from "../../../../packages/core/src/terminal-replica.ts";
import { performance } from "node:perf_hooks";
import { writeFileSync } from "node:fs";
const results = [];
for (const [rows, damage] of [
  [70, 1],
  [1000, 1],
  [70, 70],
]) {
  const initial = after.blankTerminalReplicaSnapshot(250, rows);
  const variants = Array.from({ length: 32 }, (_, n) => ({
    wrapped: false,
    cells: initial.grid[0].cells.map((c, i) => ({
      ...c,
      grapheme: i === 0 ? String.fromCharCode(65 + n) : " ",
    })),
  }));
  const patches = variants.map((row) => ({
    rows: Array.from({ length: damage }, (_, index) => ({ index, row })),
  }));
  function run(api, iterations) {
    let state = api.blankTerminalReplicaSnapshot(250, rows);
    api.hashTerminalReplicaSnapshot(state);
    const start = performance.now();
    let hash = "";
    for (let i = 0; i < iterations; i++) {
      state = api.applyTerminalReplicaPatch(state, patches[i % patches.length]);
      hash = api.hashTerminalReplicaSnapshot(state);
    }
    return { ms: performance.now() - start, hash };
  }
  run(before, 128);
  run(after, 128);
  const samples = [];
  for (let sample = 0; sample < 5; sample++) {
    const pair = {};
    for (const label of sample % 2 ? ["after", "before"] : ["before", "after"])
      pair[label] = run(label === "before" ? before : after, 500);
    if (pair.before.hash !== pair.after.hash) throw Error("digest mismatch");
    samples.push(pair);
  }
  results.push({ rows, cols: 250, damage, iterations: 500, samples });
}
writeFileSync(process.argv[3], JSON.stringify(results, null, 2) + "\n");
console.log(JSON.stringify(results));
