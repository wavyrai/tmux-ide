import { describe, expect, it } from "vitest";
import type { FleetSnapshot } from "../tui/chrome/snapshot.ts";
import type { ServerFeatures } from "../lib/tmux-server-features.ts";
import { finishUpgrade, upgradeServer, type UpgradeIo, type UpgradeOptions } from "./run.ts";

const NOW = 1_800_000_000;
const SOCKET = "/tmp/tmux-1000/default";
const BUNDLED = "/opt/tmux-ide/tmux";
const STOCK = "/opt/homebrew/bin/tmux";

function snapshot(agentState: string | null = `idle:${NOW}`): FleetSnapshot {
  return {
    version: 1,
    savedAt: "2026-11-10T09:00:00.000Z",
    sessions: [
      {
        name: "api",
        cwd: "/work/api",
        adopted: true,
        windows: [
          {
            index: 0,
            name: "code",
            active: true,
            layout: "abcd,80x24,0,0{40x24,0,0,1,39x24,41,0,2}",
            panes: [
              {
                index: 0,
                cwd: "/work/api",
                command: null,
                agent: "claude",
                agentSessionId: "abc-123",
                agentState,
                title: "claude",
              },
              {
                index: 1,
                cwd: "/work/api",
                command: null,
                agent: null,
                agentSessionId: null,
                agentState: null,
                title: "zsh",
              },
            ],
          },
        ],
      },
    ],
  };
}

const LISTING = ["api\t0\t0", "api\t0\t1"];

interface Fake {
  io: UpgradeIo;
  calls: string[];
  printed: string[];
  /** What had been printed when the kill ran. */
  printedAtKill: string[];
  set(patch: Partial<FakeState>): void;
}

interface FakeState {
  features: ServerFeatures[];
  bundled: { executable: string; version: string } | null;
  configured: string | undefined;
  scratch: ServerFeatures;
  listings: string[][];
  snapshots: FleetSnapshot[];
  saveFails: boolean;
  loadReturnsNull: boolean;
  inside: boolean;
  answer: boolean;
  killFails: boolean;
  gone: boolean;
  restoreFailsWith: string | null;
  /** identify() answers from this queue first, then the default server. */
  identities: (ServerFacts | null)[];
  ending: EndingPane[];
  self: string | null;
  /** The worker never writes a result. */
  workerSilent: boolean;
}

const DEFAULT_FACTS: ServerFacts = {
  socketPath: SOCKET,
  pid: 4242,
  startTime: 1_700_000_000,
  version: "3.5a",
  executable: STOCK,
};

function fake(): Fake {
  const calls: string[] = [];
  const printed: string[] = [];
  const state: FakeState = {
    features: ["stock", "full"],
    bundled: { executable: BUNDLED, version: "3.7c" },
    configured: undefined,
    scratch: "full",
    listings: [LISTING, LISTING, LISTING],
    snapshots: [snapshot()],
    saveFails: false,
    loadReturnsNull: false,
    inside: false,
    answer: true,
    killFails: false,
    gone: true,
    restoreFailsWith: null,
    identities: [],
    ending: [],
    self: null,
    workerSilent: false,
  };
  let work: WorkerState | null = null;
  const printedAtKill: string[] = [];
  let saved: FleetSnapshot | null = null;
  const io: UpgradeIo = {
    host: () => "spark-04ad",
    bundled: () => state.bundled,
    configuredBinary: () => state.configured,
    identify: (client) => {
      calls.push(`identify ${client}`);
      return state.identities.length ? state.identities.shift()! : DEFAULT_FACTS;
    },
    endingPanes: () => state.ending,
    ownPane: () => state.self,
    features: (client, socket) => {
      calls.push(`features ${client} ${socket}`);
      return state.features.shift() ?? "unknown";
    },
    scratchFeatures: (client) => {
      calls.push(`scratch ${client}`);
      return state.scratch;
    },
    listPanes: (client, socket) => {
      calls.push(`list ${client} ${socket}`);
      return state.listings.shift() ?? LISTING;
    },
    collect: (client, socket) => {
      calls.push(`collect ${client} ${socket}`);
      return state.snapshots.length > 1 ? state.snapshots.shift()! : state.snapshots[0]!;
    },
    saveSnapshot: (value) => {
      calls.push("save");
      if (state.saveFails) throw new Error("EACCES: permission denied");
      saved = value;
      return "/home/u/.tmux-ide/upgrades/t/snapshot.json";
    },
    loadSnapshot: (path) => {
      calls.push(`load ${path}`);
      return state.loadReturnsNull ? null : saved;
    },
    insideTarget: () => state.inside,
    confirm: async () => {
      calls.push("confirm");
      return state.answer;
    },
    startWorker: (state_) => {
      calls.push(`worker ${state_.snapshotPath}`);
      work = state_;
      return { log: "/home/u/.tmux-ide/upgrades/t/log", resultPath: "/r.json", pid: 1 };
    },
    // The worker runs in-process here: the same steps the detached one runs.
    waitForWorker: async () => (state.workerSilent ? null : finishUpgrade(io, work!)),
    kill: (client, server) => {
      calls.push(`kill ${client} ${server.pid}`);
      printedAtKill.push(...printed);
      if (state.killFails) throw new Error("kill refused");
    },
    serverGone: () => {
      calls.push("gone?");
      return state.gone;
    },
    restore: async ({ client, socket, snapshotPath, resumeAgents }) => {
      calls.push(`restore ${client} ${socket} ${snapshotPath} resume=${resumeAgents}`);
      if (state.restoreFailsWith && client === BUNDLED) throw new Error(state.restoreFailsWith);
      return { restored: ["api"], failed: [] };
    },
    print: (text) => {
      printed.push(text);
    },
    nowSec: () => NOW,
  };
  return { io, calls, printed, printedAtKill, set: (patch) => Object.assign(state, patch) };
}

