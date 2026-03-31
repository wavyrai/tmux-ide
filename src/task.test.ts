import { describe, it, beforeEach, afterEach, expect } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeConfig } from "./lib/yaml-io.ts";
import { _setExecutor as setPaneExecutor, type PaneInfo } from "./widgets/lib/pane-comms.ts";
import { _setExecutor as setTmuxExecutor } from "./lib/tmux.ts";
import { saveResearchState } from "./lib/research.ts";
import { makeTask } from "./__tests__/support.ts";
import {
  ensureTasksDir,
  loadMission,
  saveMission,
  clearMission,
  loadGoals,
  loadGoal,
  saveGoal,
  deleteGoal,
  nextGoalId,
  loadTasks,
  loadTask,
  saveTask,
  deleteTask,
  nextTaskId,
  loadTasksForGoal,
  detectCycle,
  normalizeTask,
  normalizeGoal,
  normalizeMission,
  type Task,
} from "./lib/task-store.ts";
import { parseProof, taskCommand } from "./task.ts";

let tmpDir: string;
let restorePaneTmux: (() => void) | null = null;
let restoreSessionTmux: (() => void) | null = null;
let mockPanes: PaneInfo[] = [];

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "tmux-ide-task-test-"));
  mockPanes = [];
});

afterEach(() => {
  restorePaneTmux?.();
  restorePaneTmux = null;
  restoreSessionTmux?.();
  restoreSessionTmux = null;
  rmSync(tmpDir, { recursive: true, force: true });
});

function captureLogs(run: () => void | Promise<void>): Promise<string[]> | string[] {
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => logs.push(args.join(" "));
  try {
    const result = run();
    if (result instanceof Promise) {
      return result.finally(() => {
        console.log = origLog;
      }).then(() => logs);
    }
    console.log = origLog;
    return logs;
  } catch (error) {
    console.log = origLog;
    throw error;
  }
}

describe("ensureTasksDir", () => {
  it("creates .tasks/, goals/, and tasks/ directories", () => {
    ensureTasksDir(tmpDir);
    expect(existsSync(join(tmpDir, ".tasks"))).toBeTruthy();
    expect(existsSync(join(tmpDir, ".tasks", "goals"))).toBeTruthy();
    expect(existsSync(join(tmpDir, ".tasks", "tasks"))).toBeTruthy();
  });

  it("is idempotent", () => {
    ensureTasksDir(tmpDir);
    ensureTasksDir(tmpDir);
    expect(existsSync(join(tmpDir, ".tasks"))).toBeTruthy();
  });
});

describe("mission", () => {
  it("returns null when no mission exists", () => {
    ensureTasksDir(tmpDir);
    expect(loadMission(tmpDir)).toBe(null);
  });

  it("saves and loads a mission", () => {
    const mission = {
      title: "Ship the auth overhaul",
      description: "Before Q2 audit",
      status: "active" as const,
      branch: null,
      milestones: [],
      created: "2026-01-01T00:00:00Z",
      updated: "2026-01-01T00:00:00Z",
    };
    saveMission(tmpDir, mission);
    const loaded = loadMission(tmpDir);
    expect(loaded).toEqual(mission);
  });

  it("clears a mission", () => {
    saveMission(tmpDir, {
      title: "Test",
      description: "",
      status: "active",
      branch: null,
      milestones: [],
      created: "2026-01-01T00:00:00Z",
      updated: "2026-01-01T00:00:00Z",
    });
    clearMission(tmpDir);
    expect(loadMission(tmpDir)).toBe(null);
  });

  it("clear is safe when no mission exists", () => {
    ensureTasksDir(tmpDir);
    clearMission(tmpDir);
    expect(loadMission(tmpDir)).toBe(null);
  });

  it("plan-complete only activates the first milestone and locks the rest", async () => {
    saveMission(tmpDir, {
      title: "Test",
      description: "",
      status: "planning",
      branch: null,
      milestones: [
        {
          id: "M1",
          title: "First",
          description: "",
          status: "active",
          order: 1,
          created: "2026-01-01T00:00:00Z",
          updated: "2026-01-01T00:00:00Z",
        },
        {
          id: "M2",
          title: "Second",
          description: "",
          status: "active",
          order: 2,
          created: "2026-01-01T00:00:00Z",
          updated: "2026-01-01T00:00:00Z",
        },
        {
          id: "M3",
          title: "Third",
          description: "",
          status: "done",
          order: 3,
          created: "2026-01-01T00:00:00Z",
          updated: "2026-01-01T00:00:00Z",
        },
      ],
      created: "2026-01-01T00:00:00Z",
      updated: "2026-01-01T00:00:00Z",
    });

    await taskCommand(tmpDir, {
      action: "mission",
      sub: "plan-complete",
      args: [],
      values: {},
      json: true,
    });

    const mission = loadMission(tmpDir)!;
    expect(mission.status).toBe("active");
    expect(mission.milestones.find((m) => m.id === "M1")?.status).toBe("active");
    expect(mission.milestones.find((m) => m.id === "M2")?.status).toBe("locked");
    expect(mission.milestones.find((m) => m.id === "M3")?.status).toBe("locked");
  });

  it("reports research status as JSON", async () => {
    ensureTasksDir(tmpDir);
    saveTask(
      tmpDir,
      makeTask({
        id: "010",
        title: "Research: mission start",
        status: "done",
        updated: "2026-01-02T00:00:00Z",
        tags: ["research", "mission_start"],
        salientSummary: "Initial audit completed",
      }),
    );
    saveTask(
      tmpDir,
      makeTask({
        id: "011",
        title: "Research: periodic",
        status: "in-progress",
        updated: "2026-01-03T00:00:00Z",
        tags: ["research", "periodic"],
      }),
    );
    saveResearchState(tmpDir, {
      lastResearchAt: { periodic: "2026-01-03T00:00:00Z" },
      missionStartAnalyzed: true,
      milestoneTaskCounts: {},
      activeResearchTaskId: "011",
      retryWindow: [],
    });

    const logs = (await captureLogs(() =>
      taskCommand(tmpDir, {
        action: "research",
        sub: "status",
        args: [],
        values: {},
        json: true,
      }),
    )) as string[];
    const body = JSON.parse(logs.join("\n")) as {
      activeTask: Task | null;
      recentFindings: Array<{ id: string }>;
      missionStartAnalyzed: boolean;
    };

    expect(body.activeTask?.id).toBe("011");
    expect(body.recentFindings.map((finding) => finding.id)).toEqual(["010"]);
    expect(body.missionStartAnalyzed).toBe(true);
  });

  it("manually dispatches research tasks from the CLI handler", async () => {
    ensureTasksDir(tmpDir);
    writeConfig(tmpDir, {
      name: "test-project",
      rows: [],
      orchestrator: {
        enabled: true,
        dispatch_mode: "missions",
        research: { enabled: true },
      },
    });
    mockPanes = [
      {
        id: "%2",
        index: 1,
        title: "Researcher",
        currentCommand: "zsh",
        width: 100,
        height: 30,
        active: false,
        role: "researcher",
        name: null,
        type: null,
      },
    ];
    restorePaneTmux = setPaneExecutor((_cmd: string, args: string[]) => {
      if (args[0] === "list-panes") {
        return mockPanes
          .map(
            (pane) =>
              `${pane.id}\t${pane.index}\t${pane.title}\t${pane.currentCommand}\t${pane.width}\t${pane.height}\t${pane.active ? "1" : "0"}\t${pane.role ?? ""}\t${pane.name ?? ""}\t${pane.type ?? ""}`,
          )
          .join("\n");
      }
      return "";
    });
    restoreSessionTmux = setTmuxExecutor((_cmd, args) => {
      if (args[0] === "has-session" && args[2] === "test-project") {
        return Buffer.from("");
      }
      return Buffer.from("");
    });

    const logs = (await captureLogs(() =>
      taskCommand(tmpDir, {
        action: "research",
        sub: "trigger",
        args: ["periodic"],
        values: {},
        json: true,
      }),
    )) as string[];
    const task = JSON.parse(logs.join("\n")) as Task;

    expect(task.tags).toEqual(["research", "periodic"]);
    expect(task.specialty).toBe("researcher");
    expect(loadTask(tmpDir, task.id)?.status).toBe("in-progress");
  });
});

