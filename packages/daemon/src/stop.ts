import { resolve } from "node:path";
import { outputError } from "./lib/output.ts";
import { killSession, stopSessionMonitor } from "@tmux-ide/tmux-bridge";
import { resolveProjectConfigContext } from "./lib/config-context.ts";

export async function stop(
  targetDir: string | undefined,
  { json }: { json?: boolean } = {},
): Promise<void> {
  const dir = resolve(targetDir ?? ".");
  const { sessionName: session } = await resolveProjectConfigContext(dir);

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
