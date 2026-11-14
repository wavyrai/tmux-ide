import { describe, expect, it, vi } from "vitest";

import {
  createDaemonCrashSnapshot,
  DAEMON_CRASH_SNAPSHOT_INTERVAL_MS,
  startDaemonCrashSnapshot,
} from "./daemon-crash-snapshot.ts";
import {
  buildSnapshot,
  fleetCrashSnapshotSource,
  snapshotFingerprint,
  SNAPSHOT_PANE_FORMAT,
  SNAPSHOT_SESSION_FORMAT,
  type FleetSnapshot,
} from "../tui/chrome/snapshot.ts";

/** One `list-panes -a` row in SNAPSHOT_PANE_FORMAT order, for a bare shell pane. */
const pane = (session: string, window = 0, index = 0) =>
  [session, window, "main", 1, "b25d,80x24,0,0,0", index, "/tmp/work", "zsh", 4242, "", "", "", ""]
    .slice(0, SNAPSHOT_PANE_FORMAT.split("\t").length)
    .join("\t");

function world(initial: { sessions: string[]; panes: string[] }) {
  const state = {
    ...initial,
    fail: null as Error | null,
    file: null as FleetSnapshot | null,
    /** `#{start_time}` of the server, in seconds. Long ago unless a test says otherwise. */
    startTime: 1_000_000_000,
  };
  const written: FleetSnapshot[] = [];
  const processTable = vi.fn(async () => []);
  const run = vi.fn(async (args: readonly string[]) => {
    if (state.fail) throw state.fail;
    if (args[0] === "list-sessions") {
      expect(args).toEqual(["list-sessions", "-F", SNAPSHOT_SESSION_FORMAT]);
      return state.sessions.map((name) => `${name}\t`).join("\n");
    }
    if (args[0] === "display-message") {
      expect(args).toEqual(["display-message", "-p", "#{start_time}"]);
      return `${state.startTime}\n`;
    }
    expect(args).toEqual(["list-panes", "-a", "-F", SNAPSHOT_PANE_FORMAT]);
    return state.panes.join("\n");
  });
  // The chrome adapter's source with the process table and the file faked.
  const source = {
    ...fleetCrashSnapshotSource,
    build: async (panes: string[], sessions: string[]) =>
      buildSnapshot(panes, sessions, await processTable()),
    read: () => state.file,
    write: (snapshot: FleetSnapshot) => {
      written.push(snapshot);
      state.file = snapshot;
    },
  };
  const deps = { run, source };
  return { state, written, processTable, run, deps };
}

