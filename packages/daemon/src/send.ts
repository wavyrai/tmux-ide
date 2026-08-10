import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { resolve, join } from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { getSessionState } from "@tmux-ide/tmux-bridge";
import {
  listSessionPanes,
  sendCommand,
  sendText,
  getPaneBusyStatus,
  type PaneInfo,
  type PaneBusyStatus,
} from "./widgets/lib/pane-comms.ts";
import { IdeError } from "./lib/errors.ts";
import { resolveProjectConfigContext } from "./lib/config-context.ts";
import { tryDispatchAction } from "./lib/cli-action-bridge.ts";
import { isCanonicalDaemonAlive, readCanonicalDaemonInfo } from "./lib/canonical-daemon.ts";
import { getDefaultWorkspaceRegistry } from "./lib/workspace-registry.ts";

export const LONG_MESSAGE_THRESHOLD = 150;

/**
 * Write a long message to a dispatch file and return the short trigger command.
 * Returns null if message is short enough to send directly.
 */
export function writeDispatchFile(
  dir: string,
  paneId: string,
  message: string,
): { filePath: string; triggerCmd: string } | null {
  if (message.length <= LONG_MESSAGE_THRESHOLD) return null;
  const dispatchDir = join(dir, ".tasks", "dispatch");
  if (!existsSync(dispatchDir)) mkdirSync(dispatchDir, { recursive: true });
  const paneSlug = paneId.replace("%", "");
  const filename = `send-${paneSlug}-${Date.now()}-${randomUUID().slice(0, 8)}.md`;
  const filePath = join(dispatchDir, filename);
  writeFileSync(filePath, message);
  return { filePath, triggerCmd: `Read and execute: .tasks/dispatch/${filename}` };
}

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

/** What a delivery reports back (the `send --json` payload, and the control
 *  socket's `send` verb data). */
export interface DeliverResult {
  ok: true;
  session: string;
  target: { paneId: string; name: string | null; title: string; role: string | null };
  message: string;
  busyStatus: PaneBusyStatus;
  sentViaFile: boolean;
  warning?: "agent_busy";
}

/**
 * Deliver `message` to a pane of `session` — the SHARED core behind the
 * `tmux-ide send` CLI case and the control socket's `send` verb. Resolves
 * `target` (pane id / @ide_name / title / role / partial title), adapts to
 * the pane's busy status, and routes long messages through a dispatch file
 * under `dir` when one is given (without a `dir` the text is sent directly).
 * Throws `IdeError` (SESSION_NOT_FOUND / PANE_NOT_FOUND) — no printing here.
 */
export function deliverMessage(opts: {
  session: string;
  target: string;
  message: string;
  noEnter?: boolean;
  /** The project dir long messages are dispatched through as a file. */
  dir?: string;
}): DeliverResult {
  const { session, target, noEnter, dir } = opts;

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
  const message = prepareMessage(opts.message, busyStatus);

  let sentViaFile = false;
  if (noEnter) {
    sendText(session, pane.id, message);
  } else {
    const dispatch = dir ? writeDispatchFile(dir, pane.id, message) : null;
    if (dispatch) {
      sendCommand(session, pane.id, dispatch.triggerCmd);
      sentViaFile = true;
    } else {
      sendCommand(session, pane.id, message);
    }
  }

  return {
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
    sentViaFile,
    ...(busyStatus === "agent" ? { warning: "agent_busy" as const } : {}),
  };
}

function semanticPaneId(paneId: string): string | null {
  try {
    const value = execFileSync(
      "tmux",
      ["display-message", "-p", "-t", paneId, "#{@tmux_ide_pane_id}"],
      { encoding: "utf8" },
    ).trim();
    return value || null;
  } catch {
    return null;
  }
}

/**
 * Prove that this CLI process is running inside a pane of the target session.
 * TMUX_PANE is runtime identity supplied by tmux itself; the semantic stamp is
 * then resolved from that exact pane. A CLI launched outside tmux, or from a
 * different workspace, stays honestly source-less.
 */
