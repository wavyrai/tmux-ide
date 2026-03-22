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
  retryCount: number;
  maxRetries: number;
  nextRetryAt: string | null;
}

interface AgentCardProps {
  agent: AgentInfo;
  theme: WidgetTheme;
  selected: boolean;
  onMouseDown?: () => void;
}

function retryCountdown(nextRetryAt: string | null): string | null {
  if (!nextRetryAt) return null;
  const ms = new Date(nextRetryAt).getTime() - Date.now();
  if (ms <= 0) return "now";
  const secs = Math.ceil(ms / 1000);
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m${secs % 60}s`;
}

export function AgentCard(props: AgentCardProps) {
  const isRetrying = () => props.agent.retryCount > 0;
  const dot = () => (isRetrying() ? "!" : props.agent.isBusy ? "*" : "o");
  const dotColor = () =>
    isRetrying()
      ? props.theme.gitRemoved
      : props.agent.isBusy
        ? props.theme.gitModified
        : props.theme.fgMuted;
  const bg = () =>
    props.selected
      ? RGBA.fromInts(
          props.theme.selected.r,
          props.theme.selected.g,
          props.theme.selected.b,
          props.theme.selected.a,
        )
      : RGBA.fromInts(0, 0, 0, 0);

  const countdown = () => retryCountdown(props.agent.nextRetryAt);

  return (
    <box paddingLeft={1} backgroundColor={bg()} onMouseDown={props.onMouseDown}>
      <box flexDirection="row" gap={1}>
        <text fg={toRGBA(dotColor())}>{dot()}</text>
        <text fg={toRGBA(props.selected ? props.theme.selectedText : props.theme.fg)}>
          {props.agent.paneTitle}
        </text>
        <Show when={isRetrying()}>
          <text fg={toRGBA(props.theme.gitRemoved)}>
            RETRYING {props.agent.retryCount}/{props.agent.maxRetries}
          </text>
        </Show>
        <Show when={props.agent.elapsed && !isRetrying()}>
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
      <Show when={isRetrying() && countdown()}>
        <text fg={toRGBA(props.theme.fgMuted)} paddingLeft={3}>
          next retry: {countdown()}
        </text>
      </Show>
    </box>
  );
}
