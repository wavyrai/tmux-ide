import assert from "node:assert/strict";
import { parentPort, workerData } from "node:worker_threads";
import { loadGhosttyVtProof } from "../load.mjs";

const loaded = loadGhosttyVtProof(workerData.addonPath);
assert.equal(loaded.status, "loaded", loaded.error);
const { GhosttyVtProofTerminal, liveHandles } = loaded.binding;
assert.equal(liveHandles(), 0);
let terminal = new GhosttyVtProofTerminal(20, 5, 100);
assert.equal(liveHandles(), 1);
terminal.write(new TextEncoder().encode(`worker-${workerData.index}`));
assert.equal(terminal.project().kind, "seed");
if (workerData.mode === "leak-exit") {
  globalThis.intentionalLeakUntilEnvironmentCleanup = terminal;
  parentPort.postMessage({ ok: true, index: workerData.index, mode: workerData.mode });
} else if (workerData.mode === "gc") {
  terminal = null;
  for (let attempt = 0; attempt < 40 && liveHandles() !== 0; attempt += 1) {
    global.gc();
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(liveHandles(), 0);
  parentPort.postMessage({ ok: true, index: workerData.index, mode: workerData.mode });
} else {
  terminal.dispose();
  assert.equal(liveHandles(), 0);
  parentPort.postMessage({ ok: true, index: workerData.index, mode: "explicit" });
}
