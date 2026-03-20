import { JSX, Show } from "solid-js";
import type { Agent } from "../types.ts";

interface AgentCardProps {
  agent: Agent;
}

export function AgentCard(props: AgentCardProps): JSX.Element {
  return (
    <div class="flex items-center gap-3 px-3 py-2 rounded-lg bg-gray-800/50">
      {/* Status dot */}
      <span
        class="w-2 h-2 rounded-full shrink-0"
        classList={{
          "bg-green-400 shadow-[0_0_6px_rgba(74,222,128,0.4)]": props.agent.isBusy,
          "bg-gray-600": !props.agent.isBusy,
        }}
      />

      {/* Agent info */}
      <div class="min-w-0 flex-1">
        <div class="text-gray-200 text-sm font-medium truncate">
          {props.agent.paneTitle}
        </div>
        <Show
          when={props.agent.taskTitle}
          fallback={<div class="text-gray-500 text-xs">idle</div>}
        >
          <div class="text-gray-400 text-xs truncate">{props.agent.taskTitle}</div>
        </Show>
      </div>

      {/* Elapsed */}
      <Show when={props.agent.elapsed}>
        <span class="text-gray-500 text-xs shrink-0">{props.agent.elapsed}</span>
      </Show>
    </div>
  );
}
