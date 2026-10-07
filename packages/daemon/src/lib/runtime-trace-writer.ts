import type { Writable } from "node:stream";

const MAX_RECORD_BYTES = 64 * 1024;

/** Opt-in diagnostics: one stream buffer, no additional queue or producer backpressure. */
export function createRuntimeTraceWriter(
  stream: Writable,
  identity: { processId: string; daemonInstanceId: string },
  closeTimeoutMs = 1000,
) {
  const counts = {
    offeredRecords: 0,
    acceptedRecords: 0,
    droppedRecords: 0,
    saturatedDrops: 0,
    failedDrops: 0,
    oversizedRecords: 0,
    constructionFailures: 0,
    rejectedWrites: 0,
    writeFailures: 0,
  };
  let saturated = false;
  let failed = false;
  let closed = false;
  let closing: Promise<void> | undefined;
  let closeFailure: ((error: Error) => void) | undefined;
  const snapshot = () => ({ ...counts, failed, saturated, writableLength: stream.writableLength });
  stream.on("drain", () => {
    if (!failed) saturated = false;
  });
  // Retain the error listener through destroy: a late stream error must not escape cleanup.
  stream.on("error", (error: Error) => {
    counts.writeFailures++;
    failed = true;
    closeFailure?.(error);
  });
  return {
    snapshot,
    append(build: () => unknown): void {
      if (closed) return;
      counts.offeredRecords++;
      if (failed || stream.destroyed) {
        counts.failedDrops++;
        counts.droppedRecords++;
        return;
      }
      if (saturated) {
        counts.saturatedDrops++;
        counts.droppedRecords++;
        return;
      }
      let line: string;
      try {
        const json = JSON.stringify(build());
        if (json === undefined) throw new Error("Trace record is not JSON");
        line = `${json}\n`;
        if (Buffer.byteLength(line) > MAX_RECORD_BYTES) {
          counts.oversizedRecords++;
          counts.droppedRecords++;
          return;
        }
      } catch {
        counts.constructionFailures++;
        counts.droppedRecords++;
        failed = true;
        return;
      }
      try {
        saturated = !stream.write(line);
        counts.acceptedRecords++;
      } catch {
        counts.rejectedWrites++;
        counts.droppedRecords++;
        failed = true;
      }
    },
    close(incomplete = false): Promise<void> {
      if (closing) return closing;
      closed = true;
      if (incomplete) failed = true;
      closing = new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          stream.off("drain", end);
          stream.off("close", prematureClose);
          closeFailure = undefined;
          if (error) {
            failed = true;
            stream.destroy();
            reject(error);
          } else resolve();
        };
        const prematureClose = () =>
          finish(new Error("Runtime trace closed before final summary completion"));
        const end = () => {
          try {
            if (stream.destroyed || !stream.writable)
              throw new Error("Runtime trace stream unavailable");
            const summary = {
              version: 1,
              type: "performance.daemon-trace.summary",
              ...identity,
              ...snapshot(),
              maxRecordBytes: MAX_RECORD_BYTES,
              acceptedRecordsExcludeSummary: true,
              shutdownKind: incomplete ? "startup-rollback" : "normal",
              ringTailOverwrites: "not-file-loss",
            };
            stream.end(`${JSON.stringify(summary)}\n`, () =>
              finish(failed ? new Error("Runtime trace recorded failures") : undefined),
            );
          } catch (error) {
            finish(error instanceof Error ? error : new Error("Runtime trace end failed"));
          }
        };
        const timer = setTimeout(
          () => finish(new Error("Runtime trace close timed out")),
          closeTimeoutMs,
        );
        closeFailure = finish;
        stream.on("close", prematureClose);
        if (stream.destroyed) finish(new Error("Runtime trace stream destroyed"));
        else if (saturated && stream.writableNeedDrain) stream.once("drain", end);
        else end();
      });
      return closing;
    },
  };
}
