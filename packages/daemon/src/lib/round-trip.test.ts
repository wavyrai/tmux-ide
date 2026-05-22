import { describe, it, beforeEach, afterEach, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureTasksDir,
  saveMission,
  saveGoal,
  saveTask,
  loadTask,
  loadGoal,
  loadMission,
  loadTasksForGoal,
  type Mission,
  type Goal,
  type Task,
} from "./task-store.ts";
import { appendEvent, readEvents } from "./event-log.ts";
import {
  buildProjectDetail,
  computeStats,
  computeGoalProgress,
  type SessionInfo,
} from "../command-center/discovery.ts";
import type { PaneInfo } from "../widgets/lib/pane-comms.ts";
import { tagContent, extractMarks, calculateStats } from "./authorship.ts";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "tmux-ide-roundtrip-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("task lifecycle round-trip", () => {
  it("creates, dispatches, completes a task with events", () => {
    ensureTasksDir(tmpDir);

    const mission: Mission = {
      title: "Build feature X",
      description: "End-to-end feature delivery",
      status: "active",
      branch: null,
      milestones: [],
      created: "2026-03-21T10:00:00Z",
      updated: "2026-03-21T10:00:00Z",
    };
    saveMission(tmpDir, mission);

    const goal: Goal = {
      id: "01",
      title: "Backend API",
      description: "REST endpoints",
      status: "in-progress",
      acceptance: "All endpoints return 200",
      priority: 1,
      created: "2026-03-21T10:00:00Z",
      updated: "2026-03-21T10:00:00Z",
      assignee: null,
      specialty: null,
      milestone: null,
    };
    saveGoal(tmpDir, goal);

    const task: Task = {
      id: "001",
      title: "Implement GET /users",
      description: "List users endpoint",
      goal: "01",
      status: "todo",
      assignee: null,
      priority: 1,
      created: "2026-03-21T10:00:00Z",
      updated: "2026-03-21T10:00:00Z",

      tags: ["backend"],
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

    // Simulate dispatch
    const loaded = loadTask(tmpDir, "001")!;
    expect(loaded).toBeTruthy();
    loaded.assignee = "François";
    loaded.status = "in-progress";
    loaded.updated = "2026-03-21T10:05:00Z";
    saveTask(tmpDir, loaded);

    appendEvent(tmpDir, {
      timestamp: "2026-03-21T10:05:00Z",
      type: "dispatch",
      taskId: "001",
      agent: "François",
      message: 'Dispatched "Implement GET /users" to François',
    });

    // Simulate completion
    const inProgress = loadTask(tmpDir, "001")!;
    expect(inProgress.status).toBe("in-progress");
    expect(inProgress.assignee).toBe("François");
    inProgress.status = "done";
    inProgress.proof = { tests: { passed: 1, total: 1 } };
    inProgress.updated = "2026-03-21T10:30:00Z";
    saveTask(tmpDir, inProgress);

    appendEvent(tmpDir, {
      timestamp: "2026-03-21T10:30:00Z",
      type: "completion",
      taskId: "001",
      agent: "François",
      message: 'Task "Implement GET /users" completed',
    });

    // Verify final state
    const done = loadTask(tmpDir, "001")!;
    expect(done.status).toBe("done");
    expect(done.proof).toEqual({ tests: { passed: 1, total: 1 } });
    expect(done.assignee).toBe("François");

    const events = readEvents(tmpDir);
    expect(events.length).toBe(2);
    expect(events[0]!.type).toBe("dispatch");
    expect(events[1]!.type).toBe("completion");
    expect(events[0]!.taskId).toBe("001");
    expect(events[1]!.taskId).toBe("001");

    const goalTasks = loadTasksForGoal(tmpDir, "01");
    expect(goalTasks.length).toBe(1);
    expect(goalTasks[0]!.status).toBe("done");
  });
});

