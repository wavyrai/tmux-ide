import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { ProcEntry } from "./process-tree.ts";
import {
  agentPidsInSubtree,
  codexIdFromOpenFiles,
  codexIdFromStateDir,
  createSessionIdCapturer,
  cursorIdFromOpenFiles,
  cursorIdFromStateDir,
  parseCodexRolloutName,
  parseEtimeSeconds,
  CAPTURE_PROBES,
  PROBED_KINDS,
  type CapturePane,
  type ProbeIo,
  type StateDirIo,
} from "./session-id.ts";

// The REAL rollout path observed live (codex-cli 0.144.1, lsof fd 34w).
const REAL_ROLLOUT =
  "/Users/thijs/.codex/sessions/2026/07/12/rollout-2026-07-12T12-16-13-019f55d3-d466-79a2-b9df-bcad709922ff.jsonl";
const REAL_ROLLOUT_ID = "019f55d3-d466-79a2-b9df-bcad709922ff";

describe("codexIdFromOpenFiles", () => {
  it("extracts the uuid from a real rollout path", () => {
    expect(codexIdFromOpenFiles(["/dev/null", REAL_ROLLOUT])).toBe(REAL_ROLLOUT_ID);
  });

  it("ignores non-rollout paths and malformed names", () => {
    expect(
      codexIdFromOpenFiles([
        "/Users/x/.codex/history.jsonl",
        "/Users/x/.codex/sessions/2026/07/12/rollout-not-a-date-xyz.jsonl",
        "/Users/x/notes/rollout-2026-07-12T12-16-13-shortid.jsonl",
      ]),
    ).toBeNull();
    expect(codexIdFromOpenFiles([])).toBeNull();
  });
});

describe("cursorIdFromOpenFiles", () => {
  it("extracts the chatId from a store.db path under a hashed cwd dir", () => {
    const paths = [
      "/dev/ttys001",
      "/Users/x/.cursor/chats/1459cb3fe30531b805749c215a475e1a/0e87b7e0-83ad-4fd3-af94-f7daa83c021a/store.db",
    ];
    expect(cursorIdFromOpenFiles(paths)).toBe("0e87b7e0-83ad-4fd3-af94-f7daa83c021a");
  });

  it("rejects paths whose hash dir is not 32 hex chars", () => {
    expect(cursorIdFromOpenFiles(["/Users/x/.cursor/chats/nothex/abc-def/store.db"])).toBeNull();
  });

  it("rejects unsafe chat ids", () => {
    expect(
      cursorIdFromOpenFiles([
        "/Users/x/.cursor/chats/1459cb3fe30531b805749c215a475e1a/$(evil)/store.db",
      ]),
    ).toBeNull();
  });
});

describe("parseEtimeSeconds", () => {
  it("parses mm:ss", () => {
    expect(parseEtimeSeconds("01:23")).toBe(83);
    expect(parseEtimeSeconds("  00:05\n")).toBe(5);
  });

  it("parses hh:mm:ss and dd-hh:mm:ss", () => {
    expect(parseEtimeSeconds("1:02:03")).toBe(3723);
    expect(parseEtimeSeconds("2-03:04:05")).toBe(2 * 86400 + 3 * 3600 + 4 * 60 + 5);
  });

  it("rejects garbage and out-of-range fields", () => {
    expect(parseEtimeSeconds("")).toBeNull();
    expect(parseEtimeSeconds("abc")).toBeNull();
    expect(parseEtimeSeconds("99")).toBeNull();
    expect(parseEtimeSeconds("61:99")).toBeNull();
  });
});

