import { createSignal, createMemo, For, Show } from "solid-js";
import { RGBA, TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/solid";
import type { Task } from "../../lib/task-store.ts";
import type { WidgetTheme, RGBA as RGBAType } from "../lib/theme.ts";

function toRGBA(c: RGBAType): RGBA {
  return RGBA.fromInts(c.r, c.g, c.b, c.a);
}

type TaskStatus = Task["status"];

const STATUS_ORDER: TaskStatus[] = ["in-progress", "todo", "review", "done"];

function statusLabel(status: TaskStatus): string {
  switch (status) {
    case "in-progress":
      return "IN PROGRESS";
    case "todo":
      return "TODO";
    case "review":
      return "REVIEW";
    case "done":
      return "DONE";
  }
}

function statusColor(status: TaskStatus, theme: WidgetTheme): RGBAType {
  switch (status) {
    case "in-progress":
      return theme.gitModified;
    case "todo":
      return theme.fgMuted;
    case "review":
      return theme.diffHunk;
    case "done":
      return theme.gitAdded;
  }
}

function priorityColor(priority: number, theme: WidgetTheme): RGBAType {
  if (priority <= 1) return theme.gitDeleted; // red
  if (priority <= 2) return theme.gitModified; // yellow
  return theme.fgMuted; // dim
}

function priorityLabel(priority: number): string {
  return `P${priority}`;
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

type FlatRow =
  | { kind: "header"; status: TaskStatus; count: number }
  | { kind: "task"; task: Task }
  | { kind: "create" };

function buildRows(tasks: Task[]): FlatRow[] {
  const groups: Record<TaskStatus, Task[]> = {
    "in-progress": [],
    todo: [],
    review: [],
    done: [],
  };

  for (const task of tasks) {
    const group = groups[task.status];
    if (group) group.push(task);
  }

  for (const group of Object.values(groups)) {
    group.sort((a, b) => a.priority - b.priority);
  }

  const rows: FlatRow[] = [];
  for (const status of STATUS_ORDER) {
    const group = groups[status];
    if (group.length === 0) continue;
    rows.push({ kind: "header", status, count: group.length });
    for (const task of group) {
      rows.push({ kind: "task", task });
    }
  }

  rows.push({ kind: "create" });
  return rows;
}

interface TaskPanelProps {
  tasks: Task[];
  isActive: boolean;
  theme: WidgetTheme;
  onCreateTask: () => void;
}

export function TaskPanel(props: TaskPanelProps) {
  const [selected, setSelected] = createSignal(0);

  const rows = createMemo(() => buildRows(props.tasks));

  // Skip headers when navigating
  function moveSelection(direction: number) {
    const list = rows();
    let next = selected() + direction;
    while (next >= 0 && next < list.length && list[next]?.kind === "header") {
      next += direction;
    }
    if (next >= 0 && next < list.length) setSelected(next);
  }

  useKeyboard((evt) => {
    if (!props.isActive) return;

    if (evt.name === "up" || evt.name === "k") {
      moveSelection(-1);
      evt.preventDefault();
    } else if (evt.name === "down" || evt.name === "j") {
      moveSelection(1);
      evt.preventDefault();
    } else if (evt.name === "return") {
      const row = rows()[selected()];
      if (row?.kind === "create") props.onCreateTask();
      evt.preventDefault();
    }
  });

  return (
    <box flexGrow={1}>
      <Show
        when={rows().length > 1}
        fallback={
          <box>
            <text fg={toRGBA(props.theme.fgMuted)}>No tasks</text>
            <box
              flexShrink={0}
              backgroundColor={
                props.isActive && selected() === 0 ? toRGBA(props.theme.selected) : undefined
              }
              onMouseDown={() => props.onCreateTask()}
            >
              <text
                fg={toRGBA(
                  props.isActive && selected() === 0 ? props.theme.accent : props.theme.fgMuted,
                )}
              >
                [+create]
              </text>
            </box>
          </box>
        }
      >
        <scrollbox flexGrow={1}>
          <For each={rows()}>
            {(row, index) => {
              if (row.kind === "header") {
                return (
                  <box flexShrink={0} paddingTop={index() > 0 ? 1 : 0}>
                    <text
                      fg={toRGBA(statusColor(row.status, props.theme))}
                      attributes={TextAttributes.BOLD}
                    >
                      {statusLabel(row.status)} ({row.count})
                    </text>
                  </box>
                );
              }

              if (row.kind === "create") {
                const isSel = () => props.isActive && selected() === index();
                return (
                  <box
                    flexShrink={0}
                    backgroundColor={isSel() ? toRGBA(props.theme.selected) : undefined}
                    onMouseDown={() => {
                      setSelected(index());
                      props.onCreateTask();
                    }}
                  >
                    <text fg={toRGBA(isSel() ? props.theme.accent : props.theme.fgMuted)}>
                      [+create]
                    </text>
                  </box>
                );
              }

              const task = row.task;
              const isSel = () => props.isActive && selected() === index();
              return (
                <box
                  flexShrink={0}
                  flexDirection="row"
                  gap={1}
                  backgroundColor={isSel() ? toRGBA(props.theme.selected) : undefined}
                  onMouseDown={() => setSelected(index())}
                >
                  <text
                    fg={toRGBA(priorityColor(task.priority, props.theme))}
                    flexShrink={0}
                    wrapMode="none"
                  >
                    {priorityLabel(task.priority)}
                  </text>
                  <text
                    fg={toRGBA(isSel() ? props.theme.accent : props.theme.fg)}
                    attributes={isSel() ? TextAttributes.BOLD : 0}
                    flexShrink={0}
                    wrapMode="none"
                  >
                    {task.id}
                  </text>
                  <text
                    fg={toRGBA(isSel() ? props.theme.selectedText : props.theme.fg)}
                    wrapMode="none"
                    flexGrow={1}
                  >
                    {truncate(task.title, 30)}
                  </text>
                  <Show when={task.assignee}>
                    <text fg={toRGBA(props.theme.fgMuted)} flexShrink={0} wrapMode="none">
                      @{truncate(task.assignee!, 10)}
                    </text>
                  </Show>
                </box>
              );
            }}
          </For>
        </scrollbox>
      </Show>
    </box>
  );
}
