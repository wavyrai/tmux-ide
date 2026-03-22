import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
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
      branch: null,
      tags: ["backend"],
      proof: null,
      retryCount: 0,
      maxRetries: 5,
      lastError: null,
      nextRetryAt: null,
      depends_on: [],
    };
    saveTask(tmpDir, task);

    // Simulate dispatch
    const loaded = loadTask(tmpDir, "001")!;
    assert.ok(loaded);
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
    assert.strictEqual(inProgress.status, "in-progress");
    assert.strictEqual(inProgress.assignee, "François");
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
    assert.strictEqual(done.status, "done");
    assert.deepStrictEqual(done.proof, { tests: { passed: 1, total: 1 } });
    assert.strictEqual(done.assignee, "François");

    const events = readEvents(tmpDir);
    assert.strictEqual(events.length, 2);
    assert.strictEqual(events[0]!.type, "dispatch");
    assert.strictEqual(events[1]!.type, "completion");
    assert.strictEqual(events[0]!.taskId, "001");
    assert.strictEqual(events[1]!.taskId, "001");

    const goalTasks = loadTasksForGoal(tmpDir, "01");
    assert.strictEqual(goalTasks.length, 1);
    assert.strictEqual(goalTasks[0]!.status, "done");
  });
});

describe("discovery round-trip", () => {
  it("builds project detail from on-disk data with mock panes", () => {
    ensureTasksDir(tmpDir);

    const mission: Mission = {
      title: "Test Project",
      description: "Integration test",
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
      branch: null,
      tags: [],
      proof: null,
      retryCount: 0,
      maxRetries: 5,
      lastError: null,
      nextRetryAt: null,
      depends_on: [],
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
    assert.strictEqual(detail.session, "test-session");
    assert.strictEqual(detail.dir, tmpDir);
    assert.ok(detail.mission);
    assert.strictEqual(detail.mission!.created, "2026-03-21T10:00:00Z");
    assert.strictEqual(detail.mission!.updated, "2026-03-21T10:00:00Z");
    assert.strictEqual(detail.tasks.length, 1);
    assert.strictEqual(detail.tasks[0]!.created, "2026-03-21T10:00:00Z");
    assert.strictEqual(detail.tasks[0]!.updated, "2026-03-21T10:05:00Z");
    assert.strictEqual(detail.goals.length, 1);
    assert.strictEqual(detail.goals[0]!.assignee, "François");
    assert.strictEqual(detail.goals[0]!.specialty, "frontend");
    assert.strictEqual(detail.agents.length, 1);
    assert.strictEqual(detail.agents[0]!.isBusy, false);

    const stats = computeStats(info);
    assert.strictEqual(stats.totalTasks, 1);
    assert.strictEqual(stats.doneTasks, 0);
    assert.strictEqual(stats.agents, 1);

    const progress = computeGoalProgress([goal], [task]);
    assert.strictEqual(progress.length, 1);
    assert.strictEqual(progress[0]!.progress, 0);
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
        branch: null,
        tags: [],
        proof: { note: "old note format" },
      }) + "\n",
    );

    const task = loadTask(tmpDir, "001")!;
    assert.ok(task);
    assert.strictEqual(task.retryCount, 0);
    assert.strictEqual(task.maxRetries, 5);
    assert.strictEqual(task.lastError, null);
    assert.strictEqual(task.nextRetryAt, null);
    assert.deepStrictEqual(task.depends_on, []);
    assert.strictEqual(task.proof!.notes, "old note format");
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
    assert.ok(goal);
    assert.strictEqual(goal.assignee, null);
    assert.strictEqual(goal.specialty, null);
    assert.strictEqual(goal.created, "1970-01-01T00:00:00.000Z");
    assert.strictEqual(goal.updated, "1970-01-01T00:00:00.000Z");
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
    assert.ok(mission);
    assert.strictEqual(mission.title, "Legacy mission");
    assert.strictEqual(mission.created, "1970-01-01T00:00:00.000Z");
    assert.strictEqual(mission.updated, "1970-01-01T00:00:00.000Z");
  });
});

describe("authorship round-trip", () => {
  it("tags content, extracts marks, and calculates stats", () => {
    const original = "# Plan\nSome content here\n\n## Details\nMore text";

    const tagged = tagContent(original, "ai:Claude");

    const { content, marks } = extractMarks(tagged);
    assert.strictEqual(content, original);
    assert.ok(marks);
    assert.ok(marks.marks);

    const markList = Object.values(marks.marks);
    assert.ok(markList.length > 0);
    const aiMark = markList.find((m) => m.by === "ai:Claude");
    assert.ok(aiMark, "should have at least one mark by ai:Claude");

    const stats = calculateStats(marks.marks);
    assert.ok(stats.aiPercent > 0, `aiPercent should be > 0, got ${stats.aiPercent}`);
    assert.ok(stats.totalChars > 0, `totalChars should be > 0, got ${stats.totalChars}`);
    assert.strictEqual(stats.humanPercent, 0);
  });
});
