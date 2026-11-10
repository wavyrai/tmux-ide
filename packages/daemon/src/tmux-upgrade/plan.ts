/**
 * PURE — the plan for moving a tmux server onto tmux-ide's own tmux (#766):
 * snapshot coverage, the agent and program lists, the text shown before the
 * question, and the confirmation rule. The io lives in ./run.ts.
 */
import { paneResumeCommand } from "../restore.ts";
import type { FleetSnapshot } from "../tui/chrome/snapshot.ts";
import { parseAuthority } from "../tui/detect/classify.ts";
import { isListableSession } from "../tui/team/sessions.ts";
import { UPDATER_SESSION } from "../lib/chrome-front-door.ts";
import type { ServerFeatures } from "../lib/tmux-server-features.ts";

/** The server to move, pinned by socket path and by pid plus start time. */
export interface ServerIdentity {
  /** The machine's hostname, as the user knows it. */
  host: string;
  socketPath: string;
  pid: number;
  /** `#{start_time}`; with pid it tells this server from a later one on the same socket. */
  startTime: number;
  /** `#{version}` of the running server. */
  version: string;
  /** The binary the server runs, or "" when it can't be read. */
  executable: string;
  features: ServerFeatures;
}

/** `list-panes -a` lines: `session \t window_index \t pane_index`. */
export const COVERAGE_PANE_FORMAT = "#{session_name}\t#{window_index}\t#{pane_index}";

export interface CoverageResult {
  ok: boolean;
  problems: string[];
  /** Sessions that end and are not restored (`_…`, `zz-…`), minus the updater's own. */
  notRestored: string[];
}

function parseListing(listing: readonly string[]) {
  const sessions = new Map<string, Map<number, number[]>>();
  const notRestored = new Set<string>();
  for (const line of listing) {
    if (!line) continue;
    const [session = "", window = "", pane = ""] = line.split("\t");
    if (!session) continue;
    if (!isListableSession(session)) {
      if (session !== UPDATER_SESSION) notRestored.add(session);
      continue;
    }
    let windows = sessions.get(session);
    if (!windows) sessions.set(session, (windows = new Map()));
    const panes = windows.get(Number(window)) ?? [];
    panes.push(Number(pane));
    windows.set(Number(window), panes);
  }
  return { sessions, notRestored: [...notRestored].sort() };
}

/**
 * Does the snapshot hold every listable session, window and pane the live
 * server lists, with a layout per window and a folder per pane? Nothing may be
 * killed unless this is ok against a listing taken after the file was read back.
 */
export function coverage(snapshot: FleetSnapshot, listing: readonly string[]): CoverageResult {
  const live = parseListing(listing);
  const problems: string[] = [];
  if (live.sessions.size === 0 && live.notRestored.length === 0)
    problems.push("the server lists no sessions");
  const saved = new Map(snapshot.sessions.map((session) => [session.name, session]));
  for (const [name, windows] of live.sessions) {
    const session = saved.get(name);
    if (!session) {
      problems.push(`session ${name} is not in the snapshot`);
      continue;
    }
    const savedWindows = new Map(session.windows.map((window) => [window.index, window]));
    for (const [index, panes] of windows) {
      const window = savedWindows.get(index);
      if (!window) {
        problems.push(`window ${name}:${index} is not in the snapshot`);
        continue;
      }
      if (window.panes.length !== panes.length)
        problems.push(
          `window ${name}:${index} has ${panes.length} panes, the snapshot has ${window.panes.length}`,
        );
    }
    for (const window of session.windows)
      if (!windows.has(window.index))
        problems.push(`window ${name}:${window.index} closed after the snapshot`);
  }
  for (const session of snapshot.sessions) {
    if (!live.sessions.has(session.name)) {
      problems.push(`session ${session.name} ended after the snapshot`);
      continue;
    }
    for (const window of session.windows) {
      if (!window.layout)
        problems.push(`window ${session.name}:${window.index} has no layout in the snapshot`);
      for (const pane of window.panes)
        if (!pane.cwd)
          problems.push(
            `pane ${session.name}:${window.index}.${pane.index} has no folder in the snapshot`,
          );
    }
  }
  return { ok: problems.length === 0, problems, notRestored: live.notRestored };
}

/**
 * After restore: the same sessions, with the same pane count per window in
 * order. Window indexes may differ (base-index), so they are not compared.
 */
export function sameShape(snapshot: FleetSnapshot, listing: readonly string[]): string[] {
  const live = parseListing(listing).sessions;
  const problems: string[] = [];
  for (const session of snapshot.sessions) {
    const windows = live.get(session.name);
    if (!windows) {
      problems.push(`session ${session.name} did not come back`);
      continue;
    }
    const got = [...windows.entries()].sort(([a], [b]) => a - b).map(([, panes]) => panes.length);
    const want = session.windows.map((window) => window.panes.length);
    if (got.join("+") !== want.join("+"))
      problems.push(
        `session ${session.name} came back with ${got.join("+")} panes, the snapshot has ${want.join("+")}`,
      );
  }
  return problems;
}

export type AgentTurnState = "working" | "blocked" | "idle" | "done" | "unknown";

export interface PlannedAgent {
  target: string;
  agent: string;
  cwd: string;
  state: AgentTurnState;
  /** Restore will run the agent's resume command for this pane. */
  resumes: boolean;
}

