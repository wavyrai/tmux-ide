import { createWriteStream } from "node:fs";
import { BoundedPerformanceRecordWriter } from "./bounded-performance-record-writer.ts";

const TUI_PERF_LOG = process.env.TMUX_IDE_TUI_PERF_LOG;
const stream = TUI_PERF_LOG
  ? createWriteStream(TUI_PERF_LOG, { flags: "a", highWaterMark: 64 * 1_024 })
  : null;
const TUI_LAUNCH_EPOCH_MS = stream
  ? Number(process.env.TMUX_IDE_TUI_LAUNCH_EPOCH_MS ?? Date.now())
  : 0;

const writer = stream ? new BoundedPerformanceRecordWriter(stream) : null;

const fail = (): void => {
  writer?.fail();
};
const drain = (): void => {
  writer?.drain();
};

stream?.on("error", fail);
stream?.on("drain", drain);

/**
 * Truthy only when opt-in application performance logging is active. The
 * renderer uses this as a feature flag; stream ownership remains in this
 * host-only module so Solid presentation never imports node:fs.
 */
export const tuiPerfStream = stream ? Object.freeze({ enabled: true as const }) : null;

function serializeMark(phase: string, details?: Readonly<Record<string, unknown>>): string | null {
  if (!stream) return null;
  try {
    return `${JSON.stringify({
      phase,
      elapsedMs: Date.now() - TUI_LAUNCH_EPOCH_MS,
      at: new Date().toISOString(),
      ...details,
      monotonicMicros: Math.floor(performance.now() * 1_000),
      processId: `opentui:${process.pid}`,
      clockId: "opentui-performance-now",
    })}\n`;
  } catch {
    return null;
  }
}

export function tuiPerfMark(phase: string, details?: Readonly<Record<string, unknown>>): void {
  const record = serializeMark(phase, details);
  if (record) writer?.write(record);
}

export function tuiPerfCriticalMark(
  key: string,
  phase: string,
  details?: Readonly<Record<string, unknown>>,
): boolean {
  const record = serializeMark(phase, details);
  return record !== null && writer !== null && writer.writeCritical(key, record);
}

export function markTerminalHostFocusControlGate(
  observation: Readonly<Record<string, unknown>>,
): boolean {
  return tuiPerfCriticalMark(
    "terminal-host-focus-control-gate",
    "terminal-host-focus-control-gate-ready",
    observation,
  );
}

export function markTerminalHostFocusBinding(
  identity: Readonly<Record<string, unknown>> & { readonly bindingEpoch: number },
): boolean {
  return tuiPerfCriticalMark(
    `terminal-host-focus-binding:${identity.bindingEpoch}`,
    "terminal-host-focus-control-binding-ready",
    identity,
  );
}

export function tuiPerfDiagnostics(): Readonly<{
  droppedRecords: number;
  failed: boolean;
  pendingCriticalRecords: number;
}> {
  return (
    writer?.diagnostics() ??
    Object.freeze({ droppedRecords: 0, failed: false, pendingCriticalRecords: 0 })
  );
}

async function flushTuiPerfMarks(): Promise<void> {
  if (!stream || writer?.diagnostics().failed) return;
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
