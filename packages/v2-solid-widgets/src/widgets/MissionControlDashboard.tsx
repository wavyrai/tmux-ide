/**
 * MissionControlDashboard — Solid port of the React production Mission view
 * at dashboard/components/mission/MissionView.tsx.
 *
 * Unlike the polling MissionControl widget at ./MissionControl.tsx (kept
 * intact for the V2 sandbox), this variant is *prop-driven*. The React
 * host owns the SessionSnapshot (via useSessionStream's WebSocket bus)
 * and pushes it through `setOptions({ snapshot })` — the Solid widget
 * is a pure renderer with no fetch loop. Mirrors the PlansRail / Diffs
 * viewer bridge pattern: data flows React → Solid; user events flow
 * Solid → React via onTaskClick / onAgentClick / onShowAllEvents.
 *
 * Layout matches MissionView's PanelBody composition:
 *   HeroStrip (title + status pill + branch + description)
 *   KpiStrip  (agents active, tasks done, runtime, validation %, ETA)
 *   MilestoneLadder (per-milestone progress + tasks-in-milestone)
 *   AgentActivityRail (busy/idle agents, current task)
 *   EventStream (recent events)
 *
 * t3 alignment (context/t3code/apps/web/src/components/):
 *   - Uses the design-token vocabulary landed in commit 4abb90c
 *     (var(--bg), var(--accent), var(--surface-elevated), color-mix on
 *     status accents) so theme switches cascade without bespoke palette.
 *   - Semantic data attributes: data-mission-section, data-mission-kpi,
 *     data-mission-milestone, data-mission-agent, data-mission-event.
 *     Same role hooks t3 uses for CSS overrides; themers can target a
 *     section without touching widget internals.
 *   - "Status pill" + dot-prefix convention mirrors t3's StatusBadge.
 */
import { createMemo, createSignal, For, Show } from "solid-js";
import { createVirtualizer } from "@tanstack/solid-virtual";
import type {
  DashboardAgent,
  DashboardEvent,
  DashboardMilestone,
  DashboardTask,
  MissionControlDashboardMountOptions,
  MissionControlDashboardSnapshot,
} from "../types";

interface MissionControlDashboardViewProps {
  options: () => MissionControlDashboardMountOptions;
}

const STATUS_COLOR: Record<string, string> = {
  active: "var(--green)",
  "in-progress": "var(--accent)",
  validating: "var(--yellow)",
  review: "var(--yellow)",
  done: "var(--green)",
  locked: "var(--dim)",
  planning: "var(--cyan, var(--accent))",
  blocked: "var(--red)",
};

const TASK_STATUS_GLYPH: Record<string, string> = {
  todo: "○",
  "in-progress": "◐",
  review: "◑",
  done: "●",
  blocked: "✕",
};

function statusColor(status: string): string {
  return STATUS_COLOR[status] ?? "var(--dim)";
}

function parseElapsedMs(elapsed: string): number {
  // Mirrors dashboard/components/mission/utils.ts:parseElapsed. Accepts
  // "1h 23m 45s" / "45s" / "12m" / etc.
  if (!elapsed) return 0;
  let total = 0;
  for (const match of elapsed.matchAll(/(\d+)\s*([hms])/g)) {
    const n = Number(match[1] ?? 0);
    const unit = match[2];
    if (unit === "h") total += n * 3_600_000;
    else if (unit === "m") total += n * 60_000;
    else if (unit === "s") total += n * 1000;
  }
  return total;
}

