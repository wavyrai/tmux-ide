import type { CausalCellStructuralDiffV1 } from "@tmux-ide/contracts";
import type { PaneStreamClockCalibrationOutcome } from "@tmux-ide/daemon-client/pane-stream-clock-calibration";

/**
 * Allocation-free hot-path bridge into the demand-loaded local performance HUD.
 * The optional feature installs one sink only while visible; producers must
 * read the sink before taking a clock sample or allocating diagnostic data.
 */
export interface TuiPerformanceEventSink {
  readonly frame: (intervalMs: number) => void;
  readonly terminalPaint: (dirtyRows: number, durationMs: number) => void;
  readonly terminalDelivery: (event: TuiTerminalDeliveryPerformanceEvent) => void;
  readonly terminalTraceSpan?: (event: TuiTerminalTraceSpanEvent) => void;
  readonly terminalTraceStage?: (event: TuiTerminalTraceStageEvent) => void;
  readonly terminalClockCalibration?: (event: TuiTerminalClockCalibrationEvent) => void;
  /** Explicit fresh-lane state for fail-closed queue fences before the first input. */
  readonly terminalInputQueueState?: (event: TuiTerminalInputQueueStateEvent) => void;
  /** Diagnostic-only proof of a canonical DEC-mode transition. */
  readonly terminalCanonicalMode?: (event: TuiTerminalCanonicalModeEvent) => void;
  readonly terminalCanonicalPublication?: (event: TuiTerminalCanonicalPublicationEvent) => void;
  readonly terminalCanonicalPaint?: (event: TuiTerminalCanonicalPaintEvent) => void;
  /** Bounded detailed-only proof that canonical state progressed after a seed paint. */
  readonly terminalCanonicalUpdate?: (event: TuiTerminalCanonicalUpdateEvent) => void;
  /** Detailed-only proof of the exact rows touched by a pane focus transition. */
  readonly terminalFocusPaint?: (event: TuiTerminalFocusPaintEvent) => void;
  readonly terminalFocusFence?: (event: TuiTerminalFocusPaintEvent) => void;
  /** Detailed-only host publication of one exact canonical identity on a renderer frame. */
  readonly terminalCanonicalHostFrame?: (event: TuiTerminalCanonicalHostFrameEvent) => void;
  /** Same-stream watermark emitted after the renderer's first coherent frame. */
  readonly terminalFrameFence?: (event: TuiTerminalFrameFenceEvent) => void;
  /** Detailed-only proof of the real OpenTUI parser boundary that admitted input. */
  readonly terminalInputOrigin?: true;
  readonly terminalInputFence?: (event: TuiTerminalInputFenceEvent) => void;
  readonly beginTerminalInput?: (origin?: TuiTerminalInputOrigin) => TuiTerminalInputTrace;
}

export interface TuiTerminalFocusPaintEvent {
  readonly processId: string;
  readonly clockId: "opentui-performance-now";
  readonly clockKind: "performance-now";
  readonly atMicros: number;
  readonly semanticPaneId: string;
  readonly generation: string;
  readonly incarnation: string;
  readonly revision: number;
  readonly stateHash: string;
  readonly cols: number;
  readonly rows: number;
  readonly sourceEpoch: number;
  readonly rendererEpoch: number;
  readonly viewportCols: number;
  readonly viewportRows: number;
  readonly focused: boolean;
  readonly diagnosticEpoch: number;
  readonly full: boolean;
  readonly writtenRows: readonly number[];
}

export interface TuiTerminalFocusFenceEvent extends TuiTerminalFocusPaintEvent {
  readonly writerHealth: Readonly<{
    droppedRecords: number;
    oversizedRecords: number;
    failed: boolean;
  }>;
}

export interface TuiTerminalClockCalibrationEvent extends PaneStreamClockCalibrationOutcome {
  readonly processId: string;
  readonly clockId: "opentui-performance-now";
  readonly clockKind: "performance-now";
  readonly atMicros: number;
}