const ASK: UpgradeOptions = {
  yes: false,
  endRunningAgents: false,
  json: false,
  dryRun: false,
  resumeAgents: true,
};
const YES: UpgradeOptions = { ...ASK, yes: true };

const killed = (calls: string[]) => calls.some((call) => call.startsWith("kill"));

describe("upgradeServer", () => {
  it("stops at once when the server already has every feature", async () => {
    const f = fake();
    f.set({ features: ["full"] });
    const result = await upgradeServer(f.io, YES);
    expect(result.status).toBe("already-full");
    expect(f.calls.some((call) => call.startsWith("collect"))).toBe(false);
    expect(killed(f.calls)).toBe(false);
  });

  it("refuses without a bundled tmux, or when TMUX_IDE_TMUX_BIN names another binary", async () => {
    const none = fake();
    none.set({ bundled: null });
    await expect(upgradeServer(none.io, YES)).rejects.toThrow(/bundled tmux/);
    expect(killed(none.calls)).toBe(false);
    const other = fake();
    other.set({ configured: STOCK });
    await expect(upgradeServer(other.io, YES)).rejects.toThrow(/TMUX_IDE_TMUX_BIN/);
    expect(killed(other.calls)).toBe(false);
  });

  it("refuses when a scratch server from the bundle is not full", async () => {
    const f = fake();
    f.set({ scratch: "partial" });
    await expect(upgradeServer(f.io, YES)).rejects.toThrow(/scratch server/);
    expect(killed(f.calls)).toBe(false);
  });

  it("kills nothing when the snapshot can't be written or read back", async () => {
    const write = fake();
    write.set({ saveFails: true });
    await expect(upgradeServer(write.io, YES)).rejects.toThrow(/Nothing was stopped/);
    expect(killed(write.calls)).toBe(false);
    const read = fake();
    read.set({ loadReturnsNull: true });
    await expect(upgradeServer(read.io, YES)).rejects.toThrow(/could not be read back/);
    expect(killed(read.calls)).toBe(false);
  });

  it("kills nothing when the snapshot misses a session", async () => {
    const f = fake();
    f.set({ listings: [[...LISTING, "web\t0\t0"]] });
    await expect(upgradeServer(f.io, YES)).rejects.toThrow(/session web is not in the snapshot/);
    expect(killed(f.calls)).toBe(false);
  });

  it("previews under --dry-run without asking or killing", async () => {
    const f = fake();
    const result = await upgradeServer(f.io, { ...YES, dryRun: true });
    expect(result.status).toBe("preview");
    expect(result.plan?.server.host).toBe("spark-04ad");
    expect(f.calls).not.toContain("confirm");
    expect(killed(f.calls)).toBe(false);
  });

  it("does nothing when the user answers No", async () => {
    const f = fake();
    f.set({ answer: false });
    const result = await upgradeServer(f.io, ASK);
    expect(result.status).toBe("declined");
    expect(f.printed[0]).toMatch(
      /^This ends 1 session and 1 agent on spark-04ad \(\/tmp\/tmux-1000\/default\)\./,
    );
    expect(killed(f.calls)).toBe(false);
  });

  it("refuses --yes alone while an agent is mid-turn", async () => {
    const f = fake();
    f.set({ snapshots: [snapshot(`working:${NOW}`)] });
    const result = await upgradeServer(f.io, YES);
    expect(result.status).toBe("refused");
    expect(result.message).toMatch(/--end-running-agents/);
    expect(killed(f.calls)).toBe(false);
    const g = fake();
    g.set({ snapshots: [snapshot(`working:${NOW}`)] });
    expect((await upgradeServer(g.io, { ...YES, endRunningAgents: true })).status).toBe("upgraded");
  });

  it("snapshots, checks again, kills the exact server, restores on the bundle and verifies", async () => {
    const f = fake();
    const result = await upgradeServer(f.io, ASK);
    expect(result.status).toBe("upgraded");
    expect(f.calls).toEqual([
      `identify ${BUNDLED}`,
      `features ${BUNDLED} ${SOCKET}`,
      `scratch ${BUNDLED}`,
      `collect ${BUNDLED} ${SOCKET}`,
      "save",
      "load /home/u/.tmux-ide/upgrades/t/snapshot.json",
      `list ${BUNDLED} ${SOCKET}`,
      "confirm",
      `list ${BUNDLED} ${SOCKET}`,
      "worker /home/u/.tmux-ide/upgrades/t/snapshot.json",
      // The worker: the same server, the snapshot still covers it, then the kill.
      `identify ${BUNDLED}`,
      "load /home/u/.tmux-ide/upgrades/t/snapshot.json",
      `list ${BUNDLED} ${SOCKET}`,
      `kill ${BUNDLED} 4242`,
      "gone?",
      `restore ${BUNDLED} ${SOCKET} /home/u/.tmux-ide/upgrades/t/snapshot.json resume=true`,
      `features ${BUNDLED} ${SOCKET}`,
      `list ${BUNDLED} ${SOCKET}`,
    ]);
    expect(f.printed.at(-1)).toMatch(/bundled tmux: full features/);
  });

  it("takes a new snapshot and asks again when the server changed after the prompt", async () => {
    const f = fake();
    const grown = snapshot();
    grown.sessions.push({
      name: "web",
      cwd: "/work/web",
      adopted: false,
      windows: [
        {
          index: 0,
          name: "zsh",
          active: true,
          layout: "aa,80x24,0,0,9",
          panes: [{ ...grown.sessions[0]!.windows[0]!.panes[1]! }],
        },
      ],
    });
    const after = [...LISTING, "web\t0\t0"];
    f.set({
      snapshots: [snapshot(), grown],
      listings: [LISTING, after, after, after, after, after],
    });
    const result = await upgradeServer(f.io, ASK);
    expect(result.status).toBe("upgraded");
    expect(f.calls.filter((call) => call === "confirm")).toHaveLength(2);
    expect(f.calls.filter((call) => call === "save")).toHaveLength(2);
  });

  it("stops before restore when the kill fails or the server stays", async () => {
    const f = fake();
    f.set({ killFails: true });
    const result = await upgradeServer(f.io, YES);
    expect(result.status).toBe("failed");
    expect(result.message).toMatch(/still running/);
    expect(f.calls.some((call) => call.startsWith("restore"))).toBe(false);
    const g = fake();
    g.set({ gone: false });
    expect((await upgradeServer(g.io, YES)).status).toBe("failed");
    expect(g.calls.some((call) => call.startsWith("restore"))).toBe(false);
  });

  it("falls back to the old binary when the bundled server won't start", async () => {
    const f = fake();
    f.set({ restoreFailsWith: "server exited unexpectedly" });
    const result = await upgradeServer(f.io, YES);
    expect(result.status).toBe("failed");
    expect(f.calls.filter((call) => call.startsWith("restore"))).toEqual([
      `restore ${BUNDLED} ${SOCKET} /home/u/.tmux-ide/upgrades/t/snapshot.json resume=true`,
      `restore ${STOCK} ${SOCKET} /home/u/.tmux-ide/upgrades/t/snapshot.json resume=true`,
    ]);
    expect(result.message).toMatch(
      /tmux-ide restore --from \/home\/u\/.tmux-ide\/upgrades\/t\/snapshot.json/,
    );
  });

  it("goes ahead on --yes alone when no pane runs an agent", async () => {
    const f = fake();
    const plain = snapshot();
    const shell = plain.sessions[0]!.windows[0]!.panes[1]!;
    plain.sessions[0]!.windows[0]!.panes = [{ ...shell, index: 0 }, shell];
    f.set({ snapshots: [plain] });
    const result = await upgradeServer(f.io, YES);
    expect(result.status).toBe("upgraded");
    expect(result.plan?.agents).toEqual([]);
  });

  it("counts an agent with no fresh state report as mid-turn", async () => {
    const f = fake();
    f.set({ snapshots: [snapshot(null)] });
    const result = await upgradeServer(f.io, YES);
    expect(result.status).toBe("refused");
    expect(killed(f.calls)).toBe(false);
  });

  it("keeps the snapshot and prints the retry when neither tmux can restore", async () => {
    const f = fake();
    f.set({ restoreFailsWith: "server exited unexpectedly" });
    f.io.restore = async ({ client }) => {
      f.calls.push(`restore ${client}`);
      throw new Error(`${client} failed`);
    };
    const result = await upgradeServer(f.io, YES);
    expect(result.status).toBe("failed");
    expect(f.calls.filter((call) => call.startsWith("restore"))).toEqual([
      `restore ${BUNDLED}`,
      `restore ${STOCK}`,
    ]);
    expect(result.message).toMatch(/Neither tmux could start a server/);
    expect(result.message).toMatch(
      /tmux-ide restore --from \/home\/u\/.tmux-ide\/upgrades\/t\/snapshot.json/,
    );
  });

  it("reports a session that failed to rebuild and keeps the rest", async () => {
    const f = fake();
    f.io.restore = async () => ({ restored: [], failed: ["api"] });
    const result = await upgradeServer(f.io, YES);
    expect(result.status).toBe("failed");
    expect(result.message).toMatch(/session api failed to rebuild/);
    expect(result.message).toMatch(/restore --from/);
  });

  it("hands the kill to a detached worker when run inside the target server", async () => {
    const f = fake();
    f.set({ inside: true });
    const result = await upgradeServer(f.io, YES);
    expect(result.status).toBe("handed-off");
    expect(f.calls).toContain("worker /home/u/.tmux-ide/upgrades/t/snapshot.json");
    expect(killed(f.calls)).toBe(false);
    expect(result.message).toMatch(/\/home\/u\/.tmux-ide\/upgrades\/t\/log/);
  });
});

