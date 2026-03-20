import { JSX, Show } from "solid-js";
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
      class="w-full text-left bg-gray-900 border border-gray-800 rounded-xl p-5 hover:bg-gray-800 hover:border-gray-700 transition-all duration-200 cursor-pointer group"
      onClick={() => props.onClick()}
    >
      {/* Header */}
      <div class="flex items-start justify-between mb-3">
        <div class="min-w-0 flex-1">
          <h3 class="text-gray-100 font-semibold text-lg truncate group-hover:text-blue-400 transition-colors">
            {props.session.name}
          </h3>
          <Show when={props.session.mission}>
            <p class="text-gray-400 text-sm truncate mt-0.5">
              {props.session.mission!.title}
            </p>
          </Show>
        </div>
        <Show when={props.session.stats.elapsed}>
          <span class="text-gray-500 text-xs ml-3 shrink-0">
            {props.session.stats.elapsed!}
          </span>
        </Show>
      </div>

      {/* Progress */}
      <div class="mb-3">
        <div class="flex justify-between text-xs text-gray-400 mb-1">
          <span>{pct()}% complete</span>
          <span>
            {props.session.stats.doneTasks}/{props.session.stats.totalTasks} tasks
          </span>
        </div>
        <ProgressBar percent={pct()} />
      </div>

      {/* Footer stats */}
      <div class="flex gap-4 text-xs text-gray-500">
        <span>
          <span
            classList={{
              "text-green-400": props.session.stats.activeAgents > 0,
              "text-gray-500": props.session.stats.activeAgents === 0,
            }}
          >
            {props.session.stats.activeAgents}
          </span>
          /{props.session.stats.agents} agents active
        </span>
        <Show when={props.session.goals.length > 0}>
          <span>{props.session.goals.length} goals</span>
        </Show>
      </div>
    </button>
  );
}
