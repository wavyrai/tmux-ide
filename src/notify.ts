import { resolve } from "node:path";
import { getSessionName } from "./lib/yaml-io.ts";
import { getSessionState } from "./lib/tmux.ts";
import { listSessionPanes, sendCommand } from "./widgets/lib/pane-comms.ts";
import { appendEvent } from "./lib/event-log.ts";
import { IdeError } from "./lib/errors.ts";

interface NotifyOptions {
  message?: string;
  json?: boolean;
}

/**
 * Send a short notification message to the lead/master pane.
 *
 * This is the counterpart to `tmux-ide dispatch` — dispatch sends tasks
 * TO agents, notify sends completion messages BACK to the master.
 *
 * The message is always kept under 200 chars to avoid triggering the
 * paste preview in Claude Code's TUI.
 */
export async function notify(
  targetDir: string | null | undefined,
  opts: NotifyOptions,
): Promise<void> {
  const dir = resolve(targetDir ?? ".");
  const { message, json } = opts;
  const { name: session } = getSessionName(dir);

  if (!message) {
    throw new IdeError("Missing message. Usage: tmux-ide notify <message>", {
      code: "USAGE",
    });
  }

  const state = getSessionState(session);
  if (!state.running) {
    throw new IdeError(`Session "${session}" is not running`, {
      code: "SESSION_NOT_FOUND",
    });
  }

  const panes = listSessionPanes(session);
  const leadPane = panes.find((p) => p.role === "lead") ?? panes[0];

  if (!leadPane) {
    throw new IdeError("No panes found in session", {
      code: "PANE_NOT_FOUND",
    });
  }

  // Keep message under 200 chars to avoid paste preview
  const short = message.length > 180 ? message.slice(0, 177) + "..." : message;

  sendCommand(session, leadPane.id, short);

  // Log notify event
  appendEvent(dir, {
    timestamp: new Date().toISOString(),
    type: "notify",
    target: leadPane.name ?? leadPane.title,
    paneId: leadPane.id,
    message: short,
  });

  if (json) {
    console.log(
      JSON.stringify({
        ok: true,
        session,
        target: {
          paneId: leadPane.id,
          name: leadPane.name,
          title: leadPane.title,
          role: leadPane.role,
        },
        message: short,
      }),
    );
    return;
  }

  const label = leadPane.name ?? leadPane.title;
  console.log(`Notified "${label}" (${leadPane.id}): ${short}`);
}
