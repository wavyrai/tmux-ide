import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createRuntimeTraceWriter } from "./runtime-trace-writer.ts";
const identity = { processId: "daemon:test", daemonInstanceId: "instance" };
function rig(hold = false) {
  const lines: string[] = [];
  let release: (() => void) | undefined;
  const stream = new Writable({
    highWaterMark: 64 * 1024,
    write(chunk, _encoding, callback) {
      lines.push(chunk.toString());
      if (hold) {
        hold = false;
        release = callback;
      } else callback();
    },
  });
  return { stream, lines, release: () => release?.() };
}
describe("daemon runtime trace accounting", () => {
  it("reproduces saturation omission but records its exact loss without another queue", async () => {
    const r = rig(true),
      writer = createRuntimeTraceWriter(r.stream, identity);
    // Exactly the stream highWaterMark, including JSON quotes and newline.
    writer.append(() => "x".repeat(64 * 1024 - 3));
    const skipped = vi.fn(() => ({ type: "observer" }));
    writer.append(skipped);
    expect(skipped).not.toHaveBeenCalled();
    expect(writer.snapshot()).toMatchObject({
      offeredRecords: 2,
      acceptedRecords: 1,
      droppedRecords: 1,
      saturatedDrops: 1,
    });
    const closing = writer.close();
    expect(r.lines).toHaveLength(1);
    r.release();
    await closing;
    const summary = JSON.parse(r.lines.at(-1)!);
    expect(summary).toMatchObject({
      type: "performance.daemon-trace.summary",
      offeredRecords: 2,
      acceptedRecords: 1,
      droppedRecords: 1,
      saturated: false,
      failed: false,
      ...identity,
    });
    expect(writer.close()).toBe(closing);
    writer.append(skipped);
    expect(skipped).not.toHaveBeenCalled();
  });
  it("records clean spans and observer diagnostics, and labels rollback incomplete", async () => {
    for (const rollback of [false, true]) {
      const r = rig(),
        writer = createRuntimeTraceWriter(r.stream, identity);
      writer.append(() => ({ type: "performance.stage" }));
      writer.append(() => ({ type: "performance.daemon-observer" }));
      if (rollback) await expect(writer.close(true)).rejects.toThrow();
      else await writer.close();
      expect(JSON.parse(r.lines.at(-1)!)).toMatchObject({
        offeredRecords: 2,
        acceptedRecords: 2,
        droppedRecords: 0,
        failed: rollback,
        shutdownKind: rollback ? "startup-rollback" : "normal",
      });
    }
  });
  it("JSON construction errors never escape append or become clean summaries", async () => {
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    for (const value of [
      cycle,
      { value: 1n },
      Object.defineProperty({}, "toJSON", {
        get() {
          throw Error("getter");
        },
      }),
    ]) {
      const r = rig(),
        writer = createRuntimeTraceWriter(r.stream, identity);
      expect(() => writer.append(() => value)).not.toThrow();
      await expect(writer.close()).rejects.toThrow();
      expect(writer.snapshot()).toMatchObject({ constructionFailures: 1, droppedRecords: 1 });
    }
  });
  it("counts oversized and construction failures, without reading error metadata", async () => {
    const r = rig(),
      writer = createRuntimeTraceWriter(r.stream, identity);
    writer.append(() => "x".repeat(64 * 1024));
    const hostile = Object.defineProperty({}, "message", {
      get() {
        throw Error("do not inspect");
      },
    });
    writer.append(() => {
      throw hostile;
    });
    writer.append(() => ({ later: true }));
    await expect(writer.close()).rejects.toThrow("recorded failures");
    expect(writer.snapshot()).toMatchObject({
      offeredRecords: 3,
      acceptedRecords: 0,
      droppedRecords: 3,
      oversizedRecords: 1,
      constructionFailures: 1,
      failedDrops: 1,
      failed: true,
    });
    expect(JSON.parse(r.lines[0]!)).toMatchObject({ failed: true, constructionFailures: 1 });
  });
  it("sticky asynchronous error survives drain and bounded close rejects", async () => {
    const r = rig(),
      writer = createRuntimeTraceWriter(r.stream, identity);
    r.stream.emit("error", Error("write failed"));
    r.stream.emit("drain");
    writer.append(() => ({ ignored: true }));
    await expect(writer.close()).rejects.toThrow();
    expect(writer.snapshot()).toMatchObject({ writeFailures: 1, failedDrops: 1, failed: true });
  });
  it("synchronous write failure is a rejected offered record", async () => {
    const r = rig(),
      writer = createRuntimeTraceWriter(r.stream, identity);
    const write = vi.spyOn(r.stream, "write").mockImplementationOnce(() => {
      throw Error("write");
    });
    writer.append(() => ({ span: true }));
    write.mockRestore();
    await expect(writer.close()).rejects.toThrow();
    expect(writer.snapshot()).toMatchObject({
      offeredRecords: 1,
      acceptedRecords: 0,
      droppedRecords: 1,
      rejectedWrites: 1,
    });
  });
  it("end throws or never completes cannot hang cleanup", async () => {
    vi.useFakeTimers();
    try {
      for (const throws of [true, false]) {
        const r = rig(),
          writer = createRuntimeTraceWriter(r.stream, identity, 25);
        vi.spyOn(r.stream, "end").mockImplementation(() => {
          if (throws) throw Error("end");
          return r.stream;
        });
        const closed = writer.close();
        const checked = expect(closed).rejects.toThrow(throws ? "end" : "timed out");
        await vi.advanceTimersByTimeAsync(25);
        await checked;
        expect(r.stream.destroyed).toBe(true);
      }
    } finally {
      vi.useRealTimers();
    }
  });
  it("a saturated stream that never drains has the same bounded close deadline", async () => {
    vi.useFakeTimers();
    try {
      const r = rig(true),
        writer = createRuntimeTraceWriter(r.stream, identity, 25);
      writer.append(() => "x".repeat(64 * 1024 - 3));
      const checked = expect(writer.close()).rejects.toThrow("timed out");
      await vi.advanceTimersByTimeAsync(25);
      await checked;
      expect(r.stream.destroyed).toBe(true);
      expect(r.lines).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
  it("premature close and failure during end settle without swallowing subsequent cleanup", async () => {
    for (const event of ["close", "error"]) {
      const r = rig(),
        writer = createRuntimeTraceWriter(r.stream, identity);
      vi.spyOn(r.stream, "end").mockImplementation(() => {
        r.stream.emit(event, Error("end error"));
        return r.stream;
      });
      const results = await Promise.allSettled([writer.close(), Promise.resolve("other cleanup")]);
      expect(results[0]?.status).toBe("rejected");
      expect(results[1]).toEqual({ status: "fulfilled", value: "other cleanup" });
    }
  });
});
