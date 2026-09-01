/* @jsxImportSource @opentui/solid */
import type { SemanticThemeSnapshot } from "../theme.ts";
import { Badge } from "./badge.tsx";
import type { ComponentInteractionState } from "./state.ts";

export type AgentBadgeStatus = "blocked" | "working" | "done" | "idle" | "unknown";

export interface AgentBadgeProps extends ComponentInteractionState {
  theme: SemanticThemeSnapshot;
  label: string;
  status: AgentBadgeStatus;
  width?: number;
}

/** Agent-specific semantic badge. Agent lifecycle remains outside this presentation primitive. */
export function AgentBadge(props: AgentBadgeProps) {
  const marker = () => {
    if (props.attention || props.status === "blocked") return "!";
    if (props.status === "working") return props.theme.glyphs.active;
    if (props.status === "done") return props.theme.glyphs.check;
    return props.theme.glyphs.inactive;
  };
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
