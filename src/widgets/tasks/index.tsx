import "@opentui/solid/runtime-plugin-support";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { render, useKeyboard, useTerminalDimensions } from "@opentui/solid";
import { RGBA, TextAttributes } from "@opentui/core";
import { createSignal, createMemo, onMount, onCleanup, Show, For } from "solid-js";
import { createTheme, type WidgetTheme, type RGBA as RGBAType } from "../lib/theme.ts";
import { watchDirectory } from "../lib/watcher.ts";
import {
  sendCommand,
  findPaneByTitle,
  findPaneByPattern,
  listSessionPanes,
} from "../lib/pane-comms.ts";
import {
  loadTasks,
  groupTasks,
  updateTaskStatus,
  updateTaskAssignee,
  createTask,
  nextStatus,
  flattenTaskList,
  ensureTasksDir,
  getTasksDir,
  type Task,
  type TaskStatus,
} from "./task-model.ts";

const { values } = parseArgs({
  options: {
    session: { type: "string" },
    dir: { type: "string" },
    target: { type: "string" },
    theme: { type: "string" },
  },
});

const session = values.session ?? "";
const dir = values.dir ?? process.cwd();
const targetTitle = values.target ?? null;
const themeConfig = values.theme ? JSON.parse(values.theme) : undefined;

function toRGBA(c: RGBAType): RGBA {
  return RGBA.fromInts(c.r, c.g, c.b, c.a);
}

function statusColor(status: TaskStatus, theme: WidgetTheme): RGBAType {
  switch (status) {
    case "in-progress":
      return theme.gitModified;
    case "todo":
      return theme.accent;
    case "review":
      return theme.diffHunk;
    case "done":
      return theme.gitAdded;
  }
}

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

function priorityColor(priority: number, theme: WidgetTheme): RGBAType {
  switch (priority) {
    case 1:
      return theme.gitDeleted;
    case 2:
      return theme.gitModified;
    case 3:
      return theme.accent;
    default:
      return theme.fgMuted;
  }
}