function fmtDurationMs(ms: number): string {
  if (ms < 1000) return "0s";
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function percent(num: number, denom: number): number {
  if (denom <= 0) return 0;
  return Math.round((num / denom) * 100);
}

export function MissionControlDashboardView(props: MissionControlDashboardViewProps) {
  // Snapshot may be undefined (loading) or null (no data yet) — distinguish
  // so we can show a skeleton vs the "no mission" empty state.
  const snapshot = createMemo<MissionControlDashboardSnapshot | null | undefined>(
    () => props.options().snapshot,
  );
  const eventLimit = createMemo(() => props.options().eventLimit ?? 20);

  const mission = createMemo(() => snapshot()?.mission ?? null);
  const validation = createMemo(() => snapshot()?.validation ?? null);
  const milestones = createMemo<DashboardMilestone[]>(() => {
    const list = snapshot()?.milestones ?? [];
    return [...list].sort((a, b) => a.order - b.order);
  });
  const tasks = createMemo<DashboardTask[]>(() => snapshot()?.tasks ?? []);
  const agents = createMemo<DashboardAgent[]>(() => snapshot()?.agents ?? []);
  const events = createMemo<DashboardEvent[]>(() => snapshot()?.events ?? []);
  // Slice + memoize the visible event window so consumers re-derive
  // only when the limit or backing list changes.
  const visibleEvents = createMemo<DashboardEvent[]>(() => events().slice(0, eventLimit()));

  // The event stream sits inside the dashboard's outer scroll. Wrap it
  // in a bounded-height region with its own virtualizer so a 10k-event
  // list isn't rendered all at once.
  const [eventsScrollEl, setEventsScrollEl] = createSignal<HTMLDivElement | null>(null);
  const eventsVirtualizer = createVirtualizer({
    get count() {
      return visibleEvents().length;
    },
    getScrollElement: () => eventsScrollEl(),
    estimateSize: () => 26,
    overscan: 6,
  });
  // Inline `.getVirtualItems()` inside `<For each={…}>` does not
  // subscribe to the virtualizer's signal — wrap in `createMemo` so
  // the rail re-renders on scroll / re-measure. See commit 9b139e5.
  const eventsVirtualItems = createMemo(() => eventsVirtualizer.getVirtualItems());
  const eventsVirtualTotalSize = createMemo(() => eventsVirtualizer.getTotalSize());

  // Milestone ladder virtualizer. Each card is variable-height (the
  // expanded mTasks list grows with the milestone), so `measureElement`
  // records the real height once a card paints; the estimate is only
  // used until then.
  const [milestonesScrollEl, setMilestonesScrollEl] = createSignal<HTMLDivElement | null>(null);
  const milestonesVirtualizer = createVirtualizer({
    get count() {
      return milestones().length;
    },
    getScrollElement: () => milestonesScrollEl(),
    estimateSize: () => 80,
    overscan: 3,
    getItemKey: (i) => milestones()[i]?.id ?? i,
  });
  const milestonesVirtualItems = createMemo(() => milestonesVirtualizer.getVirtualItems());
  const milestonesVirtualTotalSize = createMemo(() => milestonesVirtualizer.getTotalSize());

  // Agent rail virtualizer. The original grid layout doesn't survive
  // virtualization cleanly (absolute-positioned items can't auto-fill
  // a grid), so the virtualized agents list collapses to a single
  // 200px-min vertical column inside a bounded scroll region — the
  // common case still shows agents in a compact form, large fleets
  // no longer DOM-bomb.
  const [agentsScrollEl, setAgentsScrollEl] = createSignal<HTMLDivElement | null>(null);
  const agentsVirtualizer = createVirtualizer({
    get count() {
      return agents().length;
    },
    getScrollElement: () => agentsScrollEl(),
    estimateSize: () => 56,
    overscan: 4,
    getItemKey: (i) => agents()[i]?.paneId ?? i,
  });
  const agentsVirtualItems = createMemo(() => agentsVirtualizer.getVirtualItems());
  const agentsVirtualTotalSize = createMemo(() => agentsVirtualizer.getTotalSize());

  const tasksByMilestone = createMemo<Map<string, DashboardTask[]>>(() => {
    const map = new Map<string, DashboardTask[]>();
    for (const t of tasks()) {
      if (!t.milestone) continue;
      const list = map.get(t.milestone) ?? [];
      list.push(t);
      map.set(t.milestone, list);
    }
    return map;
  });

  const kpis = createMemo(() => {
    const agentsList = agents();
    const tasksList = tasks();
    const agentsTotal = agentsList.length;
    const agentsActive = agentsList.filter((a) => a.isBusy).length;
    const tasksTotal = tasksList.length;
    const tasksDone = tasksList.filter((t) => t.status === "done").length;
    const runtimeMs = agentsList.reduce((sum, a) => sum + parseElapsedMs(a.elapsed), 0);

    let eta: string | null = null;
    if (tasksTotal > 0 && tasksDone > 0 && tasksDone < tasksTotal && runtimeMs > 0) {
      const remaining = tasksTotal - tasksDone;
      const avg = runtimeMs / tasksDone;
      const future = new Date(Date.now() + remaining * avg);
      eta = future.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    } else if (tasksTotal > 0 && tasksDone === tasksTotal) {
      eta = "complete";
    }
    return { agentsActive, agentsTotal, tasksDone, tasksTotal, runtimeMs, eta };
  });

  function handleTaskClick(id: string) {
    props.options().onTaskClick?.(id);
  }

  function handleAgentClick(paneId: string) {
    props.options().onAgentClick?.(paneId);
  }

  function handleShowAllEvents() {
    props.options().onShowAllEvents?.();
  }

  return (
    <div
      data-testid="mission-control-solid"
      style={{
        display: "flex",
        "flex-direction": "column",
        height: "100%",
        "min-height": "0",
        width: "100%",
        "background-color": "var(--bg)",
        color: "var(--fg)",
        "font-family": "var(--font-mono)",
        "font-size": "var(--text-base)",
        "overflow-y": "auto",
      }}
    >
      <Show
        when={snapshot() !== undefined && snapshot() !== null}
        fallback={
          <Show
            when={snapshot() === undefined}
            fallback={
              <div
                data-testid="mission-control-empty"
                style={{
                  flex: "1",
                  display: "flex",
                  "align-items": "center",
                  "justify-content": "center",
                  padding: "32px",
                  color: "var(--dim)",
                  "text-align": "center",
                }}
              >
                <div>
                  <div style={{ "margin-bottom": "8px", color: "var(--fg-secondary)" }}>
                    No active mission
                  </div>
                  <code
                    style={{
                      display: "inline-flex",
                      "border-radius": "4px",
                      background: "var(--surface)",
                      padding: "var(--space-1) var(--space-2)",
                      "font-size": "var(--text-sm)",
                      color: "var(--fg-secondary)",
                    }}
                  >
                    tmux-ide mission set &lt;title&gt;
                  </code>
                </div>
              </div>
            }
          >
            <div
              data-testid="mission-control-loading"
              style={{
                flex: "1",
                display: "flex",
                "align-items": "center",
                "justify-content": "center",
                color: "var(--dim)",
              }}
            >
              … loading mission
            </div>
          </Show>
        }
      >
        {/* Mission may still be null even when snapshot loaded (no mission set). */}
        <Show
          when={mission()}
          fallback={
            <div
              data-testid="mission-control-empty"
              style={{
                flex: "1",
                display: "flex",
                "align-items": "center",
                "justify-content": "center",
                padding: "32px",
                color: "var(--dim)",
                "text-align": "center",
              }}
            >
              <div>
                <div style={{ "margin-bottom": "8px", color: "var(--fg-secondary)" }}>
                  No active mission
                </div>
                <code
                  style={{
                    display: "inline-flex",
                    "border-radius": "4px",
                    background: "var(--surface)",
                    padding: "var(--space-1) var(--space-2)",
                    "font-size": "var(--text-sm)",
                    color: "var(--fg-secondary)",
                  }}
                >
                  tmux-ide mission set &lt;title&gt;
                </code>
              </div>
            </div>
          }
        >
          {(m) => (
            <div
              style={{
                padding: "var(--space-4)",
                display: "flex",
                "flex-direction": "column",
                gap: "16px",
              }}
            >
              {/* HeroStrip */}
              <section
                data-mission-section="hero"
                style={{
                  "border-radius": "8px",
                  border: "1px solid var(--border)",
                  background: "var(--surface-elevated, var(--surface))",
                  padding: "var(--space-4)",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    "align-items": "center",
                    gap: "var(--space-3)",
                    "margin-bottom": "8px",
                    "flex-wrap": "wrap",
                  }}
                >
                  <span
                    data-testid="mission-control-title"
                    style={{
                      "font-size": "16px",
                      "font-weight": "600",
                      color: "var(--fg)",
                    }}
                  >
                    {m().title}
                  </span>
                  <Show when={m().status}>
                    <span
                      data-mission-status={m().status}
                      style={{
                        "font-size": "var(--text-xs)",
                        "text-transform": "uppercase",
                        "letter-spacing": "0.05em",
                        padding: "var(--space-1) var(--space-2)",
                        "border-radius": "9999px",
                        border: `1px solid ${statusColor(m().status)}`,
                        color: statusColor(m().status),
                      }}
                    >
                      {m().status}
                    </span>
                  </Show>
                  <Show when={m().branch}>
                    <span style={{ color: "var(--dim)", "font-size": "var(--text-sm)" }}>
                      ⎇ {m().branch}
                    </span>
                  </Show>
                </div>
                <Show when={m().description}>
                  <p
                    style={{
                      margin: "0",
                      color: "var(--fg-secondary)",
                      "font-size": "var(--text-base)",
                      "line-height": "1.5",
                      "white-space": "pre-wrap",
                    }}
                  >
                    {m().description}
                  </p>
                </Show>
              </section>

              {/* KpiStrip */}
              <section
                data-mission-section="kpis"
                style={{
                  display: "grid",
                  "grid-template-columns": "repeat(auto-fit, minmax(140px, 1fr))",
                  gap: "var(--space-2)",
                }}
              >
                <Kpi
                  label="Agents"
                  value={`${kpis().agentsActive}/${kpis().agentsTotal}`}
                  hint={kpis().agentsActive > 0 ? "active" : "idle"}
                />
                <Kpi
                  label="Tasks"
                  value={`${kpis().tasksDone}/${kpis().tasksTotal}`}
                  hint={`${percent(kpis().tasksDone, kpis().tasksTotal)}%`}
                />
                <Kpi label="Runtime" value={fmtDurationMs(kpis().runtimeMs)} hint="agent time" />
                <Show when={validation()}>
                  {(v) => (
                    <Kpi
                      label="Validation"
                      value={`${v().passing}/${v().total}`}
                      hint={`${percent(v().passing, v().total)}%`}
                    />
                  )}
                </Show>
                <Show when={kpis().eta}>
                  <Kpi label="ETA" value={kpis().eta ?? ""} hint="estimate" />
                </Show>
              </section>

              {/* MilestoneLadder */}
              <Show when={milestones().length > 0}>
                <section data-mission-section="milestones">
                  <SectionLabel>Milestones</SectionLabel>
                  <div
                    ref={setMilestonesScrollEl}
                    data-testid="mission-control-milestones"
                    style={{
                      "max-height": "480px",
                      "overflow-y": "auto",
                      position: "relative",
                    }}
                  >
                    <div
                      data-testid="mission-control-milestones-spacer"
                      style={{
                        height: `${milestonesVirtualTotalSize()}px`,
                        width: "100%",
                        position: "relative",
                      }}
                    >
                      <For each={milestonesVirtualItems()}>
                        {(vItem) => {
                          const m = () => milestones()[vItem.index]!;
                          const pct = () => percent(m().tasksDone, m().taskCount);
                          const mTasks = () => tasksByMilestone().get(m().id) ?? [];
                          return (
                            <div
                              data-index={vItem.index}
                              ref={(el) => milestonesVirtualizer.measureElement(el)}
                              style={{
                                position: "absolute",
                                top: "0",
                                left: "0",
                                width: "100%",
                                transform: `translateY(${vItem.start}px)`,
                                "padding-bottom": "8px",
                                "box-sizing": "border-box",
                              }}
                            >
                              <div
                                data-mission-milestone={m().id}
                                data-mission-milestone-status={m().status}
                                style={{
                                  "border-radius": "6px",
                                  border: "1px solid var(--border)",
                                  background: "var(--surface)",
                                  padding: "var(--space-2) var(--space-3)",
                                }}
                              >
                                <div
                                  style={{
                                    display: "flex",
                                    "align-items": "center",
                                    gap: "var(--space-2)",
                                    "margin-bottom": "6px",
                                  }}
                                >
                                  <span
                                    aria-hidden="true"
                                    style={{
                                      display: "inline-block",
                                      width: "8px",
                                      height: "8px",
                                      "border-radius": "9999px",
                                      background: statusColor(m().status),
                                    }}
                                  />
                                  <span style={{ "font-weight": "500", color: "var(--fg)" }}>
                                    {m().title}
                                  </span>
                                  <span
                                    style={{ color: "var(--dim)", "font-size": "var(--text-sm)" }}
                                  >
                                    {m().status}
                                  </span>
                                  <span
                                    style={{
                                      "margin-left": "auto",
                                      color: "var(--dim)",
                                      "font-size": "var(--text-sm)",
                                      "font-variant-numeric": "tabular-nums",
                                    }}
                                  >
                                    {m().tasksDone}/{m().taskCount} · {pct()}%
                                  </span>
                                </div>
                                <div
                                  role="progressbar"
                                  aria-valuenow={pct()}
                                  aria-valuemin={0}
                                  aria-valuemax={100}
                                  style={{
                                    width: "100%",
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
                                      background: statusColor(m().status),
                                      transition: "width 240ms ease",
                                    }}
                                  />
                                </div>
                                <Show when={mTasks().length > 0}>
                                  <div
                                    style={{
                                      "margin-top": "8px",
                                      display: "flex",
                                      "flex-direction": "column",
                                      gap: "2px",
                                    }}
                                  >
                                    <For each={mTasks()}>
                                      {(t) => (
                                        <button
                                          type="button"
                                          data-mission-task={t.id}
                                          data-mission-task-status={t.status}
                                          onClick={() => handleTaskClick(t.id)}
                                          style={{
                                            display: "flex",
                                            "align-items": "center",
                                            gap: "var(--space-2)",
                                            padding: "var(--space-1) var(--space-2)",
                                            background: "transparent",
                                            border: "none",
                                            color: "var(--fg-secondary)",
                                            "font-family": "inherit",
                                            "font-size": "var(--text-sm)",
                                            cursor: "pointer",
                                            "text-align": "left",
                                            "border-radius": "3px",
                                          }}
                                          onMouseEnter={(e) => {
                                            e.currentTarget.style.background =
                                              "var(--surface-hover)";
                                          }}
                                          onMouseLeave={(e) => {
                                            e.currentTarget.style.background = "transparent";
                                          }}
                                        >
                                          <span
                                            aria-hidden="true"
                                            style={{ color: statusColor(t.status), width: "10px" }}
                                          >
                                            {TASK_STATUS_GLYPH[t.status] ?? "·"}
                                          </span>
                                          <span
                                            style={{
                                              flex: "1",
                                              "min-width": "0",
                                              overflow: "hidden",
                                              "text-overflow": "ellipsis",
                                              "white-space": "nowrap",
                                            }}
                                          >
                                            {t.title}
                                          </span>
                                          <Show when={t.assignee}>
                                            <span style={{ color: "var(--dim)" }}>
                                              @{t.assignee}
                                            </span>
                                          </Show>
                                        </button>
                                      )}
                                    </For>
                                  </div>
                                </Show>
                              </div>
                            </div>
                          );
                        }}
                      </For>
                    </div>
                  </div>
                </section>
              </Show>

              {/* AgentActivityRail — virtualized vertical list inside a
                  bounded scroll region. The original auto-fill grid was
                  swapped for a single-column list so the virtualizer's
                  absolute-positioned rows don't fight the grid placer. */}
              <Show when={agents().length > 0}>
                <section data-mission-section="agents">
                  <SectionLabel>Agents</SectionLabel>
                  <div
                    ref={setAgentsScrollEl}
                    data-testid="mission-control-agents"
                    style={{
                      "max-height": "320px",
                      "overflow-y": "auto",
                      position: "relative",
                    }}
                  >
                    <div
                      data-testid="mission-control-agents-spacer"
                      style={{
                        height: `${agentsVirtualTotalSize()}px`,
                        width: "100%",
                        position: "relative",
                      }}
                    >
                      <For each={agentsVirtualItems()}>
                        {(vItem) => {
                          const a = () => agents()[vItem.index]!;
                          return (
                            <div
                              data-index={vItem.index}
                              ref={(el) => agentsVirtualizer.measureElement(el)}
                              style={{
                                position: "absolute",
                                top: "0",
                                left: "0",
                                width: "100%",
                                transform: `translateY(${vItem.start}px)`,
                                "padding-bottom": "6px",
                                "box-sizing": "border-box",
                              }}
                            >
                              <button
                                type="button"
                                data-mission-agent={a().paneId}
                                data-mission-agent-busy={a().isBusy}
                                onClick={() => handleAgentClick(a().paneId)}
                                style={{
                                  display: "flex",
                                  "flex-direction": "column",
                                  gap: "var(--space-1)",
                                  padding: "var(--space-2) var(--space-3)",
                                  "border-radius": "6px",
                                  border: "1px solid var(--border)",
                                  background: "var(--surface)",
                                  cursor: "pointer",
                                  "text-align": "left",
                                  "font-family": "inherit",
                                  "font-size": "inherit",
                                  color: "inherit",
                                  width: "100%",
                                }}
                                onMouseEnter={(e) => {
                                  e.currentTarget.style.background = "var(--surface-hover)";
                                }}
                                onMouseLeave={(e) => {
                                  e.currentTarget.style.background = "var(--surface)";
                                }}
                              >
                                <div
                                  style={{
                                    display: "flex",
                                    "align-items": "center",
                                    gap: "var(--space-2)",
                                  }}
                                >
                                  <span
                                    aria-hidden="true"
                                    style={{
                                      display: "inline-block",
                                      width: "6px",
                                      height: "6px",
                                      "border-radius": "9999px",
                                      background: a().isBusy ? "var(--green)" : "var(--dim)",
                                    }}
                                  />
                                  <span style={{ "font-weight": "500", color: "var(--fg)" }}>
                                    {a().paneTitle}
                                  </span>
                                  <span
                                    style={{
                                      "margin-left": "auto",
                                      "font-size": "var(--text-xs)",
                                      color: "var(--dim)",
                                      "font-variant-numeric": "tabular-nums",
                                    }}
                                  >
                                    {a().elapsed}
                                  </span>
                                </div>
                                <Show
                                  when={a().taskTitle}
                                  fallback={
                                    <span
                                      style={{
                                        "font-size": "var(--text-sm)",
                                        color: "var(--dim)",
                                        "font-style": "italic",
                                      }}
                                    >
                                      idle
                                    </span>
                                  }
                                >
                                  <span
                                    style={{
                                      "font-size": "var(--text-sm)",
                                      color: "var(--fg-secondary)",
                                      overflow: "hidden",
                                      "text-overflow": "ellipsis",
                                      "white-space": "nowrap",
                                    }}
                                  >
                                    {a().taskTitle}
                                  </span>
                                </Show>
                              </button>
                            </div>
                          );
                        }}
                      </For>
                    </div>
                  </div>
                </section>
              </Show>

              {/* EventStream */}
              <Show when={events().length > 0}>
                <section data-mission-section="events">
                  <div
                    style={{
                      display: "flex",
                      "align-items": "center",
                      "margin-bottom": "6px",
                    }}
                  >
                    <SectionLabel inline>Recent events</SectionLabel>
                    <span style={{ flex: "1" }} />
                    <Show when={events().length > eventLimit()}>
                      <button
                        type="button"
                        data-testid="mission-control-events-show-all"
                        onClick={handleShowAllEvents}
                        style={{
                          background: "transparent",
                          border: "none",
                          color: "var(--accent)",
                          cursor: "pointer",
                          "font-family": "inherit",
                          "font-size": "var(--text-sm)",
                          "text-decoration": "underline",
                        }}
                      >
                        show all
                      </button>
                    </Show>
                  </div>
                  <div
                    ref={setEventsScrollEl}
                    data-testid="mission-control-events"
                    style={{
                      "border-radius": "6px",
                      border: "1px solid var(--border)",
                      background: "var(--surface)",
                      "max-height": "400px",
                      "overflow-y": "auto",
                      position: "relative",
                    }}
                  >
                    <div
                      data-testid="mission-control-events-spacer"
                      style={{
                        height: `${eventsVirtualTotalSize()}px`,
                        width: "100%",
                        position: "relative",
                      }}
                    >
                      <For each={eventsVirtualItems()}>
                        {(vItem) => {
                          const e = () => visibleEvents()[vItem.index]!;
                          return (
                            <div
                              data-index={vItem.index}
                              data-mission-event={e().type}
                              ref={(el) => eventsVirtualizer.measureElement(el)}
                              style={{
                                position: "absolute",
                                top: "0",
                                left: "0",
                                width: "100%",
                                transform: `translateY(${vItem.start}px)`,
                                display: "flex",
                                "align-items": "baseline",
                                gap: "var(--space-2)",
                                padding: "var(--space-1) var(--space-3)",
                                "border-bottom": "1px solid var(--border-weak, var(--border))",
                                "font-size": "var(--text-sm)",
                                "box-sizing": "border-box",
                              }}
                            >
                              <span
                                style={{
                                  "font-variant-numeric": "tabular-nums",
                                  color: "var(--dim)",
                                  "min-width": "44px",
                                }}
                              >
                                {e().relative ?? ""}
                              </span>
                              <span
                                style={{
                                  padding: "0 var(--space-2)",
                                  "border-radius": "3px",
                                  background: "color-mix(in srgb, var(--bg) 80%, var(--accent))",
                                  color: "var(--accent)",
                                  "font-size": "var(--text-xs)",
                                  "text-transform": "uppercase",
                                  "letter-spacing": "0.05em",
                                }}
                              >
                                {e().type}
                              </span>
                              <Show when={e().agent}>
                                <span style={{ color: "var(--dim)" }}>@{e().agent}</span>
                              </Show>
                              <span
                                style={{
                                  flex: "1",
                                  "min-width": "0",
                                  color: "var(--fg-secondary)",
                                  overflow: "hidden",
                                  "text-overflow": "ellipsis",
                                  "white-space": "nowrap",
                                }}
                              >
                                {e().message}
                              </span>
                            </div>
                          );
                        }}
                      </For>
                    </div>
                  </div>
                </section>
              </Show>
            </div>
          )}
        </Show>
      </Show>
    </div>
  );
}

function Kpi(props: { label: string; value: string; hint?: string }) {
  return (
    <div
      data-mission-kpi={props.label}
      style={{
        "border-radius": "6px",
        border: "1px solid var(--border)",
        background: "var(--surface)",
        padding: "var(--space-2) var(--space-3)",
      }}
    >
      <div
        style={{
          "font-size": "var(--text-xs)",
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
          "font-size": "16px",
          "font-weight": "500",
          color: "var(--fg)",
          "font-variant-numeric": "tabular-nums",
        }}
      >
        {props.value}
      </div>
      <Show when={props.hint}>
        <div style={{ "font-size": "var(--text-xs)", color: "var(--dim)", "margin-top": "2px" }}>
          {props.hint}
        </div>
      </Show>
    </div>
  );
}

function SectionLabel(props: { children: string; inline?: boolean }) {
  return (
    <div
      style={{
        "font-size": "var(--text-xs)",
        "text-transform": "uppercase",
        "letter-spacing": "0.08em",
        color: "var(--dim)",
        "margin-bottom": props.inline ? "0" : "6px",
      }}
    >
      {props.children}
    </div>
  );
}
