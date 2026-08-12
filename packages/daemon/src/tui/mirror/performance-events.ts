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

let activeSink: TuiPerformanceEventSink | null = null;

export function currentTuiPerformanceEventSink(): TuiPerformanceEventSink | null {
  return activeSink;
}

export function installTuiPerformanceEventSink(sink: TuiPerformanceEventSink): () => void {
  if (activeSink && activeSink !== sink)
    throw new Error("An OpenTUI performance observer is already active");
  activeSink = sink;
  let installed = true;
  return () => {
    if (!installed) return;
    installed = false;
    if (activeSink === sink) activeSink = null;
  };
}
