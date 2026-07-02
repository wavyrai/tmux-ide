/**
 * Fleet snapshot — the fleet's DISASTER-RECOVERY layer.
 *
 * The chrome {@link ./updater.ts updater} sees the whole tmux server every
 * tick. This module turns that view into a durable, structural picture of the
 * fleet — every session's windows, panes, cwds, layouts, titles, and the agent
 * that was running in each pane — and persists it to `~/.tmux-ide/snapshot.json`.
 * When the tmux server dies for real, `tmux-ide restore` ({@link ../../restore.ts})
 * rebuilds the fleet from this file.
 *
 * Split as usual: {@link buildSnapshot} + {@link snapshotFingerprint} are PURE
 * (assembled from raw tmux lines + a process table, unit-tested without a live
 * tmux), while {@link collectFleetSnapshot} / {@link writeSnapshot} /
 * {@link readSnapshot} are the thin io wrappers. {@link createSnapshotter}
 * carries the throttle + change-detection the updater loop drives each tick.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { runTmux } from "@tmux-ide/tmux-bridge";
import { readProcessTable, resolveAgentCommand, type ProcEntry } from "../detect/process-tree.ts";
import { isListableSession } from "../team/sessions.ts";

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/** A single pane, frozen for rebuild. */
export interface PaneSnapshot {
  /** `pane_index` within its window. */
  index: number;
  /** `pane_current_path` — the pane's working directory. */
  cwd: string;
  /**
   * The command to re-run under `--run-commands`, or `null` for a bare shell
   * (which restores as a plain pane). An agent pane records the RESOLVED agent
   * id (e.g. `claude`), not the generic `node`/`bun` shim; a non-shell,
   * non-agent pane records its `pane_current_command` verbatim.
   */
  command: string | null;
  /** Resolved agent id (e.g. `claude`), or `null` for a non-agent pane. */
  agent: string | null;
  /** `@agent_session_id` — the agent's own session id (0037 resumes from it). */
  agentSessionId: string | null;
  /** `@agent_state` — the authority status line. Excluded from the fingerprint (it churns every tick). */
  agentState: string | null;
  /** `pane_title`. */
  title: string;
}

/** A single window (tab), with the layout string that restores its geometry. */
export interface WindowSnapshot {
  /** `window_index`. */
  index: number;
  /** `window_name`. */
  name: string;
  /** Whether this is the session's active window. */
  active: boolean;
  /** `window_layout` — the checksummed layout string tmux's `select-layout` accepts verbatim. */
  layout: string;
  panes: PaneSnapshot[];
}

/** A single session, with its adopted flag so restore re-adopts it. */
export interface SessionSnapshot {
  name: string;
  /** Session cwd — the first window's first pane's cwd. */
  cwd: string;
  /** Whether the session was adopted into the chrome. */
  adopted: boolean;
  windows: WindowSnapshot[];
}

/** The whole fleet at one instant. */
export interface FleetSnapshot {
  version: 1;
  savedAt: string;
  sessions: SessionSnapshot[];
}

// ---------------------------------------------------------------------------
// Read validation — a snapshot on disk is untrusted input
// ---------------------------------------------------------------------------

const PaneSnapshotSchemaZ = z.object({
  index: z.number(),
  cwd: z.string(),
  command: z.string().nullable(),
  agent: z.string().nullable(),
  agentSessionId: z.string().nullable(),
  agentState: z.string().nullable(),
  title: z.string(),
});

const WindowSnapshotSchemaZ = z.object({
  index: z.number(),
  name: z.string(),
  active: z.boolean(),
  layout: z.string(),
  panes: z.array(PaneSnapshotSchemaZ),
});

const SessionSnapshotSchemaZ = z.object({
  name: z.string(),
  cwd: z.string(),
  adopted: z.boolean(),
  windows: z.array(WindowSnapshotSchemaZ),
});

const FleetSnapshotSchemaZ = z.object({
  version: z.literal(1),
  savedAt: z.string(),
  sessions: z.array(SessionSnapshotSchemaZ),
});

// ---------------------------------------------------------------------------
// Pure assembly
// ---------------------------------------------------------------------------

/** The tab-separated `list-panes -a` fields {@link buildSnapshot} parses, in order. */
export const SNAPSHOT_PANE_FORMAT = [
  "#{session_name}",
  "#{window_index}",
  "#{window_name}",
  "#{window_active}",
  "#{window_layout}",
  "#{pane_index}",
  "#{pane_current_path}",
  "#{pane_current_command}",
  "#{pane_pid}",
  "#{@agent_session_id}",
  "#{@agent_state}",
  "#{@agent_hint}",
  "#{pane_title}",
].join("\t");

/** The `list-sessions` fields the adopted-flag pass parses. */
export const SNAPSHOT_SESSION_FORMAT = ["#{session_name}", "#{@tmux_ide_adopted}"].join("\t");

