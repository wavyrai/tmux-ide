import { randomUUID } from "node:crypto";
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import {
  installTuiPerformanceEventSink,
  type TuiPerformanceEventSink,
  type TuiTerminalDeliveryPerformanceEvent,
  type TuiTerminalCanonicalPaintEvent,
  type TuiTerminalCanonicalPublicationEvent,
  type TuiTerminalCanonicalUpdateEvent,
  type TuiTerminalCanonicalHostFrameEvent,
  type TuiTerminalFrameFenceEvent,
  type TuiTerminalCanonicalModeEvent,
  type TuiTerminalInputQueueStateEvent,
  type TuiTerminalTraceStageEvent,
  type TuiTerminalTraceSpanEvent,
} from "./performance-events.ts";

const TRACE_PATH = process.env.TMUX_IDE_PERFORMANCE_TRACE_LOG;
const SOURCE_COMMIT = process.env.TMUX_IDE_PERFORMANCE_TRACE_COMMIT;
const SOURCE_TREE = process.env.TMUX_IDE_PERFORMANCE_TRACE_TREE;
const DETAILED_TRACE = process.env.TMUX_IDE_PERFORMANCE_TRACE_DETAIL === "1";
const MAX_PENDING_INPUTS = 256;
const INPUT_EXPIRY_MICROS = 5_000_000;
const MAX_TRACE_RECORD_BYTES = 64 * 1_024;
const MAX_PENDING_TRACE_BYTES = 1 * 1_024 * 1_024;

export interface ReferenceTraceDroppedRecordKind {
  readonly type: string | null;
  readonly stage: string | null;
  readonly operation: string | null;
}

export interface ReferenceTraceWriterSnapshot {
  readonly acceptedRecords: number;
  readonly droppedRecords: number;
  readonly oversizedRecords: number;
  readonly writableLength: number;
  readonly pendingBytes: number;
  readonly pendingRecords: number;
  readonly pendingStorageSlots: number;
  readonly peakPendingBytes: number;
  readonly saturated: boolean;
  readonly failed: boolean;
  readonly firstDroppedRecord: ReferenceTraceDroppedRecordKind | null;
}

export interface ReferenceTraceCollectorReport extends ReferenceTraceWriterSnapshot {
  readonly pendingInputs: number;
  readonly droppedInputs: number;
}

interface ReferencePerformanceTraceSink extends TuiPerformanceEventSink {
  snapshot(): { readonly pendingInputs: number; readonly droppedInputs: number };
  close(): { readonly pendingInputs: number; readonly droppedInputs: number };
}

interface ActiveCollector {
  readonly sink: ReferencePerformanceTraceSink;
  readonly writer: ReturnType<typeof createReferenceTraceWriter>;
  readonly uninstall: () => void;
  closePromise: Promise<ReferenceTraceCollectorReport> | null;
}

export interface ReferenceTraceWritable {
  readonly writableLength: number;
  readonly destroyed: boolean;
  on(event: "error" | "drain", listener: () => void): unknown;
  once(event: "error" | "drain", listener: () => void): unknown;
  off(event: "error" | "drain", listener: () => void): unknown;
  write(value: string): boolean;
  end(value: string, callback: () => void): unknown;
  destroy(): unknown;
}

let activeCollector: ActiveCollector | null = null;

/**
 * Installs only for an explicit reference run. Ordinary production returns
 * before constructing a sink, clock, UUID, directory, or file descriptor.
 */
export function installReferencePerformanceTraceCollectorFromEnvironment(): void {
  if (activeCollector || !TRACE_PATH) return;
  if (!SOURCE_COMMIT || !SOURCE_TREE)
    throw new Error("Reference trace collection requires source commit and tree provenance");
  mkdirSync(dirname(TRACE_PATH), { recursive: true });
  const writer = createReferenceTraceWriter(
    createWriteStream(TRACE_PATH, { flags: "a", highWaterMark: MAX_TRACE_RECORD_BYTES }),
  );
  const sink = createReferencePerformanceTraceSink({
    commit: SOURCE_COMMIT,
    tree: SOURCE_TREE,
    detailed: DETAILED_TRACE,
    append: writer.append,
    health: writer.snapshot,
  });
  const uninstall = installTuiPerformanceEventSink(sink);
  activeCollector = { sink, writer, uninstall, closePromise: null };
}

/** Awaited shutdown boundary: stop admission, flush/end the stream, and reset. */
export function closeReferencePerformanceTraceCollector(): Promise<ReferenceTraceCollectorReport | null> {
  const collector = activeCollector;
  if (!collector) return Promise.resolve(null);
  if (collector.closePromise) return collector.closePromise;
  collector.uninstall();
  const sink = collector.sink.close();
  collector.closePromise = collector.writer.close(sink).finally(() => {
    if (activeCollector === collector) activeCollector = null;
  });
  return collector.closePromise;
}