describe("discovery round-trip", () => {
  it("builds project detail from on-disk data with mock panes", () => {
    ensureTasksDir(tmpDir);

    const mission: Mission = {
      title: "Test Project",
      description: "Integration test",
      status: "active",
      branch: null,
      milestones: [],
      created: "2026-03-21T10:00:00Z",
      updated: "2026-03-21T10:00:00Z",
    };
    saveMission(tmpDir, mission);

    const goal: Goal = {
      id: "01",
      title: "Frontend",
      description: "Build UI",
      status: "in-progress",
      acceptance: "UI renders",
      priority: 1,
      created: "2026-03-21T10:00:00Z",
      updated: "2026-03-21T10:00:00Z",
      assignee: "François",
      specialty: "frontend",
    };
    saveGoal(tmpDir, goal);

    const task: Task = {
      id: "001",
      title: "Build header",
      description: "",
      goal: "01",
      status: "in-progress",
      assignee: "François",
      priority: 1,
      created: "2026-03-21T10:00:00Z",
      updated: "2026-03-21T10:05:00Z",

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

    const mockPane: PaneInfo = {
      id: "%1",
      index: 0,
      title: "Agent 1",
      currentCommand: "claude",
      width: 80,
      height: 24,
      active: false,
      role: null,
      name: null,
      type: null,
    };

    const info: SessionInfo = {
      name: "test-session",
      dir: tmpDir,
      mission,
      goals: [goal],
      tasks: [task],
      panes: [mockPane],
    };

    const detail = buildProjectDetail(info);
    expect(detail.session).toBe("test-session");
    expect(detail.dir).toBe(tmpDir);
    expect(detail.mission).toBeTruthy();
    expect(detail.mission!.created).toBe("2026-03-21T10:00:00Z");
    expect(detail.mission!.updated).toBe("2026-03-21T10:00:00Z");
    expect(detail.tasks.length).toBe(1);
    expect(detail.tasks[0]!.created).toBe("2026-03-21T10:00:00Z");
    expect(detail.tasks[0]!.updated).toBe("2026-03-21T10:05:00Z");
    expect(detail.goals.length).toBe(1);
    expect(detail.goals[0]!.assignee).toBe("François");
    expect(detail.goals[0]!.specialty).toBe("frontend");
    expect(detail.agents.length).toBe(1);
    expect(detail.agents[0]!.isBusy).toBe(false);

    const stats = computeStats(info);
    expect(stats.totalTasks).toBe(1);
    expect(stats.doneTasks).toBe(0);
    expect(stats.agents).toBe(1);

    const progress = computeGoalProgress([goal], [task]);
    expect(progress.length).toBe(1);
    expect(progress[0]!.progress).toBe(0);
  });
});

describe("normalizer backward compatibility", () => {
  it("fills defaults for legacy task missing retry and depends_on fields", () => {
    ensureTasksDir(tmpDir);
    writeFileSync(
      join(tmpDir, ".tasks", "tasks", "001-legacy.json"),
      JSON.stringify({
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
        proof: { note: "old note format" },
      }) + "\n",
    );

    const task = loadTask(tmpDir, "001")!;
    expect(task).toBeTruthy();
    expect(task.retryCount).toBe(0);
    expect(task.maxRetries).toBe(5);
    expect(task.lastError).toBe(null);
    expect(task.nextRetryAt).toBe(null);
    expect(task.depends_on).toEqual([]);
    expect(task.proof!.notes).toBe("old note format");
  });

  it("fills defaults for legacy goal missing assignee, specialty, timestamps", () => {
    ensureTasksDir(tmpDir);
    writeFileSync(
      join(tmpDir, ".tasks", "goals", "01-legacy.json"),
      JSON.stringify({
        id: "01",
        title: "Legacy goal",
        description: "",
        status: "todo",
        acceptance: "",
        priority: 1,
      }) + "\n",
    );

    const goal = loadGoal(tmpDir, "01")!;
    expect(goal).toBeTruthy();
    expect(goal.assignee).toBe(null);
    expect(goal.specialty).toBe(null);
    expect(goal.created).toBe("1970-01-01T00:00:00.000Z");
    expect(goal.updated).toBe("1970-01-01T00:00:00.000Z");
  });

  it("fills defaults for legacy mission missing timestamps", () => {
    ensureTasksDir(tmpDir);
    writeFileSync(
      join(tmpDir, ".tasks", "mission.json"),
      JSON.stringify({
        title: "Legacy mission",
        description: "Old format",
      }) + "\n",
    );

    const mission = loadMission(tmpDir)!;
    expect(mission).toBeTruthy();
    expect(mission.title).toBe("Legacy mission");
    expect(mission.created).toBe("1970-01-01T00:00:00.000Z");
    expect(mission.updated).toBe("1970-01-01T00:00:00.000Z");
  });
});

describe("authorship round-trip", () => {
  it("tags content, extracts marks, and calculates stats", () => {
    const original = "# Plan\nSome content here\n\n## Details\nMore text";

    const tagged = tagContent(original, "ai:Claude");

    const { content, marks } = extractMarks(tagged);
    expect(content).toBe(original);
    expect(marks).toBeTruthy();
    expect(marks.marks).toBeTruthy();

    const markList = Object.values(marks.marks);
    expect(markList.length > 0).toBeTruthy();
    const aiMark = markList.find((m) => m.by === "ai:Claude");
    expect(aiMark).toBeTruthy();

    const stats = calculateStats(marks.marks);
    expect(stats.aiPercent > 0).toBeTruthy();
    expect(stats.totalChars > 0).toBeTruthy();
    expect(stats.humanPercent).toBe(0);
  });
});
