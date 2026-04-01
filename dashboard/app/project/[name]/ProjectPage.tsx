"use client";

import { useState, useCallback } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  fetchProject,
  fetchEvents,
  fetchMilestones,
  fetchMission,
  fetchSkills,
  fetchValidation,
  fetchCoverage,
  fetchMetrics,
  type EventData,
  type MetricsData,
  type MilestoneData,
  type MissionDetail,
  type SkillData,
} from "@/lib/api";
import { usePolling } from "@/lib/usePolling";
import { ProgressBar } from "@/components/ProgressBar";
import { AgentCard } from "@/components/AgentCard";
import { KanbanBoard } from "@/components/KanbanBoard";
import { DiffPanel } from "@/components/DiffPanel";
import { ActivityFeed } from "@/components/ActivityFeed";
import { PlansPanel } from "@/components/PlansPanel";
import { StatusBar } from "@/components/StatusBar";
import type { ProjectDetail } from "@/lib/types";

type Tab = "kanban" | "agents" | "diffs" | "plans" | "validation" | "metrics" | "activity";

const TABS: { id: Tab; label: string }[] = [
  { id: "kanban", label: "kanban" },
  { id: "agents", label: "agents" },
  { id: "diffs", label: "diffs" },
  { id: "plans", label: "plans" },
  { id: "validation", label: "validation" },
  { id: "metrics", label: "metrics" },
  { id: "activity", label: "activity" },
];