export interface UpgradePlan {
  server: ServerIdentity;
  bundled: { executable: string; version: string };
  snapshotPath: string;
  savedAt: string;
  sessions: { name: string; windows: number; panes: number }[];
  paneCount: number;
  agents: PlannedAgent[];
  /** Agents working, blocked on a question, or with no fresh state report. */
  midTurn: number;
  /** Non-agent programs that stop. */
  programs: { target: string; command: string }[];
  notRestored: string[];
  resumeAgents: boolean;
}

export function buildUpgradePlan(input: {
  server: ServerIdentity;
  bundled: { executable: string; version: string };
  snapshot: FleetSnapshot;
  snapshotPath: string;
  notRestored: string[];
  resumeAgents: boolean;
  nowSec: number;
}): UpgradePlan {
  const agents: PlannedAgent[] = [];
  const programs: UpgradePlan["programs"] = [];
  let paneCount = 0;
  const sessions = input.snapshot.sessions.map((session) => {
    let panes = 0;
    for (const window of session.windows)
      for (const pane of window.panes) {
        panes++;
        const target = `${session.name}:${window.index}.${pane.index}`;
        if (pane.agent) {
          agents.push({
            target,
            agent: pane.agent,
            cwd: pane.cwd,
            state: parseAuthority(pane.agentState ?? undefined, input.nowSec) ?? "unknown",
            resumes: paneResumeCommand(pane, { resumeAgents: input.resumeAgents }) !== null,
          });
        } else if (pane.command) programs.push({ target, command: pane.command });
      }
    paneCount += panes;
    return { name: session.name, windows: session.windows.length, panes };
  });
  return {
    server: input.server,
    bundled: input.bundled,
    snapshotPath: input.snapshotPath,
    savedAt: input.snapshot.savedAt,
    sessions,
    paneCount,
    agents,
    midTurn: agents.filter((agent) => !["idle", "done"].includes(agent.state)).length,
    programs,
    notRestored: input.notRestored,
    resumeAgents: input.resumeAgents,
  };
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

const FEATURE_NAMES: Record<ServerFeatures, string> = {
  full: "tmux-ide's tmux",
  stock: "stock tmux",
  older: "an older tmux-ide tmux",
  partial: "a tmux with only some tmux-ide commands",
  unknown: "tmux",
};

/** The text shown before the question. Its first line names the machine and the server. */
export function renderPlan(plan: UpgradePlan): string {
  const { server } = plan;
  const lines = [
    `This ends ${plural(plan.sessions.length, "session")} and ${plural(plan.agents.length, "agent")} on ${server.host} (${server.socketPath}).`,
    `The server runs ${FEATURE_NAMES[server.features]} ${server.version}${server.executable ? ` (${server.executable})` : ""}.`,
    `tmux-ide's own tmux (${plan.bundled.version}) has every feature. Moving restarts the server.`,
    "",
    "These sessions close and come back:",
    ...plan.sessions.map(
      (session) =>
        `  ${session.name}  ${plural(session.windows, "window")}, ${plural(session.panes, "pane")}`,
    ),
    "",
    "Comes back: windows, split layouts, each pane's folder, pane titles.",
    "Does not come back: running programs, scrollback, shell variables,",
    "aliases you set by hand, background jobs. Save open files first.",
  ];
  if (plan.programs.length) {
    lines.push("", "These programs stop:");
    for (const program of plan.programs) lines.push(`  ${program.target}  ${program.command}`);
  }
  if (plan.agents.length) {
    lines.push("", `Agents (${plan.agents.length}):`);
    for (const agent of plan.agents) {
      const outcome = agent.resumes
        ? "resumes its conversation"
        : plan.resumeAgents
          ? "ends; no saved conversation id"
          : "ends (--no-resume-agents)";
      lines.push(`  ${agent.target}  ${agent.agent}  ${agent.state}  ${agent.cwd}  ${outcome}`);
    }
    if (plan.midTurn)
      lines.push(
        plan.midTurn === 1
          ? "1 agent is mid-turn. Its current turn will be lost."
          : `${plan.midTurn} agents may be mid-turn. Their current turns will be lost.`,
      );
  }
  if (plan.notRestored.length)
    lines.push("", `Also ends, not restored: ${plan.notRestored.join(", ")}`);
  lines.push("", `Snapshot saved: ${plan.snapshotPath}`);
  return lines.join("\n");
}

export type Confirmation =
  | { kind: "ask" }
  | { kind: "preview" }
  | { kind: "proceed" }
  | { kind: "refuse"; reason: string };

/** The default answer is always No. `--yes` alone never ends an agent mid-turn. */
export function confirmation(input: {
  yes: boolean;
  endRunningAgents: boolean;
  json: boolean;
  dryRun: boolean;
  midTurn: number;
}): Confirmation {
  if (input.dryRun || (input.json && !input.yes)) return { kind: "preview" };
  if (!input.yes) return { kind: "ask" };
  if (input.midTurn > 0 && !input.endRunningAgents)
    return {
      kind: "refuse",
      reason: `${plural(input.midTurn, "agent")} may be mid-turn. Pass --yes --end-running-agents to end them, or wait until they are idle.`,
    };
  return { kind: "proceed" };
}