describe("goals", () => {
  it("returns empty array when no goals exist", () => {
    ensureTasksDir(tmpDir);
    expect(loadGoals(tmpDir)).toEqual([]);
  });

  it("auto-increments goal IDs", () => {
    ensureTasksDir(tmpDir);
    expect(nextGoalId(tmpDir)).toBe("01");
    saveGoal(tmpDir, {
      id: "01",
      title: "First goal",
      description: "",
      status: "todo",
      acceptance: "",
      priority: 1,
      created: "2026-01-01T00:00:00Z",
      updated: "2026-01-01T00:00:00Z",
      assignee: null,
      specialty: null,
      milestone: null,
    });
    expect(nextGoalId(tmpDir)).toBe("02");
  });

  it("saves with slugified filename", () => {
    ensureTasksDir(tmpDir);
    saveGoal(tmpDir, {
      id: "01",
      title: "Replace Session Storage",
      description: "",
      status: "todo",
      acceptance: "",
      priority: 1,
      created: "2026-01-01T00:00:00Z",
      updated: "2026-01-01T00:00:00Z",
      assignee: null,
      specialty: null,
      milestone: null,
    });
    const files = readdirSync(join(tmpDir, ".tasks", "goals"));
    expect(files.length).toBe(1);
    expect(files[0]!.startsWith("01-")).toBeTruthy();
    expect(files[0]!.includes("replace-session-storage")).toBeTruthy();
  });

  it("loads a goal by ID", () => {
    ensureTasksDir(tmpDir);
    const goal = {
      id: "01",
      title: "Test Goal",
      description: "desc",
      status: "todo" as const,
      acceptance: "acc",
      priority: 1,
      created: "2026-01-01T00:00:00Z",
      updated: "2026-01-01T00:00:00Z",
      assignee: null,
      specialty: null,
      milestone: null,
    };
    saveGoal(tmpDir, goal);
    expect(loadGoal(tmpDir, "01")).toEqual(goal);
  });

  it("returns null for non-existent goal", () => {
    ensureTasksDir(tmpDir);
    expect(loadGoal(tmpDir, "99")).toBe(null);
  });

  it("updates a goal in place", () => {
    ensureTasksDir(tmpDir);
    saveGoal(tmpDir, {
      id: "01",
      title: "Original",
      description: "",
      status: "todo",
      acceptance: "",
      priority: 1,
      created: "2026-01-01T00:00:00Z",
      updated: "2026-01-01T00:00:00Z",
      assignee: null,
      specialty: null,
      milestone: null,
    });
    const goal = loadGoal(tmpDir, "01")!;
    goal.status = "done";
    goal.title = "Updated Title";
    saveGoal(tmpDir, goal);
    const files = readdirSync(join(tmpDir, ".tasks", "goals"));
    expect(files.length).toBe(1); // no duplicate
    expect(loadGoal(tmpDir, "01")!.status).toBe("done");
  });

  it("deletes a goal", () => {
    ensureTasksDir(tmpDir);
    saveGoal(tmpDir, {
      id: "01",
      title: "To Delete",
      description: "",
      status: "todo",
      acceptance: "",
      priority: 1,
      created: "2026-01-01T00:00:00Z",
      updated: "2026-01-01T00:00:00Z",
      assignee: null,
      specialty: null,
      milestone: null,
    });
    expect(deleteGoal(tmpDir, "01")).toBe(true);
    expect(loadGoal(tmpDir, "01")).toBe(null);
  });

  it("returns false when deleting non-existent goal", () => {
    ensureTasksDir(tmpDir);
    expect(deleteGoal(tmpDir, "99")).toBe(false);
  });

  it("lists goals sorted by filename", () => {
    ensureTasksDir(tmpDir);
    const now = "2026-01-01T00:00:00Z";
    saveGoal(tmpDir, {
      id: "02",
      title: "Second",
      description: "",
      status: "todo",
      acceptance: "",
      priority: 2,
      created: now,
      updated: now,
      assignee: null,
      specialty: null,
      milestone: null,
    });
    saveGoal(tmpDir, {
      id: "01",
      title: "First",
      description: "",
      status: "todo",
      acceptance: "",
      priority: 1,
      created: now,
      updated: now,
      assignee: null,
      specialty: null,
      milestone: null,
    });
    const goals = loadGoals(tmpDir);
    expect(goals.length).toBe(2);
    expect(goals[0]!.id).toBe("01");
    expect(goals[1]!.id).toBe("02");
  });
});

