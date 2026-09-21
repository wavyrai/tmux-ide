import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { createFinitePressureWriter } from "./owned-ssh-pressure.mjs";

test("paused reader stops a finite producer before exhaustion and resumption drains exactly its cap", async () => {
  const stream = new PassThrough({ highWaterMark: 1024 });
  const writer = createFinitePressureWriter(stream, { chunkBytes: 1024, limitBytes: 8192 });
  try {
    const before = writer.snapshot();
    await delay(20);
    assert.equal(writer.snapshot().acceptedBytes, before.acceptedBytes);
    assert.equal(before.blocked, true);
    assert.equal(before.exhausted, false);
    assert(before.queuePeakBytes <= 1024);
    let read = 0;
    stream.on("data", (chunk) => {
      read += chunk.length;
    });
    await Promise.race([
      writer.closed,
      delay(1000).then(() => {
        throw Error("Writer deadline");
      }),
    ]);
    assert.equal(read, 8192);
    assert.equal(writer.snapshot().acceptedBytes, 8192);
    assert.equal(writer.snapshot().queuedBytes, 0);
    assert.equal(stream.listenerCount("drain"), 0);
  } finally {
    writer.dispose();
  }
});

test("cancelling a blocked writer releases its drain ownership without producing more", async () => {
  const stream = new PassThrough({ highWaterMark: 1024 });
  const writer = createFinitePressureWriter(stream, { chunkBytes: 1024, limitBytes: 8192 });
  const before = writer.snapshot().acceptedBytes;
  writer.dispose();
  await writer.closed;
  stream.emit("drain");
  assert.equal(writer.snapshot().acceptedBytes, before);
  assert.equal(writer.snapshot().retired, true);
  assert.equal(stream.listenerCount("drain"), 0);
});

test("refuses unbounded or ambiguous producer allocations before writing", () => {
  for (const options of [
    { chunkBytes: 0 },
    { limitBytes: Infinity },
    { limitBytes: 1e9 },
    { chunkBytes: 3, limitBytes: 10 },
  ]) {
    const stream = new PassThrough();
    assert.throws(
      () => createFinitePressureWriter(stream, options),
      /Invalid fixture pressure bound/,
    );
    assert.equal(stream.writableLength, 0);
    stream.destroy();
  }
});
