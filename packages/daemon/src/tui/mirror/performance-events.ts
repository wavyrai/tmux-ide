/**
 * Allocation-free hot-path bridge into the demand-loaded local performance HUD.
 * The optional feature installs one sink only while visible; producers must
 * read the sink before taking a clock sample or allocating diagnostic data.
 */
export interface TuiPerformanceEventSink {
  readonly frame: (intervalMs: number) => void;
  readonly terminalPaint: (dirtyRows: number, durationMs: number) => void;
  readonly terminalParse: (durationMs: number) => void;
  readonly queueDepth: (current: number, capacity: number | null) => void;
  readonly revisionLag: (lag: number) => void;
  readonly reseed: () => void;
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
