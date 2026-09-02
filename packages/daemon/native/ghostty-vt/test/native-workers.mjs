import assert from "node:assert/strict";
import { resolve } from "node:path";
import { Worker } from "node:worker_threads";

const addonPath = resolve(
  process.argv[2] ?? new URL("../build/ghostty_vt_proof.node", import.meta.url).pathname,
);
const fixture = new URL("./native-worker-fixture.mjs", import.meta.url);
async function runWorker(index, mode) {
  return await new Promise((resolveWorker, reject) => {
    const worker = new Worker(fixture, { workerData: { addonPath, index, mode } });
    let message;
    worker.once("message", (value) => {
      message = value;
    });
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (code !== 0) reject(new Error(`worker ${index} (${mode}) exited ${code}`));
      else if (message === undefined)
        reject(new Error(`worker ${index} (${mode}) exited without proof`));
      else resolveWorker(message);
    });
  });
}

const modes = ["explicit", "explicit", "gc", "gc", ...Array(8).fill("leak-exit")];
const results = await Promise.all(modes.map((mode, index) => runWorker(index, mode)));
assert.deepEqual(
  results.map(({ index }) => index).sort((a, b) => a - b),
  Array.from({ length: modes.length }, (_, index) => index),
);
console.log(JSON.stringify({ ok: true, workers: results.length, modes }));
