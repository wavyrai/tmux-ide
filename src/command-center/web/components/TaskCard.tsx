import { JSX, Show } from "solid-js";
import type { Task } from "../types.ts";

interface TaskCardProps {
  task: Task;
}

const STATUS_BADGE: Record<string, { bg: string; fg: string }> = {
  "todo": { bg: "rgba(107,99,99,0.2)", fg: "var(--text-muted)" },
  "in-progress": { bg: "rgba(232,201,90,0.12)", fg: "var(--warning)" },
  "review": { bg: "rgba(125,180,232,0.12)", fg: "var(--info)" },
  "done": { bg: "rgba(125,216,125,0.12)", fg: "var(--success)" },
};

const PRIORITY_COLORS: Record<number, string> = {
  1: "var(--error)",
  2: "var(--warning)",
  3: "var(--text-secondary)",
};

export function TaskCard(props: TaskCardProps): JSX.Element {
  const badge = () => STATUS_BADGE[props.task.status] ?? STATUS_BADGE["todo"]!;
  const priorityColor = () => PRIORITY_COLORS[props.task.priority] ?? "var(--text-muted)";

  return (
    <div style={{
      background: "var(--bg-surface)",
      "border-radius": "4px",
      padding: "8px 10px",
      border: "1px solid var(--border)",
      transition: "border-color 0.1s",
    }}>
      <div style={{ display: "flex", "align-items": "flex-start", gap: "6px" }}>
        {/* Priority */}
        <span style={{
          "font-size": "10px",
          "flex-shrink": "0",
          "margin-top": "1px",
          color: priorityColor(),
        }}>
          P{props.task.priority}
        </span>

        {/* Title + meta */}
        <div style={{ "min-width": "0", flex: "1" }}>
          <div style={{ "font-size": "12px", color: "var(--text-primary)", "line-height": "1.3" }}>
            {props.task.title}
          </div>
          <div style={{ display: "flex", "align-items": "center", gap: "6px", "margin-top": "4px" }}>
            <span style={{
              "font-size": "9px",
              "font-weight": "500",
              padding: "1px 6px",
              "border-radius": "3px",
              background: badge().bg,
              color: badge().fg,
            }}>
              {props.task.status}
            </span>
            <Show when={props.task.assignee}>
              <span style={{ "font-size": "10px", color: "var(--text-muted)" }}>@{props.task.assignee}</span>
            </Show>
            <Show when={props.task.depends_on.length > 0}>
              <span style={{ "font-size": "10px", color: "var(--text-muted)" }}>
                deps: {props.task.depends_on.join(", ")}
              </span>
            </Show>
          </div>
        </div>

        {/* ID */}
        <span style={{ "font-size": "10px", color: "var(--text-muted)", "flex-shrink": "0" }}>
          #{props.task.id}
        </span>
      </div>
    </div>
  );
}
