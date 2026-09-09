import { parseArgs } from "node:util";

const APPLICATION_SHELL_DIAGNOSTIC_HANDOFF_CAPACITY = 16;

export interface ApplicationShellDiagnosticHandoff {
  readonly emit: (phase: string, details: Readonly<Record<string, unknown>>) => void;
  readonly attach: (
    sink: (phase: string, details: Readonly<Record<string, unknown>>) => void,
  ) => void;
  /** Fence late preparation settlement before the owning stream is closed. */
  readonly retire: () => void;
}

/**
 * Retains the handful of pre-root application-shell marks until the root's
 * single bounded stream exists. Once attached, all marks go directly through
 * that stream and therefore share its ordering, backpressure, flush, and close.
 */
export function createApplicationShellDiagnosticHandoff(
  launchEpochMs: number,
  capacity = APPLICATION_SHELL_DIAGNOSTIC_HANDOFF_CAPACITY,
): ApplicationShellDiagnosticHandoff {
  const pending: Array<{
    readonly phase: string;
    readonly details: Readonly<Record<string, unknown>>;
  }> = [];
  let dropped = 0;
  let attached: ((phase: string, details: Readonly<Record<string, unknown>>) => void) | null = null;
  let retired = false;
  const emit = (phase: string, details: Readonly<Record<string, unknown>>): void => {
    if (retired) return;
    const observed = Object.freeze({
      ...details,
      causalElapsedMs: Date.now() - launchEpochMs,
      causalAt: new Date().toISOString(),
      causalMonotonicMicros: Math.floor(performance.now() * 1_000),
    });
    if (attached) {
      attached(phase, observed);
      return;
    }
    if (pending.length < Math.max(0, capacity)) pending.push({ phase, details: observed });
    else dropped += 1;
  };
  return Object.freeze({
    emit,
    attach(sink) {
      if (retired || attached) return;
      attached = sink;
      for (const event of pending) sink(event.phase, event.details);
      pending.length = 0;
      if (dropped > 0)
        sink("application-shell-diagnostic-handoff", {
          outcome: "dropped",
          count: dropped,
        });
    },
    retire() {
      retired = true;
      attached = null;
      pending.length = 0;
    },
  });
}

export function explicitApplicationTarget(argv: readonly string[]): string | null {
  const parsed = parseArgs({
    args: [...argv],
    allowPositionals: true,
    strict: false,
    options: { target: { type: "string" } },
  });
  const positional = parsed.positionals.find((value) => value !== "app") ?? null;
  const target = typeof parsed.values.target === "string" ? parsed.values.target : positional;
  return target && target !== "home" ? target : null;
}

export function prepareExplicitApplicationTarget<Value>(
  argv: readonly string[],
  prepare: (sessionName: string) => Promise<Value>,
): { readonly sessionName: string; readonly prepared: Promise<Value> } | null {
  const sessionName = explicitApplicationTarget(argv);
  if (!sessionName) return null;
  const prepared = prepare(sessionName);
  // Root import/render owns when this promise is awaited. Attach an immediate
  // observer so a very fast preparation failure cannot become a process-level
  // unhandled rejection before ownership transfers.
  void prepared.catch(() => undefined);
  return { sessionName, prepared };
}

export function abandonPreparedConnection(
  prepared:
    | Promise<{
        dispose(): void;
      } | null>
    | null
    | undefined,
): void {
  if (!prepared) return;
  // Failure cleanup must not wait for a network/liveness request it no longer
  // owns. A late success is still retired exactly; a late rejection is
  // deliberately observed and cannot become an unhandled process failure.
  void prepared.then(
    (connection) => connection?.dispose(),
    () => undefined,
  );
}

export function consumeApplicationSshTarget(argv: readonly string[]): {
  sshTarget: string | null;
  sshTargets: string[];
  argv: string[];
} {
  const sshTargets: string[] = [];
  const remaining: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") {
      remaining.push(...argv.slice(i));
      break;
    }
    if (arg === "--ssh" || arg.startsWith("--ssh=")) {
      const value = arg === "--ssh" ? argv[++i] : arg.slice(6);
      if (!value || value.startsWith("-")) throw new Error("Expected one SSH alias after --ssh");
      if (!sshTargets.includes(value)) sshTargets.push(value);
    } else remaining.push(arg);
  }
  return { sshTarget: sshTargets[0] ?? null, sshTargets, argv: remaining };
}

/**
 * Bundle-safe lazy boundary for the production OpenTUI root.
 *
 * The literal specifier is intentional: Bun can embed the Solid-transformed
 * root in the standalone executable without evaluating it during dispatcher
 * startup.
 */
export async function startApplicationEntry(): Promise<void> {
  const diagnosticLog = process.env.TMUX_IDE_TUI_PERF_LOG || process.env.TMUX_IDE_TUI_LOG;
  const launchEpochMs = Number(process.env.TMUX_IDE_TUI_LAUNCH_EPOCH_MS ?? Date.now());
  const applicationShellDiagnostics = diagnosticLog
    ? createApplicationShellDiagnosticHandoff(launchEpochMs)
    : null;
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
  let initialPreparation: ReturnType<
    typeof prepareExplicitApplicationTarget<
      import("../application-shell-daemon-connection.ts").OpenTuiApplicationShellConnection | null
    >
  > = null;
  let disposeAuthority: (() => void) | null = null;
  try {
    const target = consumeApplicationSshTarget(process.argv.slice(2));
    process.argv.splice(2, process.argv.length - 2, ...target.argv);
    const { initializeApplicationMachines } = await import("./application-machine-startup.ts");
    const authority = await import("./application-daemon-authority.ts");
    disposeAuthority = authority.disposeApplicationDaemonAuthority;
    initializeApplicationMachines(target.sshTargets);
    await mark("root-import-start");
    initialPreparation = target.sshTarget
      ? null
      : prepareExplicitApplicationTarget(process.argv.slice(2), (explicitTarget) =>
          import("../application-shell-daemon-connection.ts").then(
            ({ prepareOpenTuiApplicationShellConnection }) =>
              diagnosticLog
                ? prepareOpenTuiApplicationShellConnection(explicitTarget, {
                    onDiagnostic: applicationShellDiagnostics!.emit,
                  })
                : prepareOpenTuiApplicationShellConnection(explicitTarget),
          ),
        );
    const { startApplicationRoot } = await import("./application-root-v2.tsx");
    await mark("root-import-end");
    await mark("root-start");
    await startApplicationRoot(
      initialPreparation
        ? {
            initialPreparation: {
              sessionName: initialPreparation.sessionName,
              preparedConnection: initialPreparation.prepared,
              diagnosticHandoff: applicationShellDiagnostics,
            },
          }
        : {},
    );
    await mark("entry-ready");
  } catch (error) {
    disposeAuthority?.();
    abandonPreparedConnection(initialPreparation?.prepared);
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
