import { resolve } from "node:path";
import { resolveProjectConfigContext } from "./lib/config-context.ts";
import { launch } from "./launch.ts";
import { killSession, stopSessionMonitor } from "@tmux-ide/tmux-bridge";

export async function restart(
  targetDir: string | undefined,
  { json, attach }: { json?: boolean; attach?: boolean } = {},
): Promise<void> {
  const dir = resolve(targetDir ?? ".");
  const { sessionName: session } = await resolveProjectConfigContext(dir);

  // Stop the session monitor first — this triggers orchestrator graceful
  // shutdown (release tasks, save state) before we kill the tmux session.
  stopSessionMonitor(session);

  const result = killSession(session);

  if (result.stopped) {
    console.log(`Stopped session "${session}"`);
  }

  await launch(dir, { json, attach });
}
