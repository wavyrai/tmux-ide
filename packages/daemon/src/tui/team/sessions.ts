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
import type { AgentManifest } from "../detect/manifest.ts";
import { readProcessTable, resolveAgentCommand } from "../detect/process-tree.ts";
import { readPaneSnapshot } from "../detect/snapshot.ts";

export interface TeamSession {
  name: string;
  attached: boolean;
  windows: number;
  panes: number;
  status: AgentStatus;
  /**
   * Per-window (tmux tab) rollup: one entry per window the session owns, in
   * ascending window-index order. The `windows` count above stays for compat;
   * this is the richer breakdown the switcher/cockpit navigate.
   */
  windowList: TeamWindow[];
}

/**
 * A single tmux window (tab) within a session, with its panes' statuses rolled
 * up to one status (highest severity wins, like a session rollup).
 */
export interface TeamWindow {
  /** `window_index` — tmux's own index (may be non-contiguous). */
  index: number;
  /** `window_name`. */
  name: string;
  /** Whether this is the session's active (foreground) window. */
  active: boolean;
  /** How many panes the window owns. */
  panes: number;
  /** Rolled-up status of the window's panes. */
  status: AgentStatus;
}

/**
 * A single pane's resolved detail, handed to {@link ListTeamSessionsOpts.onPane}
 * as each pane is classified. `agent` is the resolved agent id, or `null` for a
 * non-agent pane (no manifest, or the `shell` catch-all — those get no chip).
 * `status` is the final status (authority when fresh, else scraped/tracked).
 */
export interface PaneDetail {
  sessionName: string;
  paneId: string;
  agent: string | null;
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
  /** `window_index` — the window (tab) this pane lives in. */
  windowIndex: number;
  /** `window_name`. */
  windowName: string;
  /** `window_active` — whether this pane's window is the session's active one. */
  windowActive: boolean;
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

/** Options for {@link listTeamSessions}. */
export interface ListTeamSessionsOpts {
  /**
   * Name of the currently-attached/viewed session, if any — its panes are
   * marked seen (acknowledging any pending `done`).
   */
  viewed?: string;
  /**
   * Per-pane sink, invoked once per pane with its resolved agent + final
   * status as it's classified. Lets a caller (the chrome updater) recover the
   * per-pane truth the rollup throws away, WITHOUT a second scan. When absent,
   * the extra manifest resolution for authority panes is skipped — existing
   * callers see zero behavior change.
   */
  onPane?: (pane: PaneDetail) => void;
}

/**
 * List every live tmux session with a rolled-up agent status.
 *
 * @param tracker Persistent status tracker threaded across refreshes so the
 *   cross-tick `done` state can be inferred.
 * @param opts See {@link ListTeamSessionsOpts}.
 */
export function listTeamSessions(
  tracker: StatusTracker,
  opts: ListTeamSessionsOpts = {},
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
      const wantPane = typeof opts.onPane === "function";
      const statuses = panes.map((pane) => {
        // AUTHORITY first: a fresh hook-reported state outranks scraping.
        const authority = parseAuthority(pane.authority, nowSec);
        let status: AgentStatus;
        // The manifest is resolved in the fallback anyway; for authority panes
        // we only resolve it (cheaply — the process table is already loaded, no
        // capture) when a pane sink wants the agent name for a chip.
        let manifest: AgentManifest | undefined;
        if (authority !== null) {
          if (authority === "done" && seen) {
            // Viewing acknowledges a finished agent — persist the ack so the
            // pane doesn't flip back to done on the next tick.
            ackDone(pane.id, nowSec);
            status = "idle";
          } else {
            status = authority;
          }
          if (wantPane) {
            manifest = resolveAgentCommand(pane.cmd, pane.pid, processTable, {
              hint: pane.hint,
            }).manifest;
          }
        } else {
          // FALLBACK: snapshot scraping. Resolve the real agent from the pane's
          // process tree (pane_current_command alone is usually just node/bun/sh).
          // Only capture recognized agent panes; unknown commands stay "unknown"
          // without a capture-pane round-trip.
          manifest = resolveAgentCommand(pane.cmd, pane.pid, processTable, {
            hint: pane.hint,
          }).manifest;
          const instant = manifest
            ? classifyInstant({ ...readPaneSnapshot(pane.id), title: pane.title }, manifest)
            : "unknown";
          status = tracker.update(pane.id, instant, { seen });
        }
        // The `shell` catch-all isn't a real agent — a raw shell pane gets no
        // chip (agent null → empty chip → border falls back to the pane title).
        opts.onPane?.({
          sessionName: name,
          paneId: pane.id,
          agent: manifest && manifest.id !== "shell" ? manifest.id : null,
          status,
        });
        return status;
      });

      return {
        name,
        attached: attached === "1",
        windows: Number(windows) || 0,
        panes: panes.length,
        status: rollupStatus(statuses),
        // `panes` and `statuses` are parallel (statuses = panes.map(...)), so
        // the pure rollup can group each pane's window with its resolved status.
        windowList: rollupWindows(panes, statuses),
      };
    });
}

