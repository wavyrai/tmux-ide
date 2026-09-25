/* @jsxImportSource @opentui/solid */
import type { AgentActivity } from "@tmux-ide/contracts";
import type { SemanticThemeSnapshot } from "../theme.ts";
import { createAgentStatusMarker } from "./agent-status-marker.ts";
import { Badge } from "./badge.tsx";
import type { ComponentInteractionState } from "./state.ts";

export type AgentBadgeStatus = "blocked" | "working" | "done" | "idle" | "unknown";

export interface AgentBadgeProps extends ComponentInteractionState {
  theme: SemanticThemeSnapshot;
  label: string;
  status: AgentBadgeStatus;
  activity?: AgentActivity;
  width?: number;
}

/** Agent-specific semantic badge. Agent lifecycle remains outside this presentation primitive. */
export function AgentBadge(props: AgentBadgeProps) {
  const marker = createAgentStatusMarker({
    theme: () => props.theme,
    status: () => props.activity ?? props.status,
    attention: () => Boolean(props.attention),
    unavailable: () => Boolean(props.disabled),
  });
  return (
    <Badge
      theme={props.theme}
      label={props.label}
      tone={props.status}
      marker={marker()}
      width={props.width}
      selected={props.selected}
      focused={props.focused}
      hovered={props.hovered}
      pressed={props.pressed}
      disabled={props.disabled}
      attention={props.attention || props.status === "blocked"}
      loading={props.loading}
      empty={props.empty}
      status={props.status}
    />
  );
}
