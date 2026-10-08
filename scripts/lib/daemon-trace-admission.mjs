import { createHash } from "node:crypto";
import { open, writeFile } from "node:fs/promises";
/** Final file evidence plus a creation-owned headless child's observed close outcome. */
export function admitDaemonTrace(bytes, expected, ownerClose) {
  try {
    if (bytes.length > 64 * 1024 * 1024)
      throw new Error("Daemon trace exceeds 64 MiB admission limit");
    if (
      !Number.isSafeInteger(expected.pid) ||
      expected.pid <= 0 ||
      typeof expected.daemonInstanceId !== "string" ||
      !expected.daemonInstanceId
    )
      throw new Error("Expected daemon identity unavailable");
    if (
      ownerClose?.pid !== expected.pid ||
      ownerClose.daemonInstanceId !== expected.daemonInstanceId ||
      ownerClose.requestedWhileRunning !== true ||
      ownerClose.code !== 0 ||
      ownerClose.signal !== null
    )
      throw new Error("Creation-owned headless daemon did not confirm successful shutdown");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!text.endsWith("\n")) throw new Error("Daemon trace missing final newline");
    const records = text.slice(0, -1).split("\n").map(JSON.parse);
    const summaries = records.filter(
      (record) => record?.type === "performance.daemon-trace.summary",
    );
    if (summaries.length !== 1 || records.at(-1) !== summaries[0])
      throw new Error("Daemon trace needs one last summary");
    for (const record of records.slice(0, -1)) {
      if (
        record?.version !== 1 ||
        !["performance.stage", "performance.daemon-observer"].includes(record.type)
      )
        throw new Error("Unknown daemon trace record");
      if (
        record.type === "performance.stage" &&
        (record.processId !== `daemon:${expected.pid}` ||
          (record.authority != null && record.authority.generation !== expected.daemonInstanceId))
      )
        throw new Error("Foreign daemon stage identity");
      if (
        record.type === "performance.daemon-observer" &&
        record.generation !== expected.daemonInstanceId
      )
        throw new Error("Foreign daemon observer generation");
      if (
        record.daemonInstanceId !== undefined &&
        record.daemonInstanceId !== expected.daemonInstanceId
      )
        throw new Error("Foreign daemon record identity");
    }
    const summary = summaries[0];
    if (
      summary.version !== 1 ||
      summary.processId !== `daemon:${expected.pid}` ||
      summary.daemonInstanceId !== expected.daemonInstanceId ||
      summary.shutdownKind !== "normal" ||
      summary.failed !== false ||
      summary.saturated !== false ||
      summary.acceptedRecordsExcludeSummary !== true ||
      summary.maxRecordBytes !== 65536
    )
      throw new Error("Daemon trace summary identity or completion mismatch");
    for (const field of [
      "offeredRecords",
      "acceptedRecords",
      "droppedRecords",
      "saturatedDrops",
      "failedDrops",
      "oversizedRecords",
      "constructionFailures",
      "rejectedWrites",
      "writeFailures",
      "writableLength",
    ])
      if (!Number.isSafeInteger(summary[field]) || summary[field] < 0)
        throw new Error(`Invalid daemon trace counter: ${field}`);
    if (
      summary.acceptedRecords !== records.length - 1 ||
      summary.offeredRecords !== summary.acceptedRecords + summary.droppedRecords ||
      summary.droppedRecords !==
        summary.saturatedDrops +
          summary.failedDrops +
          summary.oversizedRecords +
          summary.constructionFailures +
          summary.rejectedWrites
    )
      throw new Error("Daemon trace counters do not conserve records");
    if (summary.droppedRecords !== 0 || summary.writeFailures !== 0)
      throw new Error("Daemon trace records were lost or failed");
    if (
      text
        .slice(0, -1)
        .split("\n")
        .some((line) => Buffer.byteLength(line) + 1 > 65536)
    )
      throw new Error("Daemon trace record exceeds writer cap");
    return {
      status: "complete",
      recordCount: records.length - 1,
      ownerClose,
      scope:
        "Generation-bound daemon file integrity and successful owned headless close, not causal stage or timing acceptance",
    };
  } catch (error) {
    return { status: "incomplete", reason: error.message, ownerClose };
  }
}

/** Observe child close, not mere exit/PID absence; bounded even after owner cleanup returns. */
export function observeDaemonClose(child) {
  return new Promise((resolve) =>
    child.once("close", (code, signal) => resolve({ pid: child.pid, code, signal })),
  );
}
export async function awaitDaemonClose(observed, timeoutMs = 1000) {
  let timer;
  try {
    return await Promise.race([
      observed,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Owned daemon close receipt timed out")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function boundedTraceFile(path) {
  const file = await open(path, "r");
  try {
    const stat = await file.stat();
    if (stat.size > 64 * 1024 * 1024) throw new Error("Daemon trace exceeds admission limit");
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!read.bytesRead) throw new Error("Daemon trace changed during read");
      offset += read.bytesRead;
    }
    const after = await file.stat();
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs)
      throw new Error("Daemon trace changed during read");
    return { bytes, dev: stat.dev, ino: stat.ino };
  } finally {
    await file.close();
  }
}
export async function captureDaemonTraceStart(path) {
  try {
    const file = await boundedTraceFile(path);
    if (file.bytes.length && file.bytes.at(-1) !== 10)
      throw new Error("Existing daemon trace has a partial final record");
    return {
      exists: true,
      dev: file.dev,
      ino: file.ino,
      offset: file.bytes.length,
      prefixSha256: digest(file.bytes),
    };
  } catch (error) {
    if (error.code === "ENOENT") return { exists: false, offset: 0 };
    throw error;
  }
}
/** Used by the real fixture owner; cleanup runs before any admission failure is thrown. */
export async function stopOwnedDaemonWithTrace({
  stop,
  child,
  expected,
  path,
  start,
  observedClose,
}) {
  const requestedWhileRunning = child.exitCode === null && child.signalCode === null;
  let admission;
  let failure;
  try {
    await stop();
    const closed = await awaitDaemonClose(observedClose);
    if (child.pid !== expected.pid)
      throw new Error("Ready daemon PID differs from creation-owned child");
    const file = await boundedTraceFile(path);
    if (
      file.bytes.length < start.offset ||
      (start.exists &&
        (file.dev !== start.dev ||
          file.ino !== start.ino ||
          digest(file.bytes.subarray(0, start.offset)) !== start.prefixSha256))
    )
      throw new Error("Daemon trace append identity changed");
    const bytes = file.bytes.subarray(start.offset);
    admission = {
      ...admitDaemonTrace(bytes, expected, {
        ...closed,
        daemonInstanceId: expected.daemonInstanceId,
        requestedWhileRunning,
      }),
      bytes: bytes.length,
      sha256: digest(bytes),
    };
  } catch (error) {
    failure = error;
    admission = { status: "incomplete", reason: error.message };
  }
  try {
    await writeFile(
      `${path}.${expected.daemonInstanceId}.admission.json`,
      JSON.stringify({ ...admission, tracePath: path, start, expected }),
      { mode: 0o600 },
    );
  } catch (persistenceError) {
    if (failure)
      throw new AggregateError(
        [failure, persistenceError],
        "Daemon shutdown/admission and receipt persistence failed",
        { cause: persistenceError },
      );
    throw persistenceError;
  }
  if (admission.status !== "complete")
    throw new Error(`Daemon trace incomplete: ${admission.reason}`, { cause: failure });
  return admission;
}
