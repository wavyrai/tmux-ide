import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";

import {
  createReferencePerformanceTraceSink,
  createReferenceTraceWriter,
} from "./reference-performance-trace.ts";

describe("reference performance trace", () => {
  it("pairs local input and consumed framebuffer paint on one OpenTUI clock", () => {
    const records: Readonly<Record<string, unknown>>[] = [];
    const times = [1_000, 1_150];
    const sink = createReferencePerformanceTraceSink({
      commit: "a".repeat(40),
      tree: "b".repeat(40),
      processId: "opentui:test",
      startedAt: "2026-08-12T00:00:00.000Z",
      createTraceId: () => "00000000-0000-4000-8000-000000000001",
      nowMicros: () => times.shift()!,
      append: (record) => records.push(record),
    });
    const input = sink.beginTerminalInput!();
    input.finish();
    sink.terminalTraceSpan!({
      traceId: input.traceId,
      scenario: "terminal-input-to-paint",
      stage: "paint",
      processId: "opentui:test",
      clockId: "opentui-performance-now",
      clockKind: "performance-now",
      startedAtMicros: 1_500,
      endedAtMicros: 1_700,
      generation: "generation-a",
      incarnation: "incarnation-a",
      semanticPaneId: "pane-a",
      revision: 1,
      stateHash: "hash-a",
    });

    expect(records).toHaveLength(3);
    expect(records[1]).toMatchObject({
      type: "performance.stage",
      stage: "input",
      startedAtMicros: 1_000,
      endedAtMicros: 1_150,
      processId: "opentui:test",
      clockId: "opentui-performance-now",
    });
    expect(records[2]).toMatchObject({
      type: "performance.stage",
      stage: "paint",
      startedAtMicros: 1_500,
      endedAtMicros: 1_700,
    });
  });

  it("does not emit an unconsumed input or a paint with no matching input", () => {
    const records: Readonly<Record<string, unknown>>[] = [];
    const sink = createReferencePerformanceTraceSink({
      commit: "a".repeat(40),
      tree: "b".repeat(40),
      createTraceId: () => "00000000-0000-4000-8000-000000000002",
      nowMicros: () => 1_000,
      append: (record) => records.push(record),
    });
    sink.beginTerminalInput!();
    sink.terminalTraceSpan!({
      traceId: "00000000-0000-4000-8000-000000000003",
      scenario: "terminal-input-to-paint",
      stage: "paint",
      processId: "opentui:test",
      clockId: "opentui-performance-now",
      clockKind: "performance-now",
      startedAtMicros: 1_500,
      endedAtMicros: 1_700,
      generation: "generation-a",
      incarnation: "incarnation-a",
      semanticPaneId: "pane-a",
      revision: 1,
      stateHash: "hash-a",
    });
    expect(records).toHaveLength(1);
  });

  it("keeps minimal qualification to the header and paired input/paint", () => {
    const records: Readonly<Record<string, unknown>>[] = [];
    const times = [1_000, 1_100];
    const sink = createReferencePerformanceTraceSink({
      commit: "a".repeat(40),
      tree: "b".repeat(40),
      createTraceId: () => "00000000-0000-4000-8000-000000000004",
      nowMicros: () => times.shift()!,
      append: (record) => records.push(record),
    });
    sink.frame!(16);
    sink.terminalPaint!(1, 0.1);
    const input = sink.beginTerminalInput!();
    input.finish();
    sink.terminalTraceSpan!({
      traceId: input.traceId,
      scenario: "terminal-input-to-paint",
      stage: "paint",
      processId: "opentui:test",
      clockId: "opentui-performance-now",
      clockKind: "performance-now",
      startedAtMicros: 1_200,
      endedAtMicros: 1_300,
      generation: "generation-a",
      incarnation: "incarnation-a",
      semanticPaneId: "pane-a",
      revision: 1,
      stateHash: "hash-a",
    });
    expect(records.map((record) => record.type)).toEqual([
      "performance.trace.header",
      "performance.stage",
      "performance.stage",
    ]);
  });

  it("bounds no-output probes and expires an old completed probe without timers", () => {
    const records: Readonly<Record<string, unknown>>[] = [];
    let clock = 1_000;
    let ordinal = 0;
    const sink = createReferencePerformanceTraceSink({
      commit: "a".repeat(40),
      tree: "b".repeat(40),
      nowMicros: () => clock,
      createTraceId: () => `00000000-0000-4000-8000-${String(ordinal++).padStart(12, "0")}`,
      append: (record) => records.push(record),
    });
    const first = sink.beginTerminalInput!();
    for (let index = 0; index < 256; index += 1) sink.beginTerminalInput!();
    first.finish();
    sink.terminalTraceSpan!({
      traceId: first.traceId,
      scenario: "terminal-input-to-paint",
      stage: "paint",
      processId: "opentui:test",
      clockId: "opentui-performance-now",
      clockKind: "performance-now",
      startedAtMicros: 1_500,
      endedAtMicros: 1_700,
      generation: "generation-a",
      incarnation: "incarnation-a",
      semanticPaneId: "pane-a",
      revision: 1,
      stateHash: "hash-a",
    });
    expect(records).toHaveLength(1);

    const expiring = sink.beginTerminalInput!();
    expiring.finish();
    clock = 5_002_000;
    sink.beginTerminalInput!();
    sink.terminalTraceSpan!({
      traceId: expiring.traceId,
      scenario: "terminal-input-to-paint",
      stage: "paint",
      processId: "opentui:test",
      clockId: "opentui-performance-now",
      clockKind: "performance-now",
      startedAtMicros: clock,
      endedAtMicros: clock + 100,
      generation: "generation-a",
      incarnation: "incarnation-a",
      semanticPaneId: "pane-a",
      revision: 1,
      stateHash: "hash-a",
    });
    expect(records).toHaveLength(1);
  });

  it("retires latest-only superseded probes without reporting capacity drops", () => {
    const records: Readonly<Record<string, unknown>>[] = [];
    let ordinal = 0;
    const sink = createReferencePerformanceTraceSink({
      commit: "a".repeat(40),
      tree: "b".repeat(40),
      createTraceId: () => `00000000-0000-4000-8000-${String(ordinal++).padStart(12, "0")}`,
      nowMicros: () => 1_000 + ordinal,
      append: (record) => records.push(record),
    });
    for (let index = 0; index < 300; index += 1) sink.beginTerminalInput!().finish();

    expect(sink.snapshot()).toEqual({ pendingInputs: 1, droppedInputs: 0 });
    sink.beginTerminalInput!().cancel();
    expect(sink.snapshot()).toEqual({ pendingInputs: 0, droppedInputs: 0 });
  });

  it("cancels the final unpainted probe when the collector closes", () => {
    const sink = createReferencePerformanceTraceSink({
      commit: "a".repeat(40),
      tree: "b".repeat(40),
      createTraceId: () => "00000000-0000-4000-8000-000000000009",
      nowMicros: () => 1_000,
      append: () => undefined,
    });
    sink.beginTerminalInput!().finish();
    expect(sink.close()).toEqual({ pendingInputs: 0, droppedInputs: 0 });
  });

  it("exposes canonical mode and fresh queue proof only to the opt-in detailed collector", () => {
    const quiet = createReferencePerformanceTraceSink({
      commit: "a".repeat(40),
      tree: "b".repeat(40),
      append: () => undefined,
    });
    expect(quiet.terminalCanonicalMode).toBeUndefined();
    expect(quiet.terminalCanonicalPublication).toBeUndefined();
    expect(quiet.terminalCanonicalPaint).toBeUndefined();
    expect(quiet.terminalInputQueueState).toBeUndefined();

    const records: Array<Readonly<Record<string, unknown>>> = [];
    const detailed = createReferencePerformanceTraceSink({
      commit: "a".repeat(40),
      tree: "b".repeat(40),
      detailed: true,
      append: (record) => records.push(record),
    });
    detailed.terminalCanonicalMode?.({
      processId: "opentui:1",
      clockId: "opentui-performance-now",
      clockKind: "performance-now",
      atMicros: 12,
      semanticPaneId: "pane.alpha",
      generation: "11111111-1111-4111-8111-111111111111",
      incarnation: "incarnation",
      revision: 3,
      stateHash: "hash",
      wraparound: true,
    });
    expect(records.at(-1)).toMatchObject({
      type: "performance.terminal-canonical-mode",
      semanticPaneId: "pane.alpha",
      revision: 3,
      wraparound: true,
    });
    detailed.terminalInputQueueState?.({
      operation: "initialized",
      processId: "opentui:1",
      clockId: "opentui-performance-now",
      clockKind: "performance-now",
      atMicros: 13,
      inputPending: 0,
      inputInFlight: 0,
      inputPendingBytes: 0,
      rssBytes: 100,
      heapUsedBytes: 50,
    });
    expect(records.at(-1)).toMatchObject({
      type: "performance.input-queue-state",
      operation: "initialized",
      inputPending: 0,
      inputInFlight: 0,
      inputPendingBytes: 0,
    });
  });

  it("queues and closes a saturated 256-input diagnostic burst in exact order", async () => {
    class FakeWritable extends EventEmitter {
      writableLength = 0;
      destroyed = false;
      backpressured = true;
      readonly writes: string[] = [];
      write(value: string): boolean {
        this.writes.push(value);
        this.writableLength += Buffer.byteLength(value);
        return !this.backpressured;
      }
      end(value: string, callback: () => void): void {
        this.writes.push(value);
        this.destroyed = true;
        callback();
      }
      destroy(): void {
        this.destroyed = true;
      }
    }
    const stream = new FakeWritable();
    const writer = createReferenceTraceWriter(stream);
    writer.append({ type: "first" });
    const operations = [
      "lane-enqueue",
      "transport-send-start",
      "pane-stream-frame-enqueued",
      "pane-stream-socket-send-return",
      "pane-stream-next-event-loop-turn",
      "transport-ack",
    ];
    for (let input = 0; input < 256; input += 1) {
      for (let mark = 0; mark < 6; mark += 1) {
        writer.append({
          version: 1,
          type: "performance.stage",
          traceId: `00000000-0000-4000-8000-${String(input).padStart(12, "0")}`,
          scenario: "terminal-input-to-paint",
          stage: "client",
          operation: operations[mark],
          processId: "opentui:123456",
          clockId: "opentui-performance-now",
          clockKind: "performance-now",
          atMicros: 123_456_789 + input * 10 + mark,
          rssBytes: 675_987_456,
          heapUsedBytes: 271_076_685,
          inputPending: 256 - input,
          inputInFlight: Math.min(input, 8),
          inputPendingBytes: 159,
          sequence: input + 1,
        });
      }
    }
    const closing = writer.close({ pendingInputs: 2, droppedInputs: 1 });
    expect(writer.snapshot()).toMatchObject({
      acceptedRecords: 1,
      droppedRecords: 0,
      saturated: true,
    });
    expect(writer.snapshot().pendingBytes).toBeGreaterThan(0);
    expect(writer.snapshot().peakPendingBytes).toBeGreaterThan(500_000);
    expect(writer.snapshot().peakPendingBytes).toBeLessThan(1_024 * 1_024);
    stream.backpressured = false;
    stream.writableLength = 0;
    stream.emit("drain");
    const report = await closing;
    expect(report).toMatchObject({
      acceptedRecords: 1 + 256 * 6,
      droppedRecords: 0,
      pendingBytes: 0,
      pendingInputs: 2,
      droppedInputs: 1,
      failed: false,
    });
    expect(
      stream.writes.slice(0, -1).map((line) => {
        const record = JSON.parse(line);
        return record.operation ? `${record.sequence}:${record.operation}` : "first";
      }),
    ).toEqual([
      "first",
      ...Array.from({ length: 256 }, (_, input) =>
        operations.map((operation) => `${input + 1}:${operation}`),
      ).flat(),
    ]);
    expect(stream.writes.at(-1)).toContain('"type":"performance.trace.summary"');
    expect(stream.destroyed).toBe(true);
    expect(stream.listenerCount("drain")).toBe(0);
    expect(stream.listenerCount("error")).toBe(0);
  });

  it("bounds queued bytes and reports the first overflowed record without payload", async () => {
    class FakeWritable extends EventEmitter {
      writableLength = 0;
      destroyed = false;
      backpressured = true;
      readonly writes: string[] = [];
      write(value: string): boolean {
        this.writes.push(value);
        return !this.backpressured;
      }
      end(value: string, callback: () => void): void {
        this.writes.push(value);
        this.destroyed = true;
        callback();
      }
      destroy(): void {
        this.destroyed = true;
      }
    }
    const stream = new FakeWritable();
    const writer = createReferenceTraceWriter(stream, { maxPendingBytes: 1 });
    writer.append({ type: "first" });
    writer.append({
      type: "performance.stage",
      stage: "client",
      operation: "transport-ack",
      payload: "must-not-appear-in-drop-metadata",
    });
    const closing = writer.close({ pendingInputs: 0, droppedInputs: 0 });
    stream.backpressured = false;
    stream.emit("drain");

    const report = await closing;
    expect(report).toMatchObject({
      acceptedRecords: 1,
      droppedRecords: 1,
      pendingBytes: 0,
      firstDroppedRecord: {
        type: "performance.stage",
        stage: "client",
        operation: "transport-ack",
      },
    });
    expect(JSON.stringify(report)).not.toContain("must-not-appear");
    expect(() => createReferenceTraceWriter(stream, { maxPendingBytes: Infinity })).toThrow(
      /positive safe integer/u,
    );
  });

  it("keeps backing storage bounded across repeated partial drains and refills", async () => {
    class FakeWritable extends EventEmitter {
      writableLength = 0;
      destroyed = false;
      backpressured = true;
      readonly writes: string[] = [];
      write(value: string): boolean {
        this.writes.push(value);
        return !this.backpressured;
      }
      end(value: string, callback: () => void): void {
        this.writes.push(value);
        this.destroyed = true;
        callback();
      }
      destroy(): void {
        this.destroyed = true;
      }
    }
    const stream = new FakeWritable();
    const writer = createReferenceTraceWriter(stream);
    writer.append({ type: "first" });
    for (let index = 0; index < 100; index += 1)
      writer.append({ type: "queued", operation: `initial-${index}` });

    for (let index = 0; index < 2_000; index += 1) {
      stream.emit("drain");
      writer.append({ type: "queued", operation: `refill-${index}` });
      const snapshot = writer.snapshot();
      expect(snapshot.pendingRecords).toBe(100);
      expect(snapshot.pendingStorageSlots).toBeLessThanOrEqual(snapshot.pendingRecords * 2);
    }

    stream.backpressured = false;
    stream.emit("drain");
    const report = await writer.close({ pendingInputs: 0, droppedInputs: 0 });
    expect(report).toMatchObject({
      acceptedRecords: 2_101,
      droppedRecords: 0,
      pendingBytes: 0,
      pendingRecords: 0,
      pendingStorageSlots: 0,
    });
    expect(stream.writes.slice(1, -1).map((line) => JSON.parse(line).operation)).toEqual([
      ...Array.from({ length: 100 }, (_, index) => `initial-${index}`),
      ...Array.from({ length: 2_000 }, (_, index) => `refill-${index}`),
    ]);
  });

  it("settles a saturated close when the stream fails and releases listeners", async () => {
    class FakeWritable extends EventEmitter {
      writableLength = 0;
      destroyed = false;
      write(): boolean {
        return false;
      }
      end(_value: string, callback: () => void): void {
        callback();
      }
      destroy(): void {
        this.destroyed = true;
      }
    }
    const stream = new FakeWritable();
    const writer = createReferenceTraceWriter(stream);
    writer.append({ type: "first" });
    writer.append({ type: "queued", operation: "after-saturation" });
    const closing = writer.close({ pendingInputs: 0, droppedInputs: 0 });
    stream.emit("error", new Error("disk failed"));

    await expect(closing).resolves.toMatchObject({
      acceptedRecords: 1,
      droppedRecords: 1,
      failed: true,
      pendingBytes: 0,
    });
    expect(stream.destroyed).toBe(true);
    expect(stream.listenerCount("drain")).toBe(0);
    expect(stream.listenerCount("error")).toBe(0);
  });

  it.each(["emit", "throw"] as const)(
    "returns failed truth and releases listeners when stream end %s fails",
    async (failure) => {
      class FakeWritable extends EventEmitter {
        writableLength = 0;
        destroyed = false;
        write(): boolean {
          return true;
        }
        end(_value: string, _callback: () => void): void {
          if (failure === "throw") throw new Error("end threw");
          this.emit("error", new Error("end emitted error"));
        }
        destroy(): void {
          this.destroyed = true;
        }
      }
      const stream = new FakeWritable();
      const writer = createReferenceTraceWriter(stream);
      writer.append({ type: "first" });

      await expect(writer.close({ pendingInputs: 0, droppedInputs: 0 })).resolves.toMatchObject({
        acceptedRecords: 1,
        droppedRecords: 0,
        failed: true,
      });
      expect(stream.destroyed).toBe(true);
      expect(stream.listenerCount("drain")).toBe(0);
      expect(stream.listenerCount("error")).toBe(0);
    },
  );
});
