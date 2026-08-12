import { describe, expect, it } from "vitest";

import {
  PERFORMANCE_STAGE_ORDER,
  type ClientConvergenceObservationV1,
  type MutationQualificationAcceptanceV1,
  type MutationTerminalOutcomeV1,
  type PerformanceTraceV1,
} from "@tmux-ide/contracts";

import {
  createStateConvergenceIdentity,
  deterministicPercentile,
  evaluateMutationOutcomes,
  evaluatePerformanceBudget,
  evaluateQueueBounds,
  evaluateQueuePlateau,
  evaluateSlowClientIsolation,
  evaluateStateConvergence,
} from "./performance-qualification.ts";
import { blankTerminalReplicaSnapshot, hashTerminalReplicaSnapshot } from "./terminal-replica.ts";

const generation = "00000000-0000-4000-8000-000000000001";

function trace(index: number, durationMicros: number): PerformanceTraceV1 {
  return {
    version: 1,
    traceId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    scenario: "leading-edge-input",
    stages: PERFORMANCE_STAGE_ORDER.map((stage, stageIndex) => {
      const local = stage === "input" || stage === "paint";
      const startedAtMicros =
        stage === "input"
          ? 1_000_000
          : stage === "paint"
            ? 1_000_000 + durationMicros - 100
            : stageIndex * 10_000;
      return {
        version: 1,
        stage,
        processId: local ? "web-a" : "daemon-a",
        clockId: local ? "browser" : "node",
        clockKind: local ? "performance-now" : "hrtime",
        startedAtMicros,
        endedAtMicros: startedAtMicros + (local ? 100 : stageIndex + 1_000),
      };
    }),
    localInputToPaint: {
      version: 1,
      processId: "web-a",
      clockId: "browser",
      clockKind: "performance-now",
      startedAtMicros: 1_000_000,
      endedAtMicros: 1_000_000 + durationMicros,
    },
  };
}