describe("tasks", () => {
  it("returns empty array when no tasks exist", () => {
    ensureTasksDir(tmpDir);
    expect(loadTasks(tmpDir)).toEqual([]);
  });

  it("auto-increments task IDs with 3-digit padding", () => {
    ensureTasksDir(tmpDir);
    expect(nextTaskId(tmpDir)).toBe("001");
    saveTask(tmpDir, {
      id: "001",
      title: "First task",
      description: "",
      goal: null,
      status: "todo",
      assignee: null,
      priority: 1,
      created: "2026-01-01T00:00:00Z",
      updated: "2026-01-01T00:00:00Z",

      tags: [],
      proof: null,
      retryCount: 0,
      maxRetries: 5,
      lastError: null,
      nextRetryAt: null,
      depends_on: [],
      milestone: null,
      specialty: null,
      fulfills: [],
      discoveredIssues: [],
      salientSummary: null,
    });
    expect(nextTaskId(tmpDir)).toBe("002");
  });

  it("creates task with all fields including retry", () => {
    ensureTasksDir(tmpDir);
    const task: Task = {
      id: "001",
      title: "Fix auth middleware",
      description: "Token storage issue",
      goal: "01",
      status: "todo",
      assignee: "Agent 1",
      priority: 1,
      created: "2026-01-01T00:00:00Z",
      updated: "2026-01-01T00:00:00Z",
      tags: ["security", "compliance"],
      proof: null,
      retryCount: 2,
      maxRetries: 3,
      lastError: "timeout",
      nextRetryAt: "2026-01-02T00:00:00Z",
      depends_on: [],
      milestone: null,
      specialty: null,
      fulfills: [],
      discoveredIssues: [],
      salientSummary: null,
    };
    saveTask(tmpDir, task);
    expect(loadTask(tmpDir, "001")).toEqual(task);
  });

  it("loads tasks for a specific goal", () => {
    ensureTasksDir(tmpDir);
    const now = "2026-01-01T00:00:00Z";
    const base = {
      description: "",
      assignee: null,
      priority: 1,
      created: now,
      updated: now,

      tags: [],
      proof: null,
      retryCount: 0,
      maxRetries: 5,
      lastError: null,
      nextRetryAt: null,
      depends_on: [],
      milestone: null,
      specialty: null,
      fulfills: [],
      discoveredIssues: [],
      salientSummary: null,
    } as const;
    saveTask(tmpDir, { ...base, id: "001", title: "Task for goal 01", goal: "01", status: "todo" });
    saveTask(tmpDir, { ...base, id: "002", title: "Task for goal 02", goal: "02", status: "todo" });
    saveTask(tmpDir, {
      ...base,
      id: "003",
      title: "Another for goal 01",
      goal: "01",
      status: "done",
      priority: 2,
    });
    const goal01Tasks = loadTasksForGoal(tmpDir, "01");
    expect(goal01Tasks.length).toBe(2);
    expect(goal01Tasks.every((t) => t.goal === "01")).toBeTruthy();
  });

  it("deletes a task", () => {
    ensureTasksDir(tmpDir);
    saveTask(tmpDir, {
      id: "001",
      title: "To Delete",
      description: "",
      goal: null,
      status: "todo",
      assignee: null,
      priority: 1,
      created: "2026-01-01T00:00:00Z",
      updated: "2026-01-01T00:00:00Z",

      tags: [],
      proof: null,
      retryCount: 0,
      maxRetries: 5,
      lastError: null,
      nextRetryAt: null,
      depends_on: [],
      milestone: null,
      specialty: null,
      fulfills: [],
      discoveredIssues: [],
      salientSummary: null,
    });
    expect(deleteTask(tmpDir, "001")).toBe(true);
    expect(loadTask(tmpDir, "001")).toBe(null);
  });

  it("returns false when deleting non-existent task", () => {
    ensureTasksDir(tmpDir);
    expect(deleteTask(tmpDir, "999")).toBe(false);
  });

  it("updates task in place without duplicating file", () => {
    ensureTasksDir(tmpDir);
    saveTask(tmpDir, {
      id: "001",
      title: "Original Title",
      description: "",
      goal: null,
      status: "todo",
      assignee: null,
      priority: 1,
      created: "2026-01-01T00:00:00Z",
      updated: "2026-01-01T00:00:00Z",

      tags: [],
      proof: null,
      retryCount: 0,
      maxRetries: 5,
      lastError: null,
      nextRetryAt: null,
      depends_on: [],
      milestone: null,
      specialty: null,
      fulfills: [],
      discoveredIssues: [],
      salientSummary: null,
    });
    const task = loadTask(tmpDir, "001")!;
    task.title = "New Title";
    task.status = "in-progress";
    saveTask(tmpDir, task);
    const files = readdirSync(join(tmpDir, ".tasks", "tasks"));
    expect(files.length).toBe(1);
    expect(loadTask(tmpDir, "001")!.title).toBe("New Title");
  });

  it("applies retry defaults when loading legacy JSON without retry fields", () => {
    ensureTasksDir(tmpDir);
    const tasksDir = join(tmpDir, ".tasks", "tasks");
    // Write a legacy task JSON that has no retry fields
    const legacyTask = {
      id: "001",
      title: "Legacy task",
      description: "",
      goal: null,
      status: "todo",
      assignee: null,
      priority: 1,
      created: "2026-01-01T00:00:00Z",
      updated: "2026-01-01T00:00:00Z",

      tags: [],
      proof: null,
    };
    writeFileSync(
      join(tasksDir, "001-legacy-task.json"),
      JSON.stringify(legacyTask, null, 2) + "\n",
    );

    const loaded = loadTask(tmpDir, "001")!;
    expect(loaded.retryCount).toBe(0);
    expect(loaded.maxRetries).toBe(5);
    expect(loaded.lastError).toBe(null);
    expect(loaded.nextRetryAt).toBe(null);
    expect(loaded.depends_on).toEqual([]);
  });

  it("preserves explicit retry values from JSON", () => {
    ensureTasksDir(tmpDir);
    const tasksDir = join(tmpDir, ".tasks", "tasks");
    const taskWithRetry = {
      id: "002",
      title: "Retried task",
      description: "",
      goal: null,
      status: "in-progress",
      assignee: null,
      priority: 1,
      created: "2026-01-01T00:00:00Z",
      updated: "2026-01-01T00:00:00Z",

      tags: [],
      proof: null,
      retryCount: 3,
      maxRetries: 10,
      lastError: "Connection refused",
      nextRetryAt: "2026-01-01T01:00:00Z",
      depends_on: ["001"],
    };
    writeFileSync(
      join(tasksDir, "002-retried-task.json"),
      JSON.stringify(taskWithRetry, null, 2) + "\n",
    );

    const loaded = loadTask(tmpDir, "002")!;
    expect(loaded.retryCount).toBe(3);
    expect(loaded.maxRetries).toBe(10);
    expect(loaded.lastError).toBe("Connection refused");
    expect(loaded.nextRetryAt).toBe("2026-01-01T01:00:00Z");
  });

  it("saves and loads task with depends_on", () => {
    ensureTasksDir(tmpDir);
    const task = {
      id: "001",
      title: "Depends on others",
      description: "",
      goal: null,
      status: "todo" as const,
      assignee: null,
      priority: 1,
      created: "2026-01-01T00:00:00Z",
      updated: "2026-01-01T00:00:00Z",

      tags: [],
      proof: null,
      retryCount: 0,
      maxRetries: 5,
      lastError: null,
      nextRetryAt: null,
      depends_on: ["002", "003"],
    };
    saveTask(tmpDir, task);
    const loaded = loadTask(tmpDir, "001")!;
    expect(loaded.depends_on).toEqual(["002", "003"]);
  });

  it("defaults depends_on to empty array for legacy tasks without the field", () => {
    ensureTasksDir(tmpDir);
    const tasksDir = join(tmpDir, ".tasks", "tasks");
    writeFileSync(
      join(tasksDir, "001-legacy.json"),
      JSON.stringify({
        id: "001",
        title: "No deps field",
        description: "",
        goal: null,
        status: "todo",
        assignee: null,
        priority: 1,
        created: "2026-01-01T00:00:00Z",
        updated: "2026-01-01T00:00:00Z",

        tags: [],
        proof: null,
      }) + "\n",
    );
    const loaded = loadTask(tmpDir, "001")!;
    expect(loaded.depends_on).toEqual([]);
  });

  it("loadTasks defaults depends_on for all legacy tasks", () => {
    ensureTasksDir(tmpDir);
    const tasksDir = join(tmpDir, ".tasks", "tasks");
    for (const id of ["001", "002"]) {
      writeFileSync(
        join(tasksDir, `${id}-task.json`),
        JSON.stringify({
          id,
          title: `Task ${id}`,
          description: "",
          goal: null,
          status: "todo",
          assignee: null,
          priority: 1,
          created: "2026-01-01T00:00:00Z",
          updated: "2026-01-01T00:00:00Z",

          tags: [],
          proof: null,
        }) + "\n",
      );
    }
    const tasks = loadTasks(tmpDir);
    expect(tasks.length).toBe(2);
    for (const t of tasks) {
      expect(t.retryCount).toBe(0);
      expect(t.maxRetries).toBe(5);
      expect(t.lastError).toBe(null);
      expect(t.nextRetryAt).toBe(null);
      expect(t.depends_on).toEqual([]);
    }
  });
});

