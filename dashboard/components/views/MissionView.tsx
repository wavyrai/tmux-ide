"use client";

import { useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import type { MilestoneData } from "@/lib/api";
import type { Goal, Task } from "@/lib/types";
import { useSessionStream } from "@/lib/useSessionStream";
import { useToasts } from "@/lib/useToasts";
import { ProgressBar } from "@/components/ProgressBar";
import {
  EmptyState,
  KpiCard,
  Panel,
  PanelBody,
  SectionHeader,
  SkeletonCard,
  SkeletonText,
  StatusPill,
  SurfaceCard,
  type StatusPillVariant,
} from "@/components/ui";

interface MissionViewProps {
  sessionName: string;
}

type MissionStatus = "planning" | "active" | "validating" | "complete";
type GoalStatus = Goal["status"];

const MISSION_STATUS_META: Record<MissionStatus, { label: string; color: string; bg: string }> = {
  planning: { label: "planning", color: "var(--yellow)", bg: "rgba(252, 213, 58, 0.1)" },
  active: { label: "active", color: "var(--accent)", bg: "rgba(91, 192, 222, 0.1)" },
  validating: { label: "validating", color: "var(--yellow)", bg: "rgba(252, 213, 58, 0.1)" },
  complete: { label: "complete", color: "var(--green)", bg: "rgba(155, 205, 151, 0.1)" },
};

const GOAL_STATUS_ORDER: GoalStatus[] = ["in-progress", "todo", "done"];

const GOAL_STATUS_META: Record<GoalStatus, { label: string; color: string; bg: string }> = {
  todo: { label: "todo", color: "var(--dim)", bg: "var(--surface)" },
  "in-progress": {
    label: "in progress",
    color: "var(--accent)",
    bg: "rgba(91, 192, 222, 0.1)",
  },
  done: { label: "done", color: "var(--green)", bg: "rgba(155, 205, 151, 0.1)" },
};

const MILESTONE_META: Record<MilestoneData["status"], { label: string; color: string }> = {
  locked: { label: "pending", color: "var(--dim)" },
  active: { label: "active", color: "var(--accent)" },
  validating: { label: "validating", color: "var(--yellow)" },
  done: { label: "done", color: "var(--green)" },
};

function isMissionStatus(value: string): value is MissionStatus {
  return (
    value === "planning" || value === "active" || value === "validating" || value === "complete"
  );
}

function formatRelative(value: string | null | undefined): string {
  if (!value) return "-";
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return value;
  const ms = Date.now() - time;
  if (ms < 60_000) return `${Math.max(0, Math.floor(ms / 1000))}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

function readString(value: unknown, key: string): string | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = (value as Record<string, unknown>)[key];
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

function percent(done: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((done / total) * 100);
}

function missionVariant(status: MissionStatus): StatusPillVariant {
  if (status === "complete") return "done";
  if (status === "validating") return "warning";
  if (status === "active") return "active";
  if (status === "planning") return "pending";
  return status;
}

function goalVariant(status: GoalStatus): StatusPillVariant {
  if (status === "done") return "done";
  if (status === "in-progress") return "active";
  return "pending";
}

function milestoneVariant(status: MilestoneData["status"]): StatusPillVariant {
  if (status === "done") return "done";
  if (status === "active") return "active";
  if (status === "validating") return "warning";
  return "pending";
}

function GoalCard({ goal, done, total }: { goal: Goal; done: number; total: number }) {
  const [expanded, setExpanded] = useState(false);
  const meta = GOAL_STATUS_META[goal.status];
  const acceptance = goal.acceptance.trim();
  const showToggle = acceptance.length > 160;

  return (
    <SurfaceCard testId="mission-goal-card">
      <div className="flex items-start gap-3">
        <span className="shrink-0 rounded-md border border-[var(--border)] px-1.5 py-0.5 text-[10px] tabular-nums text-[var(--fg-secondary)]">
          P{goal.priority}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="min-w-0 truncate text-[13px] font-medium text-[var(--fg)]">
              {goal.title}
            </h3>
            <StatusPill variant={goalVariant(goal.status)} label={meta.label} />
          </div>
          {acceptance && (
            <button
              type="button"
              onClick={() => setExpanded((current) => !current)}
              className="mt-2 block w-full text-left text-[11px] leading-5 text-[var(--fg-secondary)]"
            >
              <span className={expanded ? "" : "line-clamp-2"}>{acceptance}</span>
              {showToggle && (
                <span className="mt-1 block text-[10px] uppercase tracking-[0.08em] text-[var(--accent)]">
                  {expanded ? "show less" : "show more"}
                </span>
              )}
            </button>
          )}
          <div className="mt-3 flex items-center justify-between gap-3 text-[11px] text-[var(--dim)]">
            <span className="tabular-nums">
              {done}/{total} tasks
            </span>
            <ProgressBar percent={percent(done, total)} width={12} />
          </div>
        </div>
      </div>
    </SurfaceCard>
  );
}

export function MissionView({ sessionName }: MissionViewProps) {
  const { snapshot } = useSessionStream(sessionName);
  const mission = snapshot?.mission ?? null;
  const project = snapshot?.project ?? null;
  const { push } = useToasts();

  const goals = useMemo(() => {
    const rows = [...(project?.goals ?? [])];
    return rows.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return GOAL_STATUS_ORDER.indexOf(a.status) - GOAL_STATUS_ORDER.indexOf(b.status);
    });
  }, [project?.goals]);

  const tasksByGoal = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const task of project?.tasks ?? []) {
      if (!task.goal) continue;
      map.set(task.goal, [...(map.get(task.goal) ?? []), task]);
    }
    return map;
  }, [project?.tasks]);

  const milestoneRows = snapshot?.milestones.length
    ? snapshot.milestones
    : (mission?.mission.milestones ?? []);
  const milestones = [...milestoneRows].sort((a, b) => a.order - b.order);

  function showComingSoon() {
    push({ kind: "info", title: "Coming soon", durationMs: 1600 });
  }

  function openValidation() {
    const url = new URL(window.location.href);
    url.searchParams.set("tab", "validation");
    window.history.replaceState(null, "", url.toString());
    window.dispatchEvent(new PopStateEvent("popstate"));
  }

  if (!snapshot) {
    return (
      <Panel>
        <PanelBody className="space-y-5 p-4">
          <SkeletonCard />
          <div className="grid grid-cols-1 gap-2 md:grid-cols-5">
            {Array.from({ length: 5 }, (_, index) => (
              <SkeletonCard key={index} />
            ))}
          </div>
          <SkeletonText lines={5} />
        </PanelBody>
      </Panel>
    );
  }

  if (!mission) {
    return (
      <Panel testId="mission-view" className="items-center justify-center p-8 text-center">
        <SurfaceCard testId="mission-header" padded="md" className="max-w-md p-5">
          <EmptyState
            title="No active mission"
            body="Set a mission to connect goals, milestones, and validation into one project narrative."
            action={
              <code className="inline-flex rounded-md bg-[var(--surface)] px-2 py-1 text-[11px] text-[var(--fg-secondary)]">
                tmux-ide mission set &lt;title&gt;
              </code>
            }
          />
        </SurfaceCard>
      </Panel>
    );
  }

  const rawStatus = mission.mission.status;
  const status = isMissionStatus(rawStatus) ? rawStatus : "planning";
  const statusMeta = MISSION_STATUS_META[status];
  const created = readString(mission.mission, "created");
  const updated = readString(mission.mission, "updated");
  const validation = mission.validationSummary;
  const validationPercent = percent(validation.passing, validation.total);

  return (
    <Panel testId="mission-view">
      <PanelBody className="space-y-5 p-4">
        <section
          data-testid="mission-header"
          className="rounded-md border border-[var(--border-weak)] bg-[var(--bg-strong)] p-4"
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <StatusPill variant={missionVariant(status)} label={statusMeta.label} />
                {mission.mission.branch && (
                  <span className="rounded-md border border-[var(--border)] px-1.5 py-0.5 text-[10px] text-[var(--fg-secondary)]">
                    {mission.mission.branch}
                  </span>
                )}
              </div>
              <h1 className="text-[22px] font-semibold text-[var(--fg)]">
                {mission.mission.title}
              </h1>
              <div className="mt-2 flex flex-wrap gap-3 text-[11px] text-[var(--dim)]">
                <span>created {formatRelative(created)}</span>
                <span>updated {formatRelative(updated)}</span>
              </div>
            </div>
            <button
              type="button"
              onClick={showComingSoon}
              className="rounded-md border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--fg-secondary)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
            >
              Edit mission
            </button>
          </div>
          {mission.mission.description && (
            <div className="plan-content mt-4 max-w-4xl text-[12px]">
              <ReactMarkdown>{mission.mission.description}</ReactMarkdown>
            </div>
          )}
        </section>

        <section data-testid="mission-validation-strip" className="space-y-2">
          <div className="grid grid-cols-1 gap-2 md:grid-cols-5">
            <KpiCard label="passing" value={validation.passing} color="var(--green)" />
            <KpiCard label="failing" value={validation.failing} color="var(--red)" />
            <KpiCard label="pending" value={validation.pending} color="var(--dim)" />
            <KpiCard label="blocked" value={validation.blocked} color="var(--yellow)" />
            <KpiCard label="total" value={validation.total} />
          </div>
          <div className="flex flex-wrap items-center gap-3 rounded-md border border-[var(--border-weak)] bg-[var(--bg-strong)] px-3 py-2">
            <span className="text-[11px] uppercase tracking-[0.08em] text-[var(--dim)]">
              validation
            </span>
            <div className="min-w-48 flex-1">
              <ProgressBar percent={validationPercent} width={18} />
            </div>
            <span className="text-[11px] tabular-nums text-[var(--fg-secondary)]">
              {validation.passing}/{validation.total} passing
            </span>
            <button
              type="button"
              onClick={openValidation}
              className="ml-auto rounded-md border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--fg-secondary)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
            >
              View validation
            </button>
          </div>
        </section>

        <section data-testid="mission-goals">
          <SectionHeader
            label="goals"
            rightSlot={
              <span className="text-[11px] tabular-nums text-[var(--dim)]">{goals.length}</span>
            }
          />
          {goals.length > 0 ? (
            <div className="grid gap-2 lg:grid-cols-2">
              {goals.map((goal) => {
                const tasks = tasksByGoal.get(goal.id) ?? [];
                const done = tasks.filter((task) => task.status === "done").length;
                return <GoalCard key={goal.id} goal={goal} done={done} total={tasks.length} />;
              })}
            </div>
          ) : (
            <EmptyState
              title="No goals have been created for this mission."
              className="rounded-md border border-[var(--border-weak)] bg-[var(--bg-strong)]"
            />
          )}
        </section>

        {milestones.length > 0 && (
          <section data-testid="mission-milestones">
            <SectionHeader
              label="milestones"
              rightSlot={
                <span className="text-[11px] tabular-nums text-[var(--dim)]">
                  {milestones.length}
                </span>
              }
            />
            <div className="grid gap-2 xl:grid-cols-4 md:grid-cols-2">
              {milestones.map((milestone) => {
                const meta = MILESTONE_META[milestone.status];
                const active = milestone.status === "active";
                return (
                  <article
                    key={milestone.id}
                    data-testid="mission-milestone"
                    className={`rounded-md border bg-[var(--bg-strong)] p-3 ${
                      active ? "border-[var(--accent)]" : "border-[var(--border-weak)]"
                    }`}
                  >
                    <div className="mb-2 flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="text-[10px] uppercase tracking-[0.08em] text-[var(--dim)]">
                          {milestone.id}
                        </div>
                        <h3 className="mt-1 truncate text-[13px] font-medium text-[var(--fg)]">
                          {milestone.title}
                        </h3>
                      </div>
                      <StatusPill variant={milestoneVariant(milestone.status)} label={meta.label} />
                    </div>
                    {milestone.description && (
                      <p className="mb-3 line-clamp-2 text-[11px] leading-5 text-[var(--fg-secondary)]">
                        {milestone.description}
                      </p>
                    )}
                    <div className="flex items-center justify-between gap-2 text-[11px] text-[var(--dim)]">
                      <span className="tabular-nums">
                        {milestone.tasksDone}/{milestone.taskCount}
                      </span>
                      <ProgressBar
                        percent={percent(milestone.tasksDone, milestone.taskCount)}
                        width={10}
                      />
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        )}
      </PanelBody>
    </Panel>
  );
}
