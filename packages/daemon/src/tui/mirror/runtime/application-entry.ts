/**
 * Bundle-safe lazy boundary for the production OpenTUI root.
 *
 * The literal specifier is intentional: Bun can embed the Solid-transformed
 * root in the standalone executable without evaluating it during dispatcher
 * startup.
 */
export async function startApplicationEntry(): Promise<void> {
  const diagnosticLog = process.env.TMUX_IDE_TUI_PERF_LOG;
  const launchEpochMs = Number(process.env.TMUX_IDE_TUI_LAUNCH_EPOCH_MS ?? Date.now());
  const mark = async (phase: string, details?: Readonly<Record<string, unknown>>) => {
    if (!diagnosticLog) return;
    try {
      const { appendFile } = await import("node:fs/promises");
      await appendFile(
        diagnosticLog,
        `${JSON.stringify({
          phase,
          elapsedMs: Date.now() - launchEpochMs,
          at: new Date().toISOString(),
          monotonicMicros: Math.floor(performance.now() * 1_000),
          processId: `opentui:${process.pid}`,
          clockId: "opentui-performance-now",
          ...details,
        })}\n`,
      );
    } catch {
      // Diagnostics are deliberately outside the application lifecycle.
    }
  };
  await mark("entry-start");
  if (process.env.TMUX_IDE_PERFORMANCE_TRACE_LOG) {
    const { installReferencePerformanceTraceCollectorFromEnvironment } =
      await import("../reference-performance-trace.ts");
    installReferencePerformanceTraceCollectorFromEnvironment();
    await mark("reference-trace-ready");
  }
  try {
    await mark("root-import-start");
    const { startApplicationRoot } = await import("./application-root-v2.tsx");
    await mark("root-import-end");
    await mark("root-start");
    await startApplicationRoot();
    await mark("entry-ready");
  } catch (error) {
    await mark("entry-failed", {
      error: error instanceof Error ? (error.stack ?? error.message) : String(error),
    });
    if (process.env.TMUX_IDE_PERFORMANCE_TRACE_LOG) {
      const { closeReferencePerformanceTraceCollector } =
        await import("../reference-performance-trace.ts");
      await closeReferencePerformanceTraceCollector();
    }
    throw error;
  }
}
