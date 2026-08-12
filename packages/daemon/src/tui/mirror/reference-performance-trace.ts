import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import {
  installTuiPerformanceEventSink,
  type TuiPerformanceEventSink,
  type TuiTerminalTraceSpanEvent,
} from "./performance-events.ts";

const TRACE_PATH = process.env.TMUX_IDE_PERFORMANCE_TRACE_LOG;
const SOURCE_COMMIT = process.env.TMUX_IDE_PERFORMANCE_TRACE_COMMIT;
const SOURCE_TREE = process.env.TMUX_IDE_PERFORMANCE_TRACE_TREE;
let installed = false;
const MAX_PENDING_INPUTS = 256;
const INPUT_EXPIRY_MICROS = 5_000_000;

/**
 * Installs only for an explicit reference run. The ordinary path returns before
 * constructing a sink, UUID, clock sample, directory, or file descriptor.
 */
export function installReferencePerformanceTraceCollectorFromEnvironment(): void {
  if (installed || !TRACE_PATH) return;
  if (!SOURCE_COMMIT || !SOURCE_TREE)
    throw new Error("Reference trace collection requires source commit and tree provenance");
  installed = true;
  mkdirSync(dirname(TRACE_PATH), { recursive: true });
  const sink = createReferencePerformanceTraceSink({
    commit: SOURCE_COMMIT,
    tree: SOURCE_TREE,
    append,
    diagnostics: true,
  });
  installTuiPerformanceEventSink(sink);
}

export function createReferencePerformanceTraceSink(options: {
  readonly commit: string;
  readonly tree: string;
  readonly append: (value: Readonly<Record<string, unknown>>) => void;
  readonly nowMicros?: () => number;
  readonly createTraceId?: () => string;
  readonly processId?: string;
  readonly startedAt?: string;
  readonly diagnostics?: boolean;
}): TuiPerformanceEventSink {
  const nowMicros = options.nowMicros ?? (() => Math.floor(performance.now() * 1_000));
  const createTraceId = options.createTraceId ?? randomUUID;
  const processId = options.processId ?? `opentui:${process.pid}`;
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
  return Object.freeze({
    frame: () => undefined,
    terminalPaint: () => undefined,
    terminalDelivery: () => undefined,
    beginTerminalInput: () => {
      const startedAtMicros = nowMicros();
      expireInputs(inputs, startedAtMicros);
      while (inputs.size >= MAX_PENDING_INPUTS) inputs.delete(inputs.keys().next().value!);
      const traceId = createTraceId();
      inputs.set(traceId, {
        startedAtMicros,
        expiresAtMicros: startedAtMicros + INPUT_EXPIRY_MICROS,
        endedAtMicros: null,
      });
      if (options.diagnostics)
        options.append({
          version: 1,
          type: "performance.trace.diagnostic",
          phase: "input-begin",
          traceId,
          atMicros: startedAtMicros,
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
    terminalTraceSpan: (paint: TuiTerminalTraceSpanEvent) => {
      if (options.diagnostics)
        options.append({
          version: 1,
          type: "performance.trace.diagnostic",
          phase: "paint-span",
          traceId: paint.traceId,
          atMicros: paint.endedAtMicros,
        });
      recordCompletedTrace(inputs, paint, options.append);
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

function append(value: Readonly<Record<string, unknown>>): void {
  appendFileSync(TRACE_PATH!, `${JSON.stringify(value)}\n`);
}
