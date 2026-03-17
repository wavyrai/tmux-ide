import { resolve } from "node:path";
import { getSessionName } from "./lib/yaml-io.js";
import { outputError } from "./lib/output.js";
import { attachSession, getSessionState } from "./lib/tmux.js";

export async function attach(targetDir, { json: _json } = {}) {
  const dir = resolve(targetDir ?? ".");
  const { name: session } = getSessionName(dir);
  const state = getSessionState(session);

  if (!state.running) {
    outputError(`Session "${session}" is not running. Start it with: tmux-ide`, "NOT_RUNNING");
    return;
  }

  attachSession(session);
}
