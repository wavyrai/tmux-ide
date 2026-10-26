/** Codec-only qualification. No socket, SSH, GUI paint or display latency. */
import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import { performance } from "node:perf_hooks";
import { strict as assert } from "node:assert";
import {
  encodeTerminalGraphicsBinary,
  decodeTerminalGraphicsBinary,
  decodeTerminalGraphicsCompressed,
} from "../../../../packages/contracts/src/index.ts";
import { compressGraphicsChunk } from "../../../../packages/daemon/src/terminal/graphics/compress-chunk.ts";
const size = 512 * 1024;
const text = Buffer.alloc(size, 255);
for (let y = 0; y < 512; y++)
  for (let x = 0; x < 256; x++) {
    if (y % 16 < 10 && x % 8 < 5 && (x + y) % 7)
      text.fill(32, (y * 256 + x) * 4, (y * 256 + x) * 4 + 3);
  }
const noise = Buffer.alloc(size);
let seed = 123456789;
for (let i = 0; i < noise.length; i++) {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  noise[i] = seed & 255;
}
const report: object[] = [];
for (const [name, raw] of [
  ["text-pattern", text],
  ["deterministic-noise", noise],
] as const) {
  const header = {
    pane: "pane.one",
    blob: {
      digest: createHash("sha256").update(raw).digest("hex").slice(0, 32),
      format: "rgba" as const,
      width: 256,
      height: 512,
      total: raw.length,
      offset: 0,
    },
  };
  // Warm both paths once; exclude warmup from the interleaved five pairs.
  encodeTerminalGraphicsBinary(header, raw);
  await compressGraphicsChunk(header, raw);
  const samples: object[] = [];
  for (let i = 0; i < 5; i++)
    for (const compress of i % 2 ? [true, false] : [false, true]) {
      const started = performance.now();
      const candidate = compress ? await compressGraphicsChunk(header, raw) : null;
      const frame = candidate ?? encodeTerminalGraphicsBinary(header, raw);
      const encoded = performance.now();
      const decoded = candidate
        ? inflateSync(decodeTerminalGraphicsCompressed(frame).bytes)
        : decodeTerminalGraphicsBinary(frame).bytes;
      const ended = performance.now();
      assert.deepEqual(Buffer.from(decoded), raw);
      samples.push({
        compress,
        compressed: !!candidate,
        wireBytes: frame.length,
        encodeMs: encoded - started,
        decodeMs: ended - encoded,
      });
    }
  report.push({ name, rawBytes: raw.length, samples });
}
console.log(
  JSON.stringify(
    {
      scope: "codec only; synthetic 256x512 RGBA chunks; no SSH/GUI timing",
      node: process.version,
      report,
    },
    null,
    2,
  ),
);
