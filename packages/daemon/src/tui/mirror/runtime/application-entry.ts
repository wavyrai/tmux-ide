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
          ...details,
        })}\n`,
      );
    } catch {
      // Diagnostics are deliberately outside the application lifecycle.
    }
  };
  if (process.env.TMUX_IDE_PERFORMANCE_TRACE_LOG) {
    const { installReferencePerformanceTraceCollectorFromEnvironment } =
      await import("../reference-performance-trace.ts");
    installReferencePerformanceTraceCollectorFromEnvironment();
  }
  try {
    const { startApplicationRoot } = await import("./application-root-v2.tsx");
    await startApplicationRoot();
    await mark("entry-ready");
  } catch (error) {
    await mark("entry-failed", {
      error: error instanceof Error ? (error.stack ?? error.message) : String(error),
    });
    throw error;
  }
}