describe("parseProof", () => {
  it("treats plain string as proof.notes", () => {
    const result = parseProof("all tests pass", null);
    expect(result).toEqual({ notes: "all tests pass" });
  });

  it("merges plain string into existing proof", () => {
    const existing = { tests: { passed: 10, total: 10 } };
    const result = parseProof("verified manually", existing);
    expect(result).toEqual({
      tests: { passed: 10, total: 10 },
      notes: "verified manually",
    });
  });

  it("parses JSON with tests field", () => {
    const result = parseProof('{"tests":{"passed":5,"total":6}}', null);
    expect(result).toEqual({ tests: { passed: 5, total: 6 } });
  });

  it("parses JSON with pr field", () => {
    const result = parseProof(
      '{"pr":{"number":42,"url":"https://github.com/pr/42","status":"merged"}}',
      null,
    );
    expect(result).toEqual({
      pr: { number: 42, url: "https://github.com/pr/42", status: "merged" },
    });
  });

  it("parses JSON with ci field", () => {
    const result = parseProof('{"ci":{"status":"passing","url":"https://ci/123"}}', null);
    expect(result).toEqual({
      ci: { status: "passing", url: "https://ci/123" },
    });
  });

  it("parses JSON with notes field", () => {
    const result = parseProof('{"notes":"done"}', null);
    expect(result).toEqual({ notes: "done" });
  });

  it("parses JSON with all fields", () => {
    const input = JSON.stringify({
      tests: { passed: 10, total: 10 },
      pr: { number: 1 },
      ci: { status: "green" },
      notes: "ship it",
    });
    const result = parseProof(input, null);
    expect(result).toEqual({
      tests: { passed: 10, total: 10 },
      pr: { number: 1 },
      ci: { status: "green" },
      notes: "ship it",
    });
  });

  it("merges JSON proof into existing proof", () => {
    const existing = { notes: "old note", tests: { passed: 3, total: 5 } };
    const result = parseProof('{"tests":{"passed":5,"total":5}}', existing);
    expect(result).toEqual({
      notes: "old note",
      tests: { passed: 5, total: 5 },
    });
  });

  it("falls back to notes for invalid JSON starting with {", () => {
    const result = parseProof("{not valid json", null);
    expect(result).toEqual({ notes: "{not valid json" });
  });

  it("ignores invalid tests shape in JSON", () => {
    const result = parseProof('{"tests":"not an object","notes":"ok"}', null);
    expect(result).toEqual({ notes: "ok" });
  });

  it("saves and loads proof schema through task store", () => {
    ensureTasksDir(tmpDir);
    const task: Task = {
      id: "001",
      title: "With proof",
      description: "",
      goal: null,
      status: "done",
      assignee: null,
      priority: 1,
      created: "2026-01-01T00:00:00Z",
      updated: "2026-01-01T00:00:00Z",

      tags: [],
      proof: {
        tests: { passed: 10, total: 10 },
        pr: { number: 42, url: "https://github.com/pr/42" },
        ci: { status: "passing" },
        notes: "all good",
      },
      retryCount: 0,
      maxRetries: 5,
      lastError: null,
      nextRetryAt: null,
      depends_on: [],
      milestone: null,
      specialty: null,
      fulfills: [],
      discoveredIssues: [],
      salientSummary: null,
    };
    saveTask(tmpDir, task);
    const loaded = loadTask(tmpDir, "001")!;
    expect(loaded.proof).toEqual(task.proof);
  });

  it("loads legacy Record<string,string> proof from JSON without error", () => {
    ensureTasksDir(tmpDir);
    const tasksDir = join(tmpDir, ".tasks", "tasks");
    writeFileSync(
      join(tasksDir, "001-legacy-proof.json"),
      JSON.stringify({
        id: "001",
        title: "Legacy proof",
        description: "",
        goal: null,
        status: "done",
        assignee: null,
        priority: 1,
        created: "2026-01-01T00:00:00Z",
        updated: "2026-01-01T00:00:00Z",

        tags: [],
        proof: { note: "old format proof" },
      }) + "\n",
    );
    const loaded = loadTask(tmpDir, "001")!;
    expect(loaded.proof !== null).toBeTruthy();
    expect(loaded.proof!.notes).toBe("old format proof");
  });
});

