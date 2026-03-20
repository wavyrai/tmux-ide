import { JSX, For, Show, createMemo } from "solid-js";
import { ProgressBar } from "../components/ProgressBar.tsx";
import { AgentCard } from "../components/AgentCard.tsx";
import { TaskCard } from "../components/TaskCard.tsx";
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

  const tasksByStatus = createMemo(() => {
    const groups: Record<string, Task[]> = {};
    for (const s of STATUS_ORDER) groups[s] = [];
    for (const t of props.project.tasks) {
      (groups[t.status] ??= []).push(t);
    }
    // Sort each group by priority
    for (const g of Object.values(groups)) {
      g.sort((a, b) => a.priority - b.priority);
    }
    return groups;
  });

  const goalProgress = (goalId: string) => {
    const goalTasks = props.project.tasks.filter((t) => t.goal === goalId);
    if (goalTasks.length === 0) return 0;
    return Math.round(
      (goalTasks.filter((t) => t.status === "done").length / goalTasks.length) * 100,
    );
  };

  return (
    <div class="min-h-screen bg-gray-950">
      {/* Header */}
      <header class="border-b border-gray-800 bg-gray-950/80 backdrop-blur-sm sticky top-0 z-10">
        <div class="max-w-7xl mx-auto px-6 py-4">
          <div class="flex items-center gap-4">
            <button
              onClick={() => props.onBack()}
              class="text-gray-400 hover:text-gray-200 transition-colors text-sm flex items-center gap-1"
            >
              <span>←</span> Back
            </button>
            <div class="flex-1 min-w-0">
              <h1 class="text-gray-100 text-xl font-bold truncate">
                {props.project.session}
              </h1>
              <Show when={props.project.mission}>
                <p class="text-gray-400 text-sm truncate">
                  {props.project.mission!.title}
                </p>
              </Show>
            </div>
            <div class="text-right shrink-0">
              <div class="text-gray-200 text-sm font-medium">{pct()}%</div>
              <div class="text-gray-500 text-xs">
                {props.project.tasks.filter((t) => t.status === "done").length}/
                {props.project.tasks.length} tasks
              </div>
            </div>
          </div>
          <ProgressBar percent={pct()} size="sm" class="mt-3" />
        </div>
      </header>

      <main class="max-w-7xl mx-auto px-6 py-6">
        <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left column: Goals + Agents */}
          <div class="space-y-6">
            {/* Goals */}
            <Show when={props.project.goals.length > 0}>
              <section>
                <h2 class="text-gray-300 text-sm font-semibold uppercase tracking-wider mb-3">
                  Goals
                </h2>
                <div class="space-y-3">
                  <For each={props.project.goals}>
                    {(goal) => (
                      <div class="bg-gray-900 rounded-lg p-3 border border-gray-800">
                        <div class="flex items-center justify-between mb-1.5">
                          <span class="text-gray-200 text-sm font-medium truncate">
                            {goal.title}
                          </span>
                          <span class="text-gray-500 text-xs shrink-0 ml-2">
                            P{goal.priority}
                          </span>
                        </div>
                        <ProgressBar percent={goalProgress(goal.id)} size="sm" />
                        <div class="text-gray-500 text-xs mt-1">
                          {goalProgress(goal.id)}%
                        </div>
                      </div>
                    )}
                  </For>
                </div>
              </section>
            </Show>

            {/* Agents */}
            <section>
              <h2 class="text-gray-300 text-sm font-semibold uppercase tracking-wider mb-3">
                Agents ({props.project.agents.length})
              </h2>
              <Show
                when={props.project.agents.length > 0}
                fallback={<p class="text-gray-600 text-sm">No agents detected</p>}
              >
                <div class="space-y-2">
                  <For each={props.project.agents}>
                    {(agent) => <AgentCard agent={agent} />}
                  </For>
                </div>
              </Show>
            </section>

            {/* Activity */}
            <section>
              <ActivityFeed entries={props.project.activity ?? []} maxItems={8} />
            </section>
          </div>

          {/* Right columns: Task board */}
          <div class="lg:col-span-2">
            <h2 class="text-gray-300 text-sm font-semibold uppercase tracking-wider mb-3">
              Tasks ({props.project.tasks.length})
            </h2>
            <div class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
              <For each={STATUS_ORDER}>
                {(status) => (
                  <div>
                    <div class="flex items-center gap-2 mb-2">
                      <span
                        class="w-2 h-2 rounded-full"
                        classList={{
                          "bg-gray-500": status === "todo",
                          "bg-yellow-400": status === "in-progress",
                          "bg-blue-400": status === "review",
                          "bg-green-400": status === "done",
                        }}
                      />
                      <span class="text-gray-400 text-xs font-medium uppercase">
                        {status}
                      </span>
                      <span class="text-gray-600 text-xs">
                        {(tasksByStatus()[status] ?? []).length}
                      </span>
                    </div>
                    <div class="space-y-2">
                      <For each={tasksByStatus()[status] ?? []}>
                        {(task) => <TaskCard task={task} />}
                      </For>
                    </div>
                  </div>
                )}
              </For>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
