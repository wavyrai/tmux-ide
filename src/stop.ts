import { resolve } from "node:path";
import { execSync } from "node:child_process";
import { getSessionName } from "./lib/yaml-io.ts";
import { outputError } from "./lib/output.ts";
import { killSession, stopSessionMonitor } from "./lib/tmux.ts";

export async function stop(
  targetDir: string | undefined,
  { json }: { json?: boolean } = {},
): Promise<void> {
  const dir = resolve(targetDir ?? ".");
  const { name: session } = getSessionName(dir);

  // Stop the session monitor before killing the session
  stopSessionMonitor(session);

  // Kill any orphaned daemon processes for this session
  try {
    execSync(`pkill -f "daemon-watchdog.ts ${session}" 2>/dev/null || true`, { stdio: "ignore" });
    execSync(`pkill -f "daemon.ts ${session}" 2>/dev/null || true`, { stdio: "ignore" });
  } catch {
    // Best-effort cleanup
  }

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
