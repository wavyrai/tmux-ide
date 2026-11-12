/**
 * The crash snapshot (`snapshot.json`, read by `tmux-ide restore`) written by
 * the daemon for its default tmux server.
 *
 * The chrome updater writes that file, but it runs only while a session is
 * adopted. A server started by plain `tmux` then has no snapshot, silently
 * (#783). The daemon fills the gap: it writes the same file, with the same
 * builder, whenever the updater's own session is not running. One writer at a
 * time, so the two never rotate each other's generation away.
 */
import { UPDATER_SESSION } from "./chrome-front-door.ts";
import {
  buildSnapshot,
  readSnapshot,
  snapshotFingerprint,
  SNAPSHOT_PANE_FORMAT,
  SNAPSHOT_SESSION_FORMAT,
  writeSnapshot,
  type FleetSnapshot,
} from "../tui/chrome/snapshot.ts";
import { readProcessTableAsync, type ProcEntry } from "../tui/detect/process-tree.ts";

/** How often the daemon looks. A new server has its snapshot within a minute. */
export const DAEMON_CRASH_SNAPSHOT_INTERVAL_MS = 30_000;

export interface DaemonCrashSnapshotDeps {
  /** A tmux client pinned to the daemon's default server. Throws when it cannot ask. */
  readonly run: (args: readonly string[]) => Promise<string>;
  readonly processTable?: () => Promise<ProcEntry[]>;
  readonly read?: () => FleetSnapshot | null;
  readonly write?: (snapshot: FleetSnapshot) => void;
}

export type DaemonCrashSnapshotPulse =
  | "written"
  | "unchanged"
  | "updater-writes"
  | "tmux-unavailable";

export function createDaemonCrashSnapshot(deps: DaemonCrashSnapshotDeps) {
  const processTable = deps.processTable ?? (() => readProcessTableAsync());
  const read = deps.read ?? (() => readSnapshot());
  const write = deps.write ?? writeSnapshot;
  /** The tmux answers of the last pulse that built a snapshot. */
  let seen: string | null = null;
  /** Fingerprint of what the file holds; undefined until read from the file. */
  let fingerprint: string | null | undefined;
  return {
    async pulse(): Promise<DaemonCrashSnapshotPulse> {
      let sessions: string;
      let panes: string;
      try {
        sessions = await deps.run(["list-sessions", "-F", SNAPSHOT_SESSION_FORMAT]);
        if (sessions.split("\n").some((line) => line.split("\t")[0] === UPDATER_SESSION)) {
          // The updater owns the file now; start over from the file when it stops.
          seen = null;
          fingerprint = undefined;
          return "updater-writes";
        }
        panes = await deps.run(["list-panes", "-a", "-F", SNAPSHOT_PANE_FORMAT]);
      } catch {
        // A server that is gone or unreachable must not replace the snapshot
        // that restores it.
        return "tmux-unavailable";
      }
      const answers = `${sessions}\n\n${panes}`;
      if (answers === seen) return "unchanged";
      if (fingerprint === undefined) {
        const existing = read();
        fingerprint = existing ? snapshotFingerprint(existing) : null;
      }
      const snapshot = buildSnapshot(
        panes.split("\n").filter(Boolean),
        sessions.split("\n").filter(Boolean),
        await processTable(),
      );
      seen = answers;
      const next = snapshotFingerprint(snapshot);
      if (next === fingerprint) return "unchanged";
      fingerprint = next;
      write(snapshot);
      return "written";
    },
  };
}

/**
 * Pulse on a timer until `retired` says the daemon generation is gone; the
 * timer then clears itself, so no stop step has to know about it. Returns a
 * stop function for callers that have one.
 */
export function startDaemonCrashSnapshot(
  deps: DaemonCrashSnapshotDeps & { readonly retired: () => boolean },
): () => void {
  const snapshot = createDaemonCrashSnapshot(deps);
  let busy = false;
  const timer = setInterval(() => {
    if (deps.retired()) {
      clearInterval(timer);
      return;
    }
    if (busy) return;
    busy = true;
    void snapshot
      .pulse()
      .catch(() => undefined)
      .finally(() => {
        busy = false;
      });
  }, DAEMON_CRASH_SNAPSHOT_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
