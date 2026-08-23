import { describe, expect, it } from "vitest";
import {
  DISABLED_SESSION_RUNTIME_OBSERVABILITY,
  createSessionRuntimeObservability,
} from "./runtime-observability.ts";

describe("session runtime observability", () => {
  it("is allocation- and clock-free when the production seam is disabled", () => {
    expect(DISABLED_SESSION_RUNTIME_OBSERVABILITY.enabled).toBe(false);
    expect(DISABLED_SESSION_RUNTIME_OBSERVABILITY.snapshot()).toEqual({
      spans: [],
      droppedSpans: 0,
    });
    expect(DISABLED_SESSION_RUNTIME_OBSERVABILITY.snapshot()).toBe(
      DISABLED_SESSION_RUNTIME_OBSERVABILITY.snapshot(),
    );
    expect(
      DISABLED_SESSION_RUNTIME_OBSERVABILITY.beginTrace("terminal-output", {
        generation: "11111111-1111-4111-8111-111111111111",
        incarnation: "pane:1",
      }),
    ).toBeNull();
  });

  it("retains only the newest deterministic local-clock spans", () => {
    let now = 0;
    const observer = createSessionRuntimeObservability({
      capacity: 2,
      nowMicros: () => (now += 10),
      processId: "daemon:test",
      clockId: "test-monotonic",
      createTraceId: () => "11111111-1111-4111-8111-111111111111",
    });
    const trace = observer.beginTrace("terminal-output", {
      generation: "22222222-2222-4222-8222-222222222222",
      incarnation: "pane:1",
    });
    for (const operation of ["first", "second", "third"]) {
      const start = observer.nowMicros();
      observer.recordSpan("parse", operation, start, observer.nowMicros(), trace);
    }
    expect(observer.snapshot()).toEqual({
      spans: [
        {
          traceId: "11111111-1111-4111-8111-111111111111",
          scenario: "terminal-output",
          authority: {
            generation: "22222222-2222-4222-8222-222222222222",
            incarnation: "pane:1",
          },
          stage: "parse",
          processId: "daemon:test",
          clockId: "test-monotonic",
          clockKind: "performance-now",
          operation: "second",
          startedAtMicros: 30,
          endedAtMicros: 40,
        },
        {
          traceId: "11111111-1111-4111-8111-111111111111",
          scenario: "terminal-output",
          authority: {
            generation: "22222222-2222-4222-8222-222222222222",
            incarnation: "pane:1",
          },
          stage: "parse",
          processId: "daemon:test",
          clockId: "test-monotonic",
          clockKind: "performance-now",
          operation: "third",
          startedAtMicros: 50,
          endedAtMicros: 60,
        },
      ],
      droppedSpans: 1,
    });
    expect(() =>
      observer.beginTrace(
        "terminal-input-to-paint",
        {
          generation: "22222222-2222-4222-8222-222222222222",
          incarnation: null,
        },
        "not-a-uuid",
      ),
    ).toThrow();
  });

  it("retains bounded terminal-delivery resource metrics only when explicitly supplied", () => {
    const observer = createSessionRuntimeObservability({ processId: "daemon:test" });
    observer.recordSpan("transport", "terminal-delivery-encode-enqueue", 10, 20, null, undefined, {
      representationCacheBytes: 1_024,
      rawJournalBytes: 2_048,
      queueDepth: 1,
      maxQueueDepth: 2,
      inFlight: 1,
      inFlightBytes: 512,
      semanticPaneId: "pane:alpha",
      mirrorFlowPhase: "nonconverged",
      mirrorFlowRecoveryOrdinal: 7,
      mirrorPaneIncarnation: 3,
      mirrorOutputOrdinal: 41,
      mirrorRecoveryElapsedMicros: 4_999_000,
      mirrorRecoveryFingerprintExact: false,
      mirrorRecoveryConfirmationOrdinal: 2,
      mirrorFlowFailureReason: "absolute-deadline",
    });
    expect(observer.snapshot().spans).toEqual([
      expect.objectContaining({
        terminalDelivery: {
          representationCacheBytes: 1_024,
          rawJournalBytes: 2_048,
          queueDepth: 1,
          maxQueueDepth: 2,
          inFlight: 1,
          inFlightBytes: 512,
          semanticPaneId: "pane:alpha",
          mirrorFlowPhase: "nonconverged",
          mirrorFlowRecoveryOrdinal: 7,
          mirrorPaneIncarnation: 3,
          mirrorOutputOrdinal: 41,
          mirrorRecoveryElapsedMicros: 4_999_000,
          mirrorRecoveryFingerprintExact: false,
          mirrorRecoveryConfirmationOrdinal: 2,
          mirrorFlowFailureReason: "absolute-deadline",
        },
      }),
    ]);
  });
});
