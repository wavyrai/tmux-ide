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
      <div style={{
        "font-size": "10px",
        "font-weight": "600",
        color: "var(--text-muted)",
        "text-transform": "uppercase",
        "letter-spacing": "0.05em",
        "margin-bottom": "8px",
      }}>
        activity
      </div>
      <Show
        when={visible().length > 0}
        fallback={<div style={{ "font-size": "11px", color: "var(--text-muted)" }}>No activity yet</div>}
      >
        <div style={{ display: "flex", "flex-direction": "column", gap: "2px" }}>
          <For each={visible()}>
            {(entry) => (
              <div style={{ display: "flex", "align-items": "baseline", gap: "6px", "font-size": "11px" }}>
                <span style={{ color: "var(--text-muted)", "font-size": "10px", "flex-shrink": "0", width: "32px", "text-align": "right" }}>
                  {entry.time}
                </span>
                <span style={{ color: "var(--text-secondary)" }}>{entry.message}</span>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