describe("normalizer snapshots", () => {
  it("normalizeTask produces exact default shape", () => {
    const raw = {
      id: "001",
      title: "Test",
      description: "desc",
      goal: null,
      status: "todo",
      assignee: null,
      priority: 1,
      created: "2026-01-01T00:00:00Z",
      updated: "2026-01-01T00:00:00Z",

      tags: [],
      proof: null,
    };
    const result = normalizeTask(raw as Record<string, unknown>);
    expect(result).toEqual({
      id: "001",
      title: "Test",
      description: "desc",
      goal: null,
      status: "todo",
      assignee: null,
      priority: 1,
      created: "2026-01-01T00:00:00Z",
      updated: "2026-01-01T00:00:00Z",

      tags: [],
      proof: null,
      retryCount: 0,
      maxRetries: 5,
      lastError: null,
      nextRetryAt: null,
      depends_on: [],
      milestone: null,
      specialty: null,
      fulfills: [],
      discoveredIssues: [],
      salientSummary: null,
    });
  });

  it("normalizeTask migrates proof.note to proof.notes", () => {
    const raw = {
      id: "001",
      title: "Test",
      description: "",
      goal: null,
      status: "todo",
      assignee: null,
      priority: 1,
      created: "2026-01-01T00:00:00Z",
      updated: "2026-01-01T00:00:00Z",

      tags: [],
      proof: { note: "legacy note" },
    };
    const result = normalizeTask(raw as Record<string, unknown>);
    expect(result.proof?.notes).toBe("legacy note");
    expect((result.proof as Record<string, unknown>).note).toBe(undefined);
  });

  it("normalizeGoal defaults missing fields", () => {
    const raw = {
      id: "01",
      title: "G",
      description: "",
      status: "todo",
      acceptance: "",
      priority: 1,
    };
    const result = normalizeGoal(raw as Record<string, unknown>);
    expect(result.assignee).toBe(null);
    expect(result.specialty).toBe(null);
    expect(result.milestone).toBe(null);
    expect(result.created).toBe("1970-01-01T00:00:00.000Z");
    expect(result.updated).toBe("1970-01-01T00:00:00.000Z");
  });

  it("normalizeMission defaults missing timestamps", () => {
    const raw = { title: "M", description: "desc" };
    const result = normalizeMission(raw as Record<string, unknown>);
    expect(result).toEqual({
      title: "M",
      description: "desc",
      status: "active",
      branch: null,
      milestones: [],
      created: "1970-01-01T00:00:00.000Z",
      updated: "1970-01-01T00:00:00.000Z",
    });
  });

  it("normalizeTask preserves explicit retry values", () => {
    const raw = {
      id: "001",
      title: "Test",
      description: "",
      goal: null,
      status: "todo",
      assignee: null,
      priority: 1,
      created: "2026-01-01T00:00:00Z",
      updated: "2026-01-01T00:00:00Z",

      tags: [],
      proof: null,
      retryCount: 3,
      maxRetries: 10,
      lastError: "timeout",
      nextRetryAt: "2026-01-02T00:00:00Z",
      depends_on: ["002"],
    };
    const result = normalizeTask(raw as Record<string, unknown>);
    expect(result.retryCount).toBe(3);
    expect(result.maxRetries).toBe(10);
    expect(result.lastError).toBe("timeout");
    expect(result.nextRetryAt).toBe("2026-01-02T00:00:00Z");
    expect(result.depends_on).toEqual(["002"]);
  });
});

