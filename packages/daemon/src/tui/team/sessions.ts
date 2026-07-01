/**
 * Data layer for the team TUI.
 *
 * Enumerates every live tmux session and rolls each one up to an agent
 * status using the real snapshot-based detector. For each pane we pick a
 * detection manifest by its current command; only recognized agent panes
 * are captured (a `capture-pane` call) and classified, and the resulting
 * per-pane states are folded through a persistent `StatusTracker` so that
 * `done` (a working→idle transition that hasn't been viewed) surfaces. The
 * pane statuses are then rolled up to a single session status.
 */
import { execFileSync } from "node:child_process";
import { classifyInstant, type AgentStatus, type StatusTracker } from "../detect/classify.ts";
import { pickManifest } from "../detect/manifest.ts";
import { BUNDLED_MANIFESTS } from "../detect/manifests.ts";
import { readPaneSnapshot } from "../detect/snapshot.ts";
import { HOST_SESSION } from "./host.ts";

export interface TeamSession {
  name: string;
  attached: boolean;
  windows: number;
  panes: number;
  status: AgentStatus;
}

interface PaneRecord {
  /** tmux pane id, e.g. `%5`. */
  id: string;
  /** `pane_current_command`. */
  cmd: string;
  /** `pane_title`. */
  title: string;
}

/** Severity order — highest present status wins in a rollup. */
const SEVERITY: AgentStatus[] = ["blocked", "working", "done", "idle", "unknown"];

/**
 * Whether a session should appear in the switcher. The host session (the
 * outer `[ switcher | main ]` shell that hosts tmux-ide itself) is filtered
 * out so the cockpit never lists — or navigates into — its own container.
 */
export function isListableSession(name: string): boolean {
  return name !== HOST_SESSION;
}

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

/**
 * List every live tmux session with a rolled-up agent status.
 *
 * @param tracker Persistent status tracker threaded across refreshes so the
 *   cross-tick `done` state can be inferred.
 * @param opts.viewed Name of the currently-attached/viewed session, if any —
 *   its panes are marked seen (acknowledging any pending `done`).
 */
export function listTeamSessions(
  tracker: StatusTracker,
  opts: { viewed?: string } = {},
): TeamSession[] {
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
    .filter((line) => isListableSession(line.split("\t")[0] ?? ""))
    .map((line) => {
      const [name = "", attached = "", windows = "0"] = line.split("\t");
      const panes = panesBySession.get(name) ?? [];
      const seen = opts.viewed === name;

      const statuses = panes.map((pane) => {
        const manifest = pickManifest(pane.cmd, BUNDLED_MANIFESTS);
        // Only capture the pane buffer for recognized agent panes; unknown
        // commands stay "unknown" without a capture-pane round-trip.
        const instant = manifest
          ? classifyInstant({ ...readPaneSnapshot(pane.id), title: pane.title }, manifest)
          : "unknown";
        return tracker.update(pane.id, instant, { seen });
      });

      return {
        name,
        attached: attached === "1",
        windows: Number(windows) || 0,
        panes: panes.length,
        status: rollupStatus(statuses),
      };
    });
}

/** One `list-panes -a` call, grouped by session — avoids N tmux calls. */
function collectPanes(): Map<string, PaneRecord[]> {
  const raw = tmux([
    "list-panes",
    "-a",
    "-F",
    "#{session_name}\t#{pane_id}\t#{pane_current_command}\t#{pane_title}",
  ]);
  const bySession = new Map<string, PaneRecord[]>();
  for (const line of raw.split("\n").filter(Boolean)) {
    const [session = "", id = "", cmd = "", title = ""] = line.split("\t");
    if (!session) continue;
    const list = bySession.get(session) ?? [];
    list.push({ id, cmd, title });
    bySession.set(session, list);
  }
  return bySession;
}

/**
 * Roll a session's per-pane statuses up to a single status. The highest
 * present severity wins (blocked > working > done > idle > unknown), so
 * `unknown` only surfaces when nothing else is present. An empty session
 * (no panes) rolls up to `"idle"`.
 */
export function rollupStatus(statuses: AgentStatus[]): AgentStatus {
  if (statuses.length === 0) return "idle";
  const present = new Set(statuses);
  for (const status of SEVERITY) {
    if (present.has(status)) return status;
  }
  return "unknown";
}
