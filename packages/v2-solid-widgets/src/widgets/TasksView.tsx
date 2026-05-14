/**
 * TasksView — Solid port of dashboard's React TasksView (the table-and-
 * detail-panel surface under the "Tasks" activity tab).
 *
 * Mirrors the MissionControlDashboard prop-driven pattern: the host
 * owns the canonical task list (sourced from /api/project/:name) and
 * pushes it through `setOptions({ tasks })`. The widget owns:
 *   - Filter state (status / goal / milestone / priority / search)
 *   - Selected-task id (expanded detail panel)
 *   - Local sort order
 *
 * Visual language:
 *   - Top toolbar with filter chip groups + search input + "New task"
 *     button. Chip groups use the same selected/idle pattern as t3's
 *     filter rails (data-selected="true" toggles the accent treatment).
 *   - Task table with tight rows: status glyph · priority dot · id ·
 *     title · assignee · goal · depends_on indicator. Click a row to
 *     open the detail panel.
 *   - Right detail panel renders inline (split-pane) for desktop;
 *     collapses below the table when the host gives us a narrow box.
 *
 * Status glyphs mirror MissionControlDashboard (single source of truth
 * for the status vocabulary). Priority dots scale by importance —
 * P1 a saturated red dot, P4 muted.
 *
 * t3 alignment (context/t3code/apps/web/src/components):
 *   - Design tokens only — var(--bg), var(--accent), var(--fg-soft),
 *     var(--border), var(--surface). Theme switches cascade.
 *   - Semantic data-* hooks: data-task-id, data-task-status,
 *     data-task-priority, data-filter-group, data-filter-key,
 *     data-filter-selected, data-empty-state, data-detail-open.
 *     Same role pattern t3 uses for CSS overrides.
 *   - Status pill convention matches StatusBadge in t3.
 */

import { createMemo, createSignal, For, Show } from "solid-js";
import type {
  TasksGoalSummary,
  TasksMilestoneSummary,
  TasksTask,
  TasksTaskStatus,
  TasksViewMountOptions,
} from "../types";

interface TasksViewProps {
  options: () => TasksViewMountOptions;
}

const TASK_STATUSES: ReadonlyArray<TasksTaskStatus> = ["todo", "in-progress", "review", "done"];

const STATUS_GLYPH: Record<string, string> = {
  todo: "○",
  "in-progress": "◐",
  review: "◑",
  done: "●",
  blocked: "✕",
};

const STATUS_COLOR: Record<string, string> = {
  todo: "var(--dim)",
  "in-progress": "var(--accent)",
  review: "var(--yellow, var(--accent))",
  done: "var(--green)",
  blocked: "var(--red)",
};

const PRIORITY_COLOR: Record<number, string> = {
  1: "var(--red)",
  2: "var(--yellow, var(--accent))",
  3: "var(--accent)",
  4: "var(--dim)",
};

const STATUS_ORDER: Record<string, number> = {
  "in-progress": 0,
  review: 1,
  todo: 2,
  done: 3,
};

