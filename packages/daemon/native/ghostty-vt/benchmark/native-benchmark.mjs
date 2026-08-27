import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { loadGhosttyVtProof } from "../load.mjs";

const addonPath = resolve(
  process.argv[2] ?? new URL("../build/ghostty_vt_proof.node", import.meta.url).pathname,
);
const loaded = loadGhosttyVtProof(addonPath);
assert.equal(loaded.status, "loaded", loaded.error);
const { GhosttyVtProofTerminal, liveHandles } = loaded.binding;
const encoder = new TextEncoder();
const results = {};

for (const historyCap of [0, 100, 500]) {
  const terminal = new GhosttyVtProofTerminal(120, 40, historyCap);
  terminal.write(
    encoder.encode(Array.from({ length: 7000 }, (_, index) => `seed-${index}\r\n`).join("")),
  );
  terminal.project();
  const samples = [];
  for (let index = 0; index < 25; index += 1) {
    terminal.write(encoder.encode(`warm-${index}\r\n`));
    terminal.project();
  }
  for (let index = 0; index < 500; index += 1) {
    const start = performance.now();
    terminal.write(encoder.encode(`\x1b[3${index % 8}mline-${index}\x1b[0m\r\n`));
    const delta = terminal.project();
    assert.equal(delta.kind, "delta");
    samples.push(performance.now() - start);
  }
  samples.sort((left, right) => left - right);
  const percentile = (p) => samples[Math.min(samples.length - 1, Math.floor(samples.length * p))];
  results[historyCap] = {
    iterations: samples.length,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    p99Ms: percentile(0.99),
    maxMs: samples.at(-1),
  };
  terminal.dispose();
}

assert.equal(liveHandles(), 0);
console.log(JSON.stringify({ historyCaps: results }));
