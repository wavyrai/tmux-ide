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
  readonly beginTerminalInput?: () => TuiTerminalInputTrace;
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
}

export interface TuiTerminalDeliveryPerformanceEvent {
  readonly parseMs: number;
  readonly queuePeak: number;
  readonly queueCapacity: number | null;
  readonly revisionLagPeak: number;
  readonly reseed: boolean;
}

export type TuiPerformanceDiagnosticEvent = Readonly<Record<string, unknown>> & {
  readonly phase: string;
};
export type TuiPerformanceDiagnosticSink = (event: TuiPerformanceDiagnosticEvent) => void;

// The production TUI is assembled through lazy bundle boundaries. Bun may
// materialize this tiny module more than once across those chunks, so
// module-local state can split producers from the installed observer. A global
// symbol preserves one process-local registry without allocating on hot reads.
const PERFORMANCE_SINK_SLOT = Symbol.for("tmux-ide.tui.performance-event-sink");
const PERFORMANCE_DIAGNOSTIC_SLOT = Symbol.for("tmux-ide.tui.performance-diagnostic-sink");
const performanceSinkGlobal = globalThis as typeof globalThis &
  Record<symbol, TuiPerformanceEventSink | TuiPerformanceDiagnosticSink | null | undefined>;

export function currentTuiPerformanceEventSink(): TuiPerformanceEventSink | null {
  return (
    (performanceSinkGlobal[PERFORMANCE_SINK_SLOT] as TuiPerformanceEventSink | undefined) ?? null
  );
}

export function currentTuiPerformanceDiagnosticSink(): TuiPerformanceDiagnosticSink | null {
  return (
    (performanceSinkGlobal[PERFORMANCE_DIAGNOSTIC_SLOT] as
      | TuiPerformanceDiagnosticSink
      | undefined) ?? null
  );
}

export function installTuiPerformanceDiagnosticSink(sink: TuiPerformanceDiagnosticSink): void {
  performanceSinkGlobal[PERFORMANCE_DIAGNOSTIC_SLOT] = sink;
}

export function installTuiPerformanceEventSink(sink: TuiPerformanceEventSink): () => void {
  const activeSink = performanceSinkGlobal[PERFORMANCE_SINK_SLOT] as
    | TuiPerformanceEventSink
    | undefined;
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
