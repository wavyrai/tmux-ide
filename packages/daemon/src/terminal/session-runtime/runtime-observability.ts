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
  readonly terminalDelivery?: Readonly<{
    readonly representationCacheBytes?: number;
    readonly rawJournalBytes?: number;
    readonly queueDepth?: number;
    readonly maxQueueDepth?: number;
    readonly inFlight?: number;
    readonly inFlightBytes?: number;
    readonly representation?: "patch" | "seed" | "tombstone";
    readonly representationBytes?: number;
    readonly attemptedPatchBytes?: number | null;
    readonly attemptedSeedBytes?: number | null;
    readonly attemptedLegacyPatchBytes?: number | null;
    readonly attemptedLegacySeedBytes?: number | null;
    readonly attemptedLegacyPatchAtLeastBytes?: number | null;
    readonly attemptedLegacySeedAtLeastBytes?: number | null;
    readonly attemptedLegacyPatchSizeCapped?: boolean;
    readonly attemptedLegacySeedSizeCapped?: boolean;
    readonly attemptedCompactPatchBytes?: number | null;
    readonly attemptedCompactSeedBytes?: number | null;
    readonly selectedEncoding?: "semantic-v1" | "semantic-compact-v1";
    readonly selectionStatus?:
      | "patch-preferred"
      | "seed-preferred"
      | "patch-fallback"
      | "legacy-patch-fallback"
      | "legacy-seed-fallback"
      | "direct-seed"
      | "direct-tombstone";
    readonly workspaceName?: string;
    readonly semanticPaneId?: string;
    readonly canonicalGeneration?: string;
    readonly canonicalIncarnation?: string;
    readonly canonicalRevision?: number;
    readonly canonicalStateHash?: string;
    readonly deliveryOrdinal?: number;
    readonly transactionId?: string;
    readonly deliveryClientId?: string;
    readonly deliverySurface?: string;
    readonly deliveryLaneId?: string;
    readonly deliveryNonce?: string;
    readonly deliveryLifecycleEvent?: "open" | "close";
    readonly deliveryPurpose?: "terminal-surface";
    readonly deliveryLifecycleOrdinal?: number;
    readonly deliveryStatusOrdinal?: number;
    readonly paneStreamCloseCode?: number;
    readonly paneStreamCloseReason?:
      | "none"
      | "stream-retired"
      | "stream-unavailable"
      | "stream-closed"
      | "topology-changed"
      | "output-backpressure"
      | "panes-closed"
      | "peer-closed"
      | "daemon-shutdown"
      | "redemption-rejected"
      | "unknown";
    readonly deliveryVisibility?: "visible" | "background" | "hidden" | "frozen";
    readonly deliveryBaselineRevision?: number;
    readonly deliveryBaselineHash?: string | null;
    readonly deliveryInFlightRevision?: number | null;
    readonly deliveryInFlightHash?: string | null;
    readonly deliveryLatestRevision?: number | null;
    readonly deliveryClientQueueDepth?: number;
    readonly deliveryRequestId?: string;
    readonly faultReason?: "state-too-large" | "source-closed" | "protocol-violation";
    readonly mirrorFlowPhase?:
      | "pause"
      | "continue-request"
      | "continue-reply"
      | "continue-notify"
      | "provisional-reseed"
      | "final-continue-request"
      | "final-continue-reply"
      | "final-reseed"
      | "confirmation-reseed"
      | "converged"
      | "nonconverged";
    readonly mirrorFlowRecoveryOrdinal?: number;
    readonly mirrorPaneIncarnation?: number;
    readonly mirrorOutputOrdinal?: number;
    readonly mirrorRecoveryElapsedMicros?: number;
    readonly mirrorRecoveryFingerprintExact?: boolean;
    readonly mirrorRecoveryConfirmationOrdinal?: number;
    readonly mirrorCollectorStarted?: boolean;
    readonly mirrorCollectorLastCompletedOrdinal?: number;
    readonly mirrorCollectorCaptureLineCount?: number;
    readonly mirrorCollectorCaptureByteCount?: number;
    readonly mirrorCollectorContinueObserved?: boolean;
    readonly mirrorCollectorStatusObserved?: boolean;
    readonly mirrorCollectorObserverEmissionObserved?: boolean;
    readonly mirrorCollectorFailureReason?:
      | "busy"
      | "channel-exit"
      | "foreign-sentinel"
      | "duplicate-sentinel"
      | "sentinel-order"
      | "capture-byte-cap"
      | "capture-line-cap"
      | "cursor-cardinality"
      | "cursor-byte-cap"
      | "unexpected-post-line"
      | "marker-rejected"
      | "timeout"
      | "retired";
    readonly mirrorFlowFailureReason?:
      | "command-error"
      | "command-timeout"
      | "notification-queue-overflow"
      | "no-progress"
      | "absolute-deadline"
      | "attempts-exhausted";
  }>;
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
    terminalDelivery?: SessionRuntimeStageSpan["terminalDelivery"],
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
      terminalDelivery?: SessionRuntimeStageSpan["terminalDelivery"],
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
        ...(terminalDelivery ? { terminalDelivery: Object.freeze({ ...terminalDelivery }) } : {}),
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
