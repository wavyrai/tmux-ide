import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { listSessionPanes } from "../widgets/lib/pane-comms.ts";
import type { PaneInfo } from "@tmux-ide/contracts";
import { getDefaultWorkspaceRegistry } from "../lib/workspace-registry.ts";
import { ADOPTED_OPTION } from "../lib/chrome-front-door.ts";

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

export interface LiveSessionSummary {
  readonly liveSessionId: `live-session.${string}`;
  readonly sessionName: string;
  readonly paneCount: number;
}

function liveSessionId(serverPid: string, sessionId: string, sessionCreated: string) {
  const digest = createHash("sha256")
    .update(`${serverPid}\0${sessionId}\0${sessionCreated}`)
    .digest("hex")
    .slice(0, 20);
  return `live-session.${digest}` as const;
}

/**
 * Enumerate observed tmux truth without consulting the workspace registry.
 *
 * The V2 workspace catalog deliberately separates durable workspace intent
 * from live tmux sessions. Reusing {@link discoverSessions} here would erase
 * every ordinary, not-yet-promoted tmux session as soon as the registry has
 * loaded, making the configless app unable to discover its own front door.
 * Production passes the daemon-generation-pinned runner; the default keeps
 * the small command-center test seam backwards compatible.
 */
export function discoverLiveSessionSummaries(
  runTmux: TmuxRunner = _tmuxRunner,
): LiveSessionSummary[] {
  let raw: string;
  try {
    raw = runTmux([
      "list-panes",
      "-a",
      "-F",
      "#{pid}\t#{session_id}\t#{session_created}\t#{session_name}",
    ]);
  } catch {
    return [];
  }
  if (!raw) return [];
  const sessions = new Map<string, LiveSessionSummary>();
  for (const line of raw.split("\n")) {
    const [serverPid = "", sessionId = "", sessionCreated = "", sessionName = ""] =
      line.split("\t");
    if (!/^\d+$/u.test(serverPid) || !/^\$\d+$/u.test(sessionId) || !/^\d+$/u.test(sessionCreated))
      continue;
    if (!sessionName || !isVisibleFleetSession(sessionName)) continue;
    const identity = liveSessionId(serverPid, sessionId, sessionCreated);
    const previous = sessions.get(identity);
    sessions.set(identity, {
      liveSessionId: identity,
      sessionName,
      paneCount: (previous?.paneCount ?? 0) + 1,
    });
  }
  return [...sessions.values()];
}

const AGENT_STATE_LINE = /^([^\t]+)\t(%[0-9]+)\t([^\t]*)\t(.*)$/u;

/** One pane's agent-discovery reading: authority, identity, and foreground command. */
export interface AgentPaneStateReading {
  /** Raw `@agent_state` stamp (`"<state>:<epoch>"`, empty when unset). */
  readonly state: string;
  /** Durable `@tmux_ide_pane_id` stamp, or null when unset. Never a runtime `%id`. */
  readonly paneStamp: string | null;
  /** tmux's current foreground command; changes when a new pane finishes exec'ing its agent. */
  readonly command?: string;
}

/**
 * Read the ground-truth `@agent_state` option of every pane on the tmux
 * server, grouped by session name, alongside each pane's durable
 * `@tmux_ide_pane_id` stamp (the turn-completed receipt's correlation key).
 * Runs through the same injectable tmux runner as the rest of discovery, so
 * tests stay hermetic and a failing `tmux` call degrades to an empty read
 * (`null`) rather than throwing.
 *
 * Returns `null` when the underlying `list-panes` fails so callers can tell a
 * transient tmux hiccup apart from a genuinely empty server — the agent-status
 * watcher relies on that distinction to avoid emitting spurious invalidations.
 */
