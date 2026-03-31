import { describe, it, beforeEach, afterEach, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeMetrics,
  loadMetrics,
  saveMetrics,
  appendMissionHistory,
  loadMissionHistory,
  type MetricsSnapshot,
} from "./metrics.ts";
import { ensureTasksDir, saveTask, saveMission } from "./task-store.ts";
import { appendEvent } from "./event-log.ts";
import { makeTask, makeMission } from "../__tests__/support.ts";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "tmux-ide-metrics-test-"));
  ensureTasksDir(tmpDir);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("computeMetrics", () => {
  it("calculates task completion rate", () => {
    saveTask(tmpDir, makeTask({ id: "001", status: "done", assignee: "Agent 1" }));
    saveTask(tmpDir, makeTask({ id: "002", status: "done", assignee: "Agent 1" }));
    saveTask(tmpDir, makeTask({ id: "003", status: "todo" }));

    const metrics = computeMetrics(tmpDir);
    expect(metrics.tasks.total).toBe(3);
    expect(metrics.tasks.completed).toBe(2);
    expect(metrics.tasks.completionRate).toBeCloseTo(0.67, 1);
  });

  it("calculates retry rate", () => {
    saveTask(tmpDir, makeTask({ id: "001", status: "done", retryCount: 2 }));
    saveTask(tmpDir, makeTask({ id: "002", status: "done", retryCount: 0 }));

    const metrics = computeMetrics(tmpDir);
    expect(metrics.tasks.retried).toBe(1);
    expect(metrics.tasks.retryRate).toBe(0.5);
  });

  it("computes agent utilization from heartbeat events", () => {
    appendEvent(tmpDir, {
      timestamp: "2026-01-01T00:00:00Z",
      type: "agent_heartbeat",
      message: "agents: Alice=busy, Bob=idle",
    });
    appendEvent(tmpDir, {
      timestamp: "2026-01-01T00:05:00Z",
      type: "agent_heartbeat",
      message: "agents: Alice=busy, Bob=busy",
    });
    appendEvent(tmpDir, {
      timestamp: "2026-01-01T00:10:00Z",
      type: "agent_heartbeat",
      message: "agents: Alice=idle, Bob=idle",
    });

    const metrics = computeMetrics(tmpDir);
    const alice = metrics.agents.find((a) => a.name === "Alice");
    const bob = metrics.agents.find((a) => a.name === "Bob");

    expect(alice).toBeTruthy();
    expect(alice!.utilization).toBeCloseTo(0.67, 1); // 2/3 busy
    expect(bob).toBeTruthy();
    expect(bob!.utilization).toBeCloseTo(0.33, 1); // 1/3 busy
  });

  it("includes milestone metrics", () => {
    saveMission(tmpDir, makeMission({
      milestones: [
        { id: "M1", title: "Phase 1", description: "", status: "done", order: 1, created: "2026-01-01T00:00:00Z", updated: "2026-01-01T01:00:00Z" },
        { id: "M2", title: "Phase 2", description: "", status: "active", order: 2, created: "2026-01-01T00:00:00Z", updated: "2026-01-01T00:00:00Z" },
      ],
    }));
    saveTask(tmpDir, makeTask({ id: "001", milestone: "M1", status: "done" }));
    saveTask(tmpDir, makeTask({ id: "002", milestone: "M2", status: "todo" }));

    const metrics = computeMetrics(tmpDir);
    expect(metrics.tasks.byMilestone.length).toBe(2);
    expect(metrics.tasks.byMilestone[0]!.id).toBe("M1");
    expect(metrics.tasks.byMilestone[0]!.completedCount).toBe(1);
    expect(metrics.mission.milestonesCompleted).toBe(1);
  });

  it("handles empty project", () => {
    const metrics = computeMetrics(tmpDir);
    expect(metrics.tasks.total).toBe(0);
    expect(metrics.tasks.completionRate).toBe(0);
    expect(metrics.agents.length).toBe(0);
    expect(metrics.timeline.length).toBe(0);
  });

  it("generates timeline from events", () => {
    const baseTime = new Date("2026-01-01T00:00:00Z").getTime();
    appendEvent(tmpDir, {
      timestamp: new Date(baseTime).toISOString(),
      type: "dispatch",
      taskId: "001",
      agent: "Agent 1",
      message: "Dispatched",
    });
    appendEvent(tmpDir, {
      timestamp: new Date(baseTime + 10 * 60 * 1000).toISOString(),
      type: "completion",
      taskId: "001",
      agent: "Agent 1",
      message: "Completed",
    });

    const metrics = computeMetrics(tmpDir);
    expect(metrics.timeline.length).toBeGreaterThan(0);
  });
});

describe("saveMetrics / loadMetrics", () => {
  it("round-trips metrics snapshot", () => {
    const snapshot: MetricsSnapshot = {
      session: { startedAt: "2026-01-01T00:00:00Z", durationMs: 60000, status: "active", agentCount: 2 },
      tasks: { total: 5, completed: 3, failed: 0, retried: 1, completionRate: 0.6, retryRate: 0.2, avgDurationMs: 5000, medianDurationMs: 4000, p90DurationMs: 8000, byMilestone: [] },
      agents: [],
      mission: { title: "Test", status: "active", milestonesCompleted: 1, validationPassRate: 1, wallClockMs: 60000 },
      timeline: [],
    };
    saveMetrics(tmpDir, snapshot);
    const loaded = loadMetrics(tmpDir);
    expect(loaded).toEqual(snapshot);
  });

  it("returns null when no file", () => {
    expect(loadMetrics(tmpDir)).toBeNull();
  });
});

describe("appendMissionHistory / loadMissionHistory", () => {
  it("appends and loads mission summaries", () => {
    const mission = makeMission({ title: "Mission A", status: "complete" });
    const tasks = [
      makeTask({ id: "001", status: "done", assignee: "Agent 1" }),
      makeTask({ id: "002", status: "done", assignee: "Agent 2" }),
    ];

    appendMissionHistory(tmpDir, mission, tasks);

    const history = loadMissionHistory(tmpDir);
    expect(history.length).toBe(1);
    expect(history[0]!.title).toBe("Mission A");
    expect(history[0]!.taskCount).toBe(2);
    expect(history[0]!.agentCount).toBe(2);
  });

  it("appends multiple missions", () => {
    appendMissionHistory(tmpDir, makeMission({ title: "M1" }), []);
    appendMissionHistory(tmpDir, makeMission({ title: "M2" }), [makeTask()]);

    const history = loadMissionHistory(tmpDir);
    expect(history.length).toBe(2);
    expect(history[0]!.title).toBe("M1");
    expect(history[1]!.title).toBe("M2");
  });

  it("returns empty array when no history", () => {
    expect(loadMissionHistory(tmpDir)).toEqual([]);
  });
});
