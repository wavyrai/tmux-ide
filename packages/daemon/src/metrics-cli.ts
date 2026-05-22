import { resolve } from "node:path";
import { computeMetrics, loadMissionHistory } from "./lib/metrics.ts";

function fmtDuration(ms: number): string {
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600000) return `${Math.round(ms / 60000)}m`;
  const h = Math.floor(ms / 3600000);
  const m = Math.round((ms % 3600000) / 60000);
  return `${h}h ${m}m`;
}

function fmtPct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

export async function metricsCommand(
  targetDir: string | undefined,
  {
    json = false,
    sub,
  }: {
    json?: boolean;
    sub?: string;
  },
): Promise<void> {
  const dir = resolve(targetDir ?? ".");

  switch (sub) {
    case "agents": {
      const metrics = computeMetrics(dir);
      if (json) {
        console.log(JSON.stringify(metrics.agents, null, 2));
        return;
      }
      if (metrics.agents.length === 0) {
        console.log("No agent data yet.");
        return;
      }
      console.log("Agent Performance:");
      for (const a of metrics.agents) {
        const specs = a.specialties.length > 0 ? ` [${a.specialties.join(", ")}]` : "";
        console.log(`  ${a.name}${specs}`);
        console.log(
          `    Tasks: ${a.taskCount}  Retries: ${a.retryCount}  Utilization: ${fmtPct(a.utilization)}`,
        );
        console.log(
          `    Active: ${fmtDuration(a.activeTimeMs)}  Idle: ${fmtDuration(a.idleTimeMs)}`,
        );
      }
      break;
    }
    case "timeline": {
      const metrics = computeMetrics(dir);
      if (json) {
        console.log(JSON.stringify(metrics.timeline, null, 2));
        return;
      }
      if (metrics.timeline.length === 0) {
        console.log("No timeline data yet.");
        return;
      }
      console.log("Activity Timeline:");
      for (const t of metrics.timeline.slice(-20)) {
        const ts = new Date(t.timestamp).toLocaleTimeString();
        console.log(
          `  ${ts}  done:${t.completedTasks} active:${t.activeTasks} busy:${t.busyAgents} idle:${t.idleAgents}`,
        );
      }
      break;
    }
    case "eval": {
      const metrics = computeMetrics(dir);
      if (json) {
        const bottlenecks = [...metrics.tasks.byMilestone]
          .sort((a, b) => b.durationMs - a.durationMs)
          .slice(0, 3);
        const highRetryAgents = [...metrics.agents]
          .filter((a) => a.retryCount > 0)
          .sort((a, b) => b.retryCount - a.retryCount);
        const ranking = [...metrics.agents].sort((a, b) => b.utilization - a.utilization);
        console.log(JSON.stringify({ bottlenecks, highRetryAgents, ranking }, null, 2));
        return;
      }
      console.log("Evaluation:");
      // Bottleneck milestones
      const slowest = [...metrics.tasks.byMilestone]
        .filter((m) => m.durationMs > 0)
        .sort((a, b) => b.durationMs - a.durationMs);
      if (slowest.length > 0) {
        console.log("  Slowest milestones:");
        for (const m of slowest.slice(0, 3)) {
          console.log(
            `    ${m.id} ${m.title}: ${fmtDuration(m.durationMs)} (${m.completedCount}/${m.taskCount} tasks)`,
          );
        }
      }
      // High-retry agents
      const retryAgents = metrics.agents.filter((a) => a.retryCount > 0);
      if (retryAgents.length > 0) {
        console.log("  High-retry agents:");
        for (const a of retryAgents.sort((x, y) => y.retryCount - x.retryCount)) {
          console.log(`    ${a.name}: ${a.retryCount} retries across ${a.taskCount} tasks`);
        }
      }
      // Agent ranking by utilization
      if (metrics.agents.length > 0) {
        console.log("  Agent ranking (by utilization):");
        for (const a of [...metrics.agents].sort((x, y) => y.utilization - x.utilization)) {
          console.log(`    ${a.name}: ${fmtPct(a.utilization)} util, ${a.taskCount} tasks`);
        }
      }
      break;
    }
    case "history": {
      const history = loadMissionHistory(dir);
      if (json) {
        console.log(JSON.stringify(history, null, 2));
        return;
      }
      if (history.length === 0) {
        console.log("No mission history yet.");
        return;
      }
      console.log("Mission History:");
      for (const m of history) {
        console.log(`  ${m.title} [${m.status}]`);
        console.log(`    Completed: ${m.completedAt}  Duration: ${fmtDuration(m.wallClockMs)}`);
        console.log(
          `    Tasks: ${m.taskCount} (${fmtPct(m.completionRate)} done)  Agents: ${m.agentCount}  Milestones: ${m.milestonesCompleted}`,
        );
      }
      break;
    }
    case "help":
      console.log(`Usage: tmux-ide metrics [subcommand] [--json]

  (default)   Session summary — duration, task rates, agent utilization
  agents      Per-agent table — tasks, time, utilization, specialties
  timeline    Activity timeline — sampled every 5 minutes
  eval        Evaluation — bottleneck milestones, high-retry tasks, agent ranking
  history     Cross-mission comparison from history`);
      break;
    default: {
      // Default: session summary
      const metrics = computeMetrics(dir);
      if (json) {
        console.log(JSON.stringify(metrics, null, 2));
        return;
      }
      console.log("Session Metrics:");
      console.log(`  Status: ${metrics.session.status}`);
      console.log(`  Duration: ${fmtDuration(metrics.session.durationMs)}`);
      console.log(`  Agents: ${metrics.session.agentCount}`);
      console.log();
      console.log("Tasks:");
      console.log(
        `  Total: ${metrics.tasks.total}  Done: ${metrics.tasks.completed}  Failed: ${metrics.tasks.failed}`,
      );
      console.log(
        `  Completion rate: ${fmtPct(metrics.tasks.completionRate)}  Retry rate: ${fmtPct(metrics.tasks.retryRate)}`,
      );
      if (metrics.tasks.avgDurationMs > 0) {
        console.log(
          `  Avg duration: ${fmtDuration(metrics.tasks.avgDurationMs)}  Median: ${fmtDuration(metrics.tasks.medianDurationMs)}  P90: ${fmtDuration(metrics.tasks.p90DurationMs)}`,
        );
      }
      if (metrics.mission.title) {
        console.log();
        console.log(`Mission: ${metrics.mission.title} [${metrics.mission.status}]`);
        console.log(`  Milestones: ${metrics.mission.milestonesCompleted} completed`);
        console.log(`  Validation: ${fmtPct(metrics.mission.validationPassRate)} pass rate`);
        console.log(`  Wall clock: ${fmtDuration(metrics.mission.wallClockMs)}`);
      }
      break;
    }
  }
}
