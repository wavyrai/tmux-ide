import { JSX, Show, For } from "solid-js";
import { ProgressBar } from "./ProgressBar.tsx";
import type { SessionOverview } from "../types.ts";

interface ProjectCardProps {
  session: SessionOverview;
  onClick: () => void;
}

export function ProjectCard(props: ProjectCardProps): JSX.Element {
  const pct = () => {
    const s = props.session.stats;
    return s.totalTasks > 0 ? Math.round((s.doneTasks / s.totalTasks) * 100) : 0;
  };

  return (
    <button
      onClick={() => props.onClick()}
      style={{
        "all": "unset",
        "display": "block",
        "width": "100%",
        "text-align": "left",
        "background": "var(--bg-raised)",
        "border": "1px solid var(--border)",
        "border-radius": "6px",
        "padding": "14px 16px",
        "cursor": "pointer",
        "transition": "border-color 0.15s, background 0.15s",
      }}
      onMouseOver={(e) => {
        e.currentTarget.style.borderColor = "var(--border-strong)";
        e.currentTarget.style.background = "var(--bg-surface)";
      }}
      onMouseOut={(e) => {
        e.currentTarget.style.borderColor = "var(--border)";
        e.currentTarget.style.background = "var(--bg-raised)";
      }}
    >
      {/* Header */}
      <div style={{ display: "flex", "align-items": "flex-start", "justify-content": "space-between", "margin-bottom": "10px" }}>
        <div style={{ "min-width": "0", flex: "1" }}>
          <div style={{ "font-size": "13px", "font-weight": "500", color: "var(--text-primary)" }}>
            {props.session.name}
          </div>
          <Show
            when={props.session.mission}
            fallback={<div style={{ "font-size": "11px", color: "var(--text-muted)", "margin-top": "2px" }}>no mission</div>}
          >
            <div style={{ "font-size": "11px", color: "var(--text-secondary)", "margin-top": "2px", overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" }}>
              {props.session.mission!.title}
            </div>
          </Show>
        </div>
        <div style={{ display: "flex", gap: "12px" }}>
          <div style={{ "text-align": "right" }}>
            <div style={{ "font-size": "16px", "font-weight": "500", color: "var(--text-primary)", "line-height": "1" }}>
              {props.session.stats.doneTasks}
              <span style={{ "font-size": "11px", "font-weight": "400", color: "var(--text-muted)" }}>/{props.session.stats.totalTasks}</span>
            </div>
            <div style={{ "font-size": "10px", color: "var(--text-muted)", "margin-top": "2px" }}>tasks</div>
          </div>
          <div style={{ "text-align": "right" }}>
            <div style={{ "font-size": "16px", "font-weight": "500", color: "var(--text-primary)", "line-height": "1" }}>
              {props.session.stats.agents}
            </div>
            <div style={{ "font-size": "10px", color: "var(--text-muted)", "margin-top": "2px" }}>agents</div>
          </div>
        </div>
      </div>

      {/* Progress */}
      <div style={{ "margin-bottom": "10px" }}>
        <ProgressBar percent={pct()} />
      </div>

      {/* Goals */}
      <Show when={props.session.goals.length > 0}>
        <div style={{ "margin-top": "10px", "padding-top": "10px", "border-top": "1px solid var(--border)", display: "flex", "flex-direction": "column", gap: "6px" }}>
          <For each={props.session.goals}>
            {(goal) => (
              <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>
                <span style={{ flex: "1", "font-size": "11px", color: "var(--text-secondary)", overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" }}>
                  {goal.title}
                </span>
                <div style={{ width: "80px" }}>
                  <ProgressBar percent={goal.progress} />
                </div>
                <span style={{ width: "32px", "text-align": "right", "font-size": "10px", color: "var(--text-muted)" }}>
                  {goal.progress}%
                </span>
              </div>
            )}
          </For>
        </div>
      </Show>
    </button>
  );
}
