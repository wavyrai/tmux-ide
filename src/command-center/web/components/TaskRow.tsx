import { JSX, Show } from "solid-js";
import type { Task } from "../types.ts";

interface TaskRowProps {
  task: Task;
}

const STATUS_DOT_COLORS: Record<string, string> = {
  "todo": "var(--text-muted)",
  "in-progress": "var(--warning)",
  "review": "var(--info)",
  "done": "var(--success)",
};

const STATUS_BADGE: Record<string, { bg: string; fg: string }> = {
  "todo": { bg: "rgba(107,99,99,0.2)", fg: "var(--text-muted)" },
  "in-progress": { bg: "rgba(232,201,90,0.12)", fg: "var(--warning)" },
  "review": { bg: "rgba(125,180,232,0.12)", fg: "var(--info)" },
  "done": { bg: "rgba(125,216,125,0.12)", fg: "var(--success)" },
};

export function TaskRow(props: TaskRowProps): JSX.Element {
  const dotColor = () => STATUS_DOT_COLORS[props.task.status] ?? "var(--text-muted)";
  const badge = () => STATUS_BADGE[props.task.status] ?? STATUS_BADGE["todo"]!;

  return (
    <div
      style={{
        display: "flex",
        "align-items": "center",
        gap: "8px",
        padding: "6px 8px",
        "border-radius": "4px",
        background: "var(--bg-surface)",
        transition: "background 0.1s",
      }}
      onMouseOver={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
      onMouseOut={(e) => { e.currentTarget.style.background = "var(--bg-surface)"; }}
    >
      {/* Status dot */}
      <span style={{
        width: "6px",
        height: "6px",
        "border-radius": "50%",
        "flex-shrink": "0",
        background: dotColor(),
      }} />

      {/* Task ID */}
      <span style={{
        "font-size": "10px",
        color: "var(--text-muted)",
        width: "32px",
        "flex-shrink": "0",
      }}>
        #{props.task.id}
      </span>

      {/* Title */}
      <span style={{
        flex: "1",
        "font-size": "12px",
        color: "var(--text-primary)",
        overflow: "hidden",
        "text-overflow": "ellipsis",
        "white-space": "nowrap",
      }}>
        {props.task.title}
      </span>

      {/* Assignee */}
      <Show when={props.task.assignee}>
        <span style={{
          "font-size": "10px",
          color: "var(--text-muted)",
          "max-width": "80px",
          overflow: "hidden",
          "text-overflow": "ellipsis",
          "white-space": "nowrap",
        }}>
          {props.task.assignee}
        </span>
      </Show>

      {/* Status label */}
      <span style={{
        "font-size": "9px",
        "font-weight": "500",
        padding: "1px 6px",
        "border-radius": "3px",
        "flex-shrink": "0",
        "text-transform": "uppercase",
        background: badge().bg,
        color: badge().fg,
      }}>
        {props.task.status}
      </span>
    </div>
  );
}
