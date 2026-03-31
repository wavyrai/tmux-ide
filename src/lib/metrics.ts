import { join } from "node:path";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  renameSync,
  mkdirSync,
} from "node:fs";
import { loadTasks, loadMission, type Task, type Mission } from "./task-store.ts";
import { readEvents } from "./event-log.ts";

// --- Interfaces ---

export interface AgentMetrics {
  name: string;
  totalTimeMs: number;
  activeTimeMs: number;
  idleTimeMs: number;
  taskCount: number;
  retryCount: number;
  utilization: number;
  specialties: string[];
}

export interface MilestoneMetrics {
  id: string;
  title: string;
  status: string;
  taskCount: number;
  completedCount: number;
  durationMs: number;
}

export interface TimelineEntry {
  timestamp: string;
  completedTasks: number;
  activeTasks: number;
  busyAgents: number;
  idleAgents: number;
}

export interface MetricsSnapshot {
  session: {
    startedAt: string | null;
    durationMs: number;
    status: string;
    agentCount: number;
  };
  tasks: {
    total: number;
    completed: number;
    failed: number;
    retried: number;
    completionRate: number;
    retryRate: number;
    avgDurationMs: number;
    medianDurationMs: number;
    p90DurationMs: number;
    byMilestone: MilestoneMetrics[];
  };
  agents: AgentMetrics[];
  mission: {
    title: string | null;
    status: string | null;
    milestonesCompleted: number;
    validationPassRate: number;
    wallClockMs: number;
  };
  timeline: TimelineEntry[];
}

export interface MissionSummary {
  title: string;
  status: string;
  completedAt: string;
  wallClockMs: number;
  taskCount: number;
  completionRate: number;
  agentCount: number;
  milestonesCompleted: number;
}

// --- Helpers ---

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)]!;
}

function median(sorted: number[]): number {
  return percentile(sorted, 50);
}

// --- Core computation ---

export function computeMetrics(dir: string): MetricsSnapshot {
  const events = readEvents(dir);
  const tasks = loadTasks(dir);
  const mission = loadMission(dir);

  // Session info
  const sessionStart = events.find((e) => e.type === "session_start");
  const startedAt = sessionStart?.timestamp ?? (events[0]?.timestamp ?? null);
  const now = Date.now();
  const durationMs = startedAt ? now - new Date(startedAt).getTime() : 0;

  // Task metrics
  const completed = tasks.filter((t) => t.status === "done").length;
  const failed = tasks.filter((t) => t.status === "review" && t.lastError).length;
  const retried = tasks.filter((t) => t.retryCount > 0).length;
  const completionRate = tasks.length > 0 ? completed / tasks.length : 0;
  const retryRate = tasks.length > 0 ? retried / tasks.length : 0;

  // Task durations from completion events with durationMs
  const durations: number[] = [];
  for (const evt of events) {
    if (evt.type === "completion" && (evt as Record<string, unknown>).durationMs) {
      durations.push((evt as Record<string, unknown>).durationMs as number);
    }
  }
  durations.sort((a, b) => a - b);

  // Per-milestone metrics
  const byMilestone: MilestoneMetrics[] = (mission?.milestones ?? []).map((m) => {
    const mTasks = tasks.filter((t) => t.milestone === m.id);
    const mCompleted = mTasks.filter((t) => t.status === "done").length;
    // Estimate milestone duration from task timestamps
    const timestamps = mTasks
      .filter((t) => t.status === "done")
      .map((t) => new Date(t.updated).getTime());
    const mDuration = timestamps.length > 0 ? Math.max(...timestamps) - Math.min(...timestamps) : 0;
    return {
      id: m.id,
      title: m.title,
      status: m.status,
      taskCount: mTasks.length,
      completedCount: mCompleted,
      durationMs: mDuration,
    };
  });

  // Agent metrics from heartbeat events
  const agentBusySamples = new Map<string, { busy: number; idle: number; total: number }>();
  const agentTaskCounts = new Map<string, number>();
  const agentRetryCounts = new Map<string, number>();
  const agentSpecialties = new Map<string, Set<string>>();

  for (const evt of events) {
    if (evt.type === "agent_heartbeat" && evt.message) {
      // Parse heartbeat: "agents: Name1=busy, Name2=idle"
      const parts = evt.message.replace("agents: ", "").split(", ");
      for (const part of parts) {
        const [name, status] = part.split("=");
        if (!name || !status) continue;
        const entry = agentBusySamples.get(name) ?? { busy: 0, idle: 0, total: 0 };
        entry.total++;
        if (status === "busy") entry.busy++;
        else entry.idle++;
        agentBusySamples.set(name, entry);
      }
    }
  }

  // Count tasks and retries per agent
  for (const task of tasks) {
    if (task.assignee) {
      agentTaskCounts.set(task.assignee, (agentTaskCounts.get(task.assignee) ?? 0) + 1);
      if (task.retryCount > 0) {
        agentRetryCounts.set(
          task.assignee,
          (agentRetryCounts.get(task.assignee) ?? 0) + task.retryCount,
        );
      }
      if (task.specialty) {
        const specs = agentSpecialties.get(task.assignee) ?? new Set();
        specs.add(task.specialty);
        agentSpecialties.set(task.assignee, specs);
      }
    }
  }

  const agentNames = new Set([...agentBusySamples.keys(), ...agentTaskCounts.keys()]);
  const agents: AgentMetrics[] = [...agentNames].map((name) => {
    const samples = agentBusySamples.get(name) ?? { busy: 0, idle: 0, total: 0 };
    const utilization = samples.total > 0 ? samples.busy / samples.total : 0;
    const estimatedTotalMs = durationMs;
    return {
      name,
      totalTimeMs: estimatedTotalMs,
      activeTimeMs: Math.round(estimatedTotalMs * utilization),
      idleTimeMs: Math.round(estimatedTotalMs * (1 - utilization)),
      taskCount: agentTaskCounts.get(name) ?? 0,
      retryCount: agentRetryCounts.get(name) ?? 0,
      utilization: Math.round(utilization * 100) / 100,
      specialties: [...(agentSpecialties.get(name) ?? [])],
    };
  });

  // Mission metrics
  const milestonesCompleted = (mission?.milestones ?? []).filter(
    (m) => m.status === "done",
  ).length;
  const missionWallClock = mission?.created
    ? now - new Date(mission.created).getTime()
    : 0;

  // Validation pass rate (simple estimate from completion events)
  const validationEvents = events.filter(
    (e) => e.type === "milestone_complete" || e.type === "validation_failed",
  );
  const passEvents = validationEvents.filter((e) => e.type === "milestone_complete").length;
  const validationPassRate =
    validationEvents.length > 0 ? passEvents / validationEvents.length : 1;

  // Timeline: sample at 5-minute intervals
  const timeline: TimelineEntry[] = [];
  if (events.length > 0) {
    const firstTs = new Date(events[0]!.timestamp).getTime();
    const interval = 5 * 60 * 1000;
    for (let t = firstTs; t <= now; t += interval) {
      const cutoff = new Date(t).toISOString();
      const completedByNow = events.filter(
        (e) => e.type === "completion" && e.timestamp <= cutoff,
      ).length;
      const activeByNow = events.filter(
        (e) => e.type === "dispatch" && e.timestamp <= cutoff,
      ).length - completedByNow;

      // Last heartbeat before this timestamp
      const heartbeat = events
        .filter((e) => e.type === "agent_heartbeat" && e.timestamp <= cutoff)
        .pop();
      let busyAgents = 0;
      let idleAgents = 0;
      if (heartbeat?.message) {
        const parts = heartbeat.message.replace("agents: ", "").split(", ");
        for (const p of parts) {
          if (p.includes("=busy")) busyAgents++;
          else if (p.includes("=idle")) idleAgents++;
        }
      }

      timeline.push({
        timestamp: cutoff,
        completedTasks: completedByNow,
        activeTasks: Math.max(0, activeByNow),
        busyAgents,
        idleAgents,
      });

      if (timeline.length >= 200) break;
    }
  }

  return {
    session: {
      startedAt,
      durationMs,
      status: mission?.status ?? "unknown",
      agentCount: agents.length,
    },
    tasks: {
      total: tasks.length,
      completed,
      failed,
      retried,
      completionRate: Math.round(completionRate * 100) / 100,
      retryRate: Math.round(retryRate * 100) / 100,
      avgDurationMs: durations.length > 0
        ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
        : 0,
      medianDurationMs: median(durations),
      p90DurationMs: percentile(durations, 90),
      byMilestone,
    },
    agents,
    mission: {
      title: mission?.title ?? null,
      status: mission?.status ?? null,
      milestonesCompleted,
      validationPassRate: Math.round(validationPassRate * 100) / 100,
      wallClockMs: missionWallClock,
    },
    timeline,
  };
}

