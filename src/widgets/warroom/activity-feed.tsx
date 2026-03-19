import { Show, For } from "solid-js";
import { RGBA, TextAttributes } from "@opentui/core";
import type { WidgetTheme } from "../lib/theme.ts";

function toRGBA(c: { r: number; g: number; b: number; a: number }): RGBA {
  return RGBA.fromInts(c.r, c.g, c.b, c.a);
}

export interface ActivityEntry {
  time: string;
  message: string;
  timestamp: number;
}

export function formatElapsedShort(timestamp: number): string {
  const ms = Date.now() - timestamp;
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h`;
}

interface ActivityFeedProps {
  entries: ActivityEntry[];
  theme: WidgetTheme;
}

export function ActivityFeed(props: ActivityFeedProps) {
  return (
    <box paddingLeft={1} paddingTop={1}>
      <text fg={toRGBA(props.theme.fgMuted)} attributes={TextAttributes.BOLD}>
        ACTIVITY
      </text>
      <Show
        when={props.entries.length > 0}
        fallback={<text fg={toRGBA(props.theme.fgMuted)}>No activity yet</text>}
      >
        <For each={props.entries.slice(0, 8)}>
          {(entry) => (
            <box flexDirection="row" gap={1}>
              <text fg={toRGBA(props.theme.fgMuted)} flexShrink={0} wrapMode="none">
                {formatElapsedShort(entry.timestamp).padStart(4)}
              </text>
              <text fg={toRGBA(props.theme.fg)} wrapMode="none">
                {entry.message}
              </text>
            </box>
          )}
        </For>
      </Show>
    </box>
  );
}
