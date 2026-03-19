import { Show } from "solid-js";
import { RGBA } from "@opentui/core";
import type { WidgetTheme } from "../lib/theme.ts";

function toRGBA(c: { r: number; g: number; b: number; a: number }): RGBA {
  return RGBA.fromInts(c.r, c.g, c.b, c.a);
}

export interface AgentInfo {
  paneTitle: string;
  isBusy: boolean;
  taskTitle: string | null;
  elapsed: string;
}

interface AgentCardProps {
  agent: AgentInfo;
  theme: WidgetTheme;
  selected: boolean;
}

export function AgentCard(props: AgentCardProps) {
  const dot = () => (props.agent.isBusy ? "*" : "o");
  const dotColor = () => (props.agent.isBusy ? props.theme.gitModified : props.theme.fgMuted);
  const bg = () =>
    props.selected
      ? RGBA.fromInts(
          props.theme.selected.r,
          props.theme.selected.g,
          props.theme.selected.b,
          props.theme.selected.a,
        )
      : RGBA.fromInts(0, 0, 0, 0);

  return (
    <box paddingLeft={1} backgroundColor={bg()}>
      <box flexDirection="row" gap={1}>
        <text fg={toRGBA(dotColor())}>{dot()}</text>
        <text fg={toRGBA(props.selected ? props.theme.selectedText : props.theme.fg)}>
          {props.agent.paneTitle}
        </text>
        <Show when={props.agent.elapsed}>
          <text fg={toRGBA(props.theme.fgMuted)}>{props.agent.elapsed}</text>
        </Show>
      </box>
      <Show
        when={props.agent.taskTitle}
        fallback={
          <text fg={toRGBA(props.theme.fgMuted)} paddingLeft={3}>
            idle
          </text>
        }
      >
        <text fg={toRGBA(props.theme.fgMuted)} paddingLeft={3}>
          {props.agent.taskTitle}
        </text>
      </Show>
    </box>
  );
}
