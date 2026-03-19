import { resolve } from "node:path";
import { getSessionName } from "./lib/yaml-io.ts";
import { launch } from "./launch.ts";
import { killSession, stopSessionMonitor } from "./lib/tmux.ts";

export async function restart(
  targetDir: string | undefined,
  {
    json,
    attach,
    session: targetSession,
  }: { json?: boolean; attach?: boolean; session?: string } = {},
): Promise<void> {
  const dir = resolve(targetDir ?? ".");
  const session = targetSession ?? getSessionName(dir).name;

  stopSessionMonitor(session);
  const result = killSession(session);

  if (result.stopped) {
    console.log(`Stopped session "${session}"`);
  }

  // If restarting a specific (possibly suffixed) session, pass sessionOverride
  // so launch re-creates it with the same name instead of the base name.
  await launch(dir, { json, attach, sessionOverride: targetSession });
}