/** Bounded streaming writer exported only so backpressure can be proven. */
export function createReferenceTraceWriter(
  stream: ReferenceTraceWritable,
  options: { readonly maxPendingBytes?: number } = {},
): {
  readonly append: (value: Readonly<Record<string, unknown>>) => void;
  readonly snapshot: () => ReferenceTraceWriterSnapshot;
  readonly close: (sink: {
    readonly pendingInputs: number;
    readonly droppedInputs: number;
  }) => Promise<ReferenceTraceCollectorReport>;
} {
  let acceptedRecords = 0;
  let droppedRecords = 0;
  let oversizedRecords = 0;
  let saturated = false;
  let failed = false;
  let closed = false;
  let closePromise: Promise<ReferenceTraceCollectorReport> | null = null;
  let pendingBytes = 0;
  let peakPendingBytes = 0;
  let firstDroppedRecord: ReferenceTraceDroppedRecordKind | null = null;
  const maxPendingBytes = options.maxPendingBytes ?? MAX_PENDING_TRACE_BYTES;
  if (!Number.isSafeInteger(maxPendingBytes) || maxPendingBytes <= 0)
    throw new TypeError("Reference trace pending-byte limit must be a positive safe integer");
  type PendingRecord = {
    readonly line: string;
    readonly bytes: number;
    readonly kind: ReferenceTraceDroppedRecordKind;
  };
  const pending: Array<PendingRecord | undefined> = [];
  let pendingIndex = 0;
  const pendingCount = () => pending.length - pendingIndex;
  const flushWaiters = new Set<() => void>();
  const settleFlushWaiters = () => {
    if (!failed && (saturated || pendingCount() > 0)) return;
    for (const resolve of flushWaiters) resolve();
    flushWaiters.clear();
  };
  const discardPending = () => {
    firstDroppedRecord ??= pending[pendingIndex]?.kind ?? null;
    droppedRecords += pendingCount();
    pending.length = 0;
    pendingIndex = 0;
    pendingBytes = 0;
  };
  const onError = () => {
    failed = true;
    discardPending();
    settleFlushWaiters();
  };
  const writeLine = (line: string): boolean => {
    saturated = !stream.write(line);
    acceptedRecords += 1;
    return !saturated;
  };
  const flushPending = () => {
    if (failed) return;
    saturated = false;
    while (pendingIndex < pending.length) {
      const next = pending[pendingIndex++]!;
      pending[pendingIndex - 1] = undefined;
      pendingBytes -= next.bytes;
      try {
        if (!writeLine(next.line)) break;
      } catch {
        failed = true;
        droppedRecords += 1;
        firstDroppedRecord ??= next.kind;
        discardPending();
        break;
      }
    }
    if (pendingIndex === pending.length) {
      pending.length = 0;
      pendingIndex = 0;
    } else if (pendingIndex >= 1_024 || pendingIndex * 2 >= pending.length) {
      pending.splice(0, pendingIndex);
      pendingIndex = 0;
    }
    settleFlushWaiters();
  };
  const onDrain = () => flushPending();
  stream.on("error", onError);
  stream.on("drain", onDrain);

  const snapshot = (): ReferenceTraceWriterSnapshot =>
    Object.freeze({
      acceptedRecords,
      droppedRecords,
      oversizedRecords,
      writableLength: stream.writableLength,
      pendingBytes,
      pendingRecords: pendingCount(),
      pendingStorageSlots: pending.length,
      peakPendingBytes,
      saturated,
      failed,
      firstDroppedRecord,
    });
  const append = (value: Readonly<Record<string, unknown>>): void => {
    if (closed || failed) {
      droppedRecords += 1;
      firstDroppedRecord ??= droppedRecordKind(value);
      return;
    }
    const line = `${JSON.stringify(value)}\n`;
    const bytes = Buffer.byteLength(line);
    if (bytes > MAX_TRACE_RECORD_BYTES) {
      oversizedRecords += 1;
      return;
    }
    try {
      if (!saturated && pendingCount() === 0) {
        writeLine(line);
        return;
      }
      if (pendingBytes + bytes > maxPendingBytes) {
        droppedRecords += 1;
        firstDroppedRecord ??= droppedRecordKind(value);
        return;
      }
      pending.push({ line, bytes, kind: droppedRecordKind(value) });
      pendingBytes += bytes;
      peakPendingBytes = Math.max(peakPendingBytes, pendingBytes);
    } catch {
      failed = true;
      droppedRecords += 1;
      firstDroppedRecord ??= droppedRecordKind(value);
      discardPending();
      settleFlushWaiters();
    }
  };
  const close = (sink: {
    readonly pendingInputs: number;
    readonly droppedInputs: number;
  }): Promise<ReferenceTraceCollectorReport> => {
    if (closePromise) return closePromise;
    closed = true;
    closePromise = (async () => {
      if (!failed && (saturated || pendingCount() > 0))
        await new Promise<void>((resolve) => flushWaiters.add(resolve));
      let report = Object.freeze({ ...snapshot(), ...sink });
      if (!failed) {
        const summary = `${JSON.stringify({
          version: 1,
          type: "performance.trace.summary",
          ...report,
        })}\n`;
        await new Promise<void>((resolve) => {
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            stream.off("error", finish);
            resolve();
          };
          stream.once("error", finish);
          try {
            stream.end(summary, finish);
          } catch {
            failed = true;
            finish();
          }
        });
        report = Object.freeze({ ...snapshot(), ...sink });
      }
      if (failed && !stream.destroyed) {
        stream.destroy();
      }
      stream.off("error", onError);
      stream.off("drain", onDrain);
      return report;
    })();
    return closePromise;
  };
  return Object.freeze({ append, snapshot, close });
}

