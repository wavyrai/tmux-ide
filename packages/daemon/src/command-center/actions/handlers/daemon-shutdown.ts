import { ActionError } from "../errors.ts";
import type { ActionInput, ActionResult } from "../contract.ts";

export interface DaemonShutdownDeps {
  shutdown?: (reason: string | null) => Promise<void> | void;
  instanceId?: string | null;
}

let shutdownBackend: ((reason: string | null) => Promise<void> | void) | null = null;
let daemonInstanceId: string | null = null;
let shutdownInProgress = false;

export function setDaemonShutdownBackend(
  backend: ((reason: string | null) => Promise<void> | void) | null,
  instanceId: string | null = null,
): void {
  shutdownBackend = backend;
  daemonInstanceId = backend ? instanceId : null;
  if (!backend) shutdownInProgress = false;
}

export function daemonShutdownHandler(
  input: ActionInput<"daemon.shutdown">,
  deps: DaemonShutdownDeps = {},
): ActionResult<"daemon.shutdown"> {
  const expectedInstanceId = input.expectedInstanceId;
  const currentInstanceId = deps.instanceId ?? daemonInstanceId;
  if (expectedInstanceId && expectedInstanceId !== currentInstanceId) {
    throw new ActionError({
      code: "daemon_instance_mismatch",
      message: "Daemon instance changed before shutdown",
    });
  }
  if (shutdownInProgress) {
    throw new ActionError({
      code: "shutdown_already_in_progress",
      message: "Daemon shutdown is already in progress",
    });
  }

  shutdownInProgress = true;
  const shutdown = deps.shutdown ?? shutdownBackend;
  process.nextTick(() => {
    void Promise.resolve(shutdown?.(input.reason ?? null)).catch((err) => {
      console.error("[daemon] shutdown action failed:", err);
    });
  });

  return { stopping: true };
}
