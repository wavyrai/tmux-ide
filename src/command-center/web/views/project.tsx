import { JSX, For, Show, createMemo } from "solid-js";
import { ProgressBar } from "../components/ProgressBar.tsx";
import { AgentCard } from "../components/AgentCard.tsx";
import { TaskRow } from "../components/TaskRow.tsx";
import { ActivityFeed } from "../components/ActivityFeed.tsx";
import type { ProjectDetail, Task } from "../types.ts";

interface ProjectViewProps {
  project: ProjectDetail;
  onBack: () => void;
}

const STATUS_ORDER = ["in-progress", "todo", "review", "done"] as const;

export function ProjectView(props: ProjectViewProps): JSX.Element {
  const pct = () => {
    const tasks = props.project.tasks;
    if (tasks.length === 0) return 0;
    const done = tasks.filter((t) => t.status === "done").length;
    return Math.round((done / tasks.length) * 100);
  };

  const sortedTasks = createMemo(() => {
    const order: Record<string, number> = {
      "in-progress": 0,
      "todo": 1,
      "review": 2,
      "done": 3,
    };
    return [...props.project.tasks].sort((a, b) => {
      const d = (order[a.status] ?? 9) - (order[b.status] ?? 9);
      return d !== 0 ? d : a.priority - b.priority;
    });
  });

  const goalProgress = (goalId: string) => {
    const goalTasks = props.project.tasks.filter((t) => t.goal === goalId);
    if (goalTasks.length === 0) return 0;
    return Math.round(
      (goalTasks.filter((t) => t.status === "done").length / goalTasks.length) * 100,
    );
  };

  const sectionTitleStyle = (): Record<string, string> => ({
    "font-size": "10px",
    "font-weight": "600",
    color: "var(--text-muted)",
    "text-transform": "uppercase",
    "letter-spacing": "0.05em",
    "margin-bottom": "8px",
  });

  return (
    <div style={{ "min-height": "100vh" }}>
      {/* Header */}
      <header style={{
        "border-bottom": "1px solid var(--border)",
        background: "var(--bg-raised)",
        position: "sticky",
        top: "0",
        "z-index": "10",
      }}>
        <div style={{ "max-width": "960px", margin: "0 auto", padding: "10px 16px" }}>
          <div style={{ display: "flex", "align-items": "center", gap: "12px" }}>
            <button
              onClick={() => props.onBack()}
              style={{
                all: "unset",
                cursor: "pointer",
                color: "var(--text-muted)",
                "font-size": "12px",
                "font-family": "var(--font)",
                transition: "color 0.1s",
              }}
              onMouseOver={(e) => { e.currentTarget.style.color = "var(--text-primary)"; }}
              onMouseOut={(e) => { e.currentTarget.style.color = "var(--text-muted)"; }}
            >
              &larr; back
            </button>
            <div style={{ flex: "1", "min-width": "0" }}>
              <div style={{ "font-size": "14px", "font-weight": "500" }}>
                {props.project.session}
              </div>
              <Show when={props.project.mission}>
                <div style={{ "font-size": "11px", color: "var(--text-secondary)", "margin-top": "2px" }}>
                  {props.project.mission!.title}
                </div>
              </Show>
            </div>
            <div style={{ "text-align": "right", "flex-shrink": "0" }}>
              <div style={{ "font-size": "12px", color: "var(--text-secondary)", "font-weight": "500" }}>
                {pct()}%
              </div>
              <div style={{ "font-size": "10px", color: "var(--text-muted)", "margin-top": "1px" }}>
                {props.project.tasks.filter((t) => t.status === "done").length}/{props.project.tasks.length} tasks
              </div>
            </div>
          </div>
          <div style={{ "margin-top": "8px" }}>
            <ProgressBar percent={pct()} />
          </div>
        </div>
      </header>

      <main style={{ "max-width": "960px", margin: "0 auto", padding: "20px 16px" }}>
        <div style={{
          display: "grid",
          "grid-template-columns": "280px 1fr",
          gap: "20px",
        }}>
          {/* Left column: Goals + Agents */}
          <div>
            {/* Goals */}
            <Show when={props.project.goals.length > 0}>
              <div style={{ "margin-bottom": "16px" }}>
                <div style={sectionTitleStyle()}>goals</div>
                <For each={props.project.goals}>
                  {(goal) => (
                    <div style={{ "margin-bottom": "8px" }}>
                      <div style={{ display: "flex", "justify-content": "space-between", "margin-bottom": "3px" }}>
                        <span style={{ "font-size": "11px", color: "var(--text-secondary)" }}>
                          {goal.title}
                        </span>
                        <span style={{ "font-size": "10px", color: "var(--text-muted)" }}>
                          {goalProgress(goal.id)}%
                        </span>
                      </div>
                      <ProgressBar percent={goalProgress(goal.id)} />
                    </div>
                  )}
                </For>
              </div>
            </Show>

            {/* Agents */}
            <div style={{ "margin-bottom": "16px" }}>
              <div style={sectionTitleStyle()}>agents ({props.project.agents.length})</div>
              <Show
                when={props.project.agents.length > 0}
                fallback={<div style={{ "font-size": "11px", color: "var(--text-muted)" }}>No agents detected</div>}
              >
                <div style={{ display: "flex", "flex-direction": "column", gap: "4px" }}>
                  <For each={props.project.agents}>
                    {(agent) => <AgentCard agent={agent} />}
                  </For>
                </div>
              </Show>
            </div>

            {/* Activity */}
            <div>
              <ActivityFeed entries={props.project.activity ?? []} maxItems={8} />
            </div>
          </div>

          {/* Right column: Tasks */}
          <div>
            <div style={sectionTitleStyle()}>tasks ({props.project.tasks.length})</div>
            <Show
              when={sortedTasks().length > 0}
              fallback={<div style={{ "font-size": "11px", color: "var(--text-muted)" }}>No tasks</div>}
            >
              <div style={{ display: "flex", "flex-direction": "column", gap: "2px" }}>
                <For each={sortedTasks()}>
                  {(task) => <TaskRow task={task} />}
                </For>
              </div>
            </Show>
          </div>
        </div>
      </main>
    </div>
  );
}
