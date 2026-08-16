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

  it("flushes and closes a saturated writer with explicit drop accounting", async () => {
    class FakeWritable extends EventEmitter {
      writableLength = 0;
      destroyed = false;
      readonly writes: string[] = [];
      write(value: string): boolean {
        this.writes.push(value);
        this.writableLength += Buffer.byteLength(value);
        return false;
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
    writer.append({ type: "dropped-while-saturated" });
    const closing = writer.close({ pendingInputs: 2, droppedInputs: 1 });
    stream.writableLength = 0;
    stream.emit("drain");
    const report = await closing;
    expect(report).toMatchObject({
      acceptedRecords: 1,
      droppedRecords: 1,
      pendingInputs: 2,
      droppedInputs: 1,
      failed: false,
    });
    expect(stream.writes.at(-1)).toContain('"type":"performance.trace.summary"');
    expect(stream.destroyed).toBe(true);
    expect(stream.listenerCount("drain")).toBe(0);
    expect(stream.listenerCount("error")).toBe(0);
  });
});
