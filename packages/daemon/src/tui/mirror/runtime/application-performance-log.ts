import { createWriteStream } from "node:fs";

const TUI_PERF_LOG = process.env.TMUX_IDE_TUI_PERF_LOG;
const stream = TUI_PERF_LOG
  ? createWriteStream(TUI_PERF_LOG, { flags: "a", highWaterMark: 64 * 1_024 })
  : null;
const TUI_LAUNCH_EPOCH_MS = stream
  ? Number(process.env.TMUX_IDE_TUI_LAUNCH_EPOCH_MS ?? Date.now())
  : 0;

let failed = false;
let saturated = false;
let droppedRecords = 0;

const fail = (): void => {
  failed = true;
};
const drain = (): void => {
  saturated = false;
};

stream?.on("error", fail);
stream?.on("drain", drain);

/**
 * Truthy only when opt-in application performance logging is active. The
 * renderer uses this as a feature flag; stream ownership remains in this
 * host-only module so Solid presentation never imports node:fs.
 */
export const tuiPerfStream = stream ? Object.freeze({ enabled: true as const }) : null;

export function tuiPerfMark(phase: string, details?: Readonly<Record<string, unknown>>): void {
  if (!stream || failed) return;
  if (saturated) {
    droppedRecords += 1;
    return;
  }
  try {
    saturated = !stream.write(
      `${JSON.stringify({
        phase,
        elapsedMs: Date.now() - TUI_LAUNCH_EPOCH_MS,
        at: new Date().toISOString(),
        ...details,
        monotonicMicros: Math.floor(performance.now() * 1_000),
        processId: `opentui:${process.pid}`,
        clockId: "opentui-performance-now",
      })}\n`,
    );
  } catch {
    // Opt-in diagnostics never own renderer lifecycle.
  }
}

export function tuiPerfDiagnostics(): Readonly<{
  droppedRecords: number;
  failed: boolean;
}> {
  return Object.freeze({ droppedRecords, failed });
}

async function flushTuiPerfMarks(): Promise<void> {
  if (!stream || failed) return;
  await new Promise<void>((resolveFlush) => {
    try {
      stream.write("", () => resolveFlush());
    } catch {
      resolveFlush();
    }
  });
}

export async function closeTuiPerfMarks(): Promise<void> {
  if (!stream) return;
  await flushTuiPerfMarks();
  await new Promise<void>((resolveClose) => stream.end(resolveClose));
  stream.off("error", fail);
  stream.off("drain", drain);
}