/** A bare interactive shell — restores as a plain pane, records no command. */
function isBareShell(cmd: string): boolean {
  return /^-?(zsh|bash|sh|fish|dash|ksh|tcsh|csh|nu)$/.test(cmd.trim());
}

/**
 * Decide a pane's `agent` + `command` from its command line + process tree.
 *
 * A real agent (a manifest that isn't the `shell` catch-all) records its id as
 * BOTH the agent and the restore command; a bare shell records neither; any
 * other foreground process records its `pane_current_command` as the command.
 */
function resolvePaneCommand(
  cmd: string,
  pid: number,
  hint: string,
  table: ProcEntry[],
): { agent: string | null; command: string | null } {
  const { manifest } = resolveAgentCommand(cmd, pid, table, { hint: hint || undefined });
  if (manifest && manifest.id !== "shell") {
    return { agent: manifest.id, command: manifest.id };
  }
  if (isBareShell(cmd)) return { agent: null, command: null };
  return { agent: null, command: cmd };
}

/** `""` → null, so absent user-options round-trip as null rather than empty string. */
function nullable(value: string): string | null {
  return value.length > 0 ? value : null;
}

/**
 * PURE — assemble a {@link FleetSnapshot} from raw `list-panes -a` lines, raw
 * `list-sessions` lines (for the adopted flag), and a process table (for agent
 * resolution). Internal `_`-prefixed sessions are skipped. Windows and panes
 * come out in ascending index order; a session's cwd is its first window's
 * first pane's cwd.
 */
export function buildSnapshot(
  rawPanes: string[],
  rawSessions: string[],
  table: ProcEntry[],
  savedAt: string = new Date().toISOString(),
): FleetSnapshot {
  // Adopted flag per session (marker field exactly "1").
  const adopted = new Set<string>();
  for (const line of rawSessions) {
    const [name = "", flag = ""] = line.split("\t");
    if (name && flag === "1") adopted.add(name);
  }

  // Group panes → session → window, preserving insertion but sorting at the end.
  interface WinAccum {
    index: number;
    name: string;
    active: boolean;
    layout: string;
    panes: PaneSnapshot[];
  }
  const sessions = new Map<string, Map<number, WinAccum>>();

  for (const line of rawPanes) {
    if (line.length === 0) continue;
    const [
      session = "",
      windowIndex = "0",
      windowName = "",
      windowActive = "0",
      layout = "",
      paneIndex = "0",
      cwd = "",
      cmd = "",
      pid = "0",
      agentSessionId = "",
      agentState = "",
      hint = "",
      ...titleParts
    ] = line.split("\t");
    if (!session || !isListableSession(session)) continue;

    let windows = sessions.get(session);
    if (!windows) {
      windows = new Map();
      sessions.set(session, windows);
    }
    const wIndex = Number(windowIndex) || 0;
    let win = windows.get(wIndex);
    if (!win) {
      win = {
        index: wIndex,
        name: windowName,
        active: windowActive === "1",
        layout,
        panes: [],
      };
      windows.set(wIndex, win);
    }

    const { agent, command } = resolvePaneCommand(cmd, Number(pid) || 0, hint, table);
    win.panes.push({
      index: Number(paneIndex) || 0,
      cwd,
      command,
      agent,
      agentSessionId: nullable(agentSessionId),
      agentState: nullable(agentState),
      title: titleParts.join("\t"),
    });
  }

  const out: SessionSnapshot[] = [];
  for (const [name, windows] of sessions) {
    const windowList: WindowSnapshot[] = [...windows.values()]
      .sort((a, b) => a.index - b.index)
      .map((w) => ({
        index: w.index,
        name: w.name,
        active: w.active,
        layout: w.layout,
        panes: w.panes.slice().sort((a, b) => a.index - b.index),
      }));
    const cwd = windowList[0]?.panes[0]?.cwd ?? "";
    out.push({ name, cwd, adopted: adopted.has(name), windows: windowList });
  }
  // Stable session order so the fingerprint doesn't churn on Map iteration.
  out.sort((a, b) => a.name.localeCompare(b.name));

  return { version: 1, savedAt, sessions: out };
}

/**
 * PURE — a stable fingerprint of the fleet's STRUCTURE. Everything but
 * `savedAt` and each pane's `agentState` is included, so the fingerprint is
 * unchanged as agents churn working→idle every tick (agentState is a timestamped
 * status line) but DOES change when a pane/window/session, a cwd, a layout, a
 * title, or an agent-session-id changes. The updater rewrites the file only when
 * this value moves — a steady fleet issues zero snapshot writes.
 */