describe("performance qualification", () => {
  it("uses deterministic nearest-rank percentiles and the exact 60 Hz budget", () => {
    const values = Array.from({ length: 20 }, (_, index) => index + 1);
    expect(deterministicPercentile(values, 0.95)).toBe(19);
    expect(deterministicPercentile([...values].reverse(), 0.95)).toBe(19);
    expect(() => deterministicPercentile([1, Number.NaN], 0.95)).toThrow(/finite/u);

    const atBudget = evaluatePerformanceBudget(
      Array.from({ length: 20 }, (_, index) => trace(index + 1, index === 19 ? 30_000 : 16_670)),
    );
    expect(atBudget.inputToPaint.p95Ms).toBe(16.67);
    expect(atBudget.passed).toBe(true);
    expect(evaluatePerformanceBudget([trace(99, 16_669)]).passed).toBe(true);
    const overBudget = evaluatePerformanceBudget(
      Array.from({ length: 20 }, (_, index) => trace(index + 21, index < 19 ? 16_671 : 30_000)),
    );
    expect(overBudget.passed).toBe(false);
  });

  it("summarizes each stage from local spans and is input-order invariant", () => {
    const base = trace(1, 8_000);
    const crossClock: PerformanceTraceV1 = {
      ...base,
      stages: base.stages.map((span, index) =>
        index === 1
          ? { ...span, startedAtMicros: 9_000_000_000, endedAtMicros: 9_000_001_000 }
          : span,
      ),
    };
    const forward = [crossClock, trace(2, 12_000), trace(3, 10_000)];
    expect(evaluatePerformanceBudget(forward)).toEqual(
      evaluatePerformanceBudget([...forward].reverse()),
    );
    expect(evaluatePerformanceBudget(forward).stages.tmux.p95Ms).toBe(1.001);
    expect(evaluatePerformanceBudget(forward).stages.paint.p95Ms).toBe(0.1);
  });

  it("preserves the canonical terminal hash and converges 2/4/8 clients", () => {
    const snapshot = blankTerminalReplicaSnapshot(4, 2);
    const canonicalStateHash = hashTerminalReplicaSnapshot(snapshot);
    const expected = createStateConvergenceIdentity(generation, "pane-a:1", 42, canonicalStateHash);
    expect(expected.stateHash).toBe(canonicalStateHash);
    expect(expected.hashAlgorithm).toBe("fnv1a64-v1");
    expect(() =>
      createStateConvergenceIdentity(generation, "pane-a:1", 42, "not-a-hash"),
    ).toThrow();
    for (const count of [2, 4, 8]) {
      const observations: ClientConvergenceObservationV1[] = Array.from(
        { length: count },
        (_, index) => ({
          version: 1,
          clientId: `client-${index}`,
          disposition: "healthy",
          identity: expected,
        }),
      );
      const result = evaluateStateConvergence(expected, observations.reverse());
      expect(result.converged).toBe(true);
      expect(result.matchingClientIds).toEqual(
        Array.from({ length: count }, (_, index) => `client-${index}`).sort(),
      );
    }

    const divergent = createStateConvergenceIdentity(
      generation,
      "pane-a:1",
      43,
      hashTerminalReplicaSnapshot(blankTerminalReplicaSnapshot(5, 2)),
    );
    expect(
      evaluateStateConvergence(expected, [
        { version: 1, clientId: "slow", disposition: "slow", identity: divergent },
        { version: 1, clientId: "healthy", disposition: "healthy", identity: expected },
      ]),
    ).toMatchObject({ converged: true, excludedClientIds: ["slow"] });
    const newerIncarnation = createStateConvergenceIdentity(
      generation,
      "pane-a:2",
      42,
      canonicalStateHash,
    );
    expect(
      evaluateStateConvergence(expected, [
        { version: 1, clientId: "healthy", disposition: "healthy", identity: newerIncarnation },
      ]),
    ).toMatchObject({ converged: false, divergentClientIds: ["healthy"] });
  });

  it("qualifies bounded slow-client queues and healthy-client p95 isolation", () => {
    expect(
      evaluateQueueBounds([
        {
          version: 1,
          clientId: "slow",
          disposition: "slow",
          queue: "terminal",
          sampleOrdinal: 0,
          depthItems: 32,
          capacityItems: 32,
          bytes: 4_096,
          capacityBytes: 4_096,
          coalesced: 100,
          dropped: 2,
        },
      ]),
    ).toEqual({ bounded: true, maxDepthItems: 32, maxBytes: 4096, coalesced: 100, dropped: 2 });

    const baseline = [trace(1, 10_000), trace(2, 11_000)];
    expect(
      evaluateSlowClientIsolation(baseline, [trace(3, 10_500), trace(4, 11_500)], 0.5),
    ).toEqual({
      passed: true,
      baselineP95Ms: 11,
      contendedP95Ms: 11.5,
      regressionMs: 0.5,
      allowedRegressionMs: 0.5,
    });

    const queueSample = (sampleOrdinal: number, depthItems: number, bytes: number) => ({
      version: 1 as const,
      clientId: "slow",
      disposition: "slow" as const,
      queue: "terminal" as const,
      sampleOrdinal,
      depthItems,
      capacityItems: 32,
      bytes,
      capacityBytes: 4_096,
      coalesced: 0,
      dropped: 0,
    });
    expect(
      evaluateQueuePlateau([
        queueSample(0, 8, 1_024),
        queueSample(1, 8, 1_024),
        queueSample(2, 8, 1_024),
        queueSample(3, 8, 1_024),
      ]),
    ).toMatchObject({ plateaued: true, itemSlopePerSample: 0, byteSlopePerSample: 0 });
    expect(
      evaluateQueuePlateau([
        queueSample(0, 1, 100),
        queueSample(1, 2, 200),
        queueSample(2, 3, 300),
        queueSample(3, 4, 400),
      ]),
    ).toMatchObject({ plateaued: false, itemSlopePerSample: 1, byteSlopePerSample: 100 });
    expect(() =>
      evaluateQueuePlateau([
        queueSample(0, 1, 100),
        queueSample(1, 2, 200),
        queueSample(1, 3, 300),
        queueSample(3, 4, 400),
      ]),
    ).toThrow(/ordinals must increase/u);
  });

  it("rejects mutation limbo, duplicate terminals and unknown outcomes", () => {
    const accepted = (index: number): MutationQualificationAcceptanceV1 => ({
      version: 1,
      mutationId: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      processId: "daemon-a",
      clockId: "node-hrtime",
      clockKind: "hrtime",
      acceptedAtMicros: index * 100,
      deadlineAtMicros: index * 100 + 1_000,
    });
    const outcome = (
      acceptance: MutationQualificationAcceptanceV1,
      status: "observed" | "rejected" | "timed-out",
    ): MutationTerminalOutcomeV1 => ({
      version: 1,
      mutationId: acceptance.mutationId,
      processId: acceptance.processId,
      clockId: acceptance.clockId,
      clockKind: acceptance.clockKind,
      occurredAtMicros:
        status === "timed-out" ? acceptance.deadlineAtMicros : acceptance.acceptedAtMicros + 1,
      status,
      ...(status === "observed"
        ? {
            identity: createStateConvergenceIdentity(
              generation,
              "pane-a:1",
              1,
              hashTerminalReplicaSnapshot(blankTerminalReplicaSnapshot(1, 1)),
            ),
          }
        : { reason: status }),
    });
    const a = accepted(1);
    const b = accepted(2);
    expect(evaluateMutationOutcomes([a, b], [outcome(a, "observed")])).toMatchObject({
      complete: false,
      limboMutationIds: [b.mutationId],
    });
    expect(
      evaluateMutationOutcomes([a, b], [outcome(a, "observed"), outcome(b, "timed-out")]),
    ).toMatchObject({ complete: true, terminalCount: 2 });
    expect(
      evaluateMutationOutcomes([a], [outcome(a, "rejected"), outcome(a, "timed-out")]),
    ).toMatchObject({ complete: false, duplicateMutationIds: [a.mutationId] });
    const unknown = accepted(3);
    expect(evaluateMutationOutcomes([a], [outcome(unknown, "rejected")])).toMatchObject({
      complete: false,
      limboMutationIds: [a.mutationId],
      unknownMutationIds: [unknown.mutationId],
    });
    expect(
      evaluateMutationOutcomes(
        [a],
        [{ ...outcome(a, "observed"), occurredAtMicros: a.deadlineAtMicros + 1 }],
      ),
    ).toMatchObject({ complete: false, lateMutationIds: [a.mutationId] });
    expect(
      evaluateMutationOutcomes([a], [{ ...outcome(a, "rejected"), clockId: "other-clock" }]),
    ).toMatchObject({ complete: false, clockDomainMismatchMutationIds: [a.mutationId] });
    expect(
      evaluateMutationOutcomes(
        [a],
        [{ ...outcome(a, "timed-out"), occurredAtMicros: a.deadlineAtMicros - 1 }],
      ),
    ).toMatchObject({ complete: false, prematureTimeoutMutationIds: [a.mutationId] });
  });
});