export interface TuiTerminalInputFenceEvent {
  readonly traceId: string;
  readonly processId: string;
  readonly clockId: "opentui-performance-now";
  readonly clockKind: "performance-now";
  readonly atMicros: number;
  readonly semanticPaneId: string;
  readonly generation: string;
  readonly incarnation: string;
  readonly revision: number;
  readonly stateHash: string;
}

export interface TuiTerminalInputOrigin {
  readonly origin: "keyboard" | "bracketed-paste";
  readonly payload: Uint8Array;
  readonly semanticPaneId: string;
  readonly generation: string;
  readonly incarnation: string;
  readonly revision: number;
  readonly stateHash: string;
}

export interface TuiTerminalInputOriginEvent {
  readonly processId: string;
  readonly clockId: "opentui-performance-now";
  readonly clockKind: "performance-now";
  readonly atMicros: number;
  readonly origin: "keyboard" | "bracketed-paste";
  readonly payloadByteCount: number;
  readonly payloadFingerprint: string;
  readonly parserConsumption: "keyboard-event" | "paste-event";
  readonly traceId: string;
  readonly semanticPaneId: string;
  readonly generation: string;
  readonly incarnation: string;
  readonly revision: number;
  readonly stateHash: string;
}

export interface TuiTerminalCanonicalPublicationEvent {
  readonly processId: string;
  readonly clockId: "opentui-performance-now";
  readonly clockKind: "performance-now";
  readonly atMicros: number;
  readonly updateType: "terminal.seed";
  readonly semanticPaneId: string;
  readonly generation: string;
  readonly incarnation: string;
  readonly revision: number;
  readonly stateHash: string;
  readonly cols: number;
  readonly rows: number;
  readonly sourceEpoch: number;
}

export interface TuiTerminalCanonicalPaintEvent extends Omit<
  TuiTerminalCanonicalPublicationEvent,
  "updateType"
> {
  readonly viewportCols: number;
  readonly viewportRows: number;
  readonly writtenRows: readonly number[];
}

export interface TuiTerminalCanonicalUpdateEvent extends Omit<
  TuiTerminalCanonicalPublicationEvent,
  "updateType"
> {
  readonly updateType: "terminal.patch";
}

export type TuiTerminalCanonicalPaintIdentity = Omit<
  TuiTerminalCanonicalPaintEvent,
  "atMicros" | "writtenRows"
>;

export interface TuiTerminalCanonicalHostFrameEvent extends TuiTerminalCanonicalPaintIdentity {
  readonly atMicros: number;
  readonly rendererEpoch: number;
}

export interface TuiTerminalFrameFenceEvent extends Partial<TuiTerminalCanonicalPaintIdentity> {
  readonly daemonGeneration: string;
  readonly rendererEpoch: number;
  readonly identityDrops?: number;
}

export function emitTuiTerminalCanonicalHostFrameFailOpen(
  sink: ((event: TuiTerminalCanonicalHostFrameEvent) => void) | undefined,
  event: TuiTerminalCanonicalHostFrameEvent,
): void {
  if (!sink) return;
  try {
    sink(event);
  } catch {
    // Opt-in diagnostics never own renderer frame publication.
  }
}

export function emitTuiTerminalFrameFenceFailOpen(
  sink: ((event: TuiTerminalFrameFenceEvent) => void) | undefined,
  event: TuiTerminalFrameFenceEvent,
): void {
  if (!sink) return;
  try {
    sink(event);
  } catch {
    // Opt-in diagnostics never own renderer frame publication.
  }
}

export interface TuiTerminalCanonicalModeEvent {
  readonly processId: string;
  readonly clockId: "opentui-performance-now";
  readonly clockKind: "performance-now";
  readonly atMicros: number;
  readonly semanticPaneId: string;
  readonly generation: string;
  readonly incarnation: string;
  readonly revision: number;
  readonly stateHash: string;
  readonly wraparound: boolean;
}

export interface TuiTerminalInputTrace {
  readonly traceId: string;
  readonly finish: () => void;
  readonly cancel: () => void;
}

