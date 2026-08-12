import { describe, expect, it } from "vitest";

import { createReferencePerformanceTraceSink } from "./reference-performance-trace.ts";

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
    });
    expect(records).toHaveLength(1);
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
    });
    expect(records).toHaveLength(1);
  });
});
