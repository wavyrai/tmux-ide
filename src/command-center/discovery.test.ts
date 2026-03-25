import { describe, it, beforeEach, afterEach, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentIdentifier } from "../lib/orchestrator.ts";
import { ensureTasksDir, saveMission, saveTask, loadTask, type Goal } from "../lib/task-store.ts";
import { _setExecutor, type PaneInfo } from "../widgets/lib/pane-comms.ts";
import {
  _setTmuxRunner,
  discoverSessions,
  computeStats,
  computeGoalProgress,
  buildOverviews,
  buildProjectDetail,
  updateTask,
  type SessionInfo,
} from "./discovery.ts";
import { makeTask, makePane } from "../__tests__/support.ts";

let tmpDir: string;
let restoreTmux: () => void;
let restoreDiscoveryTmux: () => void;
let mockPanes: PaneInfo[];

function makeSessionInfo(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    name: "test-session",
    dir: tmpDir,
    mission: null,
    goals: [],
    tasks: [],
    panes: [],
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "tmux-ide-cc-test-"));
  ensureTasksDir(tmpDir);
  mockPanes = [];

  restoreTmux = _setExecutor((_cmd: string, args: string[]) => {
    if (args[0] === "list-panes") {
      return mockPanes
        .map(
          (p) =>
            `${p.id}\t${p.index}\t${p.title}\t${p.currentCommand}\t${p.width}\t${p.height}\t${p.active ? "1" : "0"}\t${p.role ?? ""}\t${p.name ?? ""}\t${p.type ?? ""}`,
        )
        .join("\n");
    }
    return "";
  });

  restoreDiscoveryTmux = _setTmuxRunner((args: string[]) => {
    if (args[0] === "list-sessions") {
      return "test-session";
    }
    if (args[0] === "display-message") {
      return tmpDir;
    }
    return "";
  });
});

