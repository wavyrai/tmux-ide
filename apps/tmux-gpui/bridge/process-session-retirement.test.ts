import { test } from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { createProcessSessionRetirement } from "./process-session-retirement.ts";

test("retirement revokes immediately then flushes pending final state through repeated backpressure", async () => {
  const chunks: string[] = [];
  const writes: (() => void)[] = [];
  const events: string[] = [];
  const output = new Writable({
    highWaterMark: 1,
    write(chunk, _encoding, done) {
      chunks.push(String(chunk));
      writes.push(done);
    },
  });
  let blocked = !output.write("old");
  let pending = "";
  // Same ordering as live.ts: its queue listener runs before retirement's drain listener.
  output.on("drain", () => {
    blocked = false;
    if (pending) {
      const value = pending;
      pending = "";
      blocked = !output.write(value);
    }
  });
  const session = createProcessSessionRetirement({
    output,
    blocked: () => blocked,
    unavailable: () => {
      pending = "unavailable";
      events.push("unavailable");
    },
    revoke: () => {
      events.push("revoke");
    },
    close: () => {
      events.push("close");
    },
    failed: () => assert.fail("unexpected failure"),
  });
  const done = session.dispose();
  assert.deepEqual(events, ["revoke", "unavailable"]);
  await new Promise((resolve) => setImmediate(resolve));
  writes.shift()!();
  assert.deepEqual(chunks, ["old", "unavailable"]);
  assert.equal(output.writableEnded, false);
  writes.shift()!();
  await done;
  assert.equal(output.writableFinished, true);
  assert.deepEqual(events, ["revoke", "unavailable", "close"]);
  assert.equal(output.listenerCount("drain"), 1);
  assert.equal(output.listenerCount("error"), 0);
});
test("stalled output cannot retain authority or resources indefinitely", async () => {
  const events: string[] = [];
  const output = new Writable({ write() {} });
  output.write("stuck");
  const session = createProcessSessionRetirement({
    output,
    blocked: () => true,
    unavailable: () => events.push("unavailable"),
    revoke: () => events.push("revoke"),
    close: () => events.push("close"),
    failed: () => events.push("failed"),
    timeoutMs: 15,
  });
  const result = await session.dispose();
  assert.equal(result.timedOut, true);
  assert.equal(output.destroyed, true);
  assert.deepEqual(events, ["revoke", "unavailable", "close", "failed"]);
  assert.equal(output.listenerCount("drain"), 0);
  assert.equal(output.listenerCount("error"), 0);
});
test("output error cancels drain and runs full cleanup once", async () => {
  const events: string[] = [];
  const output = new Writable({ write() {} });
  const session = createProcessSessionRetirement({
    output,
    blocked: () => true,
    unavailable: () => {},
    revoke: () => events.push("revoke"),
    close: () => events.push("close"),
    failed: () => events.push("failed"),
  });
  const done = session.dispose("output-failed");
  await new Promise((resolve) => setImmediate(resolve));
  output.emit("error", Error("EPIPE"));
  const result = await done;
  assert.equal(result.reason, "output-failed");
  assert.ok(result.failures.includes("drain"));
  assert.deepEqual(events, ["revoke", "close", "failed"]);
  assert.equal(output.listenerCount("drain"), 0);
});
