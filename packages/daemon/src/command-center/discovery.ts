import { execFileSync } from "node:child_process";
import { listSessionPanes } from "../widgets/lib/pane-comms.ts";
import type { PaneInfo } from "@tmux-ide/contracts";
import { getDefaultWorkspaceRegistry } from "../lib/workspace-registry.ts";

export interface SessionInfo {
  name: string;
  dir: string;
  panes: DiscoveredPaneInfo[];
}

/** Live pane metadata enriched with the durable tmux-ide identity stamp. */
export interface DiscoveredPaneInfo extends PaneInfo {
  semanticPaneId: string | null;
}

export interface SessionOverview {
  name: string;
  dir: string;
}

/** Resource-specific all-window facts. Runtime identities stop at the projector boundary. */
export interface ApplicationShellDiscoveredPane {
  runtimePaneId: string;
  windowId: string;
  semanticPaneId: string | null;
  index: number;
  title: string;
  currentCommand: string;
  active: boolean;
  windowPaneCount: number;
  role: string | null;
  name: string | null;
  type: string | null;
}

export interface ApplicationShellDiscoveredSession {
  name: string;
  runtimeSessionId: string;
  dir: string;
  panes: ApplicationShellDiscoveredPane[];
}

export interface ProjectDetail {
  session: string;
  dir: string;
  panes: PaneInfo[];
}

type TmuxRunner = (args: string[]) => string;