// --- Persistence ---

export function loadMetrics(dir: string): MetricsSnapshot | null {
  const path = join(dir, ".tasks", "metrics.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as MetricsSnapshot;
  } catch {
    return null;
  }
}

export function saveMetrics(dir: string, snapshot: MetricsSnapshot): void {
  const tasksDir = join(dir, ".tasks");
  if (!existsSync(tasksDir)) mkdirSync(tasksDir, { recursive: true });
  const path = join(tasksDir, "metrics.json");
  const tmpPath = path + ".tmp";
  writeFileSync(tmpPath, JSON.stringify(snapshot, null, 2) + "\n");
  renameSync(tmpPath, path);
}

export function computeAndSaveMetrics(dir: string): MetricsSnapshot {
  const snapshot = computeMetrics(dir);
  saveMetrics(dir, snapshot);
  return snapshot;
}

export function appendMissionHistory(dir: string, mission: Mission, tasks: Task[]): void {
  const tasksDir = join(dir, ".tasks");
  if (!existsSync(tasksDir)) mkdirSync(tasksDir, { recursive: true });
  const path = join(tasksDir, "metrics-history.jsonl");
  const completed = tasks.filter((t) => t.status === "done").length;
  const agentNames = new Set(tasks.filter((t) => t.assignee).map((t) => t.assignee!));
  const summary: MissionSummary = {
    title: mission.title,
    status: mission.status,
    completedAt: new Date().toISOString(),
    wallClockMs: mission.created ? Date.now() - new Date(mission.created).getTime() : 0,
    taskCount: tasks.length,
    completionRate: tasks.length > 0 ? Math.round((completed / tasks.length) * 100) / 100 : 0,
    agentCount: agentNames.size,
    milestonesCompleted: mission.milestones.filter((m) => m.status === "done").length,
  };
  appendFileSync(path, JSON.stringify(summary) + "\n");
}

export function loadMissionHistory(dir: string): MissionSummary[] {
  const path = join(dir, ".tasks", "metrics-history.jsonl");
  if (!existsSync(path)) return [];
  try {
    return readFileSync(path, "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as MissionSummary);
  } catch {
    return [];
  }
}
