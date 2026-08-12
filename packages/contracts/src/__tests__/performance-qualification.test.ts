import { describe, expect, it } from "vitest";

import {
  ClientQueueMetricV1SchemaZ,
  MutationTerminalOutcomeV1SchemaZ,
  PERFORMANCE_STAGE_ORDER,
  PerformanceTraceV1SchemaZ,
} from "../performance-qualification.ts";

function span(stage: (typeof PERFORMANCE_STAGE_ORDER)[number], index: number) {
  return {
    version: 1,
    stage,
    processId: stage === "input" || stage === "paint" ? "web-a" : "daemon-a",
    clockId: stage === "input" || stage === "paint" ? "browser-monotonic" : "node-hrtime",
    clockKind: stage === "input" || stage === "paint" ? "performance-now" : "hrtime",
    startedAtMicros: index * 100,
    endedAtMicros: index * 100 + 50,
  } as const;
}

describe("performance qualification contracts", () => {
  it("accepts ordered local spans without comparing clocks across processes", () => {
    const value = PerformanceTraceV1SchemaZ.parse({
      version: 1,
      traceId: "00000000-0000-4000-8000-000000000002",
      scenario: "leading-edge-input",
      stages: PERFORMANCE_STAGE_ORDER.map(span),
      localInputToPaint: {
        version: 1,
        processId: "web-a",
        clockId: "browser-monotonic",
        clockKind: "performance-now",
        startedAtMicros: 0,
        endedAtMicros: 20_000,
      },
    });
    expect(value.stages.map(({ stage }) => stage)).toEqual(PERFORMANCE_STAGE_ORDER);
    expect(Object.isFrozen(value)).toBe(true);
  });

  it("rejects malformed monotonic spans and incomplete/reordered pipelines", () => {
    const base = {
      version: 1,
      traceId: "00000000-0000-4000-8000-000000000002",
      scenario: "input",
      stages: PERFORMANCE_STAGE_ORDER.map(span),
      localInputToPaint: {
        version: 1,
        processId: "web-a",
        clockId: "browser-monotonic",
        clockKind: "performance-now",
        startedAtMicros: 20,
        endedAtMicros: 10,
      },
    };
    expect(() => PerformanceTraceV1SchemaZ.parse(base)).toThrow(/ends before/u);
    expect(() =>
      PerformanceTraceV1SchemaZ.parse({
        ...base,
        localInputToPaint: { ...base.localInputToPaint, endedAtMicros: 30 },
        stages: [...base.stages].reverse(),
      }),
    ).toThrow(/expected input/u);
    expect(() =>
      PerformanceTraceV1SchemaZ.parse({
        ...base,
        localInputToPaint: {
          ...base.localInputToPaint,
          processId: "other-client",
          endedAtMicros: 30,
        },
      }),
    ).toThrow(/share one client clock domain/u);
    expect(() =>
      PerformanceTraceV1SchemaZ.parse({
        ...base,
        localInputToPaint: {
          ...base.localInputToPaint,
          startedAtMicros: 1,
          endedAtMicros: 60_000,
        },
      }),
    ).toThrow(/contain the local input and paint/u);
    const causal = PERFORMANCE_STAGE_ORDER.map(span);
    causal[0] = { ...causal[0]!, endedAtMicros: causal[5]!.startedAtMicros + 1 };
    expect(() =>
      PerformanceTraceV1SchemaZ.parse({
        ...base,
        stages: causal,
        localInputToPaint: {
          ...base.localInputToPaint,
          startedAtMicros: 0,
          endedAtMicros: 60_000,
        },
      }),
    ).toThrow(/input must complete before local paint/u);
  });

  it("bounds queue dimensions and controlled vocabularies", () => {
    const queue = {
      version: 1,
      clientId: "web-a",
      disposition: "slow",
      queue: "terminal",
      sampleOrdinal: 0,
      depthItems: 4,
      capacityItems: 3,
      bytes: 4,
      capacityBytes: 8,
      coalesced: 0,
      dropped: 0,
    } as const;
    expect(() => ClientQueueMetricV1SchemaZ.parse(queue)).toThrow(/exceeds capacity/u);
    expect(() =>
      ClientQueueMetricV1SchemaZ.parse({ ...queue, depthItems: 1, queue: "misc" }),
    ).toThrow();
    expect(() =>
      MutationTerminalOutcomeV1SchemaZ.parse({
        version: 1,
        mutationId: "00000000-0000-4000-8000-000000000003",
        status: "done",
      }),
    ).toThrow();
    expect(() =>
      MutationTerminalOutcomeV1SchemaZ.parse({
        version: 1,
        mutationId: "00000000-0000-4000-8000-000000000003",
        processId: "daemon-a",
        clockId: "node-hrtime",
        clockKind: "hrtime",
        occurredAtMicros: 10,
        status: "observed",
      }),
    ).toThrow(/observed requires identity/u);
  });
});
