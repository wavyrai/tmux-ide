/**
 * Unit tests for the fleet snapshot's pure parts — assembly from raw tmux
 * lines, the structural fingerprint's stability, and the throttled snapshotter.
 */
import { describe, expect, it, vi } from "vitest";
import {
  buildSnapshot,
  createSnapshotter,
  snapshotFingerprint,
  snapshotIsRestorePoint,
  type FleetSnapshot,
} from "./snapshot.ts";
import type { ProcEntry } from "../detect/process-tree.ts";

// A pane line matches SNAPSHOT_PANE_FORMAT:
// session, w_index, w_name, w_active, layout, p_index, cwd, cmd, pid,
// @agent_session_id, @agent_state, @agent_hint, title
function paneLine(fields: Partial<Record<string, string>> & { session: string }): string {
  const f = {
    wIndex: "0",
    wName: "main",
    wActive: "1",
    layout: "abcd,80x24,0,0,0",
    pIndex: "0",
    cwd: "/home/u",
    cmd: "zsh",
    pid: "100",
    sessionId: "",
    state: "",
    hint: "",
    title: "shell",
    ...fields,
  } as Record<string, string>;
  return [
    f.session,
    f.wIndex,
    f.wName,
    f.wActive,
    f.layout,
    f.pIndex,
    f.cwd,
    f.cmd,
    f.pid,
    f.sessionId,
    f.state,
    f.hint,
    f.title,
  ].join("\t");
}

const NO_PROCS: ProcEntry[] = [];

describe("buildSnapshot", () => {
  it("assembles sessions → windows → panes from raw lines", () => {
    const panes = [
      paneLine({ session: "web", wIndex: "0", pIndex: "0", cwd: "/a", title: "editor" }),
      paneLine({ session: "web", wIndex: "0", pIndex: "1", cwd: "/b", title: "shell" }),
      paneLine({
        session: "web",
        wIndex: "1",
        wName: "logs",
        wActive: "0",
        pIndex: "0",
        cwd: "/c",
      }),
      paneLine({ session: "api", wIndex: "0", pIndex: "0", cwd: "/d" }),
    ];
    const sessions = ["web\t1", "api\t"];
    const snap = buildSnapshot(panes, sessions, NO_PROCS, "2026-07-02T00:00:00.000Z");

    expect(snap.version).toBe(1);
    expect(snap.savedAt).toBe("2026-07-02T00:00:00.000Z");
    // Sorted by name.
    expect(snap.sessions.map((s) => s.name)).toEqual(["api", "web"]);

    const web = snap.sessions.find((s) => s.name === "web")!;
    expect(web.adopted).toBe(true);
    expect(web.cwd).toBe("/a"); // first window's first pane
    expect(web.windows).toHaveLength(2);
    expect(web.windows[0]!.index).toBe(0);
    expect(web.windows[0]!.panes.map((p) => p.cwd)).toEqual(["/a", "/b"]);
    expect(web.windows[1]!.name).toBe("logs");
    expect(web.windows[1]!.active).toBe(false);

    const api = snap.sessions.find((s) => s.name === "api")!;
    expect(api.adopted).toBe(false);
  });

  it("records a bare shell as a plain pane (no command, no agent)", () => {
    const snap = buildSnapshot([paneLine({ session: "s", cmd: "zsh" })], [], NO_PROCS);
    const pane = snap.sessions[0]!.windows[0]!.panes[0]!;
    expect(pane.command).toBeNull();
    expect(pane.agent).toBeNull();
  });

  it("records a login shell (-zsh) as a plain pane too", () => {
    const snap = buildSnapshot([paneLine({ session: "s", cmd: "-zsh" })], [], NO_PROCS);
    expect(snap.sessions[0]!.windows[0]!.panes[0]!.command).toBeNull();
  });

  it("records a non-shell, non-agent command verbatim", () => {
    const snap = buildSnapshot([paneLine({ session: "s", cmd: "vim" })], [], NO_PROCS);
    const pane = snap.sessions[0]!.windows[0]!.panes[0]!;
    expect(pane.command).toBe("vim");
    expect(pane.agent).toBeNull();
  });

  it("resolves an agent pane to its id via the process tree (fast path)", () => {
    // pane_current_command IS claude (a shim) — resolves without the tree.
    const snap = buildSnapshot([paneLine({ session: "s", cmd: "claude" })], [], NO_PROCS);
    const pane = snap.sessions[0]!.windows[0]!.panes[0]!;
    expect(pane.agent).toBe("claude");
    expect(pane.command).toBe("claude"); // agent panes record the resolved agent id
  });

  it("resolves an agent pane whose immediate command is node via the tree", () => {
    const table: ProcEntry[] = [
      { pid: 100, ppid: 1, command: "node" },
      { pid: 200, ppid: 100, command: "node /usr/local/bin/claude --foo" },
    ];
    const snap = buildSnapshot([paneLine({ session: "s", cmd: "node", pid: "100" })], [], table);
    const pane = snap.sessions[0]!.windows[0]!.panes[0]!;
    expect(pane.agent).toBe("claude");
    expect(pane.command).toBe("claude");
  });

  it("captures @agent_session_id and @agent_state, and honors @agent_hint", () => {
    const snap = buildSnapshot(
      [
        paneLine({
          session: "s",
          cmd: "node",
          hint: "claude",
          sessionId: "fake-id-123",
          state: "working:1717",
        }),
      ],
      [],
      NO_PROCS,
    );
    const pane = snap.sessions[0]!.windows[0]!.panes[0]!;
    expect(pane.agent).toBe("claude"); // hint forces the manifest
    expect(pane.agentSessionId).toBe("fake-id-123");
    expect(pane.agentState).toBe("working:1717");
  });

  it("filters _-internal sessions", () => {
    const panes = [paneLine({ session: "_tmux-ide-chrome" }), paneLine({ session: "real" })];
    const snap = buildSnapshot(panes, [], NO_PROCS);
    expect(snap.sessions.map((s) => s.name)).toEqual(["real"]);
  });

  it("sorts windows and panes by index regardless of line order", () => {
    const panes = [
      paneLine({ session: "s", wIndex: "2", pIndex: "1" }),
      paneLine({ session: "s", wIndex: "2", pIndex: "0" }),
      paneLine({ session: "s", wIndex: "0", pIndex: "0" }),
    ];
    const snap = buildSnapshot(panes, [], NO_PROCS);
    expect(snap.sessions[0]!.windows.map((w) => w.index)).toEqual([0, 2]);
    expect(snap.sessions[0]!.windows[1]!.panes.map((p) => p.index)).toEqual([0, 1]);
  });

  it("keeps tabs in a pane title (title is the trailing catch-all)", () => {
    const line = paneLine({ session: "s", title: "a\tb" });
    const snap = buildSnapshot([line], [], NO_PROCS);
    expect(snap.sessions[0]!.windows[0]!.panes[0]!.title).toBe("a\tb");
  });
});