describe("schema version", () => {
  it("saveTask writes _version: 1 to JSON but loadTask strips it", () => {
    ensureTasksDir(tmpDir);
    const task = {
      id: "001",
      title: "Versioned task",
      description: "",
      goal: null,
      status: "todo" as const,
      assignee: null,
      priority: 1,
      created: "2026-01-01T00:00:00Z",
      updated: "2026-01-01T00:00:00Z",

      tags: [],
      proof: null,
      retryCount: 0,
      maxRetries: 5,
      lastError: null,
      nextRetryAt: null,
      depends_on: [],
      milestone: null,
      specialty: null,
      fulfills: [],
      discoveredIssues: [],
      salientSummary: null,
    };
    saveTask(tmpDir, task);

    // Raw JSON should contain _version
    const files = readdirSync(join(tmpDir, ".tasks", "tasks"));
    const raw = JSON.parse(readFileSync(join(tmpDir, ".tasks", "tasks", files[0]!), "utf-8"));
    expect(raw._version).toBe(1);

    // Loaded domain object should NOT contain _version
    const loaded = loadTask(tmpDir, "001")!;
    expect("_version" in loaded).toBe(false);
    expect(loaded).toEqual(task);
  });

  it("saveGoal writes _version: 1 to JSON but loadGoal strips it", () => {
    ensureTasksDir(tmpDir);
    const goal = {
      id: "01",
      title: "Versioned goal",
      description: "",
      status: "todo" as const,
      acceptance: "",
      priority: 1,
      created: "2026-01-01T00:00:00Z",
      updated: "2026-01-01T00:00:00Z",
      assignee: null,
      specialty: null,
      milestone: null,
    };
    saveGoal(tmpDir, goal);

    const files = readdirSync(join(tmpDir, ".tasks", "goals"));
    const raw = JSON.parse(readFileSync(join(tmpDir, ".tasks", "goals", files[0]!), "utf-8"));
    expect(raw._version).toBe(1);

    const loaded = loadGoal(tmpDir, "01")!;
    expect("_version" in loaded).toBe(false);
    expect(loaded).toEqual(goal);
  });

  it("saveMission writes _version: 1 to JSON but loadMission strips it", () => {
    const mission = {
      title: "Versioned mission",
      description: "desc",
      status: "active" as const,
      branch: null,
      milestones: [],
      created: "2026-01-01T00:00:00Z",
      updated: "2026-01-01T00:00:00Z",
    };
    saveMission(tmpDir, mission);

    const raw = JSON.parse(readFileSync(join(tmpDir, ".tasks", "mission.json"), "utf-8"));
    expect(raw._version).toBe(1);

    const loaded = loadMission(tmpDir)!;
    expect("_version" in loaded).toBe(false);
    expect(loaded).toEqual(mission);
  });

  it("loads legacy files without _version field (version 0)", () => {
    ensureTasksDir(tmpDir);
    // Write a task with no _version (pre-versioning format)
    writeFileSync(
      join(tmpDir, ".tasks", "tasks", "001-legacy.json"),
      JSON.stringify({
        id: "001",
        title: "Legacy",
        description: "",
        goal: null,
        status: "todo",
        assignee: null,
        priority: 1,
        created: "2026-01-01T00:00:00Z",
        updated: "2026-01-01T00:00:00Z",

        tags: [],
        proof: null,
      }) + "\n",
    );
    const loaded = loadTask(tmpDir, "001")!;
    expect(loaded.id).toBe("001");
    expect("_version" in loaded).toBe(false);
  });
});

