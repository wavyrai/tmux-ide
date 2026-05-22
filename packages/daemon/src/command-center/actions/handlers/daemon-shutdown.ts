import { ActionError } from "../errors.ts";
import type { ActionInput, ActionResult } from "../contract.ts";
import { resetChatProvidersListCache } from "./chat-actions.ts";

export interface DaemonShutdownDeps {
  shutdown?: (reason: string | null) => Promise<void> | void;
}

let shutdownBackend: ((reason: string | null) => Promise<void> | void) | null = null;
let shutdownInProgress = false;

export function setDaemonShutdownBackend(
  backend: ((reason: string | null) => Promise<void> | void) | null,
): void {
  shutdownBackend = backend;
  if (!backend) shutdownInProgress = false;
}

export function daemonShutdownHandler(
  input: ActionInput<"daemon.shutdown">,
  deps: DaemonShutdownDeps = {},
): ActionResult<"daemon.shutdown"> {
  if (shutdownInProgress) {
    throw new ActionError({
      code: "shutdown_already_in_progress",
      message: "Daemon shutdown is already in progress",
    });
  }

  shutdownInProgress = true;
  resetChatProvidersListCache();
  const shutdown = deps.shutdown ?? shutdownBackend;
  process.nextTick(() => {
    void Promise.resolve(shutdown?.(input.reason ?? null)).catch((err) => {
      console.error("[daemon] shutdown action failed:", err);
    });
  });

  return { stopping: true };
}
