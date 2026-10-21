import assert from "node:assert/strict";
import { test } from "node:test";
import { blankTerminalReplicaSnapshot } from "../../../packages/core/src/terminal-replica.ts";
import { createCompactDeltaStore } from "./compact-delta.ts";
import { createNativePublicationWriter } from "./native-publication.ts";
import { preparePublication } from "./prepared-publication.ts";
import type { RetainedSnapshotJson } from "./retained-frame-cache.ts";
const context = { identity: "source/layout/history", connection: "connection", request: 1 };
const frame = () => structuredClone(blankTerminalReplicaSnapshot(80, 24));
const publication = (
  snapshot: ReturnType<typeof frame> | null,
  ready = true,
  retained: RetainedSnapshotJson | null = null,
) =>
  preparePublication(
    { version: 1, connection: context.connection, request: context.request },
    { snapshot, inputReady: ready },
    retained,
  );

test("accepted false A, dropped pending B, then C use only the emitted baseline", () => {
  const lines: string[] = [];
  const writer = createNativePublicationWriter("rle-delta-v1", (line) => {
    lines.push(line);
    return false;
  });
  const a = frame(),
    b = frame(),
    c = frame();
  b.grid[0]!.cells[0]!.grapheme = "B";
  c.grid[1]!.cells[0]!.grapheme = "C";
  assert.equal(writer.write(publication(a), context), false);
  let pending = publication(b);
  assert.equal(pending.snapshot, b);
  pending = publication(c);
  writer.write(pending, context);
  const store = createCompactDeltaStore();
  const first = store.prepare(JSON.parse(lines[0]!).snapshot);
  first.commit();
  const wire = JSON.parse(lines[1]!).snapshot;
  assert.equal(wire.encoding, "rle-delta-v1");
  assert.equal(wire.baseSeq, 1);
  assert.equal(wire.seq, 2);
  assert.deepEqual(store.prepare(wire).snapshot, c);
  assert.equal(writer.lastAccepted?.seq, 2);
  assert.ok(Object.isFrozen(writer.lastAccepted));
});

test("metadata-only updates retain zero changed rows and full authority envelope", () => {
  const lines: string[] = [];
  const writer = createNativePublicationWriter("rle-delta-v1", (line) => {
    lines.push(line);
    return true;
  });
  const snapshot = frame();
  writer.write(publication(snapshot), context);
  writer.write(publication(snapshot, false), context);
  const wire = JSON.parse(lines[1]!);
  assert.equal(wire.inputReady, false);
  assert.deepEqual(wire.snapshot.changedRows, []);
});

for (const encoding of ["legacy", "rle-v1", "rle-delta-v1"] as const)
  test(`${encoding} null/Home and retained preview reset live baseline`, () => {
    const lines: string[] = [];
    const writer = createNativePublicationWriter(encoding, (line) => {
      lines.push(line);
      return true;
    });
    writer.write(publication(frame()), context);
    const previous = writer.lastAccepted?.epoch;
    const retained = JSON.stringify(frame()) as RetainedSnapshotJson;
    writer.write(publication(null, false, retained), context);
    assert.equal(writer.lastAccepted, null);
    const home = JSON.parse(lines[1]!);
    assert.equal(home.snapshot, null);
    assert.deepEqual(home.retainedPreview.snapshot, frame());
    assert.equal(home.retainedPreview.snapshot.encoding, undefined);
    writer.write(publication(frame()), context);
    const resumed = JSON.parse(lines[2]!).snapshot;
    if (encoding === "rle-delta-v1") {
      assert.equal(resumed.encoding, "rle-v1");
      assert.equal(resumed.seq, 1);
      assert.notEqual(resumed.epoch, previous);
    } else {
      assert.equal(resumed.encoding, encoding === "legacy" ? undefined : "rle-v1");
      assert.equal(resumed.epoch, undefined);
      assert.equal(writer.resync({ ...context, epoch: "x", baseSeq: 0 }, context), false);
    }
  });

for (const change of [{ identity: "other" }, { connection: "other" }, { request: 2 }])
  test(`context change ${Object.keys(change)[0]} establishes a full epoch`, () => {
    const lines: string[] = [];
    const writer = createNativePublicationWriter("rle-delta-v1", (line) => {
      lines.push(line);
      return true;
    });
    writer.write(publication(frame()), context);
    writer.write(publication(frame()), { ...context, ...change });
    const [a, b] = lines.map((line) => JSON.parse(line).snapshot);
    assert.equal(b.encoding, "rle-v1");
    assert.equal(b.seq, 1);
    assert.notEqual(a.epoch, b.epoch);
  });

test("resync validates last accepted proof, coalesces repeats and returns fresh epoch", () => {
  const lines: string[] = [];
  const writer = createNativePublicationWriter("rle-delta-v1", (line) => {
    lines.push(line);
    return true;
  });
  writer.write(publication(frame()), context);
  const command = {
    type: "frame-resync",
    connection: context.connection,
    request: context.request,
    epoch: writer.lastAccepted!.epoch,
    baseSeq: 0,
  };
  for (const changed of [
    { connection: "other" },
    { request: 2 },
    { epoch: "other" },
    { baseSeq: 2 },
    { baseSeq: -1 },
    { baseSeq: 0.5 },
    { baseSeq: Number.MAX_SAFE_INTEGER + 1 },
    { injected: true },
    { type: "other" },
  ])
    assert.equal(writer.resync({ ...command, ...changed }, context), false);
  for (const changed of [{ identity: "other" }, { connection: "other" }, { request: 2 }])
    assert.equal(writer.resync(command, { ...context, ...changed }), false);
  assert.equal(writer.resync(command, context), true);
  assert.equal(writer.resync(command, context), false);
  writer.write(publication(frame()), context);
  assert.notEqual(writer.lastAccepted!.epoch, command.epoch);
  assert.equal(writer.resync(command, context), false);
});

test("whole-envelope UTF-8 cap rejects before I/O without advancing baseline", () => {
  const lines: string[] = [];
  const snapshot = frame();
  const writer = createNativePublicationWriter(
    "rle-delta-v1",
    (line) => {
      lines.push(line);
      return true;
    },
    4000,
  );
  writer.write(publication(snapshot), context);
  const before = writer.lastAccepted;
  const huge = preparePublication({ version: 1, title: "🙂".repeat(1500) }, { snapshot }, null);
  assert.throws(() => writer.write(huge, context), /byte limit/);
  assert.equal(lines.length, 1);
  assert.equal(writer.lastAccepted, before);
  writer.write(publication(snapshot), context);
  assert.equal(JSON.parse(lines[1]!).snapshot.baseSeq, 1);
  assert.equal(writer.lastAccepted!.seq, 2);
});

test("thrown or asynchronous failed writes retire ownership permanently", () => {
  const writer = createNativePublicationWriter("rle-delta-v1", () => {
    throw new Error("EPIPE");
  });
  assert.throws(() => writer.write(publication(frame()), context), /EPIPE/);
  assert.equal(writer.lastAccepted, null);
  assert.throws(() => writer.write(publication(frame()), context), /retired/);
  assert.equal(writer.resync({}, context), false);
  const asyncWriter = createNativePublicationWriter("rle-delta-v1", () => false);
  asyncWriter.write(publication(frame()), context);
  asyncWriter.retire();
  assert.equal(asyncWriter.lastAccepted, null);
  assert.throws(() => asyncWriter.write(publication(frame()), context), /retired/);
});