describe("corrupted file resilience", () => {
  it("loadTasks skips corrupted files and returns valid tasks", () => {
    ensureTasksDir(tmpDir);
    const tasksDir = join(tmpDir, ".tasks", "tasks");
    // Write one valid task
    writeFileSync(
      join(tasksDir, "001-valid.json"),
      JSON.stringify({
        id: "001",
        title: "Valid task",
        description: "",
        goal: null,
        status: "todo",
        assignee: null,
        priority: 1,
        created: "2026-01-01T00:00:00Z",
        updated: "2026-01-01T00:00:00Z",

        tags: [],
        proof: null,
      }) + "\n",
    );
    // Write a corrupted file
    writeFileSync(join(tasksDir, "002-broken.json"), "{ not valid json !!!");

    const tasks = loadTasks(tmpDir);
    expect(tasks.length).toBe(1);
    expect(tasks[0]!.id).toBe("001");
  });

  it("loadTask returns null for corrupted file", () => {
    ensureTasksDir(tmpDir);
    writeFileSync(join(tmpDir, ".tasks", "tasks", "001-broken.json"), "corrupt");
    const result = loadTask(tmpDir, "001");
    expect(result).toBe(null);
  });

  it("loadGoals skips corrupted files and returns valid goals", () => {
    ensureTasksDir(tmpDir);
    const goalsDir = join(tmpDir, ".tasks", "goals");
    writeFileSync(
      join(goalsDir, "01-valid.json"),
      JSON.stringify({
        id: "01",
        title: "Valid goal",
        description: "",
        status: "todo",
        acceptance: "",
        priority: 1,
      }) + "\n",
    );
    writeFileSync(join(goalsDir, "02-broken.json"), "{{bad json");

    const goals = loadGoals(tmpDir);
    expect(goals.length).toBe(1);
    expect(goals[0]!.id).toBe("01");
  });

  it("loadGoal returns null for corrupted file", () => {
    ensureTasksDir(tmpDir);
    writeFileSync(join(tmpDir, ".tasks", "goals", "01-broken.json"), "nope");
    const result = loadGoal(tmpDir, "01");
    expect(result).toBe(null);
  });

  it("loadMission returns null for corrupted file", () => {
    ensureTasksDir(tmpDir);
    writeFileSync(join(tmpDir, ".tasks", "mission.json"), "not json");
    const result = loadMission(tmpDir);
    expect(result).toBe(null);
  });
});

describe("corrupted file resilience", () => {
  it("loadTasks skips corrupted files and returns valid tasks", () => {
    ensureTasksDir(tmpDir);
    const tasksDir = join(tmpDir, ".tasks", "tasks");
    // Write one valid task
    writeFileSync(
      join(tasksDir, "001-valid.json"),
      JSON.stringify({
        id: "001",
        title: "Valid task",
        description: "",
        goal: null,
        status: "todo",
        assignee: null,
        priority: 1,
        created: "2026-01-01T00:00:00Z",
        updated: "2026-01-01T00:00:00Z",

        tags: [],
        proof: null,
      }) + "\n",
    );
    // Write a corrupted file
    writeFileSync(join(tasksDir, "002-broken.json"), "{ not valid json !!!");

    const tasks = loadTasks(tmpDir);
    assert.strictEqual(tasks.length, 1);
    assert.strictEqual(tasks[0]!.id, "001");
  });

  it("loadTask returns null for corrupted file", () => {
    ensureTasksDir(tmpDir);
    writeFileSync(join(tmpDir, ".tasks", "tasks", "001-broken.json"), "corrupt");
    const result = loadTask(tmpDir, "001");
    assert.strictEqual(result, null);
  });

  it("loadGoals skips corrupted files and returns valid goals", () => {
    ensureTasksDir(tmpDir);
    const goalsDir = join(tmpDir, ".tasks", "goals");
    writeFileSync(
      join(goalsDir, "01-valid.json"),
      JSON.stringify({
        id: "01",
        title: "Valid goal",
        description: "",
        status: "todo",
        acceptance: "",
        priority: 1,
      }) + "\n",
    );
    writeFileSync(join(goalsDir, "02-broken.json"), "{{bad json");

    const goals = loadGoals(tmpDir);
    assert.strictEqual(goals.length, 1);
    assert.strictEqual(goals[0]!.id, "01");
  });

  it("loadGoal returns null for corrupted file", () => {
    ensureTasksDir(tmpDir);
    writeFileSync(join(tmpDir, ".tasks", "goals", "01-broken.json"), "nope");
    const result = loadGoal(tmpDir, "01");
    assert.strictEqual(result, null);
  });

  it("loadMission returns null for corrupted file", () => {
    ensureTasksDir(tmpDir);
    writeFileSync(join(tmpDir, ".tasks", "mission.json"), "not json");
    const result = loadMission(tmpDir);
    assert.strictEqual(result, null);
  });
});