function droppedRecordKind(
  value: Readonly<Record<string, unknown>>,
): ReferenceTraceDroppedRecordKind {
  const field = (key: "type" | "stage" | "operation") =>
    typeof value[key] === "string" ? value[key].slice(0, 64) : null;
  return Object.freeze({
    type: field("type"),
    stage: field("stage"),
    operation: field("operation"),
  });
}

export function createReferencePerformanceTraceSink(options: {
  readonly commit: string;
  readonly tree: string;
  readonly append: (value: Readonly<Record<string, unknown>>) => void;
  readonly health?: () => Pick<
    ReferenceTraceWriterSnapshot,
    "droppedRecords" | "oversizedRecords" | "failed"
  >;
  readonly nowMicros?: () => number;
  readonly createTraceId?: () => string;
  readonly processId?: string;
  readonly startedAt?: string;
  /** Keep false for the unperturbed input→changed-cell qualification path. */
  readonly detailed?: boolean;
}): ReferencePerformanceTraceSink {
  const nowMicros = options.nowMicros ?? (() => Math.floor(performance.now() * 1_000));
  const createTraceId = options.createTraceId ?? randomUUID;
  const processId = options.processId ?? `opentui:${process.pid}`;
  const detailed = options.detailed ?? false;
  options.append({
    version: 1,
    type: "performance.trace.header",
    commit: options.commit,
    tree: options.tree,
    processId,
    clockId: "opentui-performance-now",
    clockKind: "performance-now",
    startedAt: options.startedAt ?? new Date().toISOString(),
  });
  const inputs = new Map<
    string,
    {
      readonly startedAtMicros: number;
      readonly expiresAtMicros: number;
      endedAtMicros: number | null;
    }
  >();
  let droppedInputs = 0;
  let closed = false;
  const snapshot = () => Object.freeze({ pendingInputs: inputs.size, droppedInputs });
  return Object.freeze({
    frame: (intervalMs: number) => {
      if (!detailed || closed) return;
      options.append({
        version: 1,
        type: "performance.frame",
        processId,
        clockId: "opentui-performance-now",
        atMicros: nowMicros(),
        intervalMs,
      });
    },
    terminalPaint: (dirtyRows: number, durationMs: number) => {
      if (!detailed || closed) return;
      options.append({
        version: 1,
        type: "performance.terminal-paint",
        processId,
        clockId: "opentui-performance-now",
        atMicros: nowMicros(),
        dirtyRows,
        durationMs,
      });
    },
    terminalDelivery: (event: TuiTerminalDeliveryPerformanceEvent) => {
      if (!detailed || closed) return;
      options.append({
        version: 1,
        type: "performance.terminal-delivery",
        processId,
        clockId: "opentui-performance-now",
        atMicros: nowMicros(),
        ...event,
      });
    },
    ...(detailed
      ? {
          terminalCanonicalPublication: (event: TuiTerminalCanonicalPublicationEvent) => {
            if (!closed)
              options.append({
                version: 1,
                type: "performance.terminal-canonical-publication",
                ...event,
              });
          },
          terminalCanonicalPaint: (event: TuiTerminalCanonicalPaintEvent) => {
            if (!closed)
              options.append({
                version: 1,
                type: "performance.terminal-canonical-paint",
                ...event,
              });
          },
          terminalCanonicalUpdate: (event: TuiTerminalCanonicalUpdateEvent) => {
            if (!closed)
              options.append({
                version: 1,
                type: "performance.terminal-canonical-update",
                ...event,
              });
          },
          terminalCanonicalHostFrame: (event: TuiTerminalCanonicalHostFrameEvent) => {
            if (!closed)
              options.append({
                version: 1,
                type: "performance.terminal-canonical-host-frame",
                ...event,
              });
          },
          terminalFrameFence: (event: TuiTerminalFrameFenceEvent) => {
            if (!closed) {
              const health = options.health?.() ?? null;
              options.append({
                version: 1,
                type: "performance.terminal-frame-fence",
                processId,
                clockId: "opentui-performance-now",
                clockKind: "performance-now",
                atMicros: nowMicros(),
                ...event,
                writerHealth: health
                  ? Object.freeze({
                      droppedRecords: health.droppedRecords,
                      oversizedRecords: health.oversizedRecords,
                      failed: health.failed,
                    })
                  : null,
              });
            }
          },
          terminalInputQueueState: (event: TuiTerminalInputQueueStateEvent) => {
            if (!closed)
              options.append({ version: 1, type: "performance.input-queue-state", ...event });
          },
          terminalCanonicalMode: (event: TuiTerminalCanonicalModeEvent) => {
            if (!closed)
              options.append({ version: 1, type: "performance.terminal-canonical-mode", ...event });
          },
        }
      : {}),
    beginTerminalInput: () => {
      const startedAtMicros = nowMicros();
      expireInputs(inputs, startedAtMicros);
      // The transport carries one latest-only performance trace id. Once a
      // newer input is admitted, an older probe can no longer be attributed to
      // the exact changed-cell paint without lying. Retire it as superseded;
      // `droppedInputs` is reserved for actual capacity loss.
      inputs.clear();
      while (inputs.size >= MAX_PENDING_INPUTS) {
        inputs.delete(inputs.keys().next().value!);
        droppedInputs += 1;
      }
      const traceId = createTraceId();
      inputs.set(traceId, {
        startedAtMicros,
        expiresAtMicros: startedAtMicros + INPUT_EXPIRY_MICROS,
        endedAtMicros: null,
      });
      let finished = false;
      return Object.freeze({
        traceId,
        finish: () => {
          if (finished) return;
          finished = true;
          const input = inputs.get(traceId);
          if (input) input.endedAtMicros = nowMicros();
        },
        cancel: () => inputs.delete(traceId),
      });
    },
    terminalTraceSpan: (paint: TuiTerminalTraceSpanEvent) =>
      recordCompletedTrace(inputs, paint, options.append),
    terminalTraceStage: (event: TuiTerminalTraceStageEvent) => {
      if (detailed && !closed) options.append({ version: 1, type: "performance.stage", ...event });
    },
    snapshot,
    close: () => {
      if (closed) return snapshot();
      closed = true;
      // Shutdown cancels probes that can no longer observe a future paint.
      // They are not backpressure loss and must not survive as phantom work in
      // a closed collector summary.
      inputs.clear();
      return snapshot();
    },
  });
}