describe("the daemon's crash snapshot (#783)", () => {
  it("writes a snapshot of a server no session of which is adopted", async () => {
    const w = world({ sessions: ["work"], panes: [pane("work")] });
    const snapshot = createDaemonCrashSnapshot(w.deps);
    expect(await snapshot.pulse()).toBe("written");
    expect(w.written).toHaveLength(1);
    expect(w.written[0]!.sessions).toMatchObject([
      { name: "work", adopted: false, windows: [{ panes: [{ cwd: "/tmp/work" }] }] },
    ]);
  });

  it("writes again only when the structure changes, and reads no process table in between", async () => {
    const w = world({ sessions: ["work"], panes: [pane("work")] });
    const snapshot = createDaemonCrashSnapshot(w.deps);
    await snapshot.pulse();
    expect(await snapshot.pulse()).toBe("unchanged");
    expect(w.processTable).toHaveBeenCalledTimes(1);
    w.state.panes.push(pane("work", 0, 1));
    expect(await snapshot.pulse()).toBe("written");
    expect(w.written).toHaveLength(2);
    expect(w.written[1]!.sessions[0]!.windows[0]!.panes).toHaveLength(2);
  });

  it("does not rewrite a file that already holds this fleet", async () => {
    const w = world({ sessions: ["work"], panes: [pane("work")] });
    await createDaemonCrashSnapshot(w.deps).pulse();
    // A restarted daemon finds the file its predecessor wrote.
    expect(await createDaemonCrashSnapshot(w.deps).pulse()).toBe("unchanged");
    expect(w.written).toHaveLength(1);
  });

  it("leaves the file to the chrome updater while its session runs", async () => {
    const w = world({ sessions: ["work", "_tmux-ide-chrome"], panes: [pane("work")] });
    const snapshot = createDaemonCrashSnapshot(w.deps);
    expect(await snapshot.pulse()).toBe("updater-writes");
    expect(w.written).toHaveLength(0);
    expect(w.run).toHaveBeenCalledTimes(1);
    // The updater is gone: the daemon takes over from what the file holds now.
    w.state.sessions = ["work"];
    expect(await snapshot.pulse()).toBe("written");
  });

  it("trusts nothing it remembered once the updater has held the file", async () => {
    const w = world({ sessions: ["work"], panes: [pane("work")] });
    const snapshot = createDaemonCrashSnapshot(w.deps);
    await snapshot.pulse();
    // The updater runs and saves a fleet with a second session, which then ends.
    w.state.sessions = ["work", "_tmux-ide-chrome"];
    await snapshot.pulse();
    const other = world({ sessions: ["work", "more"], panes: [pane("work"), pane("more")] });
    await createDaemonCrashSnapshot(other.deps).pulse();
    w.state.file = other.written[0]!;
    // tmux answers as it did at the daemon's last write, but the file moved on.
    w.state.sessions = ["work"];
    expect(await snapshot.pulse()).toBe("written");
    expect(w.state.file!.sessions.map((session) => session.name)).toEqual(["work"]);
  });

  describe("a restore point: the snapshot of a server that is gone", () => {
    /** Two sessions saved by the old server; then a new server with one other session. */
    async function replaced() {
      const w = world({ sessions: ["one", "two"], panes: [pane("one"), pane("two")] });
      await createDaemonCrashSnapshot(w.deps).pulse();
      const saved = w.state.file!;
      w.state.sessions = ["fresh"];
      w.state.panes = [pane("fresh")];
      w.state.startTime = Math.floor(Date.parse(saved.savedAt) / 1000) + 60;
      // The daemon restarts with the server: it remembers nothing.
      return { w, saved, snapshot: createDaemonCrashSnapshot(w.deps) };
    }

    it("is kept while the new server lacks a session it names", async () => {
      const { w, saved, snapshot } = await replaced();
      expect(await snapshot.pulse()).toBe("restore-point-kept");
      w.state.panes.push(pane("fresh", 0, 1));
      expect(await snapshot.pulse()).toBe("restore-point-kept");
      expect(w.state.file).toBe(saved);
      expect(w.written).toHaveLength(1);
      expect(w.processTable).toHaveBeenCalledTimes(1);
    });

    it("is replaced once its sessions run again", async () => {
      const { w, snapshot } = await replaced();
      await snapshot.pulse();
      w.state.sessions = ["fresh", "one", "two"];
      w.state.panes.push(pane("one"), pane("two"));
      expect(await snapshot.pulse()).toBe("written");
      expect(w.state.file!.sessions.map((session) => session.name)).toEqual([
        "fresh",
        "one",
        "two",
      ]);
    });

    it("is replaced after the user deletes the file, with tmux unchanged", async () => {
      const { w, snapshot } = await replaced();
      await snapshot.pulse();
      w.state.file = null;
      expect(await snapshot.pulse()).toBe("written");
      expect(w.state.file!.sessions.map((session) => session.name)).toEqual(["fresh"]);
    });

    it("is not what a server sees in its own snapshot after a session ends", async () => {
      const w = world({ sessions: ["one", "two"], panes: [pane("one"), pane("two")] });
      const snapshot = createDaemonCrashSnapshot(w.deps);
      await snapshot.pulse();
      w.state.sessions = ["one"];
      w.state.panes = [pane("one")];
      expect(await snapshot.pulse()).toBe("written");
      expect(w.state.file!.sessions.map((session) => session.name)).toEqual(["one"]);
    });
  });

  it("keeps the last snapshot when tmux cannot be asked", async () => {
    const w = world({ sessions: ["work"], panes: [pane("work")] });
    const snapshot = createDaemonCrashSnapshot(w.deps);
    await snapshot.pulse();
    w.state.fail = Object.assign(new Error("Command failed"), {
      stderr: "no server running on /tmp/t.sock",
    });
    expect(await snapshot.pulse()).toBe("tmux-unavailable");
    expect(w.written).toHaveLength(1);
    expect(w.state.file!.sessions).toHaveLength(1);
  });
});

describe("the crash snapshot timer", () => {
  it("pulses every 30 s, never twice at once, and stops itself when the daemon retires", async () => {
    expect(DAEMON_CRASH_SNAPSHOT_INTERVAL_MS).toBe(30_000);
    vi.useFakeTimers();
    try {
      const w = world({ sessions: ["work"], panes: [pane("work")] });
      let release: (() => void) | null = null;
      w.run.mockImplementationOnce(
        () => new Promise<string>((resolve) => (release = () => resolve("work\t"))),
      );
      let retired = false;
      startDaemonCrashSnapshot({ ...w.deps, launcher: "headless", retired: () => retired });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(w.run).toHaveBeenCalledTimes(1);
      // The first pulse still waits for tmux: the next tick starts no second one.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(w.run).toHaveBeenCalledTimes(1);
      release!();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(w.written).toHaveLength(1);
      const calls = w.run.mock.calls.length;
      retired = true;
      await vi.advanceTimersByTimeAsync(120_000);
      expect(w.run).toHaveBeenCalledTimes(calls);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not run in a daemon embedded in an app, which lives only as long as its window", async () => {
    vi.useFakeTimers();
    try {
      const w = world({ sessions: ["work"], panes: [pane("work")] });
      expect(
        startDaemonCrashSnapshot({ ...w.deps, launcher: "embedded", retired: () => false }),
      ).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(w.run).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
  it("does not run without a snapshot source, which only the daemon's owner can pass", async () => {
    vi.useFakeTimers();
    try {
      const w = world({ sessions: ["work"], panes: [pane("work")] });
      expect(
        startDaemonCrashSnapshot({
          run: w.run,
          source: undefined,
          launcher: "headless",
          retired: () => false,
        }),
      ).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(w.run).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("is given the chrome adapter's own formats, file and fingerprint", () => {
    expect(fleetCrashSnapshotSource).toMatchObject({
      sessionFormat: SNAPSHOT_SESSION_FORMAT,
      paneFormat: SNAPSHOT_PANE_FORMAT,
      fingerprint: snapshotFingerprint,
    });
  });
});
