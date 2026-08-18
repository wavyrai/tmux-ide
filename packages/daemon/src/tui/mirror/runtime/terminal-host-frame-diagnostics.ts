import type { TuiPerformanceEventSink } from "../performance-events.ts";
import {
  emitTuiTerminalCanonicalHostFrameFailOpen,
  emitTuiTerminalFrameFenceFailOpen,
} from "../performance-events.ts";
import type { TerminalFastLaneRendererAdapter } from "./terminal-fast-lane-renderer-adapter.ts";

export function publishCanonicalHostFrameDiagnostics(
  adapter: TerminalFastLaneRendererAdapter,
  daemonGeneration: string,
  rendererEpoch: number,
  sink: TuiPerformanceEventSink | null,
  nowMicros: () => number = () => Math.floor(performance.now() * 1_000),
): number {
  const hostFrame = sink?.terminalCanonicalHostFrame;
  const fence = sink?.terminalFrameFence;
  if (!hostFrame || !fence) return 0;
  try {
    const atMicros = nowMicros();
    const { identities, dropped } = adapter.drainCanonicalHostFrameIdentities();
    for (const identity of identities) {
      emitTuiTerminalCanonicalHostFrameFailOpen(hostFrame, {
        ...identity,
        atMicros,
        rendererEpoch,
      });
      emitTuiTerminalFrameFenceFailOpen(fence, {
        ...identity,
        daemonGeneration,
        rendererEpoch,
        identityDrops: dropped,
      });
    }
    if (identities.length === 0 && dropped > 0) {
      emitTuiTerminalFrameFenceFailOpen(fence, {
        daemonGeneration,
        rendererEpoch,
        identityDrops: dropped,
      });
    }
    return identities.length;
  } catch {
    // Opt-in diagnostics never own renderer frame publication.
    return 0;
  }
}
