/**
 * CostsDashboard — Solid port of dashboard/components/views/MetricsView.tsx.
 *
 * "Costs" in tmux-ide is task-throughput cost (agent-time, retry rate,
 * completion rate, wall-clock) — not LLM tokens or dollar amounts. The
 * widget renders the metrics surface as KPI grid + tasks summary line +
 * milestone progress + per-agent utilization bars + mission validation
 * card + recent activity timeline.
 *
 * Prop-driven (mirrors MissionControlDashboard): the React host polls
 * /api/project/:name/metrics every 5s and pushes the snapshot through
 * `setOptions({ snapshot })`. The widget never fetches. Live updates
 * arrive as new snapshots and the fine-grained Solid signals re-render
 * only the affected rows — that's the architectural payoff this fourth
 * silo port stress-tests.
 *
 * t3 alignment (context/t3code/apps/web/):
 *   - Design tokens from PR 1+2 (var(--bg), var(--accent),
 *     var(--surface), var(--green/yellow/red/cyan/dim)) — theme-aware.
 *   - Compact monospace numbers (font-variant-numeric: tabular-nums)
 *     so columns line up across rows.
 *   - Semantic data-* hooks: data-costs-section,
 *     data-costs-kpi, data-costs-milestone, data-costs-agent,
 *     data-costs-timeline-row.
 */
import { createMemo, For, Show } from "solid-js";
import type {
  CostsAgentEntry,
  CostsDashboardMountOptions,
  CostsDashboardSnapshot,
  CostsMilestoneEntry,
  CostsTimelineEntry,
} from "../types";

interface CostsDashboardViewProps {
  options: () => CostsDashboardMountOptions;
}

function fmtDuration(ms: number): string {
  if (!ms || ms <= 0) return "0s";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  const h = Math.floor(ms / 3_600_000);
  const m = Math.round((ms % 3_600_000) / 60_000);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function fmtPct(p: number): string {
  if (!Number.isFinite(p)) return "0%";
  return `${Math.round(p * 100)}%`;
}

function fmtTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  return new Date(t).toLocaleTimeString();
}

function milestoneColor(status: string): string {
  switch (status) {
    case "done":
      return "var(--green)";
    case "active":
      return "var(--accent)";
    case "validating":
      return "var(--yellow)";
    default:
      return "var(--dim)";
  }
}