export function cliSourceSemanticPaneId(
  session: string,
  runtimePaneId: string | undefined = process.env.TMUX_PANE,
  readIdentity: (runtimePaneId: string) => string = (paneId) =>
    execFileSync(
      "tmux",
      ["display-message", "-p", "-t", paneId, `#{session_name}\t#{${"@tmux_ide_pane_id"}}`],
      { encoding: "utf8" },
    ),
): string | null {
  if (!runtimePaneId) return null;
  try {
    const identity = readIdentity(runtimePaneId).trim();
    const separator = identity.indexOf("\t");
    if (separator < 1 || identity.slice(0, separator) !== session) return null;
    return identity.slice(separator + 1) || null;
  } catch {
    return null;
  }
}

/**
 * Use the canonical daemon when it is already authoritative for the session.
 * A lost response is deliberately an error instead of a direct-tmux fallback:
 * the stable operation id may already have committed and delivering again
 * outside authority would duplicate user input.
 */
async function deliverMessageThroughDaemon(opts: {
  session: string;
  target: string;
  message: string;
  noEnter?: boolean;
  dir: string;
}): Promise<DeliverResult | null> {
  const daemon = readCanonicalDaemonInfo();
  if (!daemon || !(await isCanonicalDaemonAlive(daemon))) return null;

  const state = getSessionState(opts.session);
  if (!state.running) {
    throw new IdeError(`Session "${opts.session}" is not running`, { code: "SESSION_NOT_FOUND" });
  }
  const pane = resolvePane(listSessionPanes(opts.session), opts.target);
  if (!pane) return null;
  const paneStamp = semanticPaneId(pane.id);
  if (!paneStamp) return null;

  const registry = getDefaultWorkspaceRegistry();
  await registry.load();
  const workspace = registry.list().find((candidate) => candidate.sessionName === opts.session);
  if (!workspace) return null;

  const busyStatus = getPaneBusyStatus(opts.session, pane.id);
  const prepared = prepareMessage(opts.message, busyStatus);
  const dispatch = opts.noEnter ? null : writeDispatchFile(opts.dir, pane.id, prepared);
  const actualText = dispatch?.triggerCmd ?? prepared;
  const operationId = randomUUID();
  const sourceSemanticPaneId = cliSourceSemanticPaneId(opts.session);
  const outcome = await tryDispatchAction(
    "workspace.pane.send",
    {
      workspaceName: workspace.name,
      ...(sourceSemanticPaneId ? { sourceSemanticPaneId } : {}),
      semanticPaneId: paneStamp,
      text: actualText,
      submit: !opts.noEnter,
      origin: "cli",
    },
    { cwd: opts.dir, operationId, autostart: false },
  );
  if (!outcome) {
    throw new IdeError(
      `The daemon did not confirm pane input operation ${operationId}; delivery was not repeated.`,
      { code: "DAEMON_UNAVAILABLE" },
    );
  }
  return {
    ok: true,
    session: opts.session,
    target: { paneId: pane.id, name: pane.name, title: pane.title, role: pane.role },
    message: prepared,
    busyStatus,
    sentViaFile: dispatch !== null,
    ...(busyStatus === "agent" ? { warning: "agent_busy" as const } : {}),
  };
}

export async function send(targetDir: string | undefined, opts: SendOptions): Promise<void> {
  const dir = resolve(targetDir ?? ".");
  const { sessionName: session } = await resolveProjectConfigContext(dir);
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

  const result =
    (await deliverMessageThroughDaemon({ session, target, message: rawMessage, noEnter, dir })) ??
    deliverMessage({ session, target, message: rawMessage, noEnter, dir });
  const { message, busyStatus } = result;
  const pane = result.target;

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const label = pane.name ?? pane.title;
  const preview = message.length > 60 ? message.slice(0, 60) + "..." : message;
  console.log(`Sent to "${label}" (${pane.paneId}): ${preview}`);

  if (busyStatus === "agent") {
    console.log("Warning: agent appears busy. Message sent anyway.");
  }
}