function fmtDate(iso?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.valueOf())) return iso;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function toggleInSet<T>(set: ReadonlySet<T>, value: T): ReadonlySet<T> {
  const next = new Set<T>(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

export function TasksViewView(props: TasksViewProps) {
  const initial = props.options().initialFilters ?? {};
  const [statusFilter, setStatusFilter] = createSignal<ReadonlySet<TasksTaskStatus>>(
    new Set(initial.status ?? []),
  );
  const [goalFilter, setGoalFilter] = createSignal<ReadonlySet<string>>(
    new Set(initial.goalIds ?? []),
  );
  const [milestoneFilter, setMilestoneFilter] = createSignal<ReadonlySet<string>>(
    new Set(initial.milestoneIds ?? []),
  );
  const [priorityFilter, setPriorityFilter] = createSignal<ReadonlySet<number>>(
    new Set(initial.priorities ?? []),
  );
  const [search, setSearch] = createSignal(initial.search ?? "");
  const [selectedId, setSelectedId] = createSignal<string | null>(null);

  const allTasks = createMemo<ReadonlyArray<TasksTask>>(() => props.options().tasks ?? []);
  const goals = createMemo<ReadonlyArray<TasksGoalSummary>>(() => props.options().goals ?? []);
  const milestones = createMemo<ReadonlyArray<TasksMilestoneSummary>>(
    () => props.options().milestones ?? [],
  );
  const density = createMemo<"compact" | "regular">(() => props.options().density ?? "compact");

  const filtered = createMemo<TasksTask[]>(() => {
    const s = statusFilter();
    const g = goalFilter();
    const m = milestoneFilter();
    const p = priorityFilter();
    const q = search().trim().toLowerCase();
    const tasks = allTasks().filter((t) => {
      if (s.size > 0 && !s.has(t.status as TasksTaskStatus)) return false;
      if (g.size > 0 && !(t.goal && g.has(t.goal))) return false;
      if (m.size > 0 && !(t.milestone && m.has(t.milestone))) return false;
      if (p.size > 0 && !p.has(t.priority)) return false;
      if (q) {
        const hay =
          `${t.id} ${t.title} ${t.assignee ?? ""} ${(t.tags ?? []).join(" ")}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    return tasks.sort((a, b) => {
      const sa = STATUS_ORDER[a.status] ?? 99;
      const sb = STATUS_ORDER[b.status] ?? 99;
      if (sa !== sb) return sa - sb;
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.id.localeCompare(b.id);
    });
  });

  const selectedTask = createMemo<TasksTask | null>(() => {
    const id = selectedId();
    if (!id) return null;
    return allTasks().find((t) => t.id === id) ?? null;
  });

  const goalLabel = (goalId: string | null | undefined): string => {
    if (!goalId) return "—";
    const g = goals().find((x) => x.id === goalId);
    return g ? `${g.id} ${g.title}` : goalId;
  };

  const milestoneLabel = (mId: string | null | undefined): string => {
    if (!mId) return "—";
    const m = milestones().find((x) => x.id === mId);
    return m ? `${m.id} ${m.title ?? ""}`.trim() : mId;
  };

  function handleRowClick(taskId: string): void {
    setSelectedId(taskId === selectedId() ? null : taskId);
    props.options().onTaskClick?.(taskId);
  }

  function clearAllFilters(): void {
    setStatusFilter(new Set<TasksTaskStatus>());
    setGoalFilter(new Set<string>());
    setMilestoneFilter(new Set<string>());
    setPriorityFilter(new Set<number>());
    setSearch("");
  }

  const rowPadY = (): string => (density() === "compact" ? "3px" : "6px");

  return (
    <div
      data-testid="tasks-view-solid"
      data-density={density()}
      data-detail-open={selectedTask() ? "true" : "false"}
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
      }}
    >
      {/* ----- Toolbar (chips + search + actions) -------------------- */}
      <header
        data-tasks-toolbar
        style={{
          display: "flex",
          "flex-wrap": "wrap",
          "align-items": "center",
          gap: "8px",
          padding: "8px 10px",
          "border-bottom": "1px solid var(--border)",
          "background-color": "var(--bg-strong, var(--bg))",
        }}
      >
        <ChipGroup
          label="Status"
          dataKey="status"
          items={TASK_STATUSES.map((s) => ({ key: s, label: s, color: STATUS_COLOR[s] }))}
          selected={statusFilter() as ReadonlySet<string | number>}
          onToggle={(key) =>
            setStatusFilter(toggleInSet<TasksTaskStatus>(statusFilter(), key as TasksTaskStatus))
          }
        />
        <Show when={goals().length > 0}>
          <ChipGroup
            label="Goal"
            dataKey="goal"
            items={goals().map((g) => ({ key: g.id, label: `${g.id} ${g.title}` }))}
            selected={goalFilter() as ReadonlySet<string | number>}
            onToggle={(key) => setGoalFilter(toggleInSet<string>(goalFilter(), key as string))}
          />
        </Show>
        <Show when={milestones().length > 0}>
          <ChipGroup
            label="Milestone"
            dataKey="milestone"
            items={milestones().map((m) => ({
              key: m.id,
              label: m.title ? `${m.id} ${m.title}` : m.id,
            }))}
            selected={milestoneFilter() as ReadonlySet<string | number>}
            onToggle={(key) =>
              setMilestoneFilter(toggleInSet<string>(milestoneFilter(), key as string))
            }
          />
        </Show>
        <ChipGroup
          label="Priority"
          dataKey="priority"
          items={[1, 2, 3, 4].map((p) => ({
            key: p,
            label: `P${p}`,
            color: PRIORITY_COLOR[p],
          }))}
          selected={priorityFilter() as ReadonlySet<string | number>}
          onToggle={(key) =>
            setPriorityFilter(toggleInSet<number>(priorityFilter(), key as number))
          }
        />
        <input
          data-testid="tasks-search"
          type="search"
          placeholder="Search…"
          value={search()}
          onInput={(e) => setSearch(e.currentTarget.value)}
          style={{
            "flex-grow": "1",
            "min-width": "120px",
            padding: "3px 8px",
            "border-radius": "4px",
            border: "1px solid var(--border)",
            "background-color": "var(--bg)",
            color: "var(--fg)",
            "font-family": "inherit",
            "font-size": "11px",
          }}
        />
        <Show
          when={
            statusFilter().size +
              goalFilter().size +
              milestoneFilter().size +
              priorityFilter().size >
              0 || search().length > 0
          }
        >
          <button
            type="button"
            data-testid="tasks-clear-filters"
            onClick={clearAllFilters}
            style={{
              padding: "3px 8px",
              "border-radius": "4px",
              border: "1px solid var(--border)",
              "background-color": "transparent",
              color: "var(--fg-soft)",
              "font-family": "inherit",
              "font-size": "11px",
              cursor: "pointer",
            }}
          >
            Clear
          </button>
        </Show>
        <Show when={props.options().onCreateTask}>
          <button
            type="button"
            data-testid="tasks-create"
            onClick={() => props.options().onCreateTask?.()}
            style={{
              padding: "3px 10px",
              "border-radius": "4px",
              border: "1px solid var(--accent)",
              "background-color": "color-mix(in oklab, var(--accent) 14%, transparent)",
              color: "var(--accent)",
              "font-family": "inherit",
              "font-size": "11px",
              cursor: "pointer",
            }}
          >
            + New task
          </button>
        </Show>
      </header>

      {/* ----- Body (table + optional detail) ------------------------ */}
      <div
        style={{
          display: "flex",
          "flex-grow": "1",
          "min-height": "0",
        }}
      >
        <div
          data-testid="tasks-list"
          style={{
            flex: "1 1 0%",
            "min-width": "0",
            "overflow-y": "auto",
          }}
        >
          <Show
            when={filtered().length > 0}
            fallback={
              <div
                data-empty-state
                style={{
                  display: "flex",
                  "align-items": "center",
                  "justify-content": "center",
                  padding: "40px 12px",
                  color: "var(--dim)",
                  "font-size": "12px",
                }}
              >
                <Show when={allTasks().length === 0} fallback="No tasks match the current filters.">
                  — no tasks yet —
                </Show>
              </div>
            }
          >
            <table
              data-testid="tasks-table"
              style={{
                width: "100%",
                "border-collapse": "collapse",
                "table-layout": "fixed",
              }}
            >
              <thead>
                <tr
                  style={{
                    "text-align": "left",
                    color: "var(--fg-soft)",
                    "font-size": "10px",
                    "text-transform": "uppercase",
                    "letter-spacing": "0.05em",
                  }}
                >
                  <th style={{ width: "24px", padding: "4px 8px" }} />
                  <th style={{ width: "16px", padding: "4px 0" }} />
                  <th style={{ width: "44px", padding: "4px 6px" }}>ID</th>
                  <th style={{ padding: "4px 6px" }}>Title</th>
                  <th style={{ width: "92px", padding: "4px 6px" }}>Status</th>
                  <th style={{ width: "94px", padding: "4px 6px" }}>Assignee</th>
                  <th style={{ width: "60px", padding: "4px 6px" }}>Goal</th>
                  <th style={{ width: "44px", padding: "4px 6px" }}>Deps</th>
                </tr>
              </thead>
              <tbody>
                <For each={filtered()}>
                  {(task) => (
                    <tr
                      data-testid="task-row"
                      data-task-id={task.id}
                      data-task-status={task.status}
                      data-task-priority={`P${task.priority}`}
                      data-task-selected={selectedId() === task.id ? "true" : "false"}
                      onClick={() => handleRowClick(task.id)}
                      style={{
                        cursor: "pointer",
                        "background-color":
                          selectedId() === task.id
                            ? "color-mix(in oklab, var(--accent) 8%, transparent)"
                            : "transparent",
                        "border-bottom": "1px solid var(--border-weak, var(--border))",
                      }}
                    >
                      <td
                        style={{
                          padding: `${rowPadY()} 8px`,
                          color: STATUS_COLOR[task.status] ?? "var(--dim)",
                          "text-align": "center",
                        }}
                      >
                        {STATUS_GLYPH[task.status] ?? "·"}
                      </td>
                      <td style={{ padding: `${rowPadY()} 0` }}>
                        <span
                          aria-label={`P${task.priority}`}
                          title={`Priority ${task.priority}`}
                          style={{
                            display: "inline-block",
                            width: "8px",
                            height: "8px",
                            "border-radius": "50%",
                            "background-color": PRIORITY_COLOR[task.priority] ?? "var(--dim)",
                          }}
                        />
                      </td>
                      <td
                        style={{
                          padding: `${rowPadY()} 6px`,
                          color: "var(--fg-soft)",
                          "font-variant-numeric": "tabular-nums",
                        }}
                      >
                        {task.id}
                      </td>
                      <td
                        style={{
                          padding: `${rowPadY()} 6px`,
                          color: "var(--fg)",
                          "white-space": "nowrap",
                          overflow: "hidden",
                          "text-overflow": "ellipsis",
                        }}
                        title={task.title}
                      >
                        {task.title}
                      </td>
                      <td
                        style={{
                          padding: `${rowPadY()} 6px`,
                          color: STATUS_COLOR[task.status] ?? "var(--fg-soft)",
                        }}
                      >
                        {task.status}
                      </td>
                      <td
                        style={{
                          padding: `${rowPadY()} 6px`,
                          color: "var(--fg-soft)",
                          "white-space": "nowrap",
                          overflow: "hidden",
                          "text-overflow": "ellipsis",
                        }}
                      >
                        {task.assignee ?? "—"}
                      </td>
                      <td style={{ padding: `${rowPadY()} 6px`, color: "var(--fg-soft)" }}>
                        {task.goal ?? "—"}
                      </td>
                      <td style={{ padding: `${rowPadY()} 6px`, color: "var(--fg-soft)" }}>
                        <Show
                          when={task.depends_on && task.depends_on.length > 0}
                          fallback={<span style={{ color: "var(--dim)" }}>—</span>}
                        >
                          <span title={(task.depends_on ?? []).join(", ")}>
                            ⛓ {task.depends_on!.length}
                          </span>
                        </Show>
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </Show>
        </div>

        {/* ----- Detail panel ---------------------------------------- */}
        <Show when={selectedTask()}>
          {(taskAccessor) => (
            <aside
              data-testid="task-detail"
              data-task-id={taskAccessor().id}
              style={{
                flex: "0 0 360px",
                "min-width": "0",
                "border-left": "1px solid var(--border)",
                "background-color": "var(--surface, var(--bg-strong, var(--bg)))",
                "overflow-y": "auto",
                padding: "10px 12px",
                display: "flex",
                "flex-direction": "column",
                gap: "10px",
              }}
            >
              <header style={{ display: "flex", "align-items": "baseline", gap: "8px" }}>
                <span style={{ color: "var(--fg-soft)", "font-size": "10px" }}>
                  {taskAccessor().id}
                </span>
                <span
                  data-testid="task-detail-priority"
                  style={{
                    "font-size": "10px",
                    color: PRIORITY_COLOR[taskAccessor().priority] ?? "var(--dim)",
                  }}
                >
                  P{taskAccessor().priority}
                </span>
                <button
                  type="button"
                  data-testid="task-detail-close"
                  onClick={() => setSelectedId(null)}
                  style={{
                    "margin-left": "auto",
                    background: "transparent",
                    border: "none",
                    color: "var(--fg-soft)",
                    cursor: "pointer",
                    "font-size": "14px",
                    "line-height": "1",
                  }}
                  aria-label="Close detail panel"
                >
                  ×
                </button>
              </header>
              <h2
                data-testid="task-detail-title"
                style={{
                  margin: "0",
                  "font-size": "13px",
                  "font-weight": "600",
                  color: "var(--fg)",
                }}
              >
                {taskAccessor().title}
              </h2>
              <div style={{ display: "flex", "flex-wrap": "wrap", gap: "10px 14px" }}>
                <DetailField
                  label="Status"
                  value={taskAccessor().status}
                  color={STATUS_COLOR[taskAccessor().status] ?? undefined}
                />
                <DetailField label="Goal" value={goalLabel(taskAccessor().goal)} />
                <DetailField label="Milestone" value={milestoneLabel(taskAccessor().milestone)} />
                <DetailField label="Assignee" value={taskAccessor().assignee ?? "—"} />
                <DetailField label="Created" value={fmtDate(taskAccessor().created)} />
                <DetailField label="Updated" value={fmtDate(taskAccessor().updated)} />
              </div>
              <Show when={taskAccessor().tags && taskAccessor().tags!.length > 0}>
                <div style={{ display: "flex", "flex-wrap": "wrap", gap: "4px" }}>
                  <For each={taskAccessor().tags!}>
                    {(tag) => (
                      <span
                        style={{
                          padding: "1px 6px",
                          "border-radius": "10px",
                          "background-color": "color-mix(in oklab, var(--accent) 14%, transparent)",
                          color: "var(--accent)",
                          "font-size": "10px",
                        }}
                      >
                        {tag}
                      </span>
                    )}
                  </For>
                </div>
              </Show>
              <Show when={taskAccessor().depends_on && taskAccessor().depends_on!.length > 0}>
                <DetailField label="Depends on" value={taskAccessor().depends_on!.join(", ")} />
              </Show>
              <Show when={taskAccessor().description}>
                <p
                  data-testid="task-detail-description"
                  style={{
                    "white-space": "pre-wrap",
                    color: "var(--fg-soft)",
                    margin: "0",
                    "line-height": "1.45",
                    "font-size": "11px",
                  }}
                >
                  {taskAccessor().description}
                </p>
              </Show>
            </aside>
          )}
        </Show>
      </div>
    </div>
  );
}

interface ChipGroupItem {
  key: string | number;
  label: string;
  color?: string;
}

function ChipGroup(props: {
  label: string;
  dataKey: string;
  items: ChipGroupItem[];
  selected: ReadonlySet<string | number>;
  onToggle: (key: string | number) => void;
}) {
  return (
    <div
      data-filter-group={props.dataKey}
      style={{ display: "flex", "align-items": "center", gap: "4px" }}
    >
      <span
        style={{
          color: "var(--fg-soft)",
          "font-size": "10px",
          "text-transform": "uppercase",
          "letter-spacing": "0.05em",
        }}
      >
        {props.label}
      </span>
      <For each={props.items}>
        {(item) => {
          const isSelected = () => props.selected.has(item.key);
          return (
            <button
              type="button"
              data-filter-key={String(item.key)}
              data-filter-selected={isSelected() ? "true" : "false"}
              onClick={() => props.onToggle(item.key)}
              style={{
                padding: "2px 8px",
                "border-radius": "10px",
                border: "1px solid var(--border)",
                "background-color": isSelected()
                  ? "color-mix(in oklab, var(--accent) 18%, transparent)"
                  : "transparent",
                color: isSelected() ? "var(--accent)" : (item.color ?? "var(--fg-soft)"),
                "font-family": "inherit",
                "font-size": "10px",
                cursor: "pointer",
                "white-space": "nowrap",
              }}
            >
              {item.label}
            </button>
          );
        }}
      </For>
    </div>
  );
}

function DetailField(props: { label: string; value: string; color?: string }) {
  return (
    <div style={{ "min-width": "0" }}>
      <div
        style={{
          color: "var(--fg-soft)",
          "font-size": "9px",
          "text-transform": "uppercase",
          "letter-spacing": "0.05em",
        }}
      >
        {props.label}
      </div>
      <div
        style={{
          color: props.color ?? "var(--fg)",
          "font-size": "11px",
          "white-space": "nowrap",
          overflow: "hidden",
          "text-overflow": "ellipsis",
        }}
      >
        {props.value}
      </div>
    </div>
  );
}
