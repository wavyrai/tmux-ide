import { describe, expect, it } from "vitest";
import type { FleetSnapshot, PaneSnapshot } from "../../tui/chrome/snapshot.ts";
import {
  buildUpgradePlan,
  confirmation,
  coverage,
  renderPlan,
  sameShape,
  type ServerIdentity,
} from "../tmux-upgrade/plan.ts";

const NOW = 1_800_000_000;

function pane(index: number, extra: Partial<PaneSnapshot> = {}): PaneSnapshot {
  return {
    index,
    cwd: `/work/p${index}`,
    command: null,
    agent: null,
    agentSessionId: null,
    agentState: null,
    title: `t${index}`,
    ...extra,
  };
}

function fleet(): FleetSnapshot {
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
            index: 1,
            name: "code",
            active: true,
            layout: "abcd,80x24,0,0{40x24,0,0,1,39x24,41,0,2}",
            panes: [
              pane(0, {
                cwd: "/work/api",
                agent: "claude",
                agentSessionId: "0f3c-uuid",
                agentState: `working:${NOW - 5}`,
              }),
              pane(1, { cwd: "/work/api", command: "npm run dev" }),
            ],
          },
          {
            index: 2,
            name: "agents",
            active: false,
            layout: "ef01,80x24,0,0,3",
            panes: [pane(0, { cwd: "/work/api/docs", agent: "codex", agentState: `idle:${NOW}` })],
          },
        ],
      },
      {
        name: "notes",
        cwd: "/work/notes",
        adopted: false,
        windows: [
          { index: 0, name: "zsh", active: true, layout: "aa11,80x24,0,0,4", panes: [pane(0)] },
        ],
      },
    ],
  };
}

const LISTING = [
  "api\t1\t0",
  "api\t1\t1",
  "api\t2\t0",
  "notes\t0\t0",
  "_tmux-ide-chrome\t0\t0",
  "zz-scratch\t0\t0",
];

const SERVER: ServerIdentity = {
  host: "spark-04ad",
  socketPath: "/tmp/tmux-1000/default",
  pid: 4242,
  startTime: 1_700_000_000,
  version: "3.5a",
  executable: "/home/linuxbrew/.linuxbrew/bin/tmux",
  features: "stock",
};

describe("coverage", () => {
  it("accepts a snapshot that holds every listable session, window and pane", () => {
    const result = coverage(fleet(), LISTING);
    expect(result).toEqual({
      ok: true,
      problems: [],
      notRestored: ["zz-scratch"],
    });
  });

  it("names a session the snapshot misses", () => {
    const result = coverage(fleet(), [...LISTING, "web\t0\t0"]);
    expect(result.ok).toBe(false);
    expect(result.problems).toContain("session web is not in the snapshot");
  });

  it("names a missing window and a pane-count mismatch", () => {
    const missingWindow = coverage(fleet(), [...LISTING, "api\t3\t0"]);
    expect(missingWindow.problems).toContain("window api:3 is not in the snapshot");
    const extraPane = coverage(fleet(), [...LISTING, "api\t2\t1"]);
    expect(extraPane.problems).toContain("window api:2 has 2 panes, the snapshot has 1");
  });

  it("names a session that ended after the snapshot", () => {
    const result = coverage(
      fleet(),
      LISTING.filter((line) => !line.startsWith("notes")),
    );
    expect(result.problems).toContain("session notes ended after the snapshot");
  });

  it("refuses a window without a layout and a pane without a folder", () => {
    const snapshot = fleet();
    snapshot.sessions[0]!.windows[1]!.layout = "";
    snapshot.sessions[1]!.windows[0]!.panes[0]!.cwd = "";
    const result = coverage(snapshot, LISTING);
    expect(result.problems).toEqual([
      "window api:2 has no layout in the snapshot",
      "pane notes:0.0 has no folder in the snapshot",
    ]);
  });

  it("refuses an empty server listing", () => {
    expect(coverage({ ...fleet(), sessions: [] }, []).problems).toEqual([
      "the server lists no sessions",
    ]);
  });
});

