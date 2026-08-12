import type { PerformanceStage } from "@tmux-ide/contracts";

export interface SessionRuntimeStageSpan {
  readonly stage: PerformanceStage;
  readonly startedAtMicros: number;
  readonly endedAtMicros: number;
  readonly operation: string;
}

export interface SessionRuntimeObservabilitySnapshot {
  readonly spans: readonly SessionRuntimeStageSpan[];
  readonly droppedSpans: number;
}

/**
 * A deliberately tiny hot-path contract. Production receives the frozen
 * disabled singleton, so callers can guard on `enabled` before reading a
 * clock or allocating a span. Qualification builds use a bounded ring.
 */
export interface SessionRuntimeObservability {
  readonly enabled: boolean;
  nowMicros(): number;
  recordSpan(
    stage: PerformanceStage,
    operation: string,
    startedAtMicros: number,
    endedAtMicros: number,
  ): void;
  snapshot(): SessionRuntimeObservabilitySnapshot;
}

const EMPTY_SNAPSHOT: SessionRuntimeObservabilitySnapshot = Object.freeze({
  spans: Object.freeze([]),
  droppedSpans: 0,
});

export const DISABLED_SESSION_RUNTIME_OBSERVABILITY: SessionRuntimeObservability = Object.freeze({
  enabled: false,
  nowMicros: () => 0,
  recordSpan: () => undefined,
  snapshot: () => EMPTY_SNAPSHOT,
});

export function createSessionRuntimeObservability(
  options: {
    readonly nowMicros?: () => number;
    readonly capacity?: number;
  } = {},
): SessionRuntimeObservability {
  const capacity = options.capacity ?? 1_024;
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 65_536)
    throw new TypeError("Runtime observability capacity must be in [1, 65536]");
  const nowMicros = options.nowMicros ?? (() => Math.floor(performance.now() * 1_000));
  const spans: SessionRuntimeStageSpan[] = [];
  let cursor = 0;
  let droppedSpans = 0;
  return Object.freeze({
    enabled: true,
    nowMicros,
    recordSpan(
      stage: PerformanceStage,
      operation: string,
      startedAtMicros: number,
      endedAtMicros: number,
    ) {
      const span = Object.freeze({ stage, operation, startedAtMicros, endedAtMicros });
      if (spans.length < capacity) spans.push(span);
      else {
        spans[cursor] = span;
        cursor = (cursor + 1) % capacity;
        droppedSpans += 1;
      }
    },
    snapshot() {
      const ordered =
        spans.length < capacity || cursor === 0
          ? [...spans]
          : [...spans.slice(cursor), ...spans.slice(0, cursor)];
      return Object.freeze({ spans: Object.freeze(ordered), droppedSpans });
    },
  });
}
