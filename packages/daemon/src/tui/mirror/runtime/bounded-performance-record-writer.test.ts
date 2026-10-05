import { describe, expect, it } from "vitest";
import { BoundedPerformanceRecordWriter } from "./bounded-performance-record-writer.ts";

describe("BoundedPerformanceRecordWriter", () => {
  it("retains one critical readiness record while ordinary records remain droppable", () => {
    const records: string[] = [];
    let accept = false;
    const writer = new BoundedPerformanceRecordWriter(
      {
        write(record) {
          records.push(record);
          return accept;
        },
      },
      16,
      0,
    );

    expect(writer.write("ordinary-1")).toBe(true);
    expect(writer.write("ordinary-2")).toBe(false);
    expect(writer.writeCritical("generation:1", "ready")).toBe(true);
    expect(writer.writeCritical("generation:1", "duplicate")).toBe(true);
    expect(writer.diagnostics()).toEqual({
      droppedRecords: 1,
      failed: false,
      pendingCriticalRecords: 1,
    });

    accept = true;
    writer.drain();
    expect(records).toEqual(["ordinary-1", "ready"]);
    expect(writer.diagnostics().pendingCriticalRecords).toBe(0);
  });

  it("is bounded and fail-open when the sink rejects writes", () => {
    const writer = new BoundedPerformanceRecordWriter(
      {
        write() {
          throw new Error("diagnostic sink failed");
        },
      },
      1,
    );
    expect(writer.writeCritical("generation:1", "ready")).toBe(false);
    expect(writer.diagnostics()).toEqual({
      droppedRecords: 0,
      failed: true,
      pendingCriticalRecords: 0,
    });
    expect(() => writer.drain()).not.toThrow();
  });

  it("rejects critical overflow without growing its retained set", () => {
    const writer = new BoundedPerformanceRecordWriter({ write: () => false }, 1);
    writer.write("saturate");
    expect(writer.writeCritical("generation:1", "first")).toBe(true);
    expect(writer.writeCritical("generation:2", "second")).toBe(false);
    expect(writer.diagnostics()).toEqual({
      droppedRecords: 1,
      failed: false,
      pendingCriticalRecords: 1,
    });
  });
});

it("retains a bounded burst and stops draining when the sink saturates again", async () => {
  const records: string[] = [];
  const writer = new BoundedPerformanceRecordWriter({
    write(record) {
      records.push(record);
      return false;
    },
  });
  writer.write("first");
  expect(writer.write("second")).toBe(true);
  expect(writer.write("third")).toBe(true);
  expect(writer.writeCritical("ready", "critical")).toBe(true);
  writer.drain();
  expect(records).toEqual(["first", "second"]);
  writer.drain();
  expect(records).toEqual(["first", "second", "third"]);
  writer.drain();
  expect(records).toEqual(["first", "second", "third", "critical"]);
  expect(writer.diagnostics().droppedRecords).toBe(0);
});

it("bounds UTF-8 bytes and record count while preserving an explicit critical reserve", async () => {
  const writer = new BoundedPerformanceRecordWriter({ write: () => false }, 1, 4);
  writer.write("saturate");
  expect(writer.write("éé")).toBe(true);
  expect(writer.write("x")).toBe(false);
  expect(writer.writeCritical("ready", "critical")).toBe(true);
  expect(writer.writeCritical("ready", "duplicate")).toBe(true);
  expect(writer.writeCritical("other", "overflow")).toBe(false);
  expect(writer.diagnostics().droppedRecords).toBe(2);
  const tiny = new BoundedPerformanceRecordWriter({ write: () => false });
  tiny.write("saturate");
  for (let i = 0; i < 1024; i += 1) expect(tiny.write("")).toBe(true);
  expect(tiny.write("")).toBe(false);
});

it("joins pending writes before close and releases the join on sink failure", async () => {
  const writer = new BoundedPerformanceRecordWriter({ write: () => false });
  writer.write("saturate");
  writer.write("pending");
  let flushed = false;
  const done = writer.flush().then(() => {
    flushed = true;
  });
  await Promise.resolve();
  expect(flushed).toBe(false);
  writer.drain();
  await done;
  expect(flushed).toBe(true);
  writer.write("pending-again");
  const failed = writer.flush();
  writer.fail();
  await failed;
  expect(writer.diagnostics().failed).toBe(true);
});