export function snapshotFingerprint(snapshot: FleetSnapshot): string {
  const structural = {
    sessions: snapshot.sessions.map((s) => ({
      name: s.name,
      cwd: s.cwd,
      adopted: s.adopted,
      windows: s.windows.map((w) => ({
        index: w.index,
        name: w.name,
        active: w.active,
        layout: w.layout,
        panes: w.panes.map((p) => ({
          index: p.index,
          cwd: p.cwd,
          command: p.command,
          agent: p.agent,
          agentSessionId: p.agentSessionId,
          title: p.title,
          // agentState deliberately omitted — it churns every tick.
        })),
      })),
    })),
  };
  return JSON.stringify(structural);
}

// ---------------------------------------------------------------------------
// io
// ---------------------------------------------------------------------------

/** Injectable io for {@link collectFleetSnapshot} — real tmux by default. */
export interface SnapshotIo {
  listPanes: () => string;
  listSessions: () => string;
  processTable: () => ProcEntry[];
}

const defaultIo: SnapshotIo = {
  listPanes: () => runTmux(["list-panes", "-a", "-F", SNAPSHOT_PANE_FORMAT]).toString(),
  listSessions: () => runTmux(["list-sessions", "-F", SNAPSHOT_SESSION_FORMAT]).toString(),
  processTable: () => readProcessTable(),
};

/** Collect the live fleet into a {@link FleetSnapshot}. Thin io over {@link buildSnapshot}. */
export function collectFleetSnapshot(io: SnapshotIo = defaultIo): FleetSnapshot {
  const rawPanes = io.listPanes().split("\n").filter(Boolean);
  const rawSessions = io.listSessions().split("\n").filter(Boolean);
  return buildSnapshot(rawPanes, rawSessions, io.processTable());
}

/** Absolute path to the fleet snapshot. */
export function snapshotPath(): string {
  return join(homedir(), ".tmux-ide", "snapshot.json");
}

/**
 * Write the snapshot atomically (temp + rename), keeping ONE previous
 * generation as `snapshot.json.1`. Best-effort: a filesystem failure must never
 * break the updater loop.
 */
export function writeSnapshot(snapshot: FleetSnapshot): void {
  const path = snapshotPath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(snapshot, null, 2) + "\n");
    // Rotate the current generation out of the way, then swap the new one in.
    if (existsSync(path)) {
      try {
        renameSync(path, `${path}.1`);
      } catch {
        // one-generation rotation is best-effort
      }
    }
    renameSync(tmp, path);
  } catch {
    // a failed write just means a staler snapshot — never fatal
  }
}

/** Read + validate the snapshot on disk. Returns null when missing or malformed. */
export function readSnapshot(): FleetSnapshot | null {
  const path = snapshotPath();
  try {
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, "utf-8");
    if (raw.trim().length === 0) return null;
    const result = FleetSnapshotSchemaZ.safeParse(JSON.parse(raw));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Throttle + change detection — driven by the updater loop
// ---------------------------------------------------------------------------

/** Snapshot every N ticks. At {@link ./updater.ts TICK_MS} = 2s, 15 ticks ≈ 30s. */
export const SNAPSHOT_EVERY = 15;

/** Resolve the tick throttle, honoring `TMUX_IDE_SNAPSHOT_EVERY` (tests/tuning). */
export function snapshotEvery(): number {
  const raw = process.env.TMUX_IDE_SNAPSHOT_EVERY;
  const n = raw ? Number(raw) : NaN;
  return Number.isInteger(n) && n > 0 ? n : SNAPSHOT_EVERY;
}

/** Deps for {@link createSnapshotter} — injectable so the throttle is unit-tested. */
export interface SnapshotterDeps {
  collect: () => FleetSnapshot;
  read: () => FleetSnapshot | null;
  write: (snapshot: FleetSnapshot) => void;
  every: number;
}

/**
 * A stateful snapshotter the updater loop pulses once per tick via
 * {@link Snapshotter.onTick}. It fires only every `every` ticks, and even then
 * writes only when the STRUCTURE changed since the last write (seeded from the
 * existing file on first fire, so a restart doesn't rewrite an unchanged fleet).
 */
export interface Snapshotter {
  onTick: () => void;
}

export function createSnapshotter(deps: SnapshotterDeps): Snapshotter {
  let ticks = 0;
  let seeded = false;
  let lastFingerprint: string | null = null;
  return {
    onTick(): void {
      ticks++;
      if (deps.every <= 0 || ticks % deps.every !== 0) return;
      if (!seeded) {
        const existing = deps.read();
        lastFingerprint = existing ? snapshotFingerprint(existing) : null;
        seeded = true;
      }
      const snapshot = deps.collect();
      const fingerprint = snapshotFingerprint(snapshot);
      if (fingerprint === lastFingerprint) return;
      lastFingerprint = fingerprint;
      deps.write(snapshot);
    },
  };
}