describe("normalizer snapshots", () => {
  it("normalizeTask produces exact default shape", () => {
    const raw = {
      id: "001",
      title: "Test",
      description: "desc",
      goal: null,
      status: "todo",
      assignee: null,
      priority: 1,
      created: "2026-01-01T00:00:00Z",
      updated: "2026-01-01T00:00:00Z",

      tags: [],
      proof: null,
    };
    const result = normalizeTask(raw as Record<string, unknown>);
    assert.deepStrictEqual(result, {
      id: "001",
      title: "Test",
      description: "desc",
      goal: null,
      status: "todo",
      assignee: null,
      priority: 1,
      created: "2026-01-01T00:00:00Z",
      updated: "2026-01-01T00:00:00Z",

      tags: [],
      proof: null,
      retryCount: 0,
      maxRetries: 5,
      lastError: null,
      nextRetryAt: null,
      depends_on: [],
      milestone: null,
      specialty: null,
      fulfills: [],
      discoveredIssues: [],
      salientSummary: null,
    });
  });

  it("normalizeTask migrates proof.note to proof.notes", () => {
    const raw = {
      id: "001",
      title: "Test",
      description: "",
      goal: null,
      status: "todo",
      assignee: null,
      priority: 1,
      created: "2026-01-01T00:00:00Z",
      updated: "2026-01-01T00:00:00Z",

      tags: [],
      proof: { note: "legacy note" },
    };
    const result = normalizeTask(raw as Record<string, unknown>);
    assert.strictEqual(result.proof?.notes, "legacy note");
    assert.strictEqual((result.proof as Record<string, unknown>).note, undefined);
  });

  it("normalizeGoal defaults missing fields", () => {
    const raw = {
      id: "01",
      title: "G",
      description: "",
      status: "todo",
      acceptance: "",
      priority: 1,
    };
    const result = normalizeGoal(raw as Record<string, unknown>);
    assert.strictEqual(result.assignee, null);
    assert.strictEqual(result.specialty, null);
    assert.strictEqual(result.milestone, null);
    assert.strictEqual(result.created, "1970-01-01T00:00:00.000Z");
    assert.strictEqual(result.updated, "1970-01-01T00:00:00.000Z");
  });

  it("normalizeMission defaults missing timestamps", () => {
    const raw = { title: "M", description: "desc" };
    const result = normalizeMission(raw as Record<string, unknown>);
    assert.deepStrictEqual(result, {
      title: "M",
      description: "desc",
      status: "active",
      branch: null,
      milestones: [],
      created: "1970-01-01T00:00:00.000Z",
      updated: "1970-01-01T00:00:00.000Z",
    });
  });

  it("normalizeTask preserves explicit retry values", () => {
    const raw = {
      id: "001",
      title: "Test",
      description: "",
      goal: null,
      status: "todo",
      assignee: null,
      priority: 1,
      created: "2026-01-01T00:00:00Z",
      updated: "2026-01-01T00:00:00Z",

      tags: [],
      proof: null,
      retryCount: 3,
      maxRetries: 10,
      lastError: "timeout",
      nextRetryAt: "2026-01-02T00:00:00Z",
      depends_on: ["002"],
    };
    const result = normalizeTask(raw as Record<string, unknown>);
    assert.strictEqual(result.retryCount, 3);
    assert.strictEqual(result.maxRetries, 10);
    assert.strictEqual(result.lastError, "timeout");
    assert.strictEqual(result.nextRetryAt, "2026-01-02T00:00:00Z");
    assert.deepStrictEqual(result.depends_on, ["002"]);
  });
});

describe("detectCycle", () => {
  function makeMinimalTask(id: string, deps: string[] = []): Task {
    const now = new Date().toISOString();
    return {
      id,
      title: `Task ${id}`,
      description: "",
      goal: null,
      status: "todo",
      assignee: null,
      priority: 2,
      created: now,
      updated: now,

      tags: [],
      proof: null,
      depends_on: deps,
      retryCount: 0,
      maxRetries: 5,
      lastError: null,
      nextRetryAt: null,
    };
  }

  it("detects A -> B -> A cycle", () => {
    ensureTasksDir(tmpDir);
    saveTask(tmpDir, makeMinimalTask("001", ["002"]));
    saveTask(tmpDir, makeMinimalTask("002"));

    const cycle = detectCycle(tmpDir, "002", ["001"]);
    expect(cycle).toEqual(["002", "001", "002"]);
  });

  it("detects A -> B -> C -> A cycle", () => {
    ensureTasksDir(tmpDir);
    saveTask(tmpDir, makeMinimalTask("001", ["002"]));
    saveTask(tmpDir, makeMinimalTask("002", ["003"]));
    saveTask(tmpDir, makeMinimalTask("003"));

    const cycle = detectCycle(tmpDir, "003", ["001"]);
    expect(cycle).toEqual(["003", "001", "002", "003"]);
  });

  it("returns null for valid DAG", () => {
    ensureTasksDir(tmpDir);
    saveTask(tmpDir, makeMinimalTask("001"));
    saveTask(tmpDir, makeMinimalTask("002", ["001"]));
    saveTask(tmpDir, makeMinimalTask("003"));

    const cycle = detectCycle(tmpDir, "003", ["001"]);
    expect(cycle).toBeNull();
  });
});