describe("snapshotFingerprint", () => {
  function fixture(): FleetSnapshot {
    return buildSnapshot(
      [
        paneLine({ session: "web", cmd: "claude", state: "working:1", sessionId: "sid-1" }),
        paneLine({ session: "web", pIndex: "1", cmd: "zsh", state: "idle:2" }),
      ],
      ["web\t1"],
      NO_PROCS,
      "2026-07-02T00:00:00.000Z",
    );
  }

  it("is unchanged by savedAt", () => {
    const a = fixture();
    const b = { ...fixture(), savedAt: "2099-01-01T00:00:00.000Z" };
    expect(snapshotFingerprint(a)).toBe(snapshotFingerprint(b));
  });

  it("is unchanged when only @agent_state churns", () => {
    const a = fixture();
    const b = fixture();
    // Simulate an agent-state tick without any structural change.
    b.sessions[0]!.windows[0]!.panes[0]!.agentState = "idle:9999";
    expect(snapshotFingerprint(a)).toBe(snapshotFingerprint(b));
  });

  it("changes when the STRUCTURE changes (a new pane)", () => {
    const a = fixture();
    const b = buildSnapshot(
      [
        paneLine({ session: "web", cmd: "claude", sessionId: "sid-1" }),
        paneLine({ session: "web", pIndex: "1", cmd: "zsh" }),
        paneLine({ session: "web", pIndex: "2", cmd: "zsh" }),
      ],
      ["web\t1"],
      NO_PROCS,
    );
    expect(snapshotFingerprint(a)).not.toBe(snapshotFingerprint(b));
  });

  it("changes when a cwd or layout changes", () => {
    const a = fixture();
    const b = fixture();
    b.sessions[0]!.windows[0]!.layout = "zzzz,80x24,0,0,0";
    expect(snapshotFingerprint(a)).not.toBe(snapshotFingerprint(b));
  });
});

