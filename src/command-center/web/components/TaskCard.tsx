import { JSX, Show } from "solid-js";
import type { Task } from "../types.ts";

interface TaskCardProps {
  task: Task;
}

const STATUS_STYLES: Record<string, string> = {
  "todo": "bg-gray-700 text-gray-300",
  "in-progress": "bg-yellow-400/15 text-yellow-400",
  "review": "bg-blue-400/15 text-blue-400",
  "done": "bg-green-400/15 text-green-400",
};

const PRIORITY_STYLES: Record<number, string> = {
  1: "text-red-400",
  2: "text-yellow-400",
  3: "text-gray-400",
};

export function TaskCard(props: TaskCardProps): JSX.Element {
  const statusStyle = () => STATUS_STYLES[props.task.status] ?? STATUS_STYLES["todo"];
  const priorityStyle = () => PRIORITY_STYLES[props.task.priority] ?? "text-gray-500";

  return (
    <div class="bg-gray-800/50 rounded-lg px-3 py-2.5 border border-gray-800 hover:border-gray-700 transition-colors">
      <div class="flex items-start gap-2">
        {/* Priority badge */}
        <span class={`text-xs font-mono shrink-0 mt-0.5 ${priorityStyle()}`}>
          P{props.task.priority}
        </span>

        {/* Title + meta */}
        <div class="min-w-0 flex-1">
          <div class="text-gray-200 text-sm leading-snug">{props.task.title}</div>
          <div class="flex items-center gap-2 mt-1">
            <span class={`text-[10px] font-medium px-1.5 py-0.5 rounded ${statusStyle()}`}>
              {props.task.status}
            </span>
            <Show when={props.task.assignee}>
              <span class="text-gray-500 text-xs">@{props.task.assignee}</span>
            </Show>
            <Show when={props.task.depends_on.length > 0}>
              <span class="text-gray-600 text-xs">
                deps: {props.task.depends_on.join(", ")}
              </span>
            </Show>
          </div>
        </div>

        {/* Task ID */}
        <span class="text-gray-600 text-xs font-mono shrink-0">#{props.task.id}</span>
      </div>
    </div>
  );
}
