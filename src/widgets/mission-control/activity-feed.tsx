import { RGBA, TextAttributes } from "@opentui/core";
import type { OrchestratorEvent } from "../../lib/event-log.ts";
import type { WidgetTheme, RGBA as RGBAType } from "../lib/theme.ts";

function toRGBA(c: RGBAType): RGBA {
  return RGBA.fromInts(c.r, c.g, c.b, c.a);
}

function formatRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600000) return `${Math.round(ms / 60000)}m`;
  return `${(ms / 3600000).toFixed(1)}h`;
}

function eventColor(type: string, theme: WidgetTheme): RGBAType {
  switch (type) {
    case "dispatch":
      return theme.accent;
    case "completion":
      return theme.gitAdded;
    case "error":
    case "reconcile":
      return theme.gitDeleted;
    case "stall":
      return theme.gitModified;
    default:
      return theme.fgMuted;
  }
}

interface ActivityFeedProps {
  events: OrchestratorEvent[];
  theme: WidgetTheme;
}

export function ActivityFeed(props: ActivityFeedProps) {
  return (
    <box flexGrow={1}>
      {props.events.length === 0 ? (
        <text fg={toRGBA(props.theme.fgMuted)}>No recent activity</text>
      ) : (
        props.events.map((evt) => (
          <box flexShrink={0} flexDirection="row" gap={1}>
            <text fg={toRGBA(props.theme.fgMuted)} wrapMode="none">
              {formatRelative(evt.timestamp).padStart(4)}
            </text>
            <text fg={toRGBA(eventColor(evt.type, props.theme))} wrapMode="none">
              {evt.type.padEnd(11)}
            </text>
            <text fg={toRGBA(props.theme.fg)} wrapMode="none">
              {evt.message.slice(0, 40)}
            </text>
          </box>
        ))
      )}
    </box>
  );
}
