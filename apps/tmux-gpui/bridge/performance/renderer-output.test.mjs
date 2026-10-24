import { test } from "node:test";
import assert from "node:assert/strict";
import { OUTPUT_BYTES, outputChunks, writeOutput } from "./renderer-output.mjs";
import { outputMarker, RendererProbe } from "./renderer-probe.mjs";
const nonce = "c".repeat(32);
test("output workload has exact byte count and final-only completion marker", () => {
  const chunks = [...outputChunks(nonce)],
    final = chunks.pop();
  assert.equal(
    chunks.reduce((n, c) => n + Buffer.byteLength(c), 0),
    OUTPUT_BYTES,
  );
  assert.ok(chunks.every((c) => c.length === 8192 && !c.includes(outputMarker(nonce))));
  assert.equal(chunks.join("").split("\r\n").length - 1, 16384);
  assert.equal(final, `\x1b[H\x1b[2K${outputMarker(nonce)}`);
  assert.throws(() => [...outputChunks("invalid")]);
});
test("backpressure cannot let the final marker overtake the burst", async () => {
  let release,
    writes = 0;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const work = writeOutput(nonce, async () => {
    writes++;
    if (writes === 1) await held;
  });
  await Promise.resolve();
  assert.equal(writes, 1);
  release();
  await work;
  assert.equal(writes, 257);
  let attempted = 0;
  await assert.rejects(
    writeOutput(nonce, async () => {
      attempted++;
      throw Error("sink failed");
    }),
  );
  assert.equal(attempted, 1);
});
test("output receipt requires final marker in the unchanged visible scope", () => {
  const p = new RendererProbe();
  const scope = {
    pane: "p",
    generation: "g",
    incarnation: "i",
    request: 1,
    cols: 110,
    rows: 3,
    viewportOffset: 0,
  };
  assert(
    p.arm({ id: "output-0-gui", nonce, kind: "output", scope, atMicros: 10, markerAbsent: true }),
  );
  const witness = { scope, row: 0, column: 0, writtenRows: [0], atMicros: 100 };
  assert(!p.witness({ ...witness, text: `PROBE-BURST:${nonce}:16383` }));
  assert(p.witness({ ...witness, text: outputMarker(nonce) }));
  assert.equal(p.drain()[0].kind, "output");
});
