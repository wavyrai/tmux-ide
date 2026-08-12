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
  });

  it("retains only the newest deterministic local-clock spans", () => {
    let now = 0;
    const observer = createSessionRuntimeObservability({
      capacity: 2,
      nowMicros: () => (now += 10),
    });
    for (const operation of ["first", "second", "third"]) {
      const start = observer.nowMicros();
      observer.recordSpan("parse", operation, start, observer.nowMicros());
    }
    expect(observer.snapshot()).toEqual({
      spans: [
        { stage: "parse", operation: "second", startedAtMicros: 30, endedAtMicros: 40 },
        { stage: "parse", operation: "third", startedAtMicros: 50, endedAtMicros: 60 },
      ],
      droppedSpans: 1,
    });
  });
});