render(
  () => {
    const theme = createTheme(themeConfig);
    const dimensions = useTerminalDimensions();
    const [tasks, setTasks] = createSignal(loadTasks(dir));
    const [selected, setSelected] = createSignal(0);
    const [showDetail, setShowDetail] = createSignal(true);
    const [inputMode, setInputMode] = createSignal<"keyboard" | "mouse">("keyboard");

    const groups = createMemo(() => groupTasks(tasks()));
    const flatList = createMemo(() => flattenTaskList(groups()));
    const selectedTask = createMemo(() => flatList()[selected()]?.task ?? null);

    const totalActive = createMemo(() => tasks().filter((t) => t.status === "in-progress").length);

    function reload() {
      setTasks(loadTasks(dir));
    }

    // Watch .tasks/ directory
    let stopWatch: (() => Promise<void>) | null = null;
    onMount(async () => {
      ensureTasksDir(dir);
      try {
        stopWatch = await watchDirectory(getTasksDir(dir), reload, {
          debounceMs: 300,
          ignore: [],
        });
      } catch {
        /* watcher unavailable */
      }
    });
    onCleanup(async () => {
      await stopWatch?.();
    });

    function resolveTargetPane(): string | null {
      if (!session) return null;
      if (targetTitle) return findPaneByTitle(session, targetTitle);
      return findPaneByPattern(session, "claude");
    }

    function findClaudePane(): { id: string; title: string } | null {
      if (!session) return null;
      const panes = listSessionPanes(session);
      const claude = panes.find(
        (p) =>
          p.currentCommand.toLowerCase() === "claude" || p.title.toLowerCase().includes("claude"),
      );
      return claude ? { id: claude.id, title: claude.title } : null;
    }

    useKeyboard((evt) => {
      setInputMode("keyboard");
      const list = flatList();
      const task = selectedTask();

      if (evt.name === "up" || evt.name === "k") {
        setSelected((i) => Math.max(0, i - 1));
        evt.preventDefault();
      } else if (evt.name === "down" || evt.name === "j") {
        setSelected((i) => Math.min(list.length - 1, i + 1));
        evt.preventDefault();
      } else if (evt.name === "s" && task) {
        const next = nextStatus(task.status);
        updateTaskStatus(dir, task.id, next);
        reload();
        evt.preventDefault();
      } else if (evt.name === "a" && task) {
        const claude = findClaudePane();
        if (claude) {
          updateTaskAssignee(dir, task.id, claude.title);
          reload();
        }
        evt.preventDefault();
      } else if ((evt.name === "c" || evt.name === "return") && task) {
        const targetId = resolveTargetPane();
        if (targetId) {
          const prompt = `Work on this task:\n\nTitle: ${task.title}\nDescription: ${task.description}\nPriority: P${task.priority}${task.tags.length > 0 ? `\nTags: ${task.tags.join(", ")}` : ""}`;
          sendCommand(session, targetId, prompt);
          if (task.status === "todo") {
            updateTaskStatus(dir, task.id, "in-progress");
            reload();
          }
        }
        evt.preventDefault();
      } else if (evt.name === "n") {
        createTask(dir, tasks());
        reload();
        setSelected(list.length); // select new task
        evt.preventDefault();
      } else if (evt.name === "d") {
        setShowDetail((d) => !d);
        evt.preventDefault();
      } else if (evt.name === "r") {
        reload();
        evt.preventDefault();
      } else if (evt.name === "g" && !evt.shift) {
        setSelected(0);
        evt.preventDefault();
      } else if (evt.shift && evt.name === "g") {
        setSelected(list.length - 1);
        evt.preventDefault();
      } else if (evt.name === "q") {
        process.exit(0);
      }
    });

    return (
      <box
        width={dimensions().width}
        height={dimensions().height}
        backgroundColor={toRGBA(theme.bg)}
        paddingLeft={1}
        paddingRight={1}
      >
        {/* Header */}
        <box flexShrink={0} flexDirection="row" gap={2}>
          <text fg={toRGBA(theme.accent)} attributes={TextAttributes.BOLD}>
            Tasks
          </text>
          <text fg={toRGBA(theme.fgMuted)}>{tasks().length} total</text>
          <Show when={totalActive() > 0}>
            <text fg={toRGBA(theme.gitModified)}>{totalActive()} active</text>
          </Show>
        </box>

        {/* Separator */}
        <box flexShrink={0} height={1}>
          <text fg={toRGBA(theme.border)} wrapMode="none">
            {"─".repeat(Math.max(0, dimensions().width - 2))}
          </text>
        </box>

        {/* Task list */}
        <Show
          when={flatList().length > 0}
          fallback={
            <box paddingLeft={1} paddingTop={1} flexGrow={1}>
              <text fg={toRGBA(theme.fgMuted)}>No tasks yet</text>
              <text fg={toRGBA(theme.border)} paddingTop={1}>
                Press n to create a task
              </text>
              <text fg={toRGBA(theme.border)}>Or add JSON files to .tasks/</text>
            </box>
          }
        >
          <scrollbox flexGrow={1}>
            <For each={groups()}>
              {(group) => (
                <Show when={group.tasks.length > 0}>
                  <box paddingTop={1}>
                    {/* Section header */}
                    <box flexDirection="row" gap={1}>
                      <text
                        fg={toRGBA(statusColor(group.status, theme))}
                        attributes={TextAttributes.BOLD}
                      >
                        {statusLabel(group.status)}
                      </text>
                      <text fg={toRGBA(theme.fgMuted)}>({group.tasks.length})</text>
                    </box>

                    {/* Tasks in section */}
                    <For each={group.tasks}>
                      {(task) => {
                        const isSelected = createMemo(() => selectedTask()?.id === task.id);
                        return (
                          <box
                            backgroundColor={
                              isSelected() ? toRGBA(theme.selected) : RGBA.fromInts(0, 0, 0, 0)
                            }
                            paddingLeft={1}
                            onMouseMove={() => {
                              setInputMode("mouse");
                              const idx = flatList().findIndex((f) => f.task.id === task.id);
                              if (idx !== -1) setSelected(idx);
                            }}
                            onMouseDown={() => {
                              const idx = flatList().findIndex((f) => f.task.id === task.id);
                              if (idx !== -1) setSelected(idx);
                            }}
                          >
                            {/* Task title line */}
                            <box flexDirection="row" gap={1}>
                              <text fg={toRGBA(priorityColor(task.priority, theme))} flexShrink={0}>
                                [P{task.priority}]
                              </text>
                              <text
                                fg={toRGBA(isSelected() ? theme.selectedText : theme.fg)}
                                wrapMode="none"
                              >
                                {task.title}
                              </text>
                            </box>

                            {/* Task metadata line */}
                            <Show when={task.assignee || task.tags.length > 0}>
                              <box flexDirection="row" gap={1} paddingLeft={5}>
                                <Show when={task.assignee}>
                                  <text fg={toRGBA(theme.diffHunk)}>@{task.assignee}</text>
                                </Show>
                                <Show when={task.tags.length > 0}>
                                  <text fg={toRGBA(theme.fgMuted)}>{task.tags.join(" ")}</text>
                                </Show>
                              </box>
                            </Show>
                          </box>
                        );
                      }}
                    </For>
                  </box>
                </Show>
              )}
            </For>
          </scrollbox>
        </Show>

        {/* Detail panel */}
        <Show when={showDetail() && selectedTask()}>
          <box flexShrink={0} height={1}>
            <text fg={toRGBA(theme.border)} wrapMode="none">
              {"─".repeat(Math.max(0, dimensions().width - 2))}
            </text>
          </box>
          <box flexShrink={0} paddingLeft={1}>
            <text fg={toRGBA(theme.fg)} attributes={TextAttributes.BOLD}>
              {selectedTask()!.title}
            </text>
            <Show when={selectedTask()!.description}>
              <text fg={toRGBA(theme.fgMuted)} wrapMode="none">
                {selectedTask()!.description}
              </text>
            </Show>
            <box flexDirection="row" gap={2}>
              <Show when={selectedTask()!.branch}>
                <text fg={toRGBA(theme.diffHunk)}>⎇ {selectedTask()!.branch}</text>
              </Show>
              <Show when={selectedTask()!.assignee}>
                <text fg={toRGBA(theme.diffHunk)}>@{selectedTask()!.assignee}</text>
              </Show>
            </box>
            <Show when={selectedTask()!.proof}>
              <box flexDirection="row" gap={1}>
                <For each={Object.entries(selectedTask()!.proof!)}>
                  {([key, val]) => (
                    <text fg={toRGBA(theme.gitAdded)}>
                      {key}: {val}
                    </text>
                  )}
                </For>
              </box>
            </Show>
          </box>
        </Show>

        {/* Footer */}
        <box flexShrink={0} paddingTop={1}>
          <text fg={toRGBA(theme.fgMuted)} wrapMode="none">
            s:status a:assign c:claude n:new d:detail q:quit
          </text>
        </box>
      </box>
    );
  },
  {
    targetFps: 30,
    exitOnCtrlC: true,
    useKittyKeyboard: {},
    autoFocus: false,
  },
);
