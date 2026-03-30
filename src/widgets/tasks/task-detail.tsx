import { Show, For } from "solid-js";
import { RGBA, TextAttributes } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/solid";
import {
  updateTaskStatus,
  updateTaskAssignee,
  isBlocked,
  type Task,
  type TaskStatus,
} from "./task-model.ts";
import {
  sendCommand,
  findPaneByTitle,
  findPaneByPattern,
  listSessionPanes,
} from "../lib/pane-comms.ts";
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

interface TaskDetailProps {
  task: Task;
  allTasks: Task[];
  session: string;
  dir: string;
  target: string | null;
  onBack: () => void;
  onEdit: (task: Task) => void;
  onTaskUpdate: () => void;
  theme: WidgetTheme;
}

export function TaskDetail(props: TaskDetailProps) {
  const dimensions = useTerminalDimensions();
  const t = () => props.task;
  const theme = props.theme;

  const canStart = () => t().status === "todo";
  const canDone = () => t().status === "in-progress" || t().status === "review";
  const canReview = () => t().status === "in-progress";

  function resolveTargetPane(): string | null {
    if (!props.session) return null;
    if (props.target) return findPaneByTitle(props.session, props.target);
    return findPaneByPattern(props.session, "claude");
  }

  function findClaudePane(): { id: string; title: string } | null {
    if (!props.session) return null;
    const panes = listSessionPanes(props.session);
    const claude = panes.find(
      (p) =>
        p.currentCommand.toLowerCase() === "claude" || p.title.toLowerCase().includes("claude"),
    );
    return claude ? { id: claude.id, title: claude.title } : null;
  }

  useKeyboard((evt) => {
    if (
      evt.name === "escape" ||
      evt.name === "backspace" ||
      evt.name === "h" ||
      evt.name === "left"
    ) {
      props.onBack();
      evt.preventDefault();
    } else if (evt.name === "e") {
      props.onEdit(t());
      evt.preventDefault();
    } else if (evt.name === "s" && canStart()) {
      updateTaskStatus(props.dir, t().id, "in-progress");
      props.onTaskUpdate();
      evt.preventDefault();
    } else if (evt.name === "d" && canDone()) {
      updateTaskStatus(props.dir, t().id, "done");
      props.onTaskUpdate();
      evt.preventDefault();
    } else if (evt.name === "v" && canReview()) {
      updateTaskStatus(props.dir, t().id, "review");
      props.onTaskUpdate();
      evt.preventDefault();
    } else if (evt.name === "a") {
      const claude = findClaudePane();
      if (claude) {
        updateTaskAssignee(props.dir, t().id, claude.title);
        props.onTaskUpdate();
      }
      evt.preventDefault();
    } else if (evt.name === "c") {
      const targetId = resolveTargetPane();
      if (targetId) {
        const task = t();
        const prompt = `Work on this task:\n\nTitle: ${task.title}\nDescription: ${task.description}\nPriority: P${task.priority}${task.tags.length > 0 ? `\nTags: ${task.tags.join(", ")}` : ""}`;
        sendCommand(props.session, targetId, prompt);
        if (task.status === "todo") {
          updateTaskStatus(props.dir, task.id, "in-progress");
          props.onTaskUpdate();
        }
      }
      evt.preventDefault();
    } else if (evt.name === "q") {
      props.onBack();
      evt.preventDefault();
    }
  });

  const sColor = () => statusColor(t().status, theme);
  const blocked = () => isBlocked(t(), props.allTasks);

  return (
    <box paddingLeft={1} paddingRight={1}>
      {/* Back bar */}
      <box flexShrink={0} flexDirection="row" justifyContent="space-between">
        <text fg={toRGBA(theme.fgMuted)} onMouseUp={() => props.onBack()}>
          {"< Esc:back"}
        </text>
        <text fg={toRGBA(theme.fgMuted)}>Task {t().id}</text>
      </box>

      {/* Title */}
      <box flexShrink={0} paddingTop={1} flexDirection="row" gap={1}>
        <text fg={toRGBA(sColor())} flexShrink={0}>
          {priorityDots(t().priority)}
        </text>
        <text fg={toRGBA(theme.fg)} attributes={TextAttributes.BOLD}>
          {t().title}
        </text>
      </box>

      {/* Status + assignee + blocked */}
      <box flexShrink={0} paddingTop={1} flexDirection="row" gap={2}>
        <text fg={toRGBA(sColor())}>{statusLabel(t().status)}</text>
        <Show when={blocked()}>
          <text fg={toRGBA(theme.gitRemoved)}>BLOCKED</text>
        </Show>
        <Show when={t().assignee}>
          <text fg={toRGBA(theme.fgMuted)}>@{t().assignee}</text>
        </Show>
      </box>

      {/* Dependencies */}
      <Show when={t().depends_on.length > 0}>
        <box flexShrink={0} flexDirection="row" gap={1}>
          <text fg={toRGBA(theme.fgMuted)}>depends:</text>
          <For each={t().depends_on}>
            {(depId) => {
              const dep = props.allTasks.find((x) => x.id === depId);
              const done = dep?.status === "done";
              return (
                <text fg={toRGBA(done ? theme.gitAdded : theme.gitRemoved)}>
                  {depId}
                  {done ? " ok" : ""}
                </text>
              );
            }}
          </For>
        </box>
      </Show>

      {/* Branch + tags */}
      <Show when={t().branch || t().tags.length > 0}>
        <box flexShrink={0} flexDirection="row" gap={2}>
          <Show when={t().branch}>
            <text fg={toRGBA(theme.fgMuted)}>{t().branch}</text>
          </Show>
          <Show when={t().tags.length > 0}>
            <text fg={toRGBA(theme.fgMuted)}>{t().tags.join(", ")}</text>
          </Show>
        </box>
      </Show>

      {/* Description */}
      <box flexShrink={0} paddingTop={1}>
        <text fg={toRGBA(t().description ? theme.fg : theme.fgMuted)}>
          {t().description || "(no description)"}
        </text>
      </box>

      {/* Proof */}
      <Show when={t().proof}>
        <box flexShrink={0} paddingTop={1}>
          <text fg={toRGBA(theme.fgMuted)}>Proof:</text>
          <For each={Object.entries(t().proof!)}>
            {([key, val]) => (
              <text fg={toRGBA(theme.gitAdded)} paddingLeft={1}>
                {key}: {typeof val === "object" ? JSON.stringify(val) : String(val)}
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
      <box flexShrink={0} flexDirection="row" gap={2}>
        <text fg={toRGBA(theme.fgMuted)} onMouseUp={() => props.onEdit(t())} wrapMode="none">
          e:edit
        </text>
        <Show when={canStart()}>
          <text
            fg={toRGBA(theme.fgMuted)}
            onMouseUp={() => {
              updateTaskStatus(props.dir, t().id, "in-progress");
              props.onTaskUpdate();
            }}
            wrapMode="none"
          >
            s:start
          </text>
        </Show>
        <Show when={canReview()}>
          <text
            fg={toRGBA(theme.fgMuted)}
            onMouseUp={() => {
              updateTaskStatus(props.dir, t().id, "review");
              props.onTaskUpdate();
            }}
            wrapMode="none"
          >
            v:review
          </text>
        </Show>
        <Show when={canDone()}>
          <text
            fg={toRGBA(theme.fgMuted)}
            onMouseUp={() => {
              updateTaskStatus(props.dir, t().id, "done");
              props.onTaskUpdate();
            }}
            wrapMode="none"
          >
            d:done
          </text>
        </Show>
        <text
          fg={toRGBA(theme.fgMuted)}
          onMouseUp={() => {
            const claude = findClaudePane();
            if (claude) {
              updateTaskAssignee(props.dir, t().id, claude.title);
              props.onTaskUpdate();
            }
          }}
          wrapMode="none"
        >
          a:assign
        </text>
      </box>
    </box>
  );
}
