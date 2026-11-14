/**
 * The crash snapshot (`snapshot.json`, read by `tmux-ide restore`) written by
 * the daemon for its default tmux server.
 *
 * The chrome updater writes that file, but it runs only while a session is
 * adopted. A server started by plain `tmux` then has no snapshot, silently
 * (#783). The daemon fills the gap: it writes the same file, with the same
 * builder, whenever the updater's own session is not running. One writer at a
 * time, so the two never rotate each other's generation away. Neither replaces
 * a restore point: the snapshot of a server that is gone and whose sessions
 * have not come back (`snapshotIsRestorePoint`).
 */
import { UPDATER_SESSION } from "./chrome-front-door.ts";

/** How often the daemon looks. A new server has its snapshot within a minute. */
export const DAEMON_CRASH_SNAPSHOT_INTERVAL_MS = 30_000;

/** What the rule below needs to know of a snapshot. */
export interface CrashSnapshotSummary {
  readonly savedAt: string;
  readonly sessions: readonly { readonly name: string }[];
}

/**
 * The snapshot file and its builder. They belong to the chrome adapter
 * (tui/chrome/snapshot.ts, `fleetCrashSnapshotSource`), which the engine may
 * not import; the process that owns the daemon passes them in.
 */
export interface CrashSnapshotSource<S extends CrashSnapshotSummary = CrashSnapshotSummary> {
  readonly sessionFormat: string;
  readonly paneFormat: string;
  /** Build a snapshot from `list-panes -a` and `list-sessions` rows; reads the process table. */
  readonly build: (panes: string[], sessions: string[]) => Promise<S>;
  readonly read: () => S | null;
  // Method syntax on purpose: a source of a richer snapshot type is accepted
  // where the daemon options name the summary type.
  write(snapshot: S): void;
  fingerprint(snapshot: S): string;
}

/**
 * Is `existing` a restore point: the snapshot of a tmux server that is gone,
 * naming at least one session the running server lacks? That file is what
 * `tmux-ide restore` rebuilds from, so no writer may replace it. It stops
 * being one when its sessions run again (after a restore) or the user deletes
 * the file. A server's own snapshot is never one: it was saved after the
 * server started.
 */
export function snapshotIsRestorePoint(
  existing: CrashSnapshotSummary | null,
  live: { readonly serverStartMs: number; readonly sessions: readonly string[] },
): boolean {
  if (!existing || !(live.serverStartMs > Date.parse(existing.savedAt))) return false;
  const running = new Set(live.sessions);
  return existing.sessions.some((session) => !running.has(session.name));
}

export interface DaemonCrashSnapshotDeps<S extends CrashSnapshotSummary = CrashSnapshotSummary> {
  /** A tmux client pinned to the daemon's default server. Throws when it cannot ask. */
  readonly run: (args: readonly string[]) => Promise<string>;
  readonly source: CrashSnapshotSource<S>;
}

export type DaemonCrashSnapshotPulse =
  | "written"
  | "unchanged"
  | "updater-writes"
  | "restore-point-kept"
  | "tmux-unavailable";

export function createDaemonCrashSnapshot<S extends CrashSnapshotSummary>(
  deps: DaemonCrashSnapshotDeps<S>,
) {
  const { source } = deps;
  /** The tmux answers of the last pulse that built a snapshot. */
  let seen: string | null = null;
  return {
    async pulse(): Promise<DaemonCrashSnapshotPulse> {
      let sessions: string;
      let panes: string;
      let existing: S | null;
      let serverStartMs = Number.NaN;
      try {
        sessions = await deps.run(["list-sessions", "-F", source.sessionFormat]);
        if (sessions.split("\n").some((line) => line.split("\t")[0] === UPDATER_SESSION)) {
          // The updater owns the file now; start over from the file when it stops.
          seen = null;
          return "updater-writes";
        }
        panes = await deps.run(["list-panes", "-a", "-F", source.paneFormat]);
        if (`${sessions}\n\n${panes}` === seen) return "unchanged";
        existing = source.read();
        if (existing)
          serverStartMs =
            Number((await deps.run(["display-message", "-p", "#{start_time}"])).trim()) * 1000;
      } catch {
        // A server that is gone or unreachable must not replace the snapshot
        // that restores it.
        return "tmux-unavailable";
      }
      const running = sessions.split("\n").map((line) => line.split("\t")[0]!);
      if (snapshotIsRestorePoint(existing, { serverStartMs, sessions: running })) {
        // Look again next time: a restore or a deleted file changes no tmux
        // answer this pulse could remember.
        seen = null;
        return "restore-point-kept";
      }
      const snapshot = await source.build(
        panes.split("\n").filter(Boolean),
        sessions.split("\n").filter(Boolean),
      );
      seen = `${sessions}\n\n${panes}`;
      if (existing && source.fingerprint(existing) === source.fingerprint(snapshot))
        return "unchanged";
      source.write(snapshot);
      return "written";
    },
  };
}

/**
 * Pulse on a timer until `retired` says the daemon generation is gone; the
 * timer then clears itself, so no stop step has to know about it. Returns a
 * stop function for callers that have one. Only the background service
 * ("headless") writes: a daemon embedded in an app lives only as long as its
 * window, and gets null. So does a daemon started without a snapshot source.
 */
export function startDaemonCrashSnapshot<S extends CrashSnapshotSummary>(
  deps: Omit<DaemonCrashSnapshotDeps<S>, "source"> & {
    readonly source: CrashSnapshotSource<S> | undefined;
    readonly launcher: "headless" | "embedded";
    readonly retired: () => boolean;
  },
): (() => void) | null {
  if (deps.launcher !== "headless" || !deps.source) return null;
  const snapshot = createDaemonCrashSnapshot({ run: deps.run, source: deps.source });
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