export function readAgentStatesBySession(): Map<string, Map<string, AgentPaneStateReading>> | null {
  let raw: string;
  try {
    raw = _tmuxRunner([
      "list-panes",
      "-a",
      "-F",
      "#{session_name}\t#{pane_id}\t#{@tmux_ide_pane_id}\t#{@agent_state}",
    ]);
  } catch {
    return null;
  }
  const bySession = new Map<string, Map<string, AgentPaneStateReading>>();
  if (!raw) return bySession;
  for (const line of raw.split("\n")) {
    const match = AGENT_STATE_LINE.exec(line);
    if (!match) continue;
    const sessionName = match[1]!;
    const paneId = match[2]!;
    const paneStamp = match[3]!;
    const state = match[4]!;
    let panes = bySession.get(sessionName);
    if (!panes) {
      panes = new Map<string, AgentPaneStateReading>();
      bySession.set(sessionName, panes);
    }
    panes.set(paneId, { state, paneStamp: paneStamp.length > 0 ? paneStamp : null });
  }
  return bySession;
}

export function getSessionCwd(session: string): string {
  return tmuxSilent(["display-message", "-t", session, "-p", "#{pane_current_path}"]);
}

/**
 * Whether a session belongs in the visible fleet. Mirrors the cockpit's
 * `isListableSession`: `_`-prefixed sessions are internal plumbing (the chrome
 * updater, the app host) and `zz-`-prefixed sessions are development scratch —
 * both are filtered so the fleet catalog never lists infrastructure.
 */
export function isVisibleFleetSession(name: string): boolean {
  return !name.startsWith("_") && !name.startsWith("zz-");
}

/**
 * Read the visible, adopted tmux session names (those stamped with
 * {@link ADOPTED_OPTION}). Runs through the injectable tmux runner, so tests
 * stay hermetic. Returns `null` when the underlying `list-sessions` call fails
 * (e.g. no server) so a caller — the fleet-composition watcher — can hold its
 * baseline across a transient hiccup instead of reporting the whole fleet gone.
 */
export function readAdoptedSessionNames(runTmux: TmuxRunner = _tmuxRunner): string[] | null {
  let raw: string;
  try {
    raw = runTmux(["list-sessions", "-F", `#{session_name}\t#{${ADOPTED_OPTION}}`]);
  } catch {
    return null;
  }
  const names: string[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    const separator = line.indexOf("\t");
    if (separator < 0) continue;
    const name = line.slice(0, separator);
    const flag = line.slice(separator + 1);
    if (name && flag === "1" && isVisibleFleetSession(name)) names.push(name);
  }
  return names;
}

/** One live pane, with the raw agent-authority options gathered for the fleet. */
export interface FleetPaneFacts {
  readonly runtimePaneId: string;
  /** Durable semantic pane stamp owned by tmux-ide, when one has been assigned. */
  readonly semanticPaneId: string | null;
  /** tmux pane process id; fences runtime id reuse and pane reincarnation. */
  readonly incarnation: number;
  readonly active: boolean;
  readonly currentCommand: string;
  readonly currentPath: string;
  readonly agentStateRaw: string | null;
  readonly agentStatusTextRaw: string | null;
  readonly agentDisplayNameRaw: string | null;
  /** Durable `@agent_hint` agent identity, or null when the pane has none. */
  readonly agentHintRaw: string | null;
}

/** One adopted session in the fleet, with its live panes. */
export interface FleetSessionFacts {
  readonly name: string;
  /** True when the workspace registry backs this session (the app created it). */
  readonly appCreated: boolean;
  /** Session working directory (a full path; the projector emits only its basename). */
  readonly cwd: string;
  readonly panes: readonly FleetPaneFacts[];
}