describe("before and after the kill", () => {
  const RETRY =
    "tmux-ide restore --from /home/u/.tmux-ide/upgrades/t/snapshot.json --resume-agents";
  it("prints the snapshot and the restore line before anything ends, with --yes and --json", async () => {
    for (const options of [YES, { ...YES, json: true }]) {
      const f = fake();
      expect((await upgradeServer(f.io, options)).status).toBe("upgraded");
      expect(f.printedAtKill.join("\n")).toContain(
        "Snapshot saved: /home/u/.tmux-ide/upgrades/t/snapshot.json",
      );
      expect(f.printedAtKill.join("\n")).toContain(RETRY);
    }
  });

  it("reports failure with the log and the restore line when the worker never reports", async () => {
    const f = fake();
    f.set({ workerSilent: true });
    const result = await upgradeServer(f.io, YES);
    expect(result.status).toBe("failed");
    expect(result.message).toContain("/home/u/.tmux-ide/upgrades/t/log");
    expect(result.message).toContain(RETRY);
  });

  it("the worker refuses a server with the same pid but another start time", async () => {
    const f = fake();
    f.set({ identities: [DEFAULT_FACTS, { ...DEFAULT_FACTS, startTime: 1_700_000_001 }] });
    const result = await upgradeServer(f.io, YES);
    expect(result.status).toBe("failed");
    expect(result.message).toMatch(/changed since the prompt/);
    expect(killed(f.calls)).toBe(false);
  });

  it("stops with the restore line when the same server still answers after the kill", async () => {
    const f = fake();
    f.set({ gone: false });
    const result = await upgradeServer(f.io, YES);
    expect(result.status).toBe("failed");
    expect(result.message).toContain(RETRY);
    expect(f.calls.some((call) => call.startsWith("restore"))).toBe(false);
  });

  it("restores into another server that took the socket after the kill", async () => {
    const f = fake();
    // prompt, worker check, then after the kill: a new server on the socket.
    f.set({
      gone: false,
      identities: [
        DEFAULT_FACTS,
        DEFAULT_FACTS,
        { ...DEFAULT_FACTS, pid: 5151, startTime: 1_800_000_000 },
      ],
    });
    const result = await upgradeServer(f.io, YES);
    expect(f.calls.some((call) => call.startsWith("restore"))).toBe(true);
    expect(result.status).toBe("upgraded");
    expect(f.printed.join("\n")).toMatch(/Another server \(pid 5151\)/);
  });

  it("does not call a partial or unreadable new server full", async () => {
    for (const after of ["partial", "unknown", "stock"] as const) {
      const f = fake();
      f.set({ features: ["stock", after] });
      const result = await upgradeServer(f.io, YES);
      expect(result.status).toBe("failed");
      expect(result.message).toContain(`reports "${after}", not full features`);
      expect(result.message).toContain(RETRY);
    }
  });

  it("refuses --yes alone when a not-restored session runs an agent or a program", async () => {
    const f = fake();
    f.set({
      ending: [{ target: "zz-scratch:0.0", cwd: "/w", agent: "claude", command: "claude" }],
    });
    const result = await upgradeServer(f.io, YES);
    expect(result.status).toBe("refused");
    expect(result.message).toMatch(/sessions that are not restored/);
    expect(killed(f.calls)).toBe(false);
  });
});