describe("sameShape", () => {
  it("compares window and pane counts in order, not window indexes", () => {
    const shifted = ["api\t0\t0", "api\t0\t1", "api\t1\t0", "notes\t1\t0"];
    expect(sameShape(fleet(), shifted)).toEqual([]);
    expect(sameShape(fleet(), ["api\t0\t0", "api\t1\t0", "notes\t1\t0"])).toEqual([
      "session api came back with 1+1 panes, the snapshot has 2+1",
    ]);
    expect(sameShape(fleet(), shifted.slice(0, 3))).toEqual(["session notes did not come back"]);
  });
});

describe("buildUpgradePlan and renderPlan", () => {
  const plan = buildUpgradePlan({
    server: SERVER,
    bundled: { executable: "/opt/tmux-ide/tmux", version: "3.7c" },
    snapshot: fleet(),
    snapshotPath: "/home/u/.tmux-ide/upgrades/x/snapshot.json",
    notRestored: ["zz-scratch"],
    resumeAgents: true,
    nowSec: NOW,
  });

  it("counts agents, names their folders and marks the ones mid-turn", () => {
    expect(plan.agents).toEqual([
      {
        target: "api:1.0",
        agent: "claude",
        cwd: "/work/api",
        state: "working",
        resumes: true,
      },
      {
        target: "api:2.0",
        agent: "codex",
        cwd: "/work/api/docs",
        state: "idle",
        resumes: false,
      },
    ]);
    expect(plan.midTurn).toBe(1);
    expect(plan.programs).toEqual([{ target: "api:1.1", command: "npm run dev" }]);
    expect(plan.paneCount).toBe(4);
  });

  it("names the machine and the server in the first line", () => {
    const lines = renderPlan(plan).split("\n");
    expect(lines[0]).toBe(
      "This ends 2 sessions and 2 agents on spark-04ad (/tmp/tmux-1000/default).",
    );
    const text = lines.join("\n");
    expect(text).toContain("stock tmux 3.5a (/home/linuxbrew/.linuxbrew/bin/tmux)");
    expect(text).toContain("api:1.0  claude  working  /work/api  resumes its conversation");
    expect(text).toContain("api:2.0  codex  idle  /work/api/docs  ends; no saved conversation id");
    expect(text).toContain("1 agent is mid-turn. Its current turn will be lost.");
    expect(text).toContain("api:1.1  npm run dev");
    expect(text).toContain("Also ends, not restored: zz-scratch");
    expect(text).toContain("Snapshot saved: /home/u/.tmux-ide/upgrades/x/snapshot.json");
  });

  it("treats an agent with no state report as possibly mid-turn", () => {
    const snapshot = fleet();
    snapshot.sessions[0]!.windows[1]!.panes[0]!.agentState = null;
    const unknown = buildUpgradePlan({
      server: SERVER,
      bundled: { executable: "/opt/tmux-ide/tmux", version: "3.7c" },
      snapshot,
      snapshotPath: "/s.json",
      notRestored: [],
      resumeAgents: false,
      nowSec: NOW,
    });
    expect(unknown.agents[1]!.state).toBe("unknown");
    expect(unknown.midTurn).toBe(2);
    expect(unknown.agents.every((agent) => !agent.resumes)).toBe(true);
  });
});

describe("confirmation", () => {
  it("asks with a default of No when nothing was passed", () => {
    expect(
      confirmation({ yes: false, endRunningAgents: false, json: false, dryRun: false, midTurn: 0 }),
    ).toEqual({
      kind: "ask",
    });
  });

  it("previews under --dry-run, and under --json without --yes", () => {
    expect(
      confirmation({ yes: true, endRunningAgents: true, json: false, dryRun: true, midTurn: 0 })
        .kind,
    ).toBe("preview");
    expect(
      confirmation({ yes: false, endRunningAgents: false, json: true, dryRun: false, midTurn: 0 })
        .kind,
    ).toBe("preview");
  });

  it("refuses --yes alone while an agent is mid-turn", () => {
    expect(
      confirmation({ yes: true, endRunningAgents: false, json: false, dryRun: false, midTurn: 2 }),
    ).toEqual({
      kind: "refuse",
      reason:
        "2 agents may be mid-turn. Pass --yes --end-running-agents to end them, or wait until they are idle.",
    });
    expect(
      confirmation({ yes: true, endRunningAgents: true, json: false, dryRun: false, midTurn: 2 })
        .kind,
    ).toBe("proceed");
    expect(
      confirmation({ yes: true, endRunningAgents: false, json: false, dryRun: false, midTurn: 0 })
        .kind,
    ).toBe("proceed");
  });
});