/** One `list-panes -a` call, grouped by session — avoids N tmux calls. */
function collectPanes(): Map<string, PaneRecord[]> {
  const raw = tmux([
    "list-panes",
    "-a",
    "-F",
    // Window fields sit before pane_title so the (tab-safe) title stays the
    // trailing catch-all — window names don't contain tabs in practice.
    "#{session_name}\t#{pane_id}\t#{pane_pid}\t#{pane_current_command}\t#{@agent_state}\t#{@agent_hint}\t#{window_index}\t#{window_name}\t#{window_active}\t#{pane_title}",
  ]);
  const bySession = new Map<string, PaneRecord[]>();
  for (const line of raw.split("\n").filter(Boolean)) {
    const [
      session = "",
      id = "",
      pid = "",
      cmd = "",
      authority = "",
      hint = "",
      windowIndex = "0",
      windowName = "",
      windowActive = "0",
      ...titleParts
    ] = line.split("\t");
    if (!session) continue;
    const list = bySession.get(session) ?? [];
    list.push({
      id,
      pid: Number(pid) || 0,
      cmd,
      authority,
      hint,
      windowIndex: Number(windowIndex) || 0,
      windowName,
      windowActive: windowActive === "1",
      title: titleParts.join("\t"),
    });
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

/** The window fields {@link rollupWindows} needs from each pane — PaneRecord fits. */
export interface WindowPaneInput {
  windowIndex: number;
  windowName: string;
  windowActive: boolean;
}

/**
 * Group a session's panes into per-window rollups — PURE.
 *
 * `panes[i]` and `statuses[i]` are parallel (one status per pane). Panes are
 * bucketed by `windowIndex`; each window's panes roll up to a single status via
 * {@link rollupStatus}, its `name` taken from the first pane seen and `active`
 * true if ANY of its panes report `window_active`. Windows come back in
 * ascending index order. An empty pane list yields an empty window list.
 */
export function rollupWindows(
  panes: WindowPaneInput[],
  statuses: AgentStatus[],
): TeamWindow[] {
  const byIndex = new Map<
    number,
    { name: string; active: boolean; statuses: AgentStatus[] }
  >();
  panes.forEach((pane, i) => {
    let entry = byIndex.get(pane.windowIndex);
    if (!entry) {
      entry = { name: pane.windowName, active: false, statuses: [] };
      byIndex.set(pane.windowIndex, entry);
    }
    if (pane.windowActive) entry.active = true;
    const status = statuses[i];
    if (status) entry.statuses.push(status);
  });
  return [...byIndex.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, entry]) => ({
      index,
      name: entry.name,
      active: entry.active,
      panes: entry.statuses.length,
      status: rollupStatus(entry.statuses),
    }));
}
