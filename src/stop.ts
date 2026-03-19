import { resolve } from "node:path";
import { getSessionName } from "./lib/yaml-io.ts";
import { listInstances } from "./lib/session-instances.ts";
import { outputError } from "./lib/output.ts";
import { killSession, stopSessionMonitor } from "./lib/tmux.ts";

export async function stop(
  targetDir: string | undefined,
  {
    json,
    session: targetSession,
    all = false,
  }: { json?: boolean; session?: string; all?: boolean } = {},
): Promise<void> {
  const dir = resolve(targetDir ?? ".");
  const { name: baseName } = getSessionName(dir);

  if (all) {
    const instances = listInstances(baseName);
    if (instances.length === 0) {
      outputError(`No active sessions matching "${baseName}" found`, "NOT_RUNNING");
      return;
    }
    const stopped: string[] = [];
    for (const name of instances) {
      stopSessionMonitor(name);
      const result = killSession(name);
      if (result.stopped) stopped.push(name);
    }
    if (json) {
      console.log(JSON.stringify({ stopped }));
    } else {
      console.log(
        `Stopped ${stopped.length} session${stopped.length === 1 ? "" : "s"}: ${stopped.join(", ")}`,
      );
    }
    return;
  }

  const session = targetSession ?? baseName;

  // Stop the session monitor before killing the session
  stopSessionMonitor(session);

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