export interface TuiTerminalTraceSpanEvent {
  readonly traceId: string;
  readonly scenario: "terminal-input-to-paint";
  readonly stage: "paint";
  readonly processId: string;
  readonly clockId: "opentui-performance-now";
  readonly clockKind: "performance-now";
  readonly startedAtMicros: number;
  readonly endedAtMicros: number;
  readonly generation: string;
  readonly incarnation: string;
  /** Exact canonical pane/state consumed by this changed-cell paint. */
  readonly semanticPaneId: string;
  readonly revision: number;
  readonly stateHash: string;
  /** Coalescing contract: revision/hash/incarnation name the state actually blitted. */
  readonly paintStateIdentity: "latest-canonical-state-blitted";
}

export interface TuiTerminalTraceStageEvent {
  readonly traceId: string;
  readonly scenario: "terminal-input-to-paint";
  readonly stage: "client";
  readonly operation: string;
  readonly processId: string;
  readonly clockId: "opentui-performance-now";
  readonly clockKind: "performance-now";
  readonly atMicros: number;
  readonly sharedMicros?: number;
  readonly clockOffsetLowerMicros?: number;
  readonly clockOffsetUpperMicros?: number;
  readonly clockUncertaintyMicros?: number;
  readonly clockCalibratedAtMicros?: number;
  readonly clockCalibrationRequestId?: string;
  readonly inputPending?: number;
  readonly inputInFlight?: number;
  readonly inputPendingBytes?: number;
  readonly bufferedAmount?: number;
  readonly frameBytes?: number;
  readonly drained?: boolean;
  readonly rssBytes?: number;
  readonly heapUsedBytes?: number;
  readonly causalAttribution?: true;
  readonly semanticPaneId?: string;
  readonly generation?: string;
  readonly incarnation?: string;
  readonly revision?: number;
  readonly stateHash?: string;
  readonly row?: number;
  readonly column?: number;
  readonly beforeGrapheme?: string;
  readonly afterGrapheme?: string;
  readonly dirtyRowProved?: true;
  readonly causalDiagnostic?: CausalCellStructuralDiffV1;
}

export interface TuiTerminalInputQueueStateEvent {
  readonly operation: "initialized";
  readonly processId: string;
  readonly clockId: "opentui-performance-now";
  readonly clockKind: "performance-now";
  readonly atMicros: number;
  readonly inputPending: number;
  readonly inputInFlight: number;
  readonly inputPendingBytes: number;
  readonly rssBytes: number;
  readonly heapUsedBytes: number;
}

export interface TuiTerminalDeliveryPerformanceEvent {
  readonly parseMs: number;
  readonly queuePeak: number;
  readonly queueCapacity: number | null;
  readonly settledQueueDepth: number;
  readonly revisionLagPeak: number;
  readonly reseed: boolean;
}

// The production TUI is assembled through lazy bundle boundaries. Bun may
// materialize this tiny module more than once across those chunks, so
// module-local state can split producers from the installed observer. A global
// symbol preserves one process-local registry without allocating on hot reads.
const PERFORMANCE_SINK_SLOT = Symbol.for("tmux-ide.tui.performance-event-sink");
const performanceSinkGlobal = globalThis as typeof globalThis &
  Record<symbol, TuiPerformanceEventSink | null | undefined>;

export function currentTuiPerformanceEventSink(): TuiPerformanceEventSink | null {
  return performanceSinkGlobal[PERFORMANCE_SINK_SLOT] ?? null;
}

export function installTuiPerformanceEventSink(sink: TuiPerformanceEventSink): () => void {
  const activeSink = performanceSinkGlobal[PERFORMANCE_SINK_SLOT];
  if (activeSink && activeSink !== sink)
    throw new Error("An OpenTUI performance observer is already active");
  performanceSinkGlobal[PERFORMANCE_SINK_SLOT] = sink;
  let installed = true;
  return () => {
    if (!installed) return;
    installed = false;
    if (performanceSinkGlobal[PERFORMANCE_SINK_SLOT] === sink)
      performanceSinkGlobal[PERFORMANCE_SINK_SLOT] = null;
  };
}
