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
  updateTaskField,
  createTask,
  nextStatus,
  flattenTaskList,
  ensureTasksDir,
  getTasksDir,
  type Task,
  type TaskStatus,
  type FlatItem,
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
      return theme.gitModified;    // yellow — the one accent
    case "todo":
      return theme.fgMuted;        // dim
    case "review":
      return theme.diffHunk;       // cyan
    case "done":
      return theme.gitAdded;       // green
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
    case 1:  return "***";
    case 2:  return "** ";
    case 3:  return "*  ";
    default: return "   ";
  }
}

render(
  () => {
    const theme = createTheme(themeConfig);
    const dimensions = useTerminalDimensions();
    const [tasks, setTasks] = createSignal(loadTasks(dir));
    const [selected, setSelected] = createSignal(0);
    const [showDetail, setShowDetail] = createSignal(true);
    const [zoomedTask, setZoomedTask] = createSignal<Task | null>(null);
    const [editField, setEditField] = createSignal<"title" | "description" | null>(null);
    const [editValue, setEditValue] = createSignal("");
    const [inputMode, setInputMode] = createSignal<"keyboard" | "mouse">("keyboard");

    const groups = createMemo(() => groupTasks(tasks()));
    const flatList = createMemo(() => flattenTaskList(groups()));
    const selectedItem = createMemo(() => flatList()[selected()] ?? null);
    const selectedTask = createMemo(() => {
      const item = selectedItem();
      return item?.kind === "task" ? item.task : null;
    });

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
      const zoomed = zoomedTask();

      // === EDIT MODE KEYS ===
      if (editField() !== null) {
        if (evt.name === "escape") {
          setEditField(null);
          evt.preventDefault();
        } else if (evt.name === "return") {
          // Save
          if (zoomed && editValue()) {
            const field = editField()!;
            updateTaskField(dir, zoomed.id, { [field]: editValue() });
            setZoomedTask({ ...zoomed, [field]: editValue() });
            reload();
          }
          setEditField(null);
          evt.preventDefault();
        } else if (evt.name === "backspace") {
          setEditValue(v => v.slice(0, -1));
          evt.preventDefault();
        } else if (evt.name.length === 1 && !evt.ctrl && !evt.alt && !evt.meta) {
          setEditValue(v => v + evt.name);
          evt.preventDefault();
        }
        return;
      }

      // === ZOOMED VIEW KEYS ===
      if (zoomed) {
        if (evt.name === "escape" || evt.name === "backspace" || evt.name === "h" || evt.name === "left") {
          setZoomedTask(null);
          evt.preventDefault();
        } else if (evt.name === "t") {
          // Edit title
          setEditValue(zoomed.title);
          setEditField("title");
          evt.preventDefault();
        } else if (evt.name === "e") {
          // Edit description
          setEditValue(zoomed.description);
          setEditField("description");
          evt.preventDefault();
        } else if (evt.name === "s" && zoomed.status === "todo") {
          // Start: todo → in-progress
          updateTaskStatus(dir, zoomed.id, "in-progress");
          reload();
          setZoomedTask({ ...zoomed, status: "in-progress" });
          evt.preventDefault();
        } else if (evt.name === "d" && (zoomed.status === "in-progress" || zoomed.status === "review")) {
          // Done: in-progress/review → done
          updateTaskStatus(dir, zoomed.id, "done");
          reload();
          setZoomedTask({ ...zoomed, status: "done" });
          evt.preventDefault();
        } else if (evt.name === "v" && zoomed.status === "in-progress") {
          // Review: in-progress → review
          updateTaskStatus(dir, zoomed.id, "review");
          reload();
          setZoomedTask({ ...zoomed, status: "review" });
          evt.preventDefault();
        } else if (evt.name === "a") {
          const claude = findClaudePane();
          if (claude) {
            updateTaskAssignee(dir, zoomed.id, claude.title);
            reload();
            setZoomedTask({ ...zoomed, assignee: claude.title });
          }
          evt.preventDefault();
        } else if (evt.name === "c") {
          // Send to Claude — intentional from zoom view
          const targetId = resolveTargetPane();
          if (targetId) {
            const prompt = `Work on this task:\n\nTitle: ${zoomed.title}\nDescription: ${zoomed.description}\nPriority: P${zoomed.priority}${zoomed.tags.length > 0 ? `\nTags: ${zoomed.tags.join(", ")}` : ""}`;
            sendCommand(session, targetId, prompt);
            if (zoomed.status === "todo") {
              updateTaskStatus(dir, zoomed.id, "in-progress");
              reload();
              setZoomedTask({ ...zoomed, status: "in-progress" });
            }
          }
          evt.preventDefault();
        } else if (evt.name === "q") {
          setZoomedTask(null);
          evt.preventDefault();
        }
        return;
      }

      // === LIST VIEW KEYS ===
      // Skip headers when navigating
      function moveSelection(direction: number) {
        let next = selected() + direction;
        while (next >= 0 && next < list.length && list[next]?.kind === "header") {
          next += direction;
        }
        if (next >= 0 && next < list.length) setSelected(next);
      }

      if (evt.name === "up" || evt.name === "k") {
        moveSelection(-1);
        evt.preventDefault();
      } else if (evt.name === "down" || evt.name === "j") {
        moveSelection(1);
        evt.preventDefault();
      } else if (evt.name === "return" || evt.name === "l" || evt.name === "right") {
        if (task) setZoomedTask(task);
        evt.preventDefault();
      } else if (evt.name === "n") {
        createTask(dir, tasks());
        reload();
        setSelected(list.length);
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
        {/* Header bar */}
        <Show when={!zoomedTask()}>
          <box flexShrink={0} flexDirection="row" justifyContent="space-between" paddingBottom={1}>
            <box flexDirection="row" gap={1}>
              <text fg={toRGBA(theme.fg)} attributes={TextAttributes.BOLD}>Tasks</text>
              <text fg={toRGBA(theme.fgMuted)}>{tasks().length}</text>
            </box>
            <text fg={toRGBA(theme.fgMuted)}>Enter:open  n:new  q:quit</text>
          </box>
        </Show>

        {/* Task list */}
        <Show
          when={flatList().length > 0}
          fallback={
            <box paddingLeft={1} paddingTop={1} flexGrow={1}>
              <text fg={toRGBA(theme.fgMuted)}>No tasks yet. Press n to create one.</text>
            </box>
          }
        >
          <scrollbox flexGrow={1}>
            <For each={flatList()}>
              {(item, index) => {
                if (item.kind === "header") {
                  return (
                    <box paddingTop={1} paddingLeft={1}
                      onMouseMove={() => setInputMode("mouse")}
                    >
                      <text fg={toRGBA(theme.fgMuted)}>
                        {statusLabel(item.status)} ({item.count})
                      </text>
                    </box>
                  );
                }

                const task = item.task;
                const isSelected = createMemo(() => index() === selected());
                const sColor = statusColor(task.status, theme);
                return (
                  <box
                    backgroundColor={
                      isSelected() ? toRGBA(theme.selected) : RGBA.fromInts(0, 0, 0, 0)
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
                      if (t) setZoomedTask(t);
                    }}
                  >
                    <text fg={toRGBA(sColor)} flexShrink={0} wrapMode="none">
                      {priorityDots(task.priority)}{" "}
                    </text>
                    <text
                      fg={toRGBA(isSelected() ? theme.selectedText : theme.fg)}
                      wrapMode="none"
                      flexGrow={1}
                    >
                      {task.title}
                    </text>
                    <Show when={task.status === "done"}>
                      <text fg={toRGBA(sColor)} flexShrink={0}>{" ok"}</text>
                    </Show>
                    <Show when={task.assignee && task.status !== "done"}>
                      <text fg={toRGBA(theme.fgMuted)} flexShrink={0} wrapMode="none">
                        {" @"}{task.assignee}
                      </text>
                    </Show>
                  </box>
                );
              }}
            </For>
          </scrollbox>
        </Show>

        {/* Zoomed task view — replaces everything when active */}
        <Show when={zoomedTask()}>
          {(() => {
            const t = zoomedTask()!;
            const sColor = statusColor(t.status, theme);

            // Compute available actions based on status
            const canStart = t.status === "todo";
            const canDone = t.status === "in-progress" || t.status === "review";
            const canReview = t.status === "in-progress";

            return (
              <box position="absolute" left={0} top={0}
                width={dimensions().width} height={dimensions().height}
                backgroundColor={toRGBA(theme.bg)} paddingLeft={1} paddingRight={1}
              >
                {/* Back bar */}
                <box flexShrink={0} flexDirection="row" justifyContent="space-between">
                  <text fg={toRGBA(theme.fgMuted)}>{"< Esc:back"}</text>
                  <text fg={toRGBA(theme.fgMuted)}>Task {t.id}</text>
                </box>

                {/* Title */}
                <box flexShrink={0} paddingTop={1} flexDirection="row" gap={1}>
                  <text fg={toRGBA(sColor)} flexShrink={0}>{priorityDots(t.priority)}</text>
                  <Show when={editField() === "title"} fallback={
                    <text fg={toRGBA(theme.fg)} attributes={TextAttributes.BOLD}>
                      {t.title}
                    </text>
                  }>
                    <text fg={toRGBA(theme.accent)} attributes={TextAttributes.BOLD}>
                      {editValue()}_
                    </text>
                  </Show>
                </box>

                {/* Status + assignee */}
                <box flexShrink={0} paddingTop={1} flexDirection="row" gap={2}>
                  <text fg={toRGBA(sColor)}>
                    {statusLabel(t.status)}
                  </text>
                  <Show when={t.assignee}>
                    <text fg={toRGBA(theme.fgMuted)}>@{t.assignee}</text>
                  </Show>
                </box>

                {/* Branch + tags */}
                <Show when={t.branch || t.tags.length > 0}>
                  <box flexShrink={0} flexDirection="row" gap={2}>
                    <Show when={t.branch}>
                      <text fg={toRGBA(theme.fgMuted)}>{t.branch}</text>
                    </Show>
                    <Show when={t.tags.length > 0}>
                      <text fg={toRGBA(theme.fgMuted)}>{t.tags.join(", ")}</text>
                    </Show>
                  </box>
                </Show>

                {/* Description */}
                <box flexShrink={0} paddingTop={1}>
                  <Show when={editField() === "description"} fallback={
                    <text fg={toRGBA(t.description ? theme.fg : theme.fgMuted)}>
                      {t.description || "(no description)"}
                    </text>
                  }>
                    <text fg={toRGBA(theme.accent)}>
                      {editValue()}_
                    </text>
                  </Show>
                </box>

                {/* Proof */}
                <Show when={t.proof}>
                  <box flexShrink={0} paddingTop={1}>
                    <text fg={toRGBA(theme.fgMuted)}>Proof:</text>
                    <For each={Object.entries(t.proof!)}>
                      {([key, val]) => (
                        <text fg={toRGBA(theme.gitAdded)} paddingLeft={1}>
                          {key}: {val}
                        </text>
                      )}
                    </For>
                  </box>
                </Show>

                {/* Spacer */}
                <box flexGrow={1} />

                {/* Separator */}
                <box flexShrink={0} height={1}>
                  <text fg={toRGBA(theme.border)} wrapMode="none">
                    {"─".repeat(Math.max(0, dimensions().width - 2))}
                  </text>
                </box>

                {/* Actions footer */}
                <box flexShrink={0} paddingTop={0}>
                  <Show when={editField() !== null} fallback={
                    <text fg={toRGBA(theme.fgMuted)} wrapMode="none">
                      {[
                        "t:title",
                        "e:description",
                        canStart ? "s:start" : null,
                        canReview ? "v:review" : null,
                        canDone ? "d:done" : null,
                        "a:assign",
                        "c:claude",
                      ].filter(Boolean).join("  ")}
                    </text>
                  }>
                    <text fg={toRGBA(theme.fgMuted)} wrapMode="none">
                      editing {editField()}  Enter:save  Esc:cancel
                    </text>
                  </Show>
                </box>
              </box>
            );
          })()}
        </Show>
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