let _tmuxRunner: TmuxRunner = (args) =>
  execFileSync("tmux", args, {
    encoding: "utf-8",
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();

export function _setTmuxRunner(fn: TmuxRunner): () => void {
  const prev = _tmuxRunner;
  _tmuxRunner = fn;
  return () => {
    _tmuxRunner = prev;
  };
}

function tmuxSilent(args: string[]): string {
  try {
    return _tmuxRunner(args);
  } catch {
    return "";
  }
}

function tmuxRequired(args: string[]): string {
  try {
    return _tmuxRunner(args);
  } catch {
    throw new ApplicationShellDiscoveryError("tmux-command-failed");
  }
}

function decodeTmuxArgument(value: string, maxLength: number): string | null {
  if (value.length > maxLength * 4 + 16) return null;
  const startsQuote = value.startsWith('"') || value.startsWith("'");
  const endsQuote = value.endsWith('"') || value.endsWith("'");
  if (startsQuote !== endsQuote) return null;
  if (startsQuote && value[0] !== value.at(-1)) return null;
  const encoded = startsQuote && value.length >= 2 ? value.slice(1, -1) : value;
  let decoded = "";
  for (let index = 0; index < encoded.length; index += 1) {
    const current = encoded[index]!;
    if (current !== "\\") {
      const codePoint = current.codePointAt(0)!;
      if (codePoint <= 31 || (codePoint >= 127 && codePoint <= 159)) return null;
      decoded += current;
      continue;
    }
    if (index + 1 >= encoded.length) return null;
    const escaped = encoded[++index]!;
    if (escaped === "e") decoded += "\x1b";
    else if (escaped === "n") decoded += "\n";
    else if (escaped === "r") decoded += "\r";
    else if (escaped === "t") decoded += "\t";
    else if (/[0-7]/u.test(escaped)) {
      let octal = escaped;
      while (octal.length < 3 && /[0-7]/u.test(encoded[index + 1] ?? "")) {
        octal += encoded[++index]!;
      }
      if (octal.length !== 3) return null;
      decoded += String.fromCodePoint(Number.parseInt(octal, 8));
    } else if (["\\", '"', "'", "$"].includes(escaped)) {
      decoded += escaped;
    } else return null;
    if (decoded.length > maxLength) return null;
  }
  return decoded.length <= maxLength ? decoded : null;
}

const APPLICATION_SHELL_PANE_FORMAT = [
  "#{session_id}",
  "#{qa:session_name}",
  "#{pane_id}",
  "#{window_id}",
  "#{qa:@tmux_ide_pane_id}",
  "#{pane_index}",
  "#{qa:pane_title}",
  "#{qa:pane_current_command}",
  "#{window_active}",
  "#{pane_active}",
  "#{window_panes}",
  "#{qa:@ide_role}",
  "#{qa:@ide_name}",
  "#{qa:@ide_type}",
  "application-shell-v1",
].join("\t");

export type ApplicationShellDiscoveryErrorCode = "tmux-command-failed" | "malformed-pane-inventory";

export class ApplicationShellDiscoveryError extends Error {
  readonly code: ApplicationShellDiscoveryErrorCode;

  constructor(code: ApplicationShellDiscoveryErrorCode) {
    super(
      code === "tmux-command-failed"
        ? "tmux pane discovery failed"
        : "tmux pane discovery returned an incoherent inventory",
    );
    this.name = "ApplicationShellDiscoveryError";
    this.code = code;
  }
}

function rejectInventory(): never {
  throw new ApplicationShellDiscoveryError("malformed-pane-inventory");
}

/**
 * Discover one session for the application-shell resource without changing
 * the historical current-window discovery used by older REST endpoints.
 */
export function discoverApplicationShellSession(
  requestedName: string,
): ApplicationShellDiscoveredSession | null {
  const sessionsRaw = tmuxRequired(["list-sessions", "-F", "#{session_name}"]);
  if (sessionsRaw.length > 256 * 1024) rejectInventory();
  if (!sessionsRaw.split("\n").filter(Boolean).includes(requestedName)) return null;
  const registry = getDefaultWorkspaceRegistry();
  if (registry._isLoaded() && !registry.has(requestedName)) return null;

  const contextRaw = tmuxRequired([
    "display-message",
    "-t",
    `=${requestedName}:`,
    "-p",
    "#{session_id}\t#{qa:session_name}\t#{qa:pane_current_path}",
  ]);
  if (contextRaw.length > 16 * 1024) rejectInventory();
  const contextFields = contextRaw.split("\t");
  if (contextFields.length !== 3) rejectInventory();
  const [sessionId = "", encodedContextName = "", encodedDir = ""] = contextFields;
  const contextName = decodeTmuxArgument(encodedContextName, 256);
  const dir = decodeTmuxArgument(encodedDir, 4096);
  if (!/^\$[0-9]+$/u.test(sessionId) || contextName !== requestedName || dir === null || !dir) {
    rejectInventory();
  }
  if (/\p{Cc}/u.test(dir)) rejectInventory();
  const raw = tmuxRequired([
    "list-panes",
    "-s",
    "-t",
    `=${requestedName}`,
    "-F",
    APPLICATION_SHELL_PANE_FORMAT,
  ]);
  if (raw.length > 1024 * 1024) rejectInventory();
  const lines = raw ? raw.split("\n") : [];
  if (lines.length > 512) rejectInventory();
  const panes: ApplicationShellDiscoveredPane[] = [];
  const runtimePaneIds = new Set<string>();
  for (const line of lines) {
    const fields = line.split("\t");
    if (fields.length !== 15) rejectInventory();
    const [
      rowSessionId = "",
      encodedSessionName,
      runtimePaneId = "",
      windowId = "",
      encodedSemanticPaneId = "",
      indexValue = "",
      encodedTitle = "",
      encodedCommand = "",
      windowActive = "",
      paneActive = "",
      windowPaneCountValue = "",
      encodedRole = "",
      encodedName = "",
      encodedType = "",
      sentinel = "",
    ] = fields;
    if (sentinel !== "application-shell-v1") rejectInventory();
    if (rowSessionId !== sessionId) rejectInventory();
    if (decodeTmuxArgument(encodedSessionName!, 256) !== requestedName) rejectInventory();
    if (!/^%[0-9]+$/u.test(runtimePaneId) || runtimePaneIds.has(runtimePaneId)) rejectInventory();
    runtimePaneIds.add(runtimePaneId);
    if (!/^@[0-9]+$/u.test(windowId)) rejectInventory();
    const index = Number.parseInt(indexValue, 10);
    const windowPaneCount = Number.parseInt(windowPaneCountValue, 10);
    if (!Number.isSafeInteger(index) || index < 0) rejectInventory();
    if (!Number.isSafeInteger(windowPaneCount) || windowPaneCount < 1) rejectInventory();
    if (!["0", "1"].includes(windowActive) || !["0", "1"].includes(paneActive)) {
      rejectInventory();
    }
    const optional = (value: string, maxLength = 256): string | null => {
      const decoded = decodeTmuxArgument(value, maxLength);
      if (decoded === null) rejectInventory();
      return decoded.length === 0 ? null : decoded;
    };
    const title = decodeTmuxArgument(encodedTitle, 1024);
    const currentCommand = decodeTmuxArgument(encodedCommand, 512);
    if (title === null || currentCommand === null) rejectInventory();
    panes.push({
      runtimePaneId,
      windowId,
      semanticPaneId: optional(encodedSemanticPaneId),
      index,
      title,
      currentCommand,
      active: windowActive === "1" && paneActive === "1",
      windowPaneCount,
      role: optional(encodedRole),
      name: optional(encodedName),
      type: optional(encodedType),
    });
  }
  const windowCounts = new Map<string, number>();
  for (const pane of panes) {
    windowCounts.set(pane.windowId, (windowCounts.get(pane.windowId) ?? 0) + 1);
  }
  if (panes.some((pane) => windowCounts.get(pane.windowId) !== pane.windowPaneCount)) {
    rejectInventory();
  }
  if (panes.filter((pane) => pane.active).length > 1) rejectInventory();
  const afterSessionId = tmuxRequired([
    "display-message",
    "-t",
    `=${requestedName}:`,
    "-p",
    "#{session_id}",
  ]);
  if (afterSessionId !== sessionId) rejectInventory();
  return { name: requestedName, runtimeSessionId: sessionId, dir, panes };
}

function semanticPaneIds(session: string): ReadonlyMap<string, string> {
  const raw = tmuxSilent(["list-panes", "-t", session, "-F", "#{pane_id}\t#{@tmux_ide_pane_id}"]);
  const result = new Map<string, string>();
  if (!raw) return result;
  for (const line of raw.split("\n")) {
    const separator = line.indexOf("\t");
    if (separator < 0) continue;
    const runtimePaneId = line.slice(0, separator);
    const semanticPaneId = line.slice(separator + 1);
    if (!/^%[0-9]+$/u.test(runtimePaneId) || semanticPaneId.length === 0) continue;
    result.set(runtimePaneId, semanticPaneId);
  }
  return result;
}

export function listTmuxSessions(): string[] {
  const raw = tmuxSilent(["list-sessions", "-F", "#{session_name}"]);
  if (!raw) return [];
  return raw.split("\n").filter(Boolean);
}

export function getSessionCwd(session: string): string {
  return tmuxSilent(["display-message", "-t", session, "-p", "#{pane_current_path}"]);
}

export function discoverSessions(): SessionInfo[] {
  const sessionNames = listTmuxSessions();
  const results: SessionInfo[] = [];

  // Once the workspace registry is loaded (post daemon-embed startup),
  // discovery is gated by registry membership: only registered workspaces
  // are visible. Pre-load (e.g. unit tests that bypass daemon-embed) we
  // fall through to the legacy "any tmux session with a cwd" behavior.
  const registry = getDefaultWorkspaceRegistry();
  const enforceRegistry = registry._isLoaded();

  for (const name of sessionNames) {
    if (enforceRegistry && !registry.has(name)) continue;
    const dir = getSessionCwd(name);
    if (!dir) continue;

    let panes: DiscoveredPaneInfo[] = [];
    try {
      const semanticIds = semanticPaneIds(name);
      panes = listSessionPanes(name).map((pane) => ({
        ...pane,
        semanticPaneId: semanticIds.get(pane.id) ?? null,
      }));
    } catch {
      // session may have vanished
    }

    results.push({ name, dir, panes });
  }

  return results;
}

export function buildOverviews(sessions: SessionInfo[]): SessionOverview[] {
  return sessions.map((s) => ({ name: s.name, dir: s.dir }));
}

export function buildProjectDetail(info: SessionInfo): ProjectDetail {
  return {
    session: info.name,
    dir: info.dir,
    // Keep the historical project-detail response stable. The semantic stamp
    // is consumed by typed resources such as application-shell, not leaked by
    // adding an incidental field to this older endpoint.
    panes: info.panes.map(({ semanticPaneId: _semanticPaneId, ...pane }) => pane),
  };
}
