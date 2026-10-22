import { test } from "node:test";
import assert from "node:assert/strict";
import { createHostedPublicationMailbox } from "./hosted-publication-mailbox.ts";
import type { HostedLiveEvent } from "./hosted-live-types.ts";
import { blankTerminalReplicaSnapshot } from "../../../packages/core/src/terminal-replica.ts";
import { createHostedSurfaceValidator, validateHostedImage } from "./hosted-publication.ts";
const frame = (sequence: number, inputReady = true): HostedLiveEvent => ({
  connection: "c",
  sequence,
  snapshot: null,
  inputReady,
});
const image = (bytes: number): HostedLiveEvent => ({
  rawKittyImage: {
    metadata: {
      digest: "a".repeat(32),
      format: "rgba",
      width: 1,
      height: 1,
      total: bytes,
      offset: 0,
    },
    bytes: new Uint8Array(bytes),
  },
});
test("typed next-turn boundary rejects ready reentrancy; latest unavailable wins before drain", async () => {
  const events: HostedLiveEvent[] = [];
  const mailbox = createHostedPublicationMailbox({
    deliver: (event) => {
      events.push(event);
    },
    failed: () => assert.fail(),
  });
  mailbox.emit(frame(1));
  mailbox.emit(frame(2, false));
  assert.equal(events.length, 0, "no callback can reenable native input in the sending batch");
  await mailbox.drain(new AbortController().signal);
  assert.deepEqual(events, [frame(2, false)]);
  mailbox.close();
});
test("bounded ordered images precede dependent latest state and preserve byte identity", async () => {
  const events: HostedLiveEvent[] = [];
  const mailbox = createHostedPublicationMailbox({
    deliver: (event) => {
      events.push(event);
    },
    failed: () => assert.fail(),
    maxOrderedBytes: 8,
    maxOrderedEntries: 2,
  });
  const a = image(4),
    b = image(4),
    state = frame(1);
  assert.equal(mailbox.emit(a), true);
  mailbox.emit(state);
  assert.equal(mailbox.emit(b), true);
  assert.equal(mailbox.emit(image(1)), false);
  await mailbox.drain(new AbortController().signal);
  assert.deepEqual(events, [a, b, state]);
  assert.equal(events[0], a);
  mailbox.close();
});
test("handoff control follows its preceding state; final unavailable remains last", async () => {
  const events: HostedLiveEvent[] = [];
  const mailbox = createHostedPublicationMailbox({
    deliver: (event) => {
      events.push(event);
    },
    failed: () => assert.fail(),
  });
  const before = frame(1, false),
    receipt: HostedLiveEvent = {
      kind: "history-handoff",
      intent: "intent",
      state: "live",
      token: null,
    },
    final = frame(2, false);
  mailbox.emit(before);
  mailbox.emit(receipt);
  mailbox.emit(final);
  await mailbox.drain(new AbortController().signal);
  mailbox.close();
  assert.deepEqual(events, [before, receipt, final]);
});
test("cancel before dispatch releases queued state and wakes drain; receiver throw is contained", async () => {
  let calls = 0;
  const mailbox = createHostedPublicationMailbox({
    deliver: () => {
      calls++;
    },
    failed: () => assert.fail(),
  });
  mailbox.emit(frame(1));
  const controller = new AbortController();
  const drain = assert.rejects(mailbox.drain(controller.signal), /aborted/);
  controller.abort();
  await drain;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 0);
  let failures = 0;
  const fault = createHostedPublicationMailbox({
    deliver: () => {
      throw Error("renderer");
    },
    failed: () => {
      failures++;
    },
  });
  fault.emit(frame(1));
  await assert.rejects(fault.drain(new AbortController().signal), /closed/);
  assert.equal(failures, 1);
  assert.equal(fault.emit(frame(2)), false);
});
test("typed validation preserves immutable snapshot and row identity but rejects malformed data", () => {
  const validate = createHostedSurfaceValidator(),
    snapshot = blankTerminalReplicaSnapshot(4, 2);
  const [surface] = validate([{ paneId: "pane", snapshot }]);
  assert.equal(surface.snapshot, snapshot);
  assert.equal(surface.snapshot.grid[0], snapshot.grid[0]);
  assert.throws(() => validate([{ paneId: "pane", snapshot: { ...snapshot, modes: {} } }]));
  assert.throws(
    () => validate([{ paneId: "pane", snapshot: { ...snapshot, cols: 65536 } }]),
    /bounds/,
  );
  assert.throws(
    () =>
      validateHostedImage({
        metadata: {
          digest: "a".repeat(32),
          format: "rgba",
          width: 1,
          height: 1,
          total: 4,
          offset: 3,
        },
        bytes: new Uint8Array(4),
      }),
    /Invalid/,
  );
});
test("hosted terminal delivery never serializes grid or cell arrays", async () => {
  const base = blankTerminalReplicaSnapshot(4, 2);
  const snapshot = { ...base, grid: base.grid.map((row) => ({ ...row, cells: [...row.cells] })) };
  Object.defineProperty(snapshot.grid, "toJSON", {
    value: () => assert.fail("grid serialization"),
  });
  for (const row of snapshot.grid)
    Object.defineProperty(row.cells, "toJSON", { value: () => assert.fail("cell serialization") });
  const validate = createHostedSurfaceValidator();
  let delivered = false;
  const mailbox = createHostedPublicationMailbox({
    deliver: (event) => {
      assert.ok("connection" in event);
      const surfaces = validate(event.surfaces);
      assert.equal(surfaces[0].snapshot, snapshot);
      delivered = true;
    },
    failed: () => assert.fail("delivery failed"),
  });
  mailbox.emit({
    connection: "c",
    sequence: 1,
    snapshot,
    surfaces: [{ paneId: "pane", snapshot }],
  });
  await mailbox.drain(new AbortController().signal);
  assert.equal(delivered, true);
  mailbox.close();
});
