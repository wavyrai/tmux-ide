import { resolve } from "node:path";
import { outputError } from "./lib/output.ts";
import { attachSession, getSessionState } from "@tmux-ide/tmux-bridge";
import { resolveProjectConfigContext } from "./lib/config-context.ts";

export async function attach(
  targetDir: string | undefined,
  { json: _json }: { json?: boolean } = {},
): Promise<void> {
  const dir = resolve(targetDir ?? ".");
  const { sessionName: session } = await resolveProjectConfigContext(dir);
  const state = getSessionState(session);

  if (!state.running) {
    outputError(`Session "${session}" is not running. Start it with: tmux-ide`, "NOT_RUNNING");
    return;
  }

  attachSession(session);
}