function recordCompletedTrace(
  inputs: Map<
    string,
    {
      readonly startedAtMicros: number;
      readonly expiresAtMicros: number;
      endedAtMicros: number | null;
    }
  >,
  paint: TuiTerminalTraceSpanEvent,
  appendRecord: (value: Readonly<Record<string, unknown>>) => void,
): void {
  const input = inputs.get(paint.traceId);
  if (!input || input.endedAtMicros === null) return;
  if (paint.startedAtMicros > input.expiresAtMicros) {
    inputs.delete(paint.traceId);
    return;
  }
  inputs.delete(paint.traceId);
  appendRecord({
    version: 1,
    type: "performance.stage",
    traceId: paint.traceId,
    scenario: paint.scenario,
    stage: "input",
    processId: paint.processId,
    clockId: paint.clockId,
    clockKind: paint.clockKind,
    startedAtMicros: input.startedAtMicros,
    endedAtMicros: input.endedAtMicros,
    authority: { generation: paint.generation, incarnation: paint.incarnation },
  });
  appendRecord({ version: 1, type: "performance.stage", ...paint });
}

function expireInputs(
  inputs: Map<string, { readonly expiresAtMicros: number }>,
  nowMicros: number,
): void {
  for (const [traceId, input] of inputs) {
    if (input.expiresAtMicros > nowMicros) break;
    inputs.delete(traceId);
  }
}
