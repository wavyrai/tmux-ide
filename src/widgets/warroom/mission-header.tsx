import { Show } from "solid-js";
import { RGBA, TextAttributes } from "@opentui/core";
import type { WidgetTheme } from "../lib/theme.ts";

function toRGBA(c: { r: number; g: number; b: number; a: number }): RGBA {
  return RGBA.fromInts(c.r, c.g, c.b, c.a);
}

function progressBar(pct: number, width: number): string {
  const filled = Math.round((pct / 100) * width);
  return "#".repeat(filled) + "-".repeat(width - filled);
}

interface MissionHeaderProps {
  title: string | null;
  totalTasks: number;
  doneTasks: number;
  agentCount: number;
  theme: WidgetTheme;
}

export function MissionHeader(props: MissionHeaderProps) {
  const pct = () =>
    props.totalTasks > 0 ? Math.round((props.doneTasks / props.totalTasks) * 100) : 0;

  return (
    <box flexShrink={0} paddingLeft={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between" paddingRight={1}>
        <text fg={toRGBA(props.theme.fg)} attributes={TextAttributes.BOLD}>
          {props.title ?? "No mission set"}
        </text>
        <text fg={toRGBA(props.theme.fgMuted)}>{props.agentCount} agents</text>
      </box>
      <Show when={props.totalTasks > 0}>
        <box flexDirection="row" gap={1}>
          <text fg={toRGBA(props.theme.gitAdded)}>{progressBar(pct(), 20)}</text>
          <text fg={toRGBA(props.theme.fgMuted)}>
            {pct()}% ({props.doneTasks}/{props.totalTasks})
          </text>
        </box>
      </Show>
    </box>
  );
}
