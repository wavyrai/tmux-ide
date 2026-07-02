/**
 * Data layer for the team TUI.
 *
 * Enumerates every live tmux session and rolls each one up to an agent
 * status. Detection is TWO-LAYER: a fresh `@agent_state` pane option —
 * written by a lifecycle-hook integration (`tmux-ide integration install
 * claude`) or any self-reporting agent — is AUTHORITATIVE; only panes
 * without authority fall back to snapshot scraping (pick a manifest by the
 * pane command, capture, classify, fold through the persistent
 * `StatusTracker` so the cross-tick `done` surfaces). Pane statuses roll up
 * to a single session status.
 */
import { execFileSync } from "node:child_process";
import {
  classifyInstant,
  parseAuthority,
  type AgentStatus,
  type StatusTracker,
} from "../detect/classify.ts";
import { readProcessTable, resolveAgentCommand } from "../detect/process-tree.ts";
import { readPaneSnapshot } from "../detect/snapshot.ts";

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
  /** `pane_pid` — the pane's immediate process, root of its process tree. */
  pid: number;
  /** `pane_current_command`. */
  cmd: string;
  /** `pane_title`. */
  title: string;
  /** Raw `@agent_state` pane option (authority layer), if set. */
  authority: string;
  /** Raw `@agent_hint` pane option — forces a manifest when set. */
  hint: string;
}

/** Severity order — highest present status wins in a rollup. */
const SEVERITY: AgentStatus[] = ["blocked", "working", "done", "idle", "unknown"];

/**
 * Whether a session should appear in the switcher. Any `_`-prefixed session is
 * internal plumbing (the `_tmux-ide-chrome` updater, scratch sessions, …) and
 * is filtered out so the cockpit never lists — or navigates into — infrastructure.
 */
export function isListableSession(name: string): boolean {
  return !name.startsWith("_");
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
  // One `ps` read per call — a single ~10-20ms syscall shared across every
  // fallback pane, so the manifest lookup can walk each pane's process tree
  // instead of matching on the (usually generic) pane_current_command.
  const processTable = readProcessTable();

  return raw
    .split("\n")
    .filter(Boolean)
    .filter((line) => isListableSession(line.split("\t")[0] ?? ""))
    .map((line) => {
      const [name = "", attached = "", windows = "0"] = line.split("\t");
      const panes = panesBySession.get(name) ?? [];
      const seen = opts.viewed === name;

      const nowSec = Math.floor(Date.now() / 1000);
      const statuses = panes.map((pane) => {
        // AUTHORITY first: a fresh hook-reported state outranks scraping.
        const authority = parseAuthority(pane.authority, nowSec);
        if (authority !== null) {
          if (authority === "done" && seen) {
            // Viewing acknowledges a finished agent — persist the ack so the
            // pane doesn't flip back to done on the next tick.
            ackDone(pane.id, nowSec);
            return "idle";
          }
          return authority;
        }
        // FALLBACK: snapshot scraping. Resolve the real agent from the pane's
        // process tree (pane_current_command alone is usually just node/bun/sh).
        // Only capture recognized agent panes; unknown commands stay "unknown"
        // without a capture-pane round-trip.
        const manifest = resolveAgentCommand(pane.cmd, pane.pid, processTable, {
          hint: pane.hint,
        }).manifest;
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
    "#{session_name}\t#{pane_id}\t#{pane_pid}\t#{pane_current_command}\t#{@agent_state}\t#{@agent_hint}\t#{pane_title}",
  ]);
  const bySession = new Map<string, PaneRecord[]>();
  for (const line of raw.split("\n").filter(Boolean)) {
    const [session = "", id = "", pid = "", cmd = "", authority = "", hint = "", ...titleParts] =
      line.split("\t");
    if (!session) continue;
    const list = bySession.get(session) ?? [];
    list.push({ id, pid: Number(pid) || 0, cmd, authority, hint, title: titleParts.join("\t") });
    bySession.set(session, list);
  }
  return bySession;
}

/**
 * Acknowledge an authority-reported `done` for a viewed pane by rewriting its
 * option to idle — otherwise the stamped "done" would resurface every tick.
 */
function ackDone(paneId: string, nowSec: number): void {
  tmux(["set-option", "-p", "-t", paneId, "@agent_state", `idle:${nowSec}`]);
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
