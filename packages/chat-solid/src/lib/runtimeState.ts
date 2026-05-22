/**
 * Side-channel runtime state derived from the raw event log.
 *
 * `available_commands_update` / `current_mode_update` are not part of
 * the rendered transcript — they configure the composer (slash-command
 * menu, mode chip). The server-materialized timeline omits them, so the
 * client still scans the raw `ThreadMessage[]` log for the bootstrap
 * value (live updates arrive via the `chat.thread.update` side channel).
 *
 * This was previously colocated in `coalesce.ts`; that module's message
 * reduction now lives on the daemon, but this fold is not reduction —
 * it is a cheap last-write-wins scan with no reactivity hot path.
 */

import type { AvailableCommand, SessionUpdate, ThreadMessage } from "../types";

export function deriveRuntimeState(messages: readonly ThreadMessage[]): {
  availableCommands: AvailableCommand[];
  currentModeId: string | null;
} {
  let availableCommands: AvailableCommand[] = [];
  let currentModeId: string | null = null;

  for (const message of messages) {
    if (message._tag !== "AgentUpdate") continue;
    if (message.update.sessionUpdate === "available_commands_update") {
      const update = message.update as Extract<
        SessionUpdate,
        { sessionUpdate: "available_commands_update" }
      >;
      availableCommands = [...update.availableCommands];
    }
    if (message.update.sessionUpdate === "current_mode_update") {
      const update = message.update as Extract<
        SessionUpdate,
        { sessionUpdate: "current_mode_update" }
      >;
      currentModeId = update.currentModeId;
    }
  }

  return { availableCommands, currentModeId };
}