describe("agentPidsInSubtree", () => {
  // Modeled on the REAL live tree: shell → node shim (token "codex") → vendor binary.
  const table: ProcEntry[] = [
    { pid: 100, ppid: 1, command: "-zsh" },
    { pid: 200, ppid: 100, command: "node /Users/thijs/.bun/bin/codex" },
    { pid: 300, ppid: 200, command: "/Users/x/vendor/aarch64-apple-darwin/bin/codex" },
    { pid: 400, ppid: 100, command: "vim /Users/x/.codex/notes.md" },
  ];

  it("finds every subtree process carrying the kind's binary token", () => {
    expect(agentPidsInSubtree(table, 100, ["codex"]).sort()).toEqual([200, 300]);
  });

  it("does not false-positive on incidental paths in arguments", () => {
    // pid 400's argv contains `.codex` only inside a file path — commandTokens
    // yields ["vim", "notes.md"], so it must not match.
    expect(agentPidsInSubtree(table, 100, ["codex"])).not.toContain(400);
  });

  it("returns [] when the pane root is unknown or nothing matches", () => {
    expect(agentPidsInSubtree(table, 999, ["codex"])).toEqual([]);
    expect(agentPidsInSubtree(table, 100, ["cursor-agent"])).toEqual([]);
  });
});

describe("parseCodexRolloutName", () => {
  it("parses the timestamp (local time) and uuid", () => {
    const parsed = parseCodexRolloutName(
      "rollout-2026-07-12T12-16-13-019f55d3-d466-79a2-b9df-bcad709922ff.jsonl",
    );
    expect(parsed?.id).toBe(REAL_ROLLOUT_ID);
    expect(parsed?.tsMs).toBe(new Date(2026, 6, 12, 12, 16, 13).getTime());
  });

  it("rejects anything else", () => {
    expect(parseCodexRolloutName("rollout-2026-07-12T12-16-13-shortid.jsonl")).toBeNull();
    expect(parseCodexRolloutName("history.jsonl")).toBeNull();
  });
});

/** Build a fixture StateDirIo from path→entries / path→mtime / path→first-line maps. */
function fixtureIo(fixture: {
  dirs?: Record<string, string[]>;
  mtimes?: Record<string, number>;
  firstLines?: Record<string, string>;
}): StateDirIo {
  return {
    listDir: (path) => fixture.dirs?.[path] ?? [],
    mtimeMs: (path) => fixture.mtimes?.[path] ?? null,
    readFirstLine: (path) => fixture.firstLines?.[path] ?? null,
  };
}

/** A codex session_meta first line, shaped like the real one (cli 0.144.1). */
function codexMeta(cwd: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    timestamp: "2026-07-12T10:17:13.701Z",
    type: "session_meta",
    payload: { cwd, originator: "codex-tui", cli_version: "0.144.1", source: "cli", ...extra },
  });
}

describe("codexIdFromStateDir", () => {
  const root = "/fake/.codex/sessions";
  const now = new Date(2026, 6, 12, 13, 0, 0).getTime();
  const day = join(root, "2026", "07", "12");
  const nameA = "rollout-2026-07-12T12-16-13-019f55d3-d466-79a2-b9df-bcad709922ff.jsonl";
  const nameB = "rollout-2026-07-12T12-40-00-029f55d3-d466-79a2-b9df-bcad70992200.jsonl";
  const start = new Date(2026, 6, 12, 12, 15, 0).getTime();

  it("picks the newest rollout whose meta cwd matches the pane", () => {
    const io = fixtureIo({
      dirs: { [day]: [nameA, nameB] },
      firstLines: {
        [join(day, nameA)]: codexMeta("/work/project"),
        [join(day, nameB)]: codexMeta("/somewhere/else"),
      },
    });
    expect(codexIdFromStateDir(root, "/work/project", start, io, now)).toBe(REAL_ROLLOUT_ID);
  });

  it("skips subagent threads even when their cwd matches", () => {
    const io = fixtureIo({
      dirs: { [day]: [nameB] },
      firstLines: {
        [join(day, nameB)]: codexMeta("/work/project", {
          source: { subagent: { depth: 1 } },
          thread_source: "subagent",
        }),
      },
    });
    expect(codexIdFromStateDir(root, "/work/project", start, io, now)).toBeNull();
  });

  it("ignores rollouts older than the agent process", () => {
    // Session started 12:16 but the pane's codex only started 12:30 → not ours.
    const lateStart = new Date(2026, 6, 12, 12, 30, 0).getTime();
    const io = fixtureIo({
      dirs: { [day]: [nameA] },
      firstLines: { [join(day, nameA)]: codexMeta("/work/project") },
    });
    expect(codexIdFromStateDir(root, "/work/project", lateStart, io, now)).toBeNull();
  });

  it("tolerates malformed first lines", () => {
    const io = fixtureIo({
      dirs: { [day]: [nameA] },
      firstLines: { [join(day, nameA)]: "not json{" },
    });
    expect(codexIdFromStateDir(root, "/work/project", start, io, now)).toBeNull();
  });

  it("scans back across day directories", () => {
    const yesterday = join(root, "2026", "07", "11");
    const nameY = "rollout-2026-07-11T23-50-00-039f55d3-d466-79a2-b9df-bcad70992211.jsonl";
    const io = fixtureIo({
      dirs: { [yesterday]: [nameY] },
      firstLines: { [join(yesterday, nameY)]: codexMeta("/work/project") },
    });
    const eveningStart = new Date(2026, 6, 11, 23, 45, 0).getTime();
    expect(codexIdFromStateDir(root, "/work/project", eveningStart, io, now)).toBe(
      "039f55d3-d466-79a2-b9df-bcad70992211",
    );
  });
});

