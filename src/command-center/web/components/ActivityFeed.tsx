import { JSX, For, Show } from "solid-js";
import type { ActivityEntry } from "../types.ts";

interface ActivityFeedProps {
  entries: ActivityEntry[];
  maxItems?: number;
}

export function ActivityFeed(props: ActivityFeedProps): JSX.Element {
  const visible = () => props.entries.slice(0, props.maxItems ?? 10);

  return (
    <div>
      <h3 class="text-gray-400 text-xs font-semibold uppercase tracking-wider mb-2">
        Activity
      </h3>
      <Show
        when={visible().length > 0}
        fallback={<p class="text-gray-600 text-sm">No activity yet</p>}
      >
        <div class="space-y-1">
          <For each={visible()}>
            {(entry) => (
              <div class="flex items-baseline gap-2 text-sm">
                <span class="text-gray-600 text-xs font-mono shrink-0 w-8 text-right">
                  {entry.time}
                </span>
                <span class="text-gray-400">{entry.message}</span>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