// Distinctive multi-char field/line delimiters — collision-resistant against
// arbitrary pane paths and user-controlled `@agent_status_text` values, matching
// the agent-status probe idiom. A value carrying a newline splits into a line
// without the trailing sentinel, which the parser drops (that pane degrades to
// "no facts") rather than corrupting a neighbour.
const FLEET_FIELD_SEPARATOR = "|tmux-ide-fleet-field-v1|";
const FLEET_LINE_SENTINEL = "tmux-ide-fleet-v1";
const FLEET_PANE_FORMAT = [
  "#{session_name}",
  "#{pane_id}",
  "#{@tmux_ide_pane_id}",
  "#{pane_pid}",
  "#{pane_active}",
  "#{pane_current_command}",
  "#{pane_current_path}",
  "#{@agent_state}",
  "#{@agent_status_text}",
  "#{@agent_display_name}",
  "#{@agent_hint}",
  FLEET_LINE_SENTINEL,
].join(FLEET_FIELD_SEPARATOR);

function emptyToNull(value: string): string | null {
  return value.length === 0 ? null : value;
}

/**
 * Enumerate the visible, adopted fleet — every adopted tmux session (registry-
 * backed OR adopted-only) and the live panes inside it, with each pane's raw
 * `@agent_state` / `@agent_status_text` / `@agent_display_name` authority
 * options gathered in ONE batched `list-panes -a` call. All IO runs through the
 * injectable tmux runner (hermetic tests, silent degrade). Returns `null` only
 * when the session listing fails; a failed pane read degrades every session to
 * empty panes rather than dropping the sessions, and the pure projector turns
 * either into an honest, valid resource.
 */
export function readAdoptedFleet(
  registry: { list(): { sessionName: string }[] } = getDefaultWorkspaceRegistry(),
  runTmux: TmuxRunner = _tmuxRunner,
): FleetSessionFacts[] | null {
  const adopted = readAdoptedSessionNames(runTmux);
  if (adopted === null) return null;
  const adoptedSet = new Set(adopted);
  if (adoptedSet.size === 0) return [];

  const appCreatedSessions = new Set(registry.list().map((workspace) => workspace.sessionName));

  const panesBySession = new Map<string, FleetPaneFacts[]>();
  let panesRaw: string;
  try {
    panesRaw = runTmux(["list-panes", "-a", "-F", FLEET_PANE_FORMAT]);
  } catch {
    panesRaw = "";
  }
  for (const line of panesRaw.split("\n")) {
    if (!line) continue;
    const fields = line.split(FLEET_FIELD_SEPARATOR);
    // session, pane, semantic pane, incarnation pid, active, command, path, state,
    // statusText, displayName, hint, sentinel
    if (fields.length !== 12 || fields[11] !== FLEET_LINE_SENTINEL) continue;
    const sessionName = fields[0]!;
    if (!adoptedSet.has(sessionName)) continue;
    const runtimePaneId = fields[1]!;
    if (!/^%[0-9]+$/u.test(runtimePaneId)) continue;
    const incarnation = Number.parseInt(fields[3]!, 10);
    if (!Number.isSafeInteger(incarnation) || incarnation < 1) continue;
    let panes = panesBySession.get(sessionName);
    if (!panes) {
      panes = [];
      panesBySession.set(sessionName, panes);
    }
    panes.push({
      runtimePaneId,
      semanticPaneId: emptyToNull(fields[2]!),
      incarnation,
      active: fields[4] === "1",
      currentCommand: fields[5]!,
      currentPath: fields[6]!,
      agentStateRaw: emptyToNull(fields[7]!),
      agentStatusTextRaw: emptyToNull(fields[8]!),
      agentDisplayNameRaw: emptyToNull(fields[9]!),
      agentHintRaw: emptyToNull(fields[10]!),
    });
  }

  return adopted.map((name) => {
    const panes = panesBySession.get(name) ?? [];
    const active = panes.find((pane) => pane.active) ?? panes[0];
    return {
      name,
      appCreated: appCreatedSessions.has(name),
      cwd: active?.currentPath ?? "",
      panes,
    };
  });
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
  const registeredSessionNames = enforceRegistry
    ? new Set(registry.list().map(({ sessionName }) => sessionName))
    : null;

  for (const name of sessionNames) {
    if (registeredSessionNames && !registeredSessionNames.has(name)) continue;
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