afterEach(() => {
  restoreTmux();
  restoreDiscoveryTmux();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("discoverSessions", () => {
  it("discovers sessions with tasks data", () => {
    saveMission(tmpDir, {
      title: "Test mission",
      description: "desc",
      created: "2026-01-01T00:00:00Z",
      updated: "2026-01-01T00:00:00Z",
    });
    saveTask(tmpDir, makeTask());

    const sessions = discoverSessions();
    expect(sessions.length).toBe(1);
    expect(sessions[0]!.name).toBe("test-session");
    expect(sessions[0]!.mission?.title).toBe("Test mission");
    expect(sessions[0]!.tasks.length).toBe(1);
  });

  it("returns empty when no sessions exist", () => {
    restoreDiscoveryTmux();
    restoreDiscoveryTmux = _setTmuxRunner(() => "");

    const sessions = discoverSessions();
    expect(sessions.length).toBe(0);
  });
});

describe("computeStats", () => {
  it("counts tasks and agents", () => {
    const info = makeSessionInfo({
      tasks: [
        makeTask({ id: "001", status: "done" }),
        makeTask({ id: "002", status: "in-progress" }),
        makeTask({ id: "003", status: "todo" }),
      ],
      panes: [
        makePane({ id: "%1", title: "Agent 1", currentCommand: "claude" }),
        makePane({ id: "%2", title: "Shell", currentCommand: "zsh" }),
      ],
    });

    const stats = computeStats(info);
    expect(stats.totalTasks).toBe(3);
    expect(stats.doneTasks).toBe(1);
    expect(stats.agents).toBe(1); // only claude pane
    expect(stats.activeAgents).toBe(0); // no spinner
  });

  it("detects active agents with spinner", () => {
    const info = makeSessionInfo({
      panes: [makePane({ id: "%1", title: "⠙ Working...", currentCommand: "claude" })],
    });

    const stats = computeStats(info);
    expect(stats.agents).toBe(1);
    expect(stats.activeAgents).toBe(1);
  });
});

describe("computeGoalProgress", () => {
  it("computes progress per goal", () => {
    const goals: Goal[] = [
      {
        id: "01",
        title: "Goal A",
        description: "",
        status: "in-progress",
        acceptance: "",
        priority: 1,
        created: "2026-01-01T00:00:00Z",
        updated: "2026-01-01T00:00:00Z",
        assignee: null,
        specialty: null,
      },
    ];
    const tasks = [
      makeTask({ id: "001", goal: "01", status: "done" }),
      makeTask({ id: "002", goal: "01", status: "todo" }),
      makeTask({ id: "003", goal: "01", status: "done" }),
      makeTask({ id: "004", goal: null, status: "todo" }),
    ];

    const progress = computeGoalProgress(goals, tasks);
    expect(progress.length).toBe(1);
    expect(progress[0]!.id).toBe("01");
    expect(progress[0]!.progress).toBe(67); // 2/3
  });

  it("returns 0 progress for goals with no tasks", () => {
    const goals: Goal[] = [
      {
        id: "01",
        title: "Empty",
        description: "",
        status: "todo",
        acceptance: "",
        priority: 1,
        created: "2026-01-01T00:00:00Z",
        updated: "2026-01-01T00:00:00Z",
        assignee: null,
        specialty: null,
      },
    ];

    const progress = computeGoalProgress(goals, []);
    expect(progress[0]!.progress).toBe(0);
  });
});

describe("buildOverviews", () => {
  it("builds overview with stats for each session", () => {
    const sessions: SessionInfo[] = [
      makeSessionInfo({
        mission: {
          title: "Ship it",
          description: "fast",
          created: "2026-01-01T00:00:00Z",
          updated: "2026-01-01T00:00:00Z",
        },
        tasks: [makeTask({ id: "001", status: "done" }), makeTask({ id: "002", status: "todo" })],
      }),
    ];

    const overviews = buildOverviews(sessions);
    expect(overviews.length).toBe(1);
    expect(overviews[0]!.mission?.title).toBe("Ship it");
    expect(overviews[0]!.stats.totalTasks).toBe(2);
    expect(overviews[0]!.stats.doneTasks).toBe(1);
  });
});

describe("buildProjectDetail", () => {
  it("builds detail with agents matched to tasks", () => {
    const pane = makePane({ id: "%1", index: 0, title: "Agent 1", currentCommand: "claude" });
    const name = agentIdentifier(pane);
    const info = makeSessionInfo({
      tasks: [
        makeTask({
          id: "001",
          status: "in-progress",
          assignee: name,
          updated: new Date().toISOString(),
        }),
      ],
      panes: [pane],
    });

    const detail = buildProjectDetail(info);
    expect(detail.agents.length).toBe(1);
    expect(detail.agents[0]!.paneTitle).toBe(name);
    expect(detail.agents[0]!.taskTitle).toBe("Test task");
    expect(detail.agents[0]!.taskId).toBe("001");
  });

  it("shows idle agent with no task", () => {
    const info = makeSessionInfo({
      tasks: [],
      panes: [makePane({ id: "%1", title: "Agent 1", currentCommand: "claude" })],
    });

    const detail = buildProjectDetail(info);
    expect(detail.agents[0]!.taskTitle).toBe(null);
    expect(detail.agents[0]!.isBusy).toBe(false);
  });
});

describe("updateTask", () => {
  it("updates task status and returns updated task", () => {
    saveTask(tmpDir, makeTask({ id: "001", status: "todo" }));

    const result = updateTask(tmpDir, "001", { status: "in-progress" });
    expect(result).toBeTruthy();
    expect(result.status).toBe("in-progress");

    const loaded = loadTask(tmpDir, "001");
    expect(loaded?.status).toBe("in-progress");
  });

  it("updates assignee", () => {
    saveTask(tmpDir, makeTask({ id: "001" }));

    const result = updateTask(tmpDir, "001", { assignee: "Agent 1" });
    expect(result).toBeTruthy();
    expect(result.assignee).toBe("Agent 1");
  });

  it("returns null for non-existent task", () => {
    const result = updateTask(tmpDir, "999", { status: "done" });
    expect(result).toBe(null);
  });
});