describe("createSnapshotter", () => {
  function snap(name: string): FleetSnapshot {
    return buildSnapshot([paneLine({ session: name })], [], NO_PROCS, "2026-01-01T00:00:00.000Z");
  }

  it("fires only every `every` ticks", () => {
    const write = vi.fn();
    const s = createSnapshotter({
      collect: () => snap("a"),
      read: () => null,
      write,
      every: 3,
    });
    s.onTick(); // 1
    s.onTick(); // 2
    expect(write).not.toHaveBeenCalled();
    s.onTick(); // 3 → fires (no prior fingerprint → writes)
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("writes only when the structure changed since the last write", () => {
    const write = vi.fn();
    let current = snap("a");
    const s = createSnapshotter({
      collect: () => current,
      read: () => null,
      write,
      every: 1,
    });
    s.onTick(); // writes (first)
    s.onTick(); // unchanged → no write
    expect(write).toHaveBeenCalledTimes(1);
    current = snap("b"); // structural change
    s.onTick();
    expect(write).toHaveBeenCalledTimes(2);
  });

  it("seeds from the existing file so a restart of an unchanged fleet is a no-op", () => {
    const write = vi.fn();
    const existing = snap("a");
    const s = createSnapshotter({
      collect: () => snap("a"), // identical structure to what's on disk
      read: () => existing,
      write,
      every: 1,
    });
    s.onTick();
    expect(write).not.toHaveBeenCalled();
  });

  // A dead server's snapshot is what `restore` needs. The next server must
  // not replace it while it still names sessions that are gone (#783).
  describe("a restore point", () => {
    const SAVED = Date.parse("2026-01-01T00:00:00.000Z");
    const fleet = (...names: string[]) =>
      buildSnapshot(
        names.map((session) => paneLine({ session })),
        [],
        NO_PROCS,
        "2026-01-01T00:00:00.000Z",
      );

    it("is the snapshot of an older server that names a session the running one lacks", () => {
      const live = (serverStartMs: number, ...sessions: string[]) => ({ serverStartMs, sessions });
      expect(snapshotIsRestorePoint(fleet("a", "b"), live(SAVED + 1000, "fresh"))).toBe(true);
      expect(snapshotIsRestorePoint(fleet("a", "b"), live(SAVED + 1000, "a", "fresh"))).toBe(true);
      // Restored: every session it names runs again.
      expect(snapshotIsRestorePoint(fleet("a", "b"), live(SAVED + 1000, "b", "a", "x"))).toBe(
        false,
      );
      // The same server that saved it: a session that ended is just gone.
      expect(snapshotIsRestorePoint(fleet("a", "b"), live(SAVED - 1000, "a"))).toBe(false);
      expect(snapshotIsRestorePoint(fleet("a", "b"), live(SAVED, "a"))).toBe(false);
      expect(snapshotIsRestorePoint(null, live(SAVED + 1000, "fresh"))).toBe(false);
      expect(snapshotIsRestorePoint(fleet("a"), live(Number.NaN, "fresh"))).toBe(false);
    });

    it("is not replaced by the updater, until its sessions run again or the file is gone", () => {
      const write = vi.fn();
      let file: FleetSnapshot | null = fleet("a", "b");
      let current = fleet("fresh");
      const s = createSnapshotter({
        collect: () => current,
        read: () => file,
        write,
        every: 1,
        serverStartMs: () => SAVED + 60_000,
      });
      s.onTick();
      current = fleet("fresh", "more");
      s.onTick();
      expect(write).not.toHaveBeenCalled();
      // `tmux-ide restore` brought the sessions back.
      current = fleet("a", "b", "fresh", "more");
      s.onTick();
      expect(write).toHaveBeenCalledTimes(1);
      // Held again with tmux unchanged, then the user deletes the file to
      // release it: the fleet already written once is written again.
      file = fleet("gone");
      s.onTick();
      expect(write).toHaveBeenCalledTimes(1);
      file = null;
      s.onTick();
      expect(write).toHaveBeenCalledTimes(2);
    });

    it("does not stop the updater on the server that saved it", () => {
      const write = vi.fn();
      const s = createSnapshotter({
        collect: () => fleet("a"),
        read: () => fleet("a", "b"),
        write,
        every: 1,
        serverStartMs: () => SAVED - 60_000,
      });
      s.onTick();
      expect(write).toHaveBeenCalledTimes(1);
    });

    it("keeps writing when tmux cannot say when the server started", () => {
      const write = vi.fn();
      const s = createSnapshotter({
        collect: () => fleet("fresh"),
        read: () => fleet("a", "b"),
        write,
        every: 1,
        serverStartMs: () => {
          throw new Error("no server running");
        },
      });
      s.onTick();
      expect(write).toHaveBeenCalledTimes(1);
    });
  });

  it("never fires when every <= 0", () => {
    const write = vi.fn();
    const s = createSnapshotter({ collect: () => snap("a"), read: () => null, write, every: 0 });
    for (let i = 0; i < 10; i++) s.onTick();
    expect(write).not.toHaveBeenCalled();
  });
});
