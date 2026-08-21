import type {
  MonotonicClockKind,
  PerformanceStage,
  SessionRuntimeGeneration,
} from "@tmux-ide/contracts";
import { randomUUID } from "node:crypto";
import { z } from "zod";

export interface SessionRuntimeTraceAuthority {
  readonly generation: SessionRuntimeGeneration;
  readonly incarnation: string | null;
}

export interface SessionRuntimeTraceContext {
  readonly traceId: string;
  readonly scenario: string;
  readonly authority: SessionRuntimeTraceAuthority;
}

export interface SessionRuntimeStageSpan {
  readonly traceId: string | null;
  readonly scenario: string | null;
  readonly authority: SessionRuntimeTraceAuthority | null;
  readonly stage: PerformanceStage;
  readonly processId: string;
  readonly clockId: string;
  readonly clockKind: MonotonicClockKind;
  readonly startedAtMicros: number;
  readonly endedAtMicros: number;
  readonly sharedStartedAtMicros?: number;
  readonly sharedEndedAtMicros?: number;
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
  beginTrace(
    scenario: string,
    authority: SessionRuntimeTraceAuthority,
    traceId?: string,
  ): SessionRuntimeTraceContext | null;
  recordSpan(
    stage: PerformanceStage,
    operation: string,
    startedAtMicros: number,
    endedAtMicros: number,
    trace?: SessionRuntimeTraceContext | null,
    shared?: { readonly startedAtMicros: number; readonly endedAtMicros: number },
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
  beginTrace: () => null,
  recordSpan: () => undefined,
  snapshot: () => EMPTY_SNAPSHOT,
});

export function createSessionRuntimeObservability(
  options: {
    readonly nowMicros?: () => number;
    readonly capacity?: number;
    readonly processId?: string;
    readonly clockId?: string;
    readonly clockKind?: MonotonicClockKind;
    readonly createTraceId?: () => string;
    readonly onSpan?: (span: SessionRuntimeStageSpan) => void;
  } = {},
): SessionRuntimeObservability {
  const capacity = options.capacity ?? 1_024;
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 65_536)
    throw new TypeError("Runtime observability capacity must be in [1, 65536]");
  const nowMicros = options.nowMicros ?? (() => Math.floor(performance.now() * 1_000));
  const processId = options.processId ?? `daemon:${process.pid}`;
  const clockId = options.clockId ?? "node-performance-now";
  const clockKind = options.clockKind ?? "performance-now";
  const createTraceId = options.createTraceId ?? randomUUID;
  const spans: SessionRuntimeStageSpan[] = [];
  let cursor = 0;
  let droppedSpans = 0;
  return Object.freeze({
    enabled: true,
    nowMicros,
    beginTrace(scenario: string, authority: SessionRuntimeTraceAuthority, traceId?: string) {
      return Object.freeze({
        traceId: z.uuid().parse(traceId ?? createTraceId()),
        scenario,
        authority,
      });
    },
    recordSpan(
      stage: PerformanceStage,
      operation: string,
      startedAtMicros: number,
      endedAtMicros: number,
      trace: SessionRuntimeTraceContext | null = null,
      shared?: { readonly startedAtMicros: number; readonly endedAtMicros: number },
    ) {
      const span = Object.freeze({
        traceId: trace?.traceId ?? null,
        scenario: trace?.scenario ?? null,
        authority: trace?.authority ?? null,
        stage,
        processId,
        clockId,
        clockKind,
        operation,
        startedAtMicros,
        endedAtMicros,
        ...(shared
          ? {
              sharedStartedAtMicros: shared.startedAtMicros,
              sharedEndedAtMicros: shared.endedAtMicros,
            }
          : {}),
      });
      if (spans.length < capacity) spans.push(span);
      else {
        spans[cursor] = span;
        cursor = (cursor + 1) % capacity;
        droppedSpans += 1;
      }
      options.onSpan?.(span);
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