export default function ProjectPage() {
  const pathname = usePathname();
  const router = useRouter();
  // Extract project name from URL pathname (not useParams, which returns
  // the build-time placeholder "__fallback" in static exports)
  const name = decodeURIComponent(pathname.replace(/^\/project\//, "").replace(/\/$/, ""));
  const [activeTab, setActiveTab] = useState<Tab>("kanban");

  const fetcher = useCallback(() => fetchProject(name) as Promise<ProjectDetail | null>, [name]);
  const {
    data: project,
    error,
    stale,
    lastUpdate,
    refresh,
  } = usePolling<ProjectDetail | null>(fetcher, 2000);

  const eventsFetcher = useCallback(() => fetchEvents(name), [name]);
  const { data: events } = usePolling<EventData[]>(eventsFetcher, 3000);

  const milestoneFetcher = useCallback(() => fetchMilestones(name), [name]);
  const { data: milestones } = usePolling<MilestoneData[]>(milestoneFetcher, 3000);

  const missionFetcher = useCallback(() => fetchMission(name), [name]);
  const { data: missionDetail } = usePolling<MissionDetail | null>(missionFetcher, 5000);

  const skillsFetcher = useCallback(() => fetchSkills(name), [name]);
  const { data: skills } = usePolling<SkillData[]>(skillsFetcher, 10000);

  if (error) {
    return (
      <div className="h-screen flex items-center justify-center text-[var(--red)]">
        failed to load project
      </div>
    );
  }

  if (!project) {
    return (
      <div className="h-screen flex items-center justify-center text-[var(--dim)]">loading...</div>
    );
  }

  const doneTasks = project.tasks.filter((t) => t.status === "done").length;
  const totalTasks = project.tasks.length;
  const pct = totalTasks > 0 ? Math.round((doneTasks / totalTasks) * 100) : 0;
  const activeAgents = project.agents.filter((a) => a.isBusy).length;

  return (
    <div className="h-screen flex flex-col">
      {/* Top bar */}
      <div className="flex items-center justify-between px-4 h-7 bg-[var(--surface)] border-b border-[var(--border)] shrink-0">
        <div className="flex items-center gap-3">
          <button
            onClick={() => router.push("/")}
            className="text-[var(--dim)] hover:text-[var(--fg)] transition-colors"
          >
            {"< esc"}
          </button>
          <span className="text-[var(--border)]">│</span>
          <span className="text-[var(--accent)]">{project.session}</span>
          {project.mission && (
            <>
              <span className="text-[var(--border)]">│</span>
              <span className="text-[var(--dim)] truncate">{project.mission.title}</span>
            </>
          )}
        </div>
        <div className="flex items-center gap-4 text-[var(--dim)]">
          <span>
            <span className="text-[var(--green)]">{activeAgents}</span>/{project.agents.length}{" "}
            agents
          </span>
          <span>
            <span className="text-[var(--green)]">{doneTasks}</span>/{totalTasks} tasks
          </span>
          <ProgressBar percent={pct} width={10} />
        </div>
      </div>

      {/* Agents bar */}
      {project.agents.length > 0 && (
        <div className="flex items-center px-2 bg-[var(--surface)] border-b border-[var(--border)] shrink-0 overflow-x-auto">
          {project.agents.map((a, i) => (
            <AgentCard key={`${a.paneTitle}-${i}`} agent={a} />
          ))}
        </div>
      )}

      {/* Goals bar */}
      {project.goals.length > 0 && (
        <div className="flex items-center gap-4 px-4 h-6 bg-[var(--surface)] border-b border-[var(--border)] shrink-0 overflow-x-auto">
          {project.goals.map((g) => {
            const goalTasks = project.tasks.filter((t) => t.goal === g.id);
            const goalDone = goalTasks.filter((t) => t.status === "done").length;
            const goalPct =
              goalTasks.length > 0 ? Math.round((goalDone / goalTasks.length) * 100) : 0;
            return (
              <span key={g.id} className="flex items-center gap-1.5 shrink-0">
                <span className="text-[var(--fg)] truncate max-w-[20ch]">{g.title}</span>
                <ProgressBar percent={goalPct} width={4} />
              </span>
            );
          })}
        </div>
      )}

      {/* Mission status + validation summary */}
      {missionDetail && (
        <div className="flex items-center gap-4 px-4 h-6 bg-[var(--surface)] border-b border-[var(--border)] shrink-0">
          <span className="text-[var(--dim)]">mission:</span>
          <span
            className={
              missionDetail.mission.status === "complete"
                ? "text-[var(--green)]"
                : missionDetail.mission.status === "active"
                  ? "text-[var(--accent)]"
                  : "text-[var(--yellow)]"
            }
          >
            {missionDetail.mission.status}
          </span>
          {missionDetail.validationSummary.total > 0 && (
            <>
              <span className="text-[var(--border)]">│</span>
              <span className="text-[var(--dim)]">assertions:</span>
              <span className="text-[var(--green)]">{missionDetail.validationSummary.passing}</span>
              <span className="text-[var(--dim)]">/</span>
              <span>{missionDetail.validationSummary.total}</span>
              {missionDetail.validationSummary.failing > 0 && (
                <span className="text-[var(--red)]">
                  ({missionDetail.validationSummary.failing} failing)
                </span>
              )}
            </>
          )}
          {missionDetail.mission.branch && (
            <>
              <span className="text-[var(--border)]">│</span>
              <span className="text-[var(--dim)]">{missionDetail.mission.branch}</span>
            </>
          )}
        </div>
      )}

      {/* Milestone progress */}
      {milestones && milestones.length > 0 && (
        <div className="flex items-center gap-3 px-4 h-6 bg-[var(--surface)] border-b border-[var(--border)] shrink-0 overflow-x-auto">
          <span className="text-[var(--dim)] shrink-0">milestones:</span>
          {milestones.map((m) => {
            const pct = m.taskCount > 0 ? Math.round((m.tasksDone / m.taskCount) * 100) : 0;
            const statusColor =
              m.status === "done"
                ? "var(--green)"
                : m.status === "active"
                  ? "var(--accent)"
                  : m.status === "validating"
                    ? "var(--yellow)"
                    : "var(--dim)";
            return (
              <span key={m.id} className="flex items-center gap-1 shrink-0">
                <span style={{ color: statusColor }}>{m.id}</span>
                <span className="text-[var(--fg)] truncate max-w-[14ch]">{m.title}</span>
                <ProgressBar percent={pct} width={3} />
                <span className="text-[var(--dim)]">
                  {m.tasksDone}/{m.taskCount}
                </span>
              </span>
            );
          })}
        </div>
      )}

      {/* Skills bar */}
      {skills && skills.length > 0 && (
        <div className="flex items-center gap-2 px-4 h-6 bg-[var(--surface)] border-b border-[var(--border)] shrink-0 overflow-x-auto">
          <span className="text-[var(--dim)] shrink-0">skills:</span>
          {skills.map((s) => (
            <span
              key={s.name}
              className="px-1.5 py-0 text-[10px] border border-[var(--border)] text-[var(--cyan)] shrink-0"
              title={s.specialties.join(", ")}
            >
              {s.name}
            </span>
          ))}
        </div>
      )}

      {/* Tab bar */}
      <div className="flex border-b border-[var(--border)] bg-[var(--surface)] shrink-0">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`px-4 h-7 transition-colors ${
              activeTab === tab.id
                ? "text-[var(--accent)] border-b-2 border-[var(--accent)]"
                : "text-[var(--dim)] hover:text-[var(--fg)]"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === "kanban" && (
        <KanbanBoard
          tasks={project.tasks}
          sessionName={project.session}
          agents={project.agents}
          goals={project.goals}
          onRefresh={refresh}
        />
      )}

      {activeTab === "diffs" && <DiffPanel sessionName={project.session} />}

      {activeTab === "plans" && <PlansPanel sessionName={project.session} />}

      {activeTab === "validation" && <ValidationTab sessionName={project.session} />}

      {activeTab === "metrics" && <MetricsTab sessionName={project.session} />}

      {activeTab === "activity" && <ActivityFeed events={events ?? []} />}

      {activeTab === "agents" && (
        <div className="flex-1 p-4 overflow-auto">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {project.agents.map((a, i) => (
              <AgentCard key={`${a.paneTitle}-${i}`} agent={a} />
            ))}
          </div>
          {project.agents.length === 0 && (
            <div className="flex items-center justify-center h-32 text-[var(--dim)]">
              no agents in this session
            </div>
          )}
        </div>
      )}

      <StatusBar project={project} lastUpdate={lastUpdate} stale={stale} />
    </div>
  );
}

const STATUS_COLORS: Record<string, string> = {
  passing: "var(--green)",
  failing: "var(--red)",
  pending: "var(--dim)",
  blocked: "var(--yellow)",
};

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
    <div className="px-3 py-2 bg-[var(--surface)] border border-[var(--border)]">
      <div className="text-[var(--dim)] text-[11px]">{label}</div>
      <div className="text-lg" style={{ color: color ?? "var(--fg)" }}>
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

function MetricsTab({ sessionName }: { sessionName: string }) {
  const metricsFetcher = useCallback(() => fetchMetrics(sessionName), [sessionName]);
  const { data: metrics } = usePolling<MetricsData | null>(metricsFetcher, 5000);

  if (!metrics) {
    return <div className="flex-1 p-4 text-[var(--dim)]">loading metrics...</div>;
  }

  const avgUtil =
    metrics.agents.length > 0
      ? metrics.agents.reduce((s, a) => s + a.utilization, 0) / metrics.agents.length
      : 0;

  return (
    <div className="flex-1 p-4 overflow-auto space-y-4">
      {/* KPI cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
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

      {/* Task stats */}
      <div className="flex gap-4 text-[12px] text-[var(--dim)]">
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

      {/* Milestone timeline */}
      {metrics.tasks.byMilestone.length > 0 && (
        <div>
          <h3 className="text-[var(--accent)] mb-1">milestones</h3>
          <div className="space-y-px">
            {metrics.tasks.byMilestone.map((m) => {
              const pct = m.taskCount > 0 ? Math.round((m.completedCount / m.taskCount) * 100) : 0;
              return (
                <div key={m.id} className="flex items-center gap-2 px-2 py-0.5 bg-[var(--surface)]">
                  <span
                    style={{ color: MILESTONE_STATUS_COLORS[m.status] ?? "var(--dim)" }}
                    className="w-6 shrink-0"
                  >
                    {m.id}
                  </span>
                  <span className="text-[var(--fg)] w-32 truncate shrink-0">{m.title}</span>
                  <span
                    style={{ color: MILESTONE_STATUS_COLORS[m.status] ?? "var(--dim)" }}
                    className="w-20 shrink-0"
                  >
                    {m.status}
                  </span>
                  <ProgressBar percent={pct} width={8} />
                  <span className="text-[var(--dim)] text-[11px] shrink-0">
                    {m.completedCount}/{m.taskCount}
                  </span>
                  {m.durationMs > 0 && (
                    <span className="text-[var(--dim)] text-[11px]">
                      {fmtDuration(m.durationMs)}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Agent performance table */}
      {metrics.agents.length > 0 && (
        <div>
          <h3 className="text-[var(--accent)] mb-1">agents</h3>
          <div className="space-y-px">
            {[...metrics.agents]
              .sort((a, b) => b.utilization - a.utilization)
              .map((a) => (
                <div
                  key={a.name}
                  className="flex items-center gap-2 px-2 py-0.5 bg-[var(--surface)] text-[12px]"
                >
                  <span className="text-[var(--fg)] w-28 truncate shrink-0">{a.name}</span>
                  <span className="text-[var(--dim)] w-16 shrink-0">{a.taskCount} tasks</span>
                  <span
                    className="w-14 shrink-0"
                    style={{
                      color: a.utilization >= 0.5 ? "var(--green)" : "var(--dim)",
                    }}
                  >
                    {fmtPct(a.utilization)}
                  </span>
                  {a.retryCount > 0 && (
                    <span className="text-[var(--red)] shrink-0">{a.retryCount} retries</span>
                  )}
                  {a.specialties.length > 0 && (
                    <span className="text-[var(--cyan)] text-[10px] truncate">
                      {a.specialties.join(", ")}
                    </span>
                  )}
                </div>
              ))}
          </div>
        </div>
      )}

      {/* Validation status */}
      {metrics.mission.title && (
        <div className="flex gap-3 text-[12px]">
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

      {/* Activity timeline */}
      {metrics.timeline.length > 0 && (
        <div>
          <h3 className="text-[var(--accent)] mb-1">timeline</h3>
          <div className="space-y-px max-h-48 overflow-auto">
            {metrics.timeline.slice(-20).map((t, i) => (
              <div
                key={i}
                className="flex items-center gap-3 px-2 py-0.5 bg-[var(--surface)] text-[11px] text-[var(--dim)]"
              >
                <span className="w-20 shrink-0">{new Date(t.timestamp).toLocaleTimeString()}</span>
                <span>
                  done:<span className="text-[var(--green)]">{t.completedTasks}</span>
                </span>
                <span>
                  active:<span className="text-[var(--yellow)]">{t.activeTasks}</span>
                </span>
                <span>
                  busy:<span className="text-[var(--accent)]">{t.busyAgents}</span>
                </span>
                <span>
                  idle:<span className="text-[var(--fg)]">{t.idleAgents}</span>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ValidationTab({ sessionName }: { sessionName: string }) {
  const valFetcher = useCallback(() => fetchValidation(sessionName), [sessionName]);
  const { data: validation } = usePolling(valFetcher, 3000);
  const covFetcher = useCallback(() => fetchCoverage(sessionName), [sessionName]);
  const { data: coverage } = usePolling(covFetcher, 5000);

  if (!validation) {
    return <div className="flex-1 p-4 text-[var(--dim)]">no validation contract found</div>;
  }

  const assertions = validation.state ? Object.entries(validation.state.assertions) : [];

  return (
    <div className="flex-1 p-4 overflow-auto space-y-4">
      {validation.contract && (
        <div>
          <h3 className="text-[var(--accent)] mb-1">contract</h3>
          <pre className="text-[var(--fg)] text-[12px] whitespace-pre-wrap bg-[var(--surface)] p-2 border border-[var(--border)]">
            {validation.contract}
          </pre>
        </div>
      )}

      {assertions.length > 0 && (
        <div>
          <h3 className="text-[var(--accent)] mb-1">assertions</h3>
          <div className="space-y-px">
            {assertions.map(([id, entry]) => (
              <div key={id} className="flex items-center gap-2 px-2 py-0.5 bg-[var(--surface)]">
                <span className="text-[var(--fg)] w-32 shrink-0">{id}</span>
                <span
                  style={{ color: STATUS_COLORS[entry.status] ?? "var(--dim)" }}
                  className="w-16 shrink-0"
                >
                  {entry.status}
                </span>
                {entry.verifiedBy && (
                  <span className="text-[var(--cyan)] text-[11px]">@{entry.verifiedBy}</span>
                )}
                {entry.evidence && (
                  <span className="text-[var(--dim)] text-[11px] truncate">{entry.evidence}</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {coverage &&
        (coverage.unclaimed.length > 0 || Object.keys(coverage.duplicates).length > 0) && (
          <div>
            <h3 className="text-[var(--accent)] mb-1">coverage</h3>
            {coverage.unclaimed.length > 0 && (
              <div className="text-[var(--yellow)] text-[12px]">
                unclaimed: {coverage.unclaimed.join(", ")}
              </div>
            )}
            {Object.entries(coverage.duplicates).map(([id, taskIds]) => (
              <div key={id} className="text-[var(--dim)] text-[12px]">
                {id}: claimed by tasks {taskIds.join(", ")}
              </div>
            ))}
          </div>
        )}
    </div>
  );
}
