import { currentTuiPerformanceEventSink } from "../performance-events.ts";
import { publishCanonicalHostFrameDiagnostics } from "./terminal-host-frame-diagnostics.ts";
import { createTerminalFrameReadiness } from "./terminal-frame-readiness.ts";
import { tuiPerfCriticalMark } from "./application-performance-log.ts";

export function createApplicationTerminalFrameReadinessOwner(options: {
  readonly enabled: boolean;
  readonly sink: ReturnType<typeof currentTuiPerformanceEventSink>;
  readonly requestRender: () => void;
}) {
  if (!options.enabled && !options.sink) return null;
  return createTerminalFrameReadiness({
    requestRender: options.requestRender,
    markReady: (key, snapshot) =>
      tuiPerfCriticalMark(`first-terminal-frame:${key}`, "first-terminal-frame", {
        daemonGeneration: snapshot.daemonGeneration,
        rendererEpoch: snapshot.rendererEpoch,
      }),
    drainDetailed: (snapshot) =>
      publishCanonicalHostFrameDiagnostics(
        snapshot.adapter!,
        snapshot.daemonGeneration!,
        snapshot.rendererEpoch,
        options.sink,
      ),
    ...(options.sink?.terminalCanonicalHostFrame && options.sink.terminalFrameFence
      ? {
          needsDetailedDrain: (snapshot) =>
            snapshot.adapter!.hasPendingCanonicalHostFrameDiagnostics(),
        }
      : {}),
  });
}
