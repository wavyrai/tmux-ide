import { resolve } from "node:path";
import { getSessionName } from "./lib/yaml-io.ts";
import { getSessionState } from "./lib/tmux.ts";
import {
  listSessionPanes,
  sendCommand,
  sendText,
  getPaneBusyStatus,
  type PaneInfo,
  type PaneBusyStatus,
} from "./widgets/lib/pane-comms.ts";
import { appendEvent } from "./lib/event-log.ts";
import { IdeError } from "./lib/errors.ts";

interface SendOptions {
  json?: boolean;
  to?: string;
  message?: string;
  noEnter?: boolean;
}

/**
 * Resolve a target string to a pane. Priority:
 * 1. Exact pane ID (%N)
 * 2. @ide_name match
 * 3. Exact title match
 * 4. Role match (lead, teammate, planner)
 * 5. Case-insensitive partial title match
 */
export function resolvePane(panes: PaneInfo[], target: string): PaneInfo | null {
  // 1. Exact pane ID
  if (target.startsWith("%")) {
    return panes.find((p) => p.id === target) ?? null;
  }

  // 2. @ide_name match
  const byName = panes.find((p) => p.name === target);
  if (byName) return byName;

  // 3. Exact title match
  const byTitle = panes.find((p) => p.title === target);
  if (byTitle) return byTitle;

  // 4. Role match
  const lower = target.toLowerCase();
  if (["lead", "teammate", "planner"].includes(lower)) {
    const byRole = panes.find((p) => p.role === lower);
    if (byRole) return byRole;
  }

  // 5. Case-insensitive partial title match
  const byPattern = panes.find((p) => p.title.toLowerCase().includes(lower));
  if (byPattern) return byPattern;

  return null;
}

function prepareMessage(message: string, busyStatus: PaneBusyStatus): string {
  if (busyStatus === "agent") {
    // Collapse multiline to single line for Claude Code TUI
    // Prevents paste preview that requires manual Enter
    return message.replace(/\n+/g, " ").trim();
  }
  return message;
}

export async function send(targetDir: string | undefined, opts: SendOptions): Promise<void> {
  const dir = resolve(targetDir ?? ".");
  const { name: session } = getSessionName(dir);
  const { json, to: target, message: rawMessage, noEnter } = opts;

  if (!target) {
    throw new IdeError("Missing target. Usage: tmux-ide send <target> <message>", {
      code: "USAGE",
    });
  }

  if (!rawMessage) {
    throw new IdeError("Missing message. Usage: tmux-ide send <target> <message>", {
      code: "USAGE",
    });
  }

  // Verify session is running
  const state = getSessionState(session);
  if (!state.running) {
    throw new IdeError(`Session "${session}" is not running`, {
      code: "SESSION_NOT_FOUND",
    });
  }

  const panes = listSessionPanes(session);
  const pane = resolvePane(panes, target);
  if (!pane) {
    const available = panes
      .map((p) => {
        const label = p.name ?? p.title;
        return `  ${p.id}  ${label}${p.role ? ` (${p.role})` : ""}`;
      })
      .join("\n");
    throw new IdeError(`Pane "${target}" not found.\n\nAvailable panes:\n${available}`, {
      code: "PANE_NOT_FOUND",
    });
  }

  const busyStatus = getPaneBusyStatus(session, pane.id);
  const message = prepareMessage(rawMessage, busyStatus);

  if (noEnter) {
    sendText(session, pane.id, message);
  } else {
    sendCommand(session, pane.id, message);
  }

  // Log send event
  appendEvent(dir, {
    timestamp: new Date().toISOString(),
    type: "send",
    target: pane.name ?? pane.title,
    paneId: pane.id,
    message: message.length > 100 ? message.slice(0, 100) + "..." : message,
  });

  const result = {
    ok: true,
    session,
    target: {
      paneId: pane.id,
      name: pane.name,
      title: pane.title,
      role: pane.role,
    },
    message,
    busyStatus,
    ...(busyStatus === "agent" ? { warning: "agent_busy" } : {}),
  };

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const label = pane.name ?? pane.title;
  const preview = message.length > 60 ? message.slice(0, 60) + "..." : message;
  console.log(`Sent to "${label}" (${pane.id}): ${preview}`);

  if (busyStatus === "agent") {
    console.log("Warning: agent appears busy. Message sent anyway.");
  }
}
