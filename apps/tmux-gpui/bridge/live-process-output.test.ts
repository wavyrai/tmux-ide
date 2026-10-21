import { test } from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { createLiveProcessOutput } from "./live-process-output.ts";
import { blankTerminalReplicaSnapshot } from "../../../packages/core/src/terminal-replica.ts";
import { createKittyGraphicsReceiver } from "./kitty-graphics.ts";
test("typed raw image callback bypasses string/base64 path and preserves exact bytes", () => {
  const bytes = new Uint8Array([0, 1, 2, 255]);
  const metadata = {
    digest: "a".repeat(32),
    format: "rgba" as const,
    width: 1,
    height: 1,
    total: 4,
    offset: 0,
  };
  let received: unknown;
  const receiver = createKittyGraphicsReceiver({
    known: [],
    request: () => {},
    emit: () => assert.fail("string serialization used"),
    emitChunk: (chunk) => {
      received = chunk;
    },
  });
  receiver.blob("pane", metadata, bytes);
  assert.deepEqual(received, { metadata, bytes });
  assert.equal((received as { bytes: Uint8Array }).bytes, bytes);
});
test("process fallback serializes typed snapshots and raw image bytes compatibly", async () => {
  let text = "";
  const output = new Writable({
    write(chunk, _encoding, done) {
      text += chunk.toString();
      done();
    },
  });
  const transport = createLiveProcessOutput(output, "legacy");
  const snapshot = blankTerminalReplicaSnapshot(4, 2);
  transport.emit({
    connection: "connection",
    sequence: 1,
    snapshot,
    surfaces: [{ paneId: "pane", snapshot }],
    inputReady: false,
  });
  transport.emit({
    rawKittyImage: {
      metadata: {
        digest: "a".repeat(32),
        format: "rgba",
        width: 1,
        height: 1,
        total: 4,
        offset: 0,
      },
      bytes: new Uint8Array([0, 1, 2, 255]),
    },
  });
  await transport.drain(new AbortController().signal);
  transport.close();
  const lines = text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(lines[0].snapshot, snapshot);
  assert.deepEqual(lines[0].surfaces, [{ paneId: "pane", snapshot }]);
  assert.equal(lines[0].inputReady, false);
  assert.deepEqual([...Buffer.from(lines[1].kittyImageChunk.data, "base64")], [0, 1, 2, 255]);
});
