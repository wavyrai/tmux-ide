/**
 * Handler: `terminal.stop`.
 *
 * Kill a running PTY bridge by id. Wraps {@link PtyBridgeRegistry.delete} —
 * the registry delete is what resets the entry's clients counter, clears
 * any idle timer, and emits SIGTERM. Returns `{ stopped: true }` only when
 * a bridge actually existed; otherwise raises `terminal_not_found`.
 */

import {
  defaultPtyBridgeRegistry as defaultRegistry,
  type PtyBridgeRegistry,
} from "../../../server/ws-route.ts";
import { ActionError } from "../errors.ts";
import { type ActionInput, type ActionResult } from "../contract.ts";

export interface TerminalStopDeps {
  registry?: PtyBridgeRegistry;
}

export function terminalStopHandler(
  input: ActionInput<"terminal.stop">,
  deps: TerminalStopDeps = {},
): ActionResult<"terminal.stop"> {
  const registry = deps.registry ?? defaultRegistry;
  const ok = registry.delete(input.terminalId);
  if (!ok) {
    throw new ActionError({
      code: "terminal_not_found",
      message: `No terminal bridge for id "${input.terminalId}"`,
      details: { terminalId: input.terminalId, sessionName: input.sessionName },
    });
  }
  return { stopped: true };
}
