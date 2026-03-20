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
    <div class="min-h-screen bg-gray-950">
      {/* Header */}
      <header class="border-b border-gray-800 bg-gray-950/80 backdrop-blur-sm sticky top-0 z-10">
        <div class="max-w-7xl mx-auto px-6 py-4">
          <div class="flex items-center justify-between">
            <div>
              <h1 class="text-gray-100 text-xl font-bold">Command Center</h1>
              <p class="text-gray-500 text-sm mt-0.5">
                {props.sessions.length} project{props.sessions.length !== 1 ? "s" : ""}
                {" · "}
                <span class="text-green-400">{activeAgents()}</span>/{totalAgents()} agents
                {" · "}
                {doneTasks()}/{totalTasks()} tasks
              </p>
            </div>
            <Show when={props.sessions.length > 3}>
              <input
                type="text"
                placeholder="Filter projects..."
                value={filter()}
                onInput={(e) => setFilter(e.currentTarget.value)}
                class="bg-gray-900 border border-gray-800 rounded-lg px-3 py-1.5 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-gray-600 w-48"
              />
            </Show>
          </div>
        </div>
      </header>

      {/* Grid */}
      <main class="max-w-7xl mx-auto px-6 py-6">
        <Show
          when={filtered().length > 0}
          fallback={
            <div class="text-center py-20">
              <p class="text-gray-500 text-lg">
                {props.sessions.length === 0
                  ? "No tmux-ide sessions found"
                  : "No projects match your filter"}
              </p>
              <p class="text-gray-600 text-sm mt-1">
                {props.sessions.length === 0
                  ? "Start a project with tmux-ide to see it here."
                  : "Try a different search term."}
              </p>
            </div>
          }
        >
          <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
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
