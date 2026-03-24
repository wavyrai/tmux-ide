import { createSignal, createMemo, For, Show } from "solid-js";
import { RGBA, TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/solid";
import {
  groupTasks,
  flattenTaskList,
  isBlocked,
  type Task,
  type TaskStatus,
  type FlatItem,
} from "./task-model.ts";
import type { WidgetTheme, RGBA as RGBAType } from "../lib/theme.ts";

function toRGBA(c: RGBAType): RGBA {
  return RGBA.fromInts(c.r, c.g, c.b, c.a);
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

function statusLabel(status: TaskStatus): string {
  switch (status) {
    case "in-progress":
      return "DOING";
    case "todo":
      return "TODO";
    case "review":
      return "REVIEW";
    case "done":
      return "DONE";
  }
}

function priorityDots(priority: number): string {
  switch (priority) {
    case 1:
      return "***";
    case 2:
      return "** ";
    case 3:
      return "*  ";
    default:
      return "   ";
  }
}

interface TaskListProps {
  tasks: Task[];
  onSelect: (task: Task) => void;
  onNew: () => void;
  onQuit: () => void;
  theme: WidgetTheme;
}

export function TaskList(props: TaskListProps) {
  const [selected, setSelected] = createSignal(0);
  const [inputMode, setInputMode] = createSignal<"keyboard" | "mouse">("keyboard");

  const groups = createMemo(() => groupTasks(props.tasks));
  const flatList = createMemo(() => flattenTaskList(groups()));

  function selectedTask(): Task | null {
    const item = flatList()[selected()];
    return item?.kind === "task" ? item.task : null;
  }

  function moveSelection(direction: number) {
    const list = flatList();
    let next = selected() + direction;
    while (next >= 0 && next < list.length && list[next]?.kind === "header") {
      next += direction;
    }
    if (next >= 0 && next < list.length) setSelected(next);
  }

  useKeyboard((evt) => {
    setInputMode("keyboard");
    if (evt.name === "up" || evt.name === "k") {
      moveSelection(-1);
      evt.preventDefault();
    } else if (evt.name === "down" || evt.name === "j") {
      moveSelection(1);
      evt.preventDefault();
    } else if (evt.name === "return" || evt.name === "l" || evt.name === "right") {
      const task = selectedTask();
      if (task) props.onSelect(task);
      evt.preventDefault();
    } else if (evt.name === "n") {
      props.onNew();
      evt.preventDefault();
    } else if (evt.name === "g" && !evt.shift) {
      setSelected(0);
      evt.preventDefault();
    } else if (evt.shift && evt.name === "g") {
      setSelected(flatList().length - 1);
      evt.preventDefault();
    } else if (evt.name === "q") {
      props.onQuit();
    }
  });

  return (
    <box paddingLeft={1} paddingRight={1}>
      {/* Header bar */}
      <box flexShrink={0} flexDirection="row" justifyContent="space-between" paddingBottom={1}>
        <box flexDirection="row" gap={1}>
          <text fg={toRGBA(props.theme.fg)} attributes={TextAttributes.BOLD}>
            Tasks
          </text>
          <text fg={toRGBA(props.theme.fgMuted)}>{props.tasks.length}</text>
        </box>
        <text fg={toRGBA(props.theme.fgMuted)}>Enter:open n:new q:quit</text>
      </box>

      {/* Task list */}
      <Show
        when={flatList().length > 0}
        fallback={
          <box paddingLeft={1} paddingTop={1} flexGrow={1}>
            <text fg={toRGBA(props.theme.fgMuted)}>No tasks yet. Press n to create one.</text>
          </box>
        }
      >
        <scrollbox flexGrow={1}>
          <For each={flatList()}>
            {(item, index) => {
              if (item.kind === "header") {
                return (
                  <box paddingTop={1} paddingLeft={1} onMouseMove={() => setInputMode("mouse")}>
                    <text fg={toRGBA(props.theme.fgMuted)}>
                      {statusLabel(item.status)} ({item.count})
                    </text>
                  </box>
                );
              }

              const task = item.task;
              const isSelected = createMemo(() => index() === selected());
              const blocked = isBlocked(task, props.tasks);
              const sColor = blocked ? props.theme.fgMuted : statusColor(task.status, props.theme);
              const titleColor = () =>
                isSelected()
                  ? props.theme.selectedText
                  : blocked
                    ? props.theme.fgMuted
                    : props.theme.fg;
              return (
                <box
                  backgroundColor={
                    isSelected() ? toRGBA(props.theme.selected) : RGBA.fromInts(0, 0, 0, 0)
                  }
                  flexDirection="row"
                  paddingLeft={1}
                  paddingRight={1}
                  onMouseMove={() => {
                    setInputMode("mouse");
                    setSelected(index());
                  }}
                  onMouseDown={() => setSelected(index())}
                  onMouseUp={() => {
                    const t = selectedTask();
                    if (t) props.onSelect(t);
                  }}
                >
                  <Show when={blocked}>
                    <text fg={toRGBA(props.theme.fgMuted)} flexShrink={0} wrapMode="none">
                      {"# "}
                    </text>
                  </Show>
                  <text fg={toRGBA(sColor)} flexShrink={0} wrapMode="none">
                    {priorityDots(task.priority)}{" "}
                  </text>
                  <text fg={toRGBA(titleColor())} wrapMode="none" flexGrow={1}>
                    {task.title}
                  </text>
                  <Show when={task.status === "done"}>
                    <text fg={toRGBA(sColor)} flexShrink={0}>
                      {" ok"}
                    </text>
                  </Show>
                  <Show when={task.assignee && task.status !== "done"}>
                    <text fg={toRGBA(props.theme.fgMuted)} flexShrink={0} wrapMode="none">
                      {" @"}
                      {task.assignee}
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