describe("cursorIdFromStateDir", () => {
  const chatsRoot = "/fake/.cursor/chats";
  const cwd = "/work/project";
  const hashed = join(chatsRoot, createHash("md5").update(cwd).digest("hex"));
  const start = 1_000_000_000;

  it("picks the newest chat dir modified after the process start", () => {
    const io = fixtureIo({
      dirs: { [hashed]: ["old-chat", "new-chat"] },
      mtimes: {
        [join(hashed, "old-chat")]: start + 10_000,
        [join(hashed, "new-chat")]: start + 60_000,
      },
    });
    expect(cursorIdFromStateDir(chatsRoot, cwd, start, io)).toBe("new-chat");
  });

  it("ignores chats older than the process (stale conversations in the same cwd)", () => {
    const io = fixtureIo({
      dirs: { [hashed]: ["stale"] },
      mtimes: { [join(hashed, "stale")]: start - 3_600_000 },
    });
    expect(cursorIdFromStateDir(chatsRoot, cwd, start, io)).toBeNull();
  });

  it("skips unsafe dir names and missing hash dirs", () => {
    const io = fixtureIo({
      dirs: { [hashed]: ["$(evil)"] },
      mtimes: { [join(hashed, "$(evil)")]: start + 10_000 },
    });
    expect(cursorIdFromStateDir(chatsRoot, cwd, start, io)).toBeNull();
    expect(cursorIdFromStateDir(chatsRoot, "/other/cwd", start, io)).toBeNull();
  });
});

describe("CAPTURE_PROBES (kind dispatch over injected io)", () => {
  const pane: CapturePane = {
    paneId: "%7",
    agent: "codex",
    pid: 100,
    dir: "/work/project",
    sessionId: null,
  };
  const table: ProcEntry[] = [
    { pid: 100, ppid: 1, command: "-zsh" },
    { pid: 200, ppid: 100, command: "node /Users/thijs/.bun/bin/codex" },
  ];

  function io(overrides: Partial<ProbeIo>): ProbeIo {
    return {
      processTable: () => table,
      openFiles: () => [],
      processStartMs: () => null,
      stateDir: fixtureIo({}),
      codexSessionsRoot: () => "/fake/.codex/sessions",
      cursorChatsRoot: () => "/fake/.cursor/chats",
      now: () => Date.now(),
      ...overrides,
    };
  }

  it("prefers the open-files probe (exact)", () => {
    const result = CAPTURE_PROBES.codex!(pane, io({ openFiles: () => [REAL_ROLLOUT] }));
    expect(result).toBe(REAL_ROLLOUT_ID);
  });

  it("falls back to the state dir when no session file is open", () => {
    const now = new Date(2026, 6, 12, 13, 0, 0).getTime();
    const day = join("/fake/.codex/sessions", "2026", "07", "12");
    const name = "rollout-2026-07-12T12-16-13-019f55d3-d466-79a2-b9df-bcad709922ff.jsonl";
    const result = CAPTURE_PROBES.codex!(
      pane,
      io({
        processStartMs: () => new Date(2026, 6, 12, 12, 15, 0).getTime(),
        stateDir: fixtureIo({
          dirs: { [day]: [name] },
          firstLines: { [join(day, name)]: codexMeta("/work/project") },
        }),
        now: () => now,
      }),
    );
    expect(result).toBe(REAL_ROLLOUT_ID);
  });

  it("returns null when the pane's subtree has no agent process", () => {
    const shellOnly: ProcEntry[] = [{ pid: 100, ppid: 1, command: "-zsh" }];
    expect(CAPTURE_PROBES.codex!(pane, io({ processTable: () => shellOnly }))).toBeNull();
  });

  it("ships probes for exactly codex and cursor", () => {
    expect([...PROBED_KINDS].sort()).toEqual(["codex", "cursor"]);
  });
});

