/**
 * KanbanBoard — Solid port of dashboard/components/kanban/KanbanBoard.tsx.
 *
 * Prop-driven board (mirrors TasksView's data flow): the React host owns
 * the canonical task list and pushes it through `setOptions({ tasks })`.
 * The widget owns:
 *   - Filter state (priority chips / agent chips / search)
 *   - Group-by mode (status | priority)
 *   - Local optimistic status patch (so clicking the status dot updates
 *     the column immediately; the host's snapshot replaces it on commit)
 *
 * Mutations leave the widget via `onTaskStatusChange(id, nextStatus)`. The
 * host is responsible for the API round-trip — see kanban-board-bridge.tsx.
 *
 * Visual language matches TasksView: tight chips, status-coloured dots,
 * design-token palette. Semantic data-* hooks are kept stable for tests:
 *   - data-testid="kanban-board"
 *   - data-testid="kanban-column-<id>"
 *   - data-testid="kanban-column-body-<id>"
 *   - data-testid="task-card-<id>"
 *   - data-testid="task-card-status-<id>"
 *   - data-testid="kanban-filter-search"
 *   - data-testid="kanban-groupby-<mode>"
 *   - data-testid="kanban-add-task"
 *   - data-testid="kanban-filter-clear"
 */

import { createMemo, createSignal, For, Show, type JSX } from "solid-js";
import { createVirtualizer } from "@tanstack/solid-virtual";
import type {
  KanbanBoardMountOptions,
  KanbanGroupBy,
  KanbanTask,
  KanbanTaskStatus,
} from "../types";

interface KanbanBoardProps {
  options: () => KanbanBoardMountOptions;
}

const STATUS_CYCLE: ReadonlyArray<KanbanTaskStatus> = ["todo", "in-progress", "review", "done"];

const STATUS_COLOR: Record<string, string> = {
  todo: "var(--dim)",
  "in-progress": "var(--yellow, var(--accent))",
  review: "var(--magenta, var(--accent))",
  done: "var(--green)",
};

const STATUS_LABEL: Record<string, string> = {
  todo: "Todo",
  "in-progress": "In Progress",
  review: "In Review",
  done: "Done",
};

const PRIORITY_COLOR: Record<number, string> = {
  1: "var(--red)",
  2: "var(--yellow, var(--accent))",
  3: "var(--accent)",
  4: "var(--dim)",
};

interface ColumnDef {
  id: string;
  label: string;
  color: string;
  status?: KanbanTaskStatus;
}

const STATUS_COLUMNS: ReadonlyArray<ColumnDef> = [
  { id: "todo", label: "Todo", status: "todo", color: STATUS_COLOR.todo! },
  {
    id: "in-progress",
    label: "In Progress",
    status: "in-progress",
    color: STATUS_COLOR["in-progress"]!,
  },
  { id: "review", label: "In Review", status: "review", color: STATUS_COLOR.review! },
  { id: "done", label: "Done", status: "done", color: STATUS_COLOR.done! },
];

const PRIORITY_COLUMNS: ReadonlyArray<ColumnDef> = [
  { id: "p1", label: "P1 — critical", color: PRIORITY_COLOR[1]! },
  { id: "p2", label: "P2 — high", color: PRIORITY_COLOR[2]! },
  { id: "p3", label: "P3 — normal", color: PRIORITY_COLOR[3]! },
  { id: "p4", label: "P4 — low", color: PRIORITY_COLOR[4]! },
];

function priorityColumnId(p: number): string {
  if (p <= 1) return "p1";
  if (p === 2) return "p2";
  if (p === 3) return "p3";
  return "p4";
}

function columnIdForTask(task: KanbanTask, groupBy: KanbanGroupBy): string {
  if (groupBy === "priority") return priorityColumnId(task.priority);
  return task.status;
}

function nextStatus(current: string): KanbanTaskStatus {
  const idx = STATUS_CYCLE.indexOf(current as KanbanTaskStatus);
  if (idx < 0) return STATUS_CYCLE[0]!;
  return STATUS_CYCLE[(idx + 1) % STATUS_CYCLE.length]!;
}

