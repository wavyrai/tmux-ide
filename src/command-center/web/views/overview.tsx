import { JSX, For, Show, createSignal, createMemo } from "solid-js";
import { ProjectCard } from "../components/ProjectCard.tsx";
import type { SessionOverview } from "../types.ts";

interface OverviewProps {
  sessions: SessionOverview[];
  onSelectProject: (name: string) => void;
}

export function Overview(props: OverviewProps): JSX.Element {
  const [filter, setFilter] = createSignal("");

  const filtered = createMemo(() => {
    const q = filter().toLowerCase();
    if (!q) return props.sessions;
    return props.sessions.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        (s.mission?.title ?? "").toLowerCase().includes(q),
    );
  });

  const totalAgents = createMemo(() =>
    props.sessions.reduce((sum, s) => sum + s.stats.agents, 0),
  );
  const activeAgents = createMemo(() =>
    props.sessions.reduce((sum, s) => sum + s.stats.activeAgents, 0),
  );
  const totalTasks = createMemo(() =>
    props.sessions.reduce((sum, s) => sum + s.stats.totalTasks, 0),
  );
  const doneTasks = createMemo(() =>
    props.sessions.reduce((sum, s) => sum + s.stats.doneTasks, 0),
  );

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
        <div style={{
          "max-width": "680px",
          margin: "0 auto",
          padding: "10px 16px",
        }}>
          <div style={{ display: "flex", "align-items": "center", "justify-content": "space-between" }}>
            <div>
              <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>
                <span style={{ color: "var(--accent)", "font-weight": "500", "font-size": "13px" }}>
                  tmux-ide
                </span>
                <span style={{ color: "var(--text-muted)", "font-size": "12px" }}>/</span>
                <span style={{ color: "var(--text-muted)", "font-size": "12px" }}>command center</span>
              </div>
              <div style={{ "font-size": "11px", color: "var(--text-muted)", "margin-top": "4px", display: "flex", gap: "12px" }}>
                <span>
                  <span style={{ color: "var(--text-secondary)", "font-weight": "500" }}>{props.sessions.length}</span> projects
                </span>
                <span>
                  <span style={{ color: "var(--success)", "font-weight": "500" }}>{activeAgents()}</span>/{totalAgents()} agents
                </span>
                <span>
                  <span style={{ color: "var(--text-secondary)", "font-weight": "500" }}>{doneTasks()}</span>/{totalTasks()} tasks
                </span>
              </div>
            </div>
            <Show when={props.sessions.length > 3}>
              <input
                type="text"
                placeholder="Filter..."
                value={filter()}
                onInput={(e) => setFilter(e.currentTarget.value)}
                style={{
                  background: "var(--bg-surface)",
                  border: "1px solid var(--border)",
                  "border-radius": "4px",
                  padding: "4px 8px",
                  "font-size": "11px",
                  "font-family": "var(--font)",
                  color: "var(--text-primary)",
                  width: "160px",
                  outline: "none",
                }}
              />
            </Show>
          </div>
        </div>
      </header>

      {/* Card list */}
      <main style={{ "max-width": "680px", margin: "0 auto", padding: "20px 16px" }}>
        <Show
          when={filtered().length > 0}
          fallback={
            <div style={{ "text-align": "center", padding: "64px 0" }}>
              <div style={{ color: "var(--text-muted)", "font-size": "12px" }}>
                {props.sessions.length === 0
                  ? "No tmux-ide sessions running."
                  : "No projects match your filter."}
              </div>
              <Show when={props.sessions.length === 0}>
                <div style={{ color: "var(--text-muted)", "font-size": "11px", "margin-top": "4px" }}>
                  Start a project with tmux-ide to see it here.
                </div>
              </Show>
            </div>
          }
        >
          <div style={{ display: "flex", "flex-direction": "column", gap: "8px" }}>
            <For each={filtered()}>
              {(session) => (
                <ProjectCard
                  session={session}
                  onClick={() => props.onSelectProject(session.name)}
                />
              )}
            </For>
          </div>
        </Show>
      </main>
    </div>
  );
}