describe("createSessionIdCapturer", () => {
  const codexPane = (over: Partial<CapturePane> = {}): CapturePane => ({
    paneId: "%1",
    agent: "codex",
    pid: 10,
    dir: "/w",
    sessionId: null,
    ...over,
  });

  it("probes only every N ticks and stamps a discovered id once", () => {
    const stamps: Array<[string, string]> = [];
    let probes = 0;
    const capturer = createSessionIdCapturer({
      probe: () => {
        probes++;
        return "abc-123";
      },
      stamp: (paneId, id) => stamps.push([paneId, id]),
      everyTicks: 3,
    });
    capturer.onTick([codexPane()]);
    capturer.onTick([codexPane()]);
    expect(probes).toBe(0); // throttled
    capturer.onTick([codexPane()]);
    expect(probes).toBe(1);
    expect(stamps).toEqual([["%1", "abc-123"]]);
    // Already stamped by us — later windows skip it entirely.
    for (let i = 0; i < 6; i++) capturer.onTick([codexPane()]);
    expect(probes).toBe(1);
  });

  it("skips panes that are non-agents, already stamped, or of unprobed kinds", () => {
    let probes = 0;
    const capturer = createSessionIdCapturer({
      probe: () => {
        probes++;
        return "abc";
      },
      stamp: () => {},
      everyTicks: 1,
    });
    capturer.onTick([
      codexPane({ agent: null }),
      codexPane({ paneId: "%2", sessionId: "already-there" }),
      codexPane({ paneId: "%3", agent: "claude" }), // hook-captured, not probed
      codexPane({ paneId: "%4", agent: "gemini" }), // no resume story
    ]);
    expect(probes).toBe(0);
  });

  it("retries after a failed stamp and never lets a throwing probe hurt the tick", () => {
    const stamps: string[] = [];
    let attempts = 0;
    const capturer = createSessionIdCapturer({
      probe: () => "abc",
      stamp: (paneId) => {
        attempts++;
        if (attempts === 1) throw new Error("pane gone");
        stamps.push(paneId);
      },
      everyTicks: 1,
    });
    capturer.onTick([codexPane()]);
    capturer.onTick([codexPane()]);
    expect(attempts).toBe(2);
    expect(stamps).toEqual(["%1"]); // second window succeeded, then remembered

    const throwing = createSessionIdCapturer({
      probe: () => {
        throw new Error("lsof exploded");
      },
      stamp: () => {},
      everyTicks: 1,
    });
    expect(() => throwing.onTick([codexPane()])).not.toThrow();
  });

  it("rejects unsafe ids from a probe", () => {
    const stamps: string[] = [];
    const capturer = createSessionIdCapturer({
      probe: () => "$(rm -rf /)",
      stamp: (paneId) => stamps.push(paneId),
      everyTicks: 1,
    });
    capturer.onTick([codexPane()]);
    expect(stamps).toEqual([]);
  });
});