function toggleInSet<T>(set: ReadonlySet<T>, value: T): ReadonlySet<T> {
  const next = new Set<T>(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

export function KanbanBoardView(props: KanbanBoardProps) {
  const initial = props.options().initialFilters ?? {};
  const [priorityFilter, setPriorityFilter] = createSignal<ReadonlySet<number>>(
    new Set(initial.priorities ?? []),
  );
  const [agentFilter, setAgentFilter] = createSignal<ReadonlySet<string>>(
    new Set(initial.agents ?? []),
  );
  const [search, setSearch] = createSignal(initial.search ?? "");
  const [groupBy, setGroupBy] = createSignal<KanbanGroupBy>(
    props.options().initialGroupBy ?? "status",
  );
  const [optimistic, setOptimistic] = createSignal<ReadonlyMap<string, KanbanTaskStatus>>(
    new Map(),
  );

  const allTasks = createMemo<ReadonlyArray<KanbanTask>>(() => props.options().tasks ?? []);
  const density = createMemo<"compact" | "regular">(() => props.options().density ?? "compact");

  // Merge optimistic status patches onto the canonical list.
  const patched = createMemo<KanbanTask[]>(() => {
    const opts = optimistic();
    if (opts.size === 0) return allTasks().slice();
    return allTasks().map((t) => {
      const o = opts.get(t.id);
      return o ? { ...t, status: o } : t;
    });
  });

  // Distinct agents — for the agent filter chip group.
  const knownAgents = createMemo<string[]>(() => {
    const set = new Set<string>();
    for (const t of allTasks()) {
      if (t.assignee) set.add(t.assignee);
    }
    return [...set].sort();
  });

  const filtered = createMemo<KanbanTask[]>(() => {
    const p = priorityFilter();
    const a = agentFilter();
    const q = search().trim().toLowerCase();
    return patched().filter((t) => {
      if (p.size > 0 && !p.has(t.priority)) return false;
      if (a.size > 0 && !(t.assignee && a.has(t.assignee))) return false;
      if (q) {
        const hay =
          `${t.id} ${t.title} ${t.assignee ?? ""} ${(t.tags ?? []).join(" ")}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  });

  const columns = createMemo<ReadonlyArray<ColumnDef>>(() =>
    groupBy() === "priority" ? PRIORITY_COLUMNS : STATUS_COLUMNS,
  );

  const tasksByColumn = createMemo<Map<string, KanbanTask[]>>(() => {
    const map = new Map<string, KanbanTask[]>();
    for (const c of columns()) map.set(c.id, []);
    for (const t of filtered()) {
      const cid = columnIdForTask(t, groupBy());
      const list = map.get(cid);
      if (list) list.push(t);
    }
    for (const [, list] of map) {
      list.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
    }
    return map;
  });

  const hasActiveFilters = () =>
    priorityFilter().size > 0 || agentFilter().size > 0 || search().trim().length > 0;

  function clearFilters(): void {
    setPriorityFilter(new Set<number>());
    setAgentFilter(new Set<string>());
    setSearch("");
  }

  function cycleStatus(task: KanbanTask): void {
    const ns = nextStatus(task.status);
    const cb = props.options().onTaskStatusChange;
    // Optimistic update — clear it on the next setOptions push.
    setOptimistic((cur) => {
      const next = new Map(cur);
      next.set(task.id, ns);
      return next;
    });
    cb?.(task.id, ns);
  }

  const rowPadY = (): string => (density() === "compact" ? "4px" : "8px");

  return (
    <div
      data-testid="kanban-board"
      data-density={density()}
      data-groupby={groupBy()}
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
      {/* ----- Toolbar -------------------------------------------------- */}
      <header
        data-kanban-toolbar
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
          label="Group"
          dataKey="group"
          items={[
            { key: "status", label: "Status" },
            { key: "priority", label: "Priority" },
          ]}
          selected={new Set([groupBy() as string])}
          onToggle={(key) => setGroupBy(key as KanbanGroupBy)}
          testIdPrefix="kanban-groupby"
        />
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
        <Show when={knownAgents().length > 0}>
          <ChipGroup
            label="Agent"
            dataKey="agent"
            items={knownAgents().map((a) => ({ key: a, label: `@${a}` }))}
            selected={agentFilter() as ReadonlySet<string | number>}
            onToggle={(key) => setAgentFilter(toggleInSet<string>(agentFilter(), key as string))}
          />
        </Show>
        <input
          data-testid="kanban-filter-search"
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
        <Show when={hasActiveFilters()}>
          <button
            type="button"
            data-testid="kanban-filter-clear"
            onClick={clearFilters}
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
            data-testid="kanban-add-task"
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

      {/* ----- Columns -------------------------------------------------- */}
      <div
        data-testid="kanban-columns"
        style={{
          display: "flex",
          "flex-grow": "1",
          "min-height": "0",
          gap: "8px",
          padding: "10px",
          "overflow-x": "auto",
          "overflow-y": "hidden",
        }}
      >
        <For each={columns()}>
          {(col) => (
            <section
              data-testid={`kanban-column-${col.id}`}
              data-column-id={col.id}
              style={{
                flex: "1 1 0%",
                "min-width": "220px",
                "max-width": "320px",
                display: "flex",
                "flex-direction": "column",
                "min-height": "0",
                "background-color": "var(--surface, var(--bg-strong, var(--bg)))",
                border: "1px solid var(--border-weak, var(--border))",
                "border-radius": "6px",
              }}
            >
              <header
                style={{
                  display: "flex",
                  "align-items": "center",
                  gap: "6px",
                  padding: "8px 10px",
                  "border-bottom": "1px solid var(--border-weak, var(--border))",
                }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    display: "inline-block",
                    width: "8px",
                    height: "8px",
                    "border-radius": "50%",
                    "background-color": col.color,
                  }}
                />
                <span
                  style={{
                    color: "var(--fg)",
                    "font-size": "11px",
                    "font-weight": "600",
                    "text-transform": "uppercase",
                    "letter-spacing": "0.04em",
                  }}
                >
                  {col.label}
                </span>
                <span
                  data-testid={`kanban-column-count-${col.id}`}
                  style={{
                    "margin-left": "auto",
                    color: "var(--fg-soft)",
                    "font-size": "10px",
                    "font-variant-numeric": "tabular-nums",
                  }}
                >
                  {(tasksByColumn().get(col.id) ?? []).length}
                </span>
              </header>
              <KanbanColumnBody
                columnId={col.id}
                tasks={tasksByColumn().get(col.id) ?? []}
                rowPadY={rowPadY()}
                onTaskClick={(id) => props.options().onTaskClick?.(id)}
                onCycleStatus={cycleStatus}
              />
            </section>
          )}
        </For>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// KanbanColumnBody — one virtualizer per column so a board with 4
// columns × 1000 cards each renders only the visible viewport window
// per column, not 4000 articles.
// ---------------------------------------------------------------------

interface KanbanColumnBodyProps {
  columnId: string;
  tasks: KanbanTask[];
  rowPadY: string;
  onTaskClick: (id: string) => void;
  onCycleStatus: (task: KanbanTask) => void;
}

function KanbanColumnBody(props: KanbanColumnBodyProps): JSX.Element {
  const [scrollEl, setScrollEl] = createSignal<HTMLDivElement | null>(null);
  const virtualizer = createVirtualizer({
    get count() {
      return props.tasks.length;
    },
    getScrollElement: () => scrollEl(),
    // Compact rows ≈ 56px, comfortable rows ≈ 72px. measureElement
    // overwrites with the real height once a card paints.
    estimateSize: () => 64,
    overscan: 4,
    getItemKey: (i) => props.tasks[i]?.id ?? i,
  });

  return (
    <div
      ref={setScrollEl}
      data-testid={`kanban-column-body-${props.columnId}`}
      style={{
        flex: "1 1 0%",
        "min-height": "0",
        "overflow-y": "auto",
        padding: "6px",
        position: "relative",
      }}
    >
      <Show
        when={props.tasks.length > 0}
        fallback={
          <div
            data-empty-state
            style={{
              color: "var(--dim)",
              "font-size": "10px",
              padding: "10px 4px",
              "text-align": "center",
            }}
          >
            —
          </div>
        }
      >
        <div
          data-testid={`kanban-column-spacer-${props.columnId}`}
          style={{
            height: `${virtualizer.getTotalSize()}px`,
            width: "100%",
            position: "relative",
          }}
        >
          <For each={virtualizer.getVirtualItems()}>
            {(vItem) => {
              const task = () => props.tasks[vItem.index]!;
              return (
                <div
                  data-index={vItem.index}
                  ref={(el) => virtualizer.measureElement(el)}
                  style={{
                    position: "absolute",
                    top: "0",
                    left: "0",
                    width: "100%",
                    transform: `translateY(${vItem.start}px)`,
                    "padding-bottom": "4px",
                    "box-sizing": "border-box",
                  }}
                >
                  <article
                    data-testid={`task-card-${task().id}`}
                    data-task-id={task().id}
                    data-task-status={task().status}
                    data-task-priority={`P${task().priority}`}
                    onClick={(e) => {
                      const target = e.target as HTMLElement | null;
                      if (target?.closest("[data-status-dot]")) return;
                      props.onTaskClick(task().id);
                    }}
                    style={{
                      cursor: "pointer",
                      "background-color": "var(--bg)",
                      border: "1px solid var(--border-weak, var(--border))",
                      "border-radius": "4px",
                      padding: `${props.rowPadY} 8px`,
                      display: "flex",
                      "flex-direction": "column",
                      gap: "3px",
                    }}
                  >
                    <header style={{ display: "flex", "align-items": "center", gap: "6px" }}>
                      <button
                        type="button"
                        data-testid={`task-card-status-${task().id}`}
                        data-status-dot
                        onClick={(e) => {
                          e.stopPropagation();
                          props.onCycleStatus(task());
                        }}
                        aria-label={`Cycle status from ${STATUS_LABEL[task().status] ?? task().status}`}
                        title={STATUS_LABEL[task().status] ?? task().status}
                        style={{
                          display: "inline-block",
                          width: "10px",
                          height: "10px",
                          "border-radius": "50%",
                          "background-color": STATUS_COLOR[task().status] ?? "var(--dim)",
                          border: "none",
                          padding: "0",
                          cursor: "pointer",
                        }}
                      />
                      <span
                        style={{
                          color: "var(--fg-soft)",
                          "font-size": "10px",
                          "font-variant-numeric": "tabular-nums",
                        }}
                      >
                        {task().id}
                      </span>
                      <span
                        aria-label={`P${task().priority}`}
                        title={`Priority ${task().priority}`}
                        style={{
                          "margin-left": "auto",
                          display: "inline-block",
                          width: "7px",
                          height: "7px",
                          "border-radius": "50%",
                          "background-color":
                            PRIORITY_COLOR[task().priority] ?? "var(--dim)",
                        }}
                      />
                    </header>
                    <div
                      style={{
                        color: "var(--fg)",
                        "font-size": "12px",
                        "line-height": "1.3",
                        "white-space": "nowrap",
                        overflow: "hidden",
                        "text-overflow": "ellipsis",
                      }}
                      title={task().title}
                    >
                      {task().title}
                    </div>
                    <Show
                      when={
                        task().assignee || (task().depends_on && task().depends_on!.length > 0)
                      }
                    >
                      <footer
                        style={{
                          display: "flex",
                          "align-items": "center",
                          gap: "6px",
                          color: "var(--fg-soft)",
                          "font-size": "10px",
                        }}
                      >
                        <Show when={task().assignee}>
                          <span>@{task().assignee}</span>
                        </Show>
                        <Show when={task().depends_on && task().depends_on!.length > 0}>
                          <span
                            title={(task().depends_on ?? []).join(", ")}
                            style={{ "margin-left": "auto" }}
                          >
                            ⛓ {task().depends_on!.length}
                          </span>
                        </Show>
                      </footer>
                    </Show>
                  </article>
                </div>
              );
            }}
          </For>
        </div>
      </Show>
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
  testIdPrefix?: string;
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
          const tid = props.testIdPrefix ? `${props.testIdPrefix}-${item.key}` : undefined;
          return (
            <button
              type="button"
              data-testid={tid}
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
