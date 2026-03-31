import { resolve } from "node:path";
import { getSessionName } from "./lib/yaml-io.ts";
import { outputError } from "./lib/output.ts";
import { getSessionVariable, killSession, stopSessionMonitor } from "./lib/tmux.ts";

export function stopDashboard(session: string): void {
  const pid = getSessionVariable(session, "@dashboard_pid");
  if (!pid) return;

  const numPid = Number.parseInt(pid, 10);
  if (Number.isNaN(numPid)) return;

  try {
    process.kill(-numPid, "SIGTERM");
  } catch {
    try {
      process.kill(numPid, "SIGTERM");
    } catch {
      // Process already gone.
    }
  }
}

export async function stop(
  targetDir: string | undefined,
  { json }: { json?: boolean } = {},
): Promise<void> {
  const dir = resolve(targetDir ?? ".");
  const { name: session } = getSessionName(dir);

  // Stop the session monitor before killing the session
  stopSessionMonitor(session);
  stopDashboard(session);

  const result = killSession(session);

  if (result.stopped) {
    if (json) {
      console.log(JSON.stringify({ stopped: session }));
    } else {
      console.log(`Stopped session "${session}"`);
    }
    return;
  }

  outputError(`No active session "${session}" found`, "NOT_RUNNING");
}