describe("run from an agent's own pane", () => {
  it("does not count the calling pane as an agent mid-turn", async () => {
    const working = snapshot(`working:${NOW}`);
    const f = fake();
    f.set({ snapshots: [working], self: "api:0.0" });
    expect((await upgradeServer(f.io, YES)).status).toBe("upgraded");
    const g = fake();
    g.set({ snapshots: [working], self: "api:0.1" });
    expect((await upgradeServer(g.io, YES)).status).toBe("refused");
  });
});

describe("finishUpgrade", () => {
  it("re-checks the server's identity and coverage before the worker kills it", async () => {
    const f = fake();
    f.set({ features: ["full"] });
    const server = {
      host: "spark-04ad",
      socketPath: SOCKET,
      pid: 4242,
      startTime: 1_700_000_000,
      version: "3.5a",
      executable: STOCK,
      features: "stock" as const,
    };
    f.io.loadSnapshot = () => snapshot();
    const result = await finishUpgrade(f.io, {
      server,
      client: BUNDLED,
      snapshotPath: "/s.json",
      resumeAgents: false,
    });
    expect(result.status).toBe("upgraded");
    expect(f.calls.slice(0, 3)).toEqual([
      `identify ${BUNDLED}`,
      `list ${BUNDLED} ${SOCKET}`,
      `kill ${BUNDLED} 4242`,
    ]);
  });

  it("refuses when the server was replaced since the prompt", async () => {
    const f = fake();
    f.io.identify = () => ({
      socketPath: SOCKET,
      pid: 9999,
      startTime: 1,
      version: "3.5a",
      executable: STOCK,
    });
    f.io.loadSnapshot = () => snapshot();
    const result = await finishUpgrade(f.io, {
      server: {
        host: "h",
        socketPath: SOCKET,
        pid: 4242,
        startTime: 1_700_000_000,
        version: "3.5a",
        executable: STOCK,
        features: "stock",
      },
      client: BUNDLED,
      snapshotPath: "/s.json",
      resumeAgents: false,
    });
    expect(result.status).toBe("failed");
    expect(killed(f.calls)).toBe(false);
  });
});
