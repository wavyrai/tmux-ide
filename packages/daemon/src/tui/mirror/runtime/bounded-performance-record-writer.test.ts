import { describe, expect, it } from "vitest";
import { BoundedPerformanceRecordWriter } from "./bounded-performance-record-writer.ts";

describe("BoundedPerformanceRecordWriter", () => {
  it("retains one critical readiness record while ordinary records remain droppable", () => {
    const records: string[] = [];
    let accept = false;
    const writer = new BoundedPerformanceRecordWriter({
      write(record) {
        records.push(record);
        return accept;
      },
    });

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
