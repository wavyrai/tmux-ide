import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  admitDaemonTrace,
  observeDaemonClose,
  awaitDaemonClose,
  captureDaemonTraceStart,
  stopOwnedDaemonWithTrace,
} from "./daemon-trace-admission.mjs";
const expected = { pid: 123, daemonInstanceId: "one" };
const close = {
  pid: 123,
  daemonInstanceId: "one",
  code: 0,
  signal: null,
  requestedWhileRunning: true,
};
function records() {
  return [
    {
      version: 1,
      type: "performance.stage",
      processId: "daemon:123",
      authority: null,
      traceId: null,
    },
    {
      version: 1,
      type: "performance.daemon-trace.summary",
      processId: "daemon:123",
      daemonInstanceId: "one",
      shutdownKind: "normal",
      failed: false,
      saturated: false,
      acceptedRecordsExcludeSummary: true,
      maxRecordBytes: 65536,
      offeredRecords: 1,
      acceptedRecords: 1,
      droppedRecords: 0,
      saturatedDrops: 0,
      failedDrops: 0,
      oversizedRecords: 0,
      constructionFailures: 0,
      rejectedWrites: 0,
      writeFailures: 0,
      writableLength: 10,
    },
  ];
}
const encode = (r) => Buffer.from(r.map((x) => JSON.stringify(x)).join("\n") + "\n");
test("exact headerless writer summary and observed successful close admit file integrity only", () => {
  assert.equal(admitDaemonTrace(encode(records()), expected, close).status, "complete");
  for (const bad of [
    { ...close, code: 1 },
    { ...close, signal: "SIGKILL" },
    { ...close, pid: 99 },
    { ...close, daemonInstanceId: "old" },
    { ...close, requestedWhileRunning: false },
    null,
  ])
    assert.equal(admitDaemonTrace(encode(records()), expected, bad).status, "incomplete");
});
test("loss, wrong identity, malformed bytes, stale/multiple summary and mismatched counts fail", () => {
  for (const mutate of [
    (r) => r.pop(),
    (r) => (r[0] = {}),
    (r) => (r[0].processId = "daemon:99"),
    (r) => (r[0].authority = { generation: "foreign" }),
    (r) => (r[0] = { version: 1, type: "performance.daemon-observer", generation: "foreign" }),
    (r) => r.push(r[1]),
    (r) => r.reverse(),
    (r) => (r[1].processId = "daemon:99"),
    (r) => (r[1].daemonInstanceId = "old"),
    (r) => (r[1].shutdownKind = "startup-rollback"),
    (r) => (r[1].failed = true),
    (r) => (r[1].saturated = true),
    (r) => (r[1].acceptedRecords = 2),
    (r) => (r[1].offeredRecords = 2),
    (r) => (r[1].constructionFailures = 1),
    (r) => (r[1].writeFailures = 1),
    (r) => (r[1].maxRecordBytes = 999),
    (r) => (r[1].writableLength = -1),
    (r) => (r[0].huge = "x".repeat(65536)),
  ]) {
    const r = records();
    mutate(r);
    assert.equal(admitDaemonTrace(encode(r), expected, close).status, "incomplete");
  }
  for (const bytes of [Buffer.from([255, 10]), Buffer.from("{}"), Buffer.from("no\n")])
    assert.equal(admitDaemonTrace(bytes, expected, close).status, "incomplete");
  const lost = records();
  Object.assign(lost[1], { offeredRecords: 2, droppedRecords: 1, saturatedDrops: 1 });
  assert.equal(admitDaemonTrace(encode(lost), expected, close).status, "incomplete");
});
test("actual child close event is required; exit, cleanup resolution and absence do not substitute", async () => {
  const child = Object.assign(new EventEmitter(), { pid: 123 });
  const observed = observeDaemonClose(child);
  child.emit("exit", 0, null);
  await assert.rejects(awaitDaemonClose(observed, 5), /timed out/);
  child.emit("close", 0, null);
  assert.deepEqual(await awaitDaemonClose(observed, 5), { pid: 123, code: 0, signal: null });
});
test("actual writer summary integrates with verifier after awaited close", async () => {
  const { Writable } = await import("node:stream");
  const { createRuntimeTraceWriter } =
    await import("../../packages/daemon/src/lib/runtime-trace-writer.ts");
  for (const rollback of [false, true]) {
    const chunks = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(chunk);
        callback();
      },
    });
    const writer = createRuntimeTraceWriter(stream, {
      processId: "daemon:123",
      daemonInstanceId: "one",
    });
    writer.append(() => ({
      version: 1,
      type: "performance.stage",
      processId: "daemon:123",
      authority: null,
    }));
    if (rollback) await assert.rejects(writer.close(true));
    else await writer.close();
    assert.equal(
      admitDaemonTrace(Buffer.concat(chunks), expected, close).status,
      rollback ? "incomplete" : "complete",
    );
  }
});

test("real owner admission path binds append prefix, awaited close and ready PID", async () => {
  const { mkdtemp, writeFile, readFile, rename, rm, mkdir } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "daemon-trace-admission-"));
  try {
    for (const mode of ["clean", "prefix", "replace", "wrong-pid", "stop-error", "signal"]) {
      const path = join(root, mode);
      const prior = Buffer.from('{"prior":true}\n');
      await writeFile(path, prior);
      const start = await captureDaemonTraceStart(path);
      const child = Object.assign(new EventEmitter(), {
        pid: 123,
        exitCode: null,
        signalCode: null,
      });
      const observedClose = observeDaemonClose(child);
      let stopped = false;
      const operation = stopOwnedDaemonWithTrace({
        child,
        expected: mode === "wrong-pid" ? { ...expected, pid: 99 } : expected,
        path,
        start,
        observedClose,
        stop: async () => {
          stopped = true;
          if (mode === "stop-error") throw Error("owner stop failure");
          if (mode === "replace") await rename(path, path + ".old");
          await writeFile(
            path,
            Buffer.concat([
              mode === "prefix" ? Buffer.from('{"prior":null}\n') : prior,
              encode(records()),
            ]),
          );
          child.exitCode = mode === "signal" ? null : 0;
          child.signalCode = mode === "signal" ? "SIGKILL" : null;
          child.emit("close", child.exitCode, child.signalCode);
        },
      });
      if (mode === "clean") assert.equal((await operation).status, "complete");
      else await assert.rejects(operation);
      assert.equal(stopped, true);
      const receipt = JSON.parse(
        await readFile(`${path}.${expected.daemonInstanceId}.admission.json`, "utf8"),
      );
      assert.equal(receipt.status, mode === "clean" ? "complete" : "incomplete");
    }
    const path = join(root, "receipt-failure");
    await mkdir(`${path}.${expected.daemonInstanceId}.admission.json`);
    const failure = new Error("original stop failure");
    await assert.rejects(
      stopOwnedDaemonWithTrace({
        stop: async () => {
          throw failure;
        },
        child: { pid: 123, exitCode: null, signalCode: null },
        expected,
        path,
        start: { exists: false, offset: 0 },
        observedClose: Promise.resolve({ pid: 123, code: 0, signal: null }),
      }),
      (error) =>
        error instanceof AggregateError &&
        error.cause === error.errors[1] &&
        error.errors[0] === failure,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
