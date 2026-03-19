import { resolve } from "node:path";
import { getSessionName } from "./lib/yaml-io.ts";
import { outputError } from "./lib/output.ts";
import { attachSession, getSessionState } from "./lib/tmux.ts";

export async function attach(
  targetDir: string | undefined,
  { json: _json }: { json?: boolean } = {},
): Promise<void> {
  const dir = resolve(targetDir ?? ".");
  const { name: session } = getSessionName(dir);
  const state = getSessionState(session);

  if (!state.running) {
    outputError(`Session "${session}" is not running. Start it with: tmux-ide`, "NOT_RUNNING");
    return;
  }

  attachSession(session);
}
