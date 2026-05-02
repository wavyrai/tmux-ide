"use client";

import { useCallback } from "react";
import { fetchMetrics, type MetricsData } from "@/lib/api";
import { usePolling } from "@/lib/usePolling";
import { ProgressBar } from "@/components/ProgressBar";

interface MetricsViewProps {
  sessionName: string;
}

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

function KpiCard({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div
      data-testid="kpi-card"
      className="min-w-0 border border-[var(--border)] bg-[var(--surface-elevated)] px-3 py-2"
      style={{ boxShadow: "var(--surface-elevated-shadow)" }}
    >
      <div className="truncate text-[11px] text-[var(--dim)]">{label}</div>
      <div className="truncate text-lg" style={{ color: color ?? "var(--fg)" }}>
        {value}
      </div>
    </div>
  );
}

const MILESTONE_STATUS_COLORS: Record<string, string> = {
  done: "var(--green)",
  active: "var(--accent)",
  validating: "var(--yellow)",
  locked: "var(--dim)",
};

export function MetricsView({ sessionName }: MetricsViewProps) {
  const metricsFetcher = useCallback(() => fetchMetrics(sessionName), [sessionName]);
  const { data: metrics } = usePolling<MetricsData | null>(metricsFetcher, 5000);

  if (!metrics) {
    return (
      <div
        data-testid="metrics-view"
        className="flex flex-1 min-h-0 flex-col bg-[var(--bg)] p-4 text-[var(--dim)] overflow-hidden"
      >
        loading metrics...
      </div>
    );
  }

  const avgUtil =
    metrics.agents.length > 0
      ? metrics.agents.reduce((sum, agent) => sum + agent.utilization, 0) / metrics.agents.length
      : 0;

  return (
    <div
      data-testid="metrics-view"
      className="flex flex-1 min-h-0 flex-col bg-[var(--bg)] overflow-hidden"
    >
      <div className="flex-1 min-w-0 space-y-4 overflow-y-auto overflow-x-hidden p-4">
        <div className="grid min-w-0 grid-cols-2 gap-2 md:grid-cols-4">
          <KpiCard label="session duration" value={fmtDuration(metrics.session.durationMs)} />
          <KpiCard
            label="completion rate"
            value={fmtPct(metrics.tasks.completionRate)}
            color={metrics.tasks.completionRate >= 0.8 ? "var(--green)" : "var(--yellow)"}
          />
          <KpiCard
            label="avg agent utilization"
            value={fmtPct(avgUtil)}
            color={avgUtil >= 0.5 ? "var(--green)" : "var(--dim)"}
          />
          <KpiCard
            label="retry rate"
            value={fmtPct(metrics.tasks.retryRate)}
            color={metrics.tasks.retryRate > 0.2 ? "var(--red)" : "var(--green)"}
          />
        </div>

        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-[var(--dim)]">
          <span>
            tasks: <span className="text-[var(--fg)]">{metrics.tasks.completed}</span>/
            {metrics.tasks.total} done
          </span>
          {metrics.tasks.failed > 0 && (
            <span>
              failed: <span className="text-[var(--red)]">{metrics.tasks.failed}</span>
            </span>
          )}
          {metrics.tasks.avgDurationMs > 0 && (
            <span>avg: {fmtDuration(metrics.tasks.avgDurationMs)}</span>
          )}
          {metrics.tasks.medianDurationMs > 0 && (
            <span>median: {fmtDuration(metrics.tasks.medianDurationMs)}</span>
          )}
          {metrics.tasks.p90DurationMs > 0 && (
            <span>p90: {fmtDuration(metrics.tasks.p90DurationMs)}</span>
          )}
        </div>

        {metrics.tasks.byMilestone.length > 0 && (
          <div className="min-w-0">
            <h3 className="mb-1 text-[var(--accent)]">milestones</h3>
            <div className="space-y-px">
              {metrics.tasks.byMilestone.map((milestone) => {
                const pct =
                  milestone.taskCount > 0
                    ? Math.round((milestone.completedCount / milestone.taskCount) * 100)
                    : 0;
                return (
                  <div
                    key={milestone.id}
                    className="flex items-center gap-2 bg-[var(--surface)] px-2 py-0.5"
                  >
                    <span
                      style={{
                        color: MILESTONE_STATUS_COLORS[milestone.status] ?? "var(--dim)",
                      }}
                      className="w-6 shrink-0"
                    >
                      {milestone.id}
                    </span>
                    <span className="w-32 shrink-0 truncate text-[var(--fg)]">
                      {milestone.title}
                    </span>
                    <span
                      style={{
                        color: MILESTONE_STATUS_COLORS[milestone.status] ?? "var(--dim)",
                      }}
                      className="w-20 shrink-0"
                    >
                      {milestone.status}
                    </span>
                    <ProgressBar percent={pct} width={8} />
                    <span className="shrink-0 text-[11px] text-[var(--dim)]">
                      {milestone.completedCount}/{milestone.taskCount}
                    </span>
                    {milestone.durationMs > 0 && (
                      <span className="text-[11px] text-[var(--dim)]">
                        {fmtDuration(milestone.durationMs)}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {metrics.agents.length > 0 && (
          <div className="min-w-0">
            <h3 className="mb-1 text-[var(--accent)]">agents</h3>
            <div className="space-y-px">
              {[...metrics.agents]
                .sort((a, b) => b.utilization - a.utilization)
                .map((agent) => (
                  <div
                    key={agent.name}
                    className="flex items-center gap-2 bg-[var(--surface)] px-2 py-0.5 text-[12px]"
                  >
                    <span className="w-28 shrink-0 truncate text-[var(--fg)]">{agent.name}</span>
                    <span className="w-16 shrink-0 text-[var(--dim)]">
                      {agent.taskCount} tasks
                    </span>
                    <span
                      className="w-14 shrink-0"
                      style={{
                        color: agent.utilization >= 0.5 ? "var(--green)" : "var(--dim)",
                      }}
                    >
                      {fmtPct(agent.utilization)}
                    </span>
                    {agent.retryCount > 0 && (
                      <span className="shrink-0 text-[var(--red)]">
                        {agent.retryCount} retries
                      </span>
                    )}
                    {agent.specialties.length > 0 && (
                      <span className="truncate text-[10px] text-[var(--cyan)]">
                        {agent.specialties.join(", ")}
                      </span>
                    )}
                  </div>
                ))}
            </div>
          </div>
        )}

        {metrics.mission.title && (
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-[12px]">
            <span className="text-[var(--dim)]">
              mission: <span className="text-[var(--fg)]">{metrics.mission.title}</span> [
              {metrics.mission.status}]
            </span>
            <span className="text-[var(--dim)]">
              milestones: {metrics.mission.milestonesCompleted}
            </span>
            <span className="text-[var(--dim)]">
              validation:{" "}
              <span className="text-[var(--green)]">
                {fmtPct(metrics.mission.validationPassRate)}
              </span>
            </span>
            <span className="text-[var(--dim)]">
              wall clock: {fmtDuration(metrics.mission.wallClockMs)}
            </span>
          </div>
        )}

        {metrics.timeline.length > 0 && (
          <div className="min-w-0">
            <h3 className="mb-1 text-[var(--accent)]">timeline</h3>
            <div data-testid="metrics-timeline" className="max-h-48 overflow-auto">
              <div className="space-y-px">
                {metrics.timeline.slice(-20).map((entry, index) => (
                  <div
                    key={`${entry.timestamp}-${index}`}
                    className="flex w-max min-w-full items-center gap-3 bg-[var(--surface)] px-2 py-0.5 text-[11px] text-[var(--dim)]"
                  >
                    <span className="w-20 shrink-0">
                      {new Date(entry.timestamp).toLocaleTimeString()}
                    </span>
                    <span>
                      done:<span className="text-[var(--green)]">{entry.completedTasks}</span>
                    </span>
                    <span>
                      active:<span className="text-[var(--yellow)]">{entry.activeTasks}</span>
                    </span>
                    <span>
                      busy:<span className="text-[var(--accent)]">{entry.busyAgents}</span>
                    </span>
                    <span>
                      idle:<span className="text-[var(--fg)]">{entry.idleAgents}</span>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
