import { OpenTuiTerminalHostFocus } from "./terminal-host-focus.ts";
import type { OpenTuiSessionOwner } from "./open-tui-session-owner.ts";
import {
  tuiPerfCriticalMark,
  tuiPerfDiagnostics,
  tuiPerfStream,
} from "./application-performance-log.ts";

export function createApplicationTerminalHostFocus(
  currentSession: () => OpenTuiSessionOwner | null,
): OpenTuiTerminalHostFocus {
  return new OpenTuiTerminalHostFocus(
    true,
    tuiPerfStream
      ? (phase, details) => {
          const rendererEpoch = currentSession()?.snapshot()?.rendererEpoch ?? null;
          const enriched = { ...details, rendererEpoch };
          const epoch = details.diagnosticEpoch;
          const key = `terminal-host-focus:${String(epoch)}:${String(details.outcomeId ?? "")}:${phase}`;
          tuiPerfCriticalMark(key, `terminal-host-${phase}`, enriched);
          if (phase === "focus-authority-settled" || phase === "blur-authority-settled") {
            const health = tuiPerfDiagnostics();
            tuiPerfCriticalMark(`${key}:fence`, "terminal-host-focus-fence", {
              diagnosticEpoch: epoch,
              rendererEpoch,
              daemonGeneration: details.daemonInstanceId,
              workspaceName: details.workspaceName,
              clientGeneration: details.clientGeneration,
              settledPhase: phase,
              writerHealth: health,
            });
          }
        }
      : null,
  );
}
