/**
 * Data layer for the team TUI.
 *
 * Enumerates every live tmux session and rolls each one up to a coarse
 * status. This is the seam the richer agent-state detector plugs into
 * later — for now the status is an activity heuristic over pane titles
 * and current commands; a snapshot-based blocked/working/done/idle
 * detector replaces `computeSessionStatus` in a follow-up.
 */
import { execFileSync } from "node:child_process";

export type SessionStatus = "working" | "idle" | "empty" | "unknown";

export interface TeamSession {
  name: string;
  attached: boolean;
  windows: number;
  panes: number;
  status: SessionStatus;
}

interface PaneSnapshot {
  cmd: string;
  title: string;
}

// Spinner/activity glyphs agents render while a turn is in flight. A
// pane showing one is treated as actively working. This is intentionally
// coarse — the follow-up detector reads the actual pane buffer.
const ACTIVITY = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏◐◓◑◒]|[✳✶✻✽]|⏳|↻|…|thinking|working|running/iu;

function tmux(args: string[]): string {
  try {
    return execFileSync("tmux", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

/** List every live tmux session with a rolled-up status. */
export function listTeamSessions(): TeamSession[] {
  const raw = tmux([
    "list-sessions",
    "-F",
    "#{session_name}\t#{session_attached}\t#{session_windows}",
  ]);
  if (!raw) return [];

  const panesBySession = collectPanes();

  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name = "", attached = "", windows = "0"] = line.split("\t");
      const panes = panesBySession.get(name) ?? [];
      return {
        name,
        attached: attached === "1",
        windows: Number(windows) || 0,
        panes: panes.length,
        status: computeSessionStatus(panes),
      };
    });
}

/** One `list-panes -a` call, grouped by session — avoids N tmux calls. */
function collectPanes(): Map<string, PaneSnapshot[]> {
  const raw = tmux([
    "list-panes",
    "-a",
    "-F",
    "#{session_name}\t#{pane_current_command}\t#{pane_title}",
  ]);
  const bySession = new Map<string, PaneSnapshot[]>();
  for (const line of raw.split("\n").filter(Boolean)) {
    const [session = "", cmd = "", title = ""] = line.split("\t");
    if (!session) continue;
    const list = bySession.get(session) ?? [];
    list.push({ cmd, title });
    bySession.set(session, list);
  }
  return bySession;
}

/** Coarse activity heuristic. Replaced by the snapshot detector later. */
export function computeSessionStatus(panes: PaneSnapshot[]): SessionStatus {
  if (panes.length === 0) return "empty";
  const working = panes.some((p) => ACTIVITY.test(p.title));
  return working ? "working" : "idle";
}