export function CostsDashboardView(props: CostsDashboardViewProps) {
  const snapshot = createMemo<CostsDashboardSnapshot | null | undefined>(
    () => props.options().snapshot,
  );
  const timelineLimit = createMemo(() => props.options().timelineLimit ?? 20);

  const agents = createMemo<CostsAgentEntry[]>(() => {
    const list = snapshot()?.agents ?? [];
    return [...list].sort((a, b) => b.utilization - a.utilization);
  });
  const milestones = createMemo<CostsMilestoneEntry[]>(() => snapshot()?.tasks.byMilestone ?? []);
  const timeline = createMemo<CostsTimelineEntry[]>(() => {
    const list = snapshot()?.timeline ?? [];
    return list.slice(-timelineLimit());
  });

  const avgUtilization = createMemo(() => {
    const list = agents();
    if (list.length === 0) return 0;
    return list.reduce((s, a) => s + a.utilization, 0) / list.length;
  });

  return (
    <div
      data-testid="costs-dashboard-solid"
      style={{
        display: "flex",
        "flex-direction": "column",
        height: "100%",
        "min-height": "0",
        width: "100%",
        "background-color": "var(--bg)",
        color: "var(--fg)",
        "font-family": "var(--font-family-mono, var(--font-mono))",
        "font-size": "12px",
        "overflow-y": "auto",
      }}
    >
      <Show
        when={snapshot()}
        fallback={
          <div
            data-testid="costs-dashboard-loading"
            style={{
              flex: "1",
              display: "flex",
              "align-items": "center",
              "justify-content": "center",
              color: "var(--dim)",
            }}
          >
            … loading metrics
          </div>
        }
      >
        {(s) => (
          <div
            style={{ padding: "16px", display: "flex", "flex-direction": "column", gap: "20px" }}
          >
            {/* KPI grid */}
            <section
              data-costs-section="kpis"
              style={{
                display: "grid",
                "grid-template-columns": "repeat(auto-fit, minmax(140px, 1fr))",
                gap: "8px",
              }}
            >
              <Kpi
                label="session duration"
                value={fmtDuration(s().session.durationMs)}
                color="var(--fg)"
              />
              <Kpi
                label="completion rate"
                value={fmtPct(s().tasks.completionRate)}
                color={s().tasks.completionRate >= 0.8 ? "var(--green)" : "var(--yellow)"}
              />
              <Kpi
                label="avg utilization"
                value={fmtPct(avgUtilization())}
                color={avgUtilization() >= 0.5 ? "var(--green)" : "var(--dim)"}
              />
              <Kpi
                label="retry rate"
                value={fmtPct(s().tasks.retryRate)}
                color={s().tasks.retryRate > 0.2 ? "var(--red)" : "var(--green)"}
              />
            </section>

            {/* Tasks summary line */}
            <section
              data-costs-section="tasks-summary"
              style={{
                display: "flex",
                "flex-wrap": "wrap",
                gap: "4px 16px",
                "font-size": "12px",
                color: "var(--dim)",
              }}
            >
              <span>
                tasks:{" "}
                <span
                  style={{
                    "font-variant-numeric": "tabular-nums",
                    color: "var(--fg)",
                  }}
                >
                  {s().tasks.completed}
                </span>
                /{s().tasks.total} done
              </span>
              <Show when={s().tasks.failed > 0}>
                <span>
                  failed:{" "}
                  <span
                    style={{
                      "font-variant-numeric": "tabular-nums",
                      color: "var(--red)",
                    }}
                  >
                    {s().tasks.failed}
                  </span>
                </span>
              </Show>
              <Show when={s().tasks.avgDurationMs > 0}>
                <span style={{ "font-variant-numeric": "tabular-nums" }}>
                  avg: {fmtDuration(s().tasks.avgDurationMs)}
                </span>
              </Show>
              <Show when={s().tasks.medianDurationMs > 0}>
                <span style={{ "font-variant-numeric": "tabular-nums" }}>
                  median: {fmtDuration(s().tasks.medianDurationMs)}
                </span>
              </Show>
              <Show when={s().tasks.p90DurationMs > 0}>
                <span style={{ "font-variant-numeric": "tabular-nums" }}>
                  p90: {fmtDuration(s().tasks.p90DurationMs)}
                </span>
              </Show>
            </section>

            {/* Milestones */}
            <Show when={milestones().length > 0}>
              <section data-costs-section="milestones">
                <SectionLabel>Milestones</SectionLabel>
                <div style={{ display: "flex", "flex-direction": "column", gap: "1px" }}>
                  <For each={milestones()}>
                    {(m) => {
                      const pct = () =>
                        m.taskCount > 0 ? Math.round((m.completedCount / m.taskCount) * 100) : 0;
                      return (
                        <div
                          data-costs-milestone={m.id}
                          data-costs-milestone-status={m.status}
                          style={{
                            display: "flex",
                            "align-items": "center",
                            gap: "8px",
                            "border-radius": "4px",
                            background: "var(--surface)",
                            padding: "2px 8px",
                          }}
                        >
                          <span
                            style={{
                              width: "32px",
                              "flex-shrink": "0",
                              "font-variant-numeric": "tabular-nums",
                              color: "var(--fg-secondary, var(--dim))",
                            }}
                          >
                            {m.id}
                          </span>
                          <span
                            style={{
                              width: "128px",
                              "flex-shrink": "0",
                              overflow: "hidden",
                              "text-overflow": "ellipsis",
                              "white-space": "nowrap",
                              color: "var(--fg)",
                            }}
                          >
                            {m.title}
                          </span>
                          <span
                            data-costs-milestone-pill
                            style={{
                              "font-size": "10px",
                              "text-transform": "uppercase",
                              "letter-spacing": "0.05em",
                              padding: "1px 6px",
                              "border-radius": "9999px",
                              border: `1px solid ${milestoneColor(m.status)}`,
                              color: milestoneColor(m.status),
                            }}
                          >
                            {m.status}
                          </span>
                          <div
                            role="progressbar"
                            aria-valuenow={pct()}
                            aria-valuemin={0}
                            aria-valuemax={100}
                            style={{
                              flex: "1",
                              "min-width": "0",
                              height: "4px",
                              "border-radius": "2px",
                              background: "var(--border)",
                              overflow: "hidden",
                            }}
                          >
                            <div
                              style={{
                                width: `${pct()}%`,
                                height: "100%",
                                background: milestoneColor(m.status),
                                transition: "width 240ms ease",
                              }}
                            />
                          </div>
                          <span
                            style={{
                              "flex-shrink": "0",
                              "font-size": "11px",
                              "font-variant-numeric": "tabular-nums",
                              color: "var(--dim)",
                            }}
                          >
                            {m.completedCount}/{m.taskCount}
                          </span>
                          <Show when={m.durationMs > 0}>
                            <span
                              style={{
                                "font-size": "11px",
                                "font-variant-numeric": "tabular-nums",
                                color: "var(--dim)",
                              }}
                            >
                              {fmtDuration(m.durationMs)}
                            </span>
                          </Show>
                        </div>
                      );
                    }}
                  </For>
                </div>
              </section>
            </Show>

            {/* Agents */}
            <Show when={agents().length > 0}>
              <section data-costs-section="agents">
                <SectionLabel>Agents</SectionLabel>
                <div style={{ display: "flex", "flex-direction": "column", gap: "1px" }}>
                  <For each={agents()}>
                    {(a) => (
                      <div
                        data-costs-agent={a.name}
                        style={{
                          display: "flex",
                          "align-items": "center",
                          gap: "8px",
                          "border-radius": "4px",
                          background: "var(--surface)",
                          padding: "2px 8px",
                          "font-size": "12px",
                        }}
                      >
                        <span
                          style={{
                            width: "112px",
                            "flex-shrink": "0",
                            overflow: "hidden",
                            "text-overflow": "ellipsis",
                            "white-space": "nowrap",
                            color: "var(--fg)",
                          }}
                        >
                          {a.name}
                        </span>
                        <span
                          style={{
                            width: "64px",
                            "flex-shrink": "0",
                            "font-variant-numeric": "tabular-nums",
                            color: "var(--dim)",
                          }}
                        >
                          {a.taskCount} tasks
                        </span>
                        <span
                          style={{
                            width: "56px",
                            "flex-shrink": "0",
                            "font-variant-numeric": "tabular-nums",
                            color: a.utilization >= 0.5 ? "var(--green)" : "var(--dim)",
                          }}
                        >
                          {fmtPct(a.utilization)}
                        </span>
                        <Show when={a.activeTimeMs > 0}>
                          <span
                            style={{
                              "flex-shrink": "0",
                              "font-variant-numeric": "tabular-nums",
                              color: "var(--dim)",
                            }}
                          >
                            {fmtDuration(a.activeTimeMs)}
                          </span>
                        </Show>
                        <Show when={a.retryCount > 0}>
                          <span
                            data-costs-agent-retries
                            style={{
                              "flex-shrink": "0",
                              "font-variant-numeric": "tabular-nums",
                              color: "var(--red)",
                            }}
                          >
                            {a.retryCount} retries
                          </span>
                        </Show>
                        <Show when={a.specialties.length > 0}>
                          <span
                            style={{
                              "min-width": "0",
                              overflow: "hidden",
                              "text-overflow": "ellipsis",
                              "white-space": "nowrap",
                              "font-size": "10px",
                              color: "var(--cyan, var(--accent))",
                            }}
                          >
                            {a.specialties.join(", ")}
                          </span>
                        </Show>
                      </div>
                    )}
                  </For>
                </div>
              </section>
            </Show>

            {/* Mission card */}
            <Show when={s().mission.title}>
              <section
                data-costs-section="mission"
                style={{
                  "border-radius": "6px",
                  background: "var(--surface)",
                  border: "1px solid var(--border)",
                  padding: "10px 12px",
                  display: "flex",
                  "flex-wrap": "wrap",
                  gap: "4px 12px",
                  "font-size": "12px",
                }}
              >
                <span style={{ color: "var(--dim)" }}>
                  mission: <span style={{ color: "var(--fg)" }}>{s().mission.title}</span> [
                  {s().mission.status}]
                </span>
                <span
                  style={{
                    "font-variant-numeric": "tabular-nums",
                    color: "var(--dim)",
                  }}
                >
                  milestones: {s().mission.milestonesCompleted}
                </span>
                <span style={{ color: "var(--dim)" }}>
                  validation:{" "}
                  <span style={{ color: "var(--green)" }}>
                    {fmtPct(s().mission.validationPassRate)}
                  </span>
                </span>
                <span
                  style={{
                    "font-variant-numeric": "tabular-nums",
                    color: "var(--dim)",
                  }}
                >
                  wall clock: {fmtDuration(s().mission.wallClockMs)}
                </span>
              </section>
            </Show>

            {/* Timeline */}
            <Show when={timeline().length > 0}>
              <section data-costs-section="timeline">
                <SectionLabel>Timeline</SectionLabel>
                <div
                  data-testid="costs-dashboard-timeline"
                  style={{
                    "max-height": "192px",
                    "overflow-y": "auto",
                  }}
                >
                  <div style={{ display: "flex", "flex-direction": "column", gap: "1px" }}>
                    <For each={timeline()}>
                      {(entry) => (
                        <div
                          data-costs-timeline-row
                          style={{
                            display: "flex",
                            "align-items": "center",
                            gap: "12px",
                            "border-radius": "4px",
                            background: "var(--surface)",
                            padding: "2px 8px",
                            "font-size": "11px",
                            "font-variant-numeric": "tabular-nums",
                            color: "var(--dim)",
                            width: "max-content",
                            "min-width": "100%",
                          }}
                        >
                          <span style={{ width: "80px", "flex-shrink": "0" }}>
                            {fmtTime(entry.timestamp)}
                          </span>
                          <span>
                            done:
                            <span style={{ color: "var(--green)" }}>{entry.completedTasks}</span>
                          </span>
                          <span>
                            active:
                            <span style={{ color: "var(--yellow)" }}>{entry.activeTasks}</span>
                          </span>
                          <span>
                            busy:
                            <span style={{ color: "var(--accent)" }}>{entry.busyAgents}</span>
                          </span>
                          <span>
                            idle:<span style={{ color: "var(--fg)" }}>{entry.idleAgents}</span>
                          </span>
                        </div>
                      )}
                    </For>
                  </div>
                </div>
              </section>
            </Show>

            {/* All-empty fallback — snapshot exists but nothing populated yet. */}
            <Show
              when={
                agents().length === 0 &&
                milestones().length === 0 &&
                timeline().length === 0 &&
                !s().mission.title &&
                s().tasks.total === 0
              }
            >
              <div
                data-testid="costs-dashboard-empty"
                style={{
                  padding: "32px",
                  "text-align": "center",
                  color: "var(--dim)",
                }}
              >
                <div style={{ "margin-bottom": "4px", color: "var(--fg-secondary)" }}>
                  No usage yet
                </div>
                <div style={{ "font-size": "11px" }}>
                  Metrics populate once agents start working on tasks.
                </div>
              </div>
            </Show>
          </div>
        )}
      </Show>
    </div>
  );
}

function Kpi(props: { label: string; value: string; color?: string }) {
  return (
    <div
      data-costs-kpi={props.label}
      style={{
        "border-radius": "6px",
        border: "1px solid var(--border)",
        background: "var(--surface)",
        padding: "10px 12px",
      }}
    >
      <div
        style={{
          "font-size": "10px",
          "text-transform": "uppercase",
          "letter-spacing": "0.05em",
          color: "var(--dim)",
          "margin-bottom": "4px",
        }}
      >
        {props.label}
      </div>
      <div
        style={{
          "font-size": "18px",
          "font-weight": "500",
          color: props.color ?? "var(--fg)",
          "font-variant-numeric": "tabular-nums",
        }}
      >
        {props.value}
      </div>
    </div>
  );
}

function SectionLabel(props: { children: string }) {
  return (
    <div
      style={{
        "font-size": "10px",
        "text-transform": "uppercase",
        "letter-spacing": "0.08em",
        color: "var(--dim)",
        "margin-bottom": "6px",
      }}
    >
      {props.children}
    </div>
  );
}
