"use client";

import { useCallback } from "react";
import { fetchMetrics, type MetricsData } from "@/lib/api";
import { usePolling } from "@/lib/usePolling";
import { ProgressBar } from "@/components/ProgressBar";
import {
  KpiCard,
  Panel,
  PanelBody,
  SectionHeader,
  SkeletonCard,
  StatusPill,
  SurfaceCard,
  type StatusPillVariant,
} from "@/components/ui";

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

function milestoneVariant(status: string): StatusPillVariant {
  if (status === "done") return "done";
  if (status === "active") return "active";
  if (status === "validating") return "warning";
  return "pending";
}

export function MetricsView({ sessionName }: MetricsViewProps) {
  const metricsFetcher = useCallback(() => fetchMetrics(sessionName), [sessionName]);
  const { data: metrics } = usePolling<MetricsData | null>(metricsFetcher, 5000);

  if (!metrics) {
    return (
      <Panel testId="metrics-view">
        <PanelBody className="space-y-5 p-4">
          <div className="grid min-w-0 grid-cols-2 gap-2 md:grid-cols-4">
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
          </div>
        </PanelBody>
      </Panel>
    );
  }

  const avgUtil =
    metrics.agents.length > 0
      ? metrics.agents.reduce((sum, agent) => sum + agent.utilization, 0) / metrics.agents.length
      : 0;

  return (
    <Panel testId="metrics-view">
      <PanelBody className="min-w-0 space-y-5 p-4">
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
            tasks: <span className="tabular-nums text-[var(--fg)]">{metrics.tasks.completed}</span>/
            {metrics.tasks.total} done
          </span>
          {metrics.tasks.failed > 0 && (
            <span>
              failed: <span className="tabular-nums text-[var(--red)]">{metrics.tasks.failed}</span>
            </span>
          )}
          {metrics.tasks.avgDurationMs > 0 && (
            <span className="tabular-nums">avg: {fmtDuration(metrics.tasks.avgDurationMs)}</span>
          )}
          {metrics.tasks.medianDurationMs > 0 && (
            <span className="tabular-nums">
              median: {fmtDuration(metrics.tasks.medianDurationMs)}
            </span>
          )}
          {metrics.tasks.p90DurationMs > 0 && (
            <span className="tabular-nums">p90: {fmtDuration(metrics.tasks.p90DurationMs)}</span>
          )}
        </div>

        {metrics.tasks.byMilestone.length > 0 && (
          <div className="min-w-0">
            <SectionHeader label="milestones" />
            <div className="space-y-px">
              {metrics.tasks.byMilestone.map((milestone) => {
                const pct =
                  milestone.taskCount > 0
                    ? Math.round((milestone.completedCount / milestone.taskCount) * 100)
                    : 0;
                return (
                  <div
                    key={milestone.id}
                    className="flex items-center gap-2 rounded-md bg-[var(--surface)] px-2 py-0.5"
                  >
                    <span className="w-6 shrink-0 tabular-nums text-[var(--fg-secondary)]">
                      {milestone.id}
                    </span>
                    <span className="w-32 shrink-0 truncate text-[var(--fg)]">
                      {milestone.title}
                    </span>
                    <StatusPill
                      variant={milestoneVariant(milestone.status)}
                      label={milestone.status}
                    />
                    <ProgressBar percent={pct} width={8} />
                    <span className="shrink-0 text-[11px] tabular-nums text-[var(--dim)]">
                      {milestone.completedCount}/{milestone.taskCount}
                    </span>
                    {milestone.durationMs > 0 && (
                      <span className="text-[11px] tabular-nums text-[var(--dim)]">
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
            <SectionHeader label="agents" />
            <div className="space-y-px">
              {[...metrics.agents]
                .sort((a, b) => b.utilization - a.utilization)
                .map((agent) => (
                  <div
                    key={agent.name}
                    className="flex items-center gap-2 rounded-md bg-[var(--surface)] px-2 py-0.5 text-[12px]"
                  >
                    <span className="w-28 shrink-0 truncate text-[var(--fg)]">{agent.name}</span>
                    <span className="w-16 shrink-0 tabular-nums text-[var(--dim)]">
                      {agent.taskCount} tasks
                    </span>
                    <span
                      className="w-14 shrink-0 tabular-nums"
                      style={{
                        color: agent.utilization >= 0.5 ? "var(--green)" : "var(--dim)",
                      }}
                    >
                      {fmtPct(agent.utilization)}
                    </span>
                    {agent.retryCount > 0 && (
                      <span className="shrink-0 tabular-nums text-[var(--red)]">
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
          <SurfaceCard className="flex flex-wrap gap-x-3 gap-y-1 text-[12px]">
            <span className="text-[var(--dim)]">
              mission: <span className="text-[var(--fg)]">{metrics.mission.title}</span> [
              {metrics.mission.status}]
            </span>
            <span className="tabular-nums text-[var(--dim)]">
              milestones: {metrics.mission.milestonesCompleted}
            </span>
            <span className="text-[var(--dim)]">
              validation:{" "}
              <span className="text-[var(--green)]">
                {fmtPct(metrics.mission.validationPassRate)}
              </span>
            </span>
            <span className="tabular-nums text-[var(--dim)]">
              wall clock: {fmtDuration(metrics.mission.wallClockMs)}
            </span>
          </SurfaceCard>
        )}

        {metrics.timeline.length > 0 && (
          <div className="min-w-0">
            <SectionHeader label="timeline" />
            <div data-testid="metrics-timeline" className="max-h-48 overflow-auto">
              <div className="space-y-px">
                {metrics.timeline.slice(-20).map((entry, index) => (
                  <div
                    key={`${entry.timestamp}-${index}`}
                    className="flex w-max min-w-full items-center gap-3 rounded-md bg-[var(--surface)] px-2 py-0.5 text-[11px] tabular-nums text-[var(--dim)]"
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
      </PanelBody>
    </Panel>
  );
}
