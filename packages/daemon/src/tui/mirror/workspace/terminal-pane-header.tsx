/* @jsxImportSource @opentui/solid */
import type { AgentActivity } from "@tmux-ide/contracts";

import type { SemanticThemeSnapshot } from "../theme.ts";
import { clipTerminal, terminalDisplayWidth } from "../terminal-text.ts";
import { Badge } from "../ui/badge.tsx";
import { IconButton } from "../ui/button.tsx";
import type { ComponentTone } from "../ui/state.ts";

type PaneHeaderPointerEvent = {
  readonly button?: number;
  readonly x: number;
  readonly y: number;
  stopPropagation?: () => void;
};

export interface TerminalPaneHeaderProps {
  theme: SemanticThemeSnapshot;
  paneId: string;
  title: string;
  width: number;
  focused: boolean;
  terminalFocused: boolean;
  activity?: AgentActivity;
  attention?: boolean;
  onSelect: () => void;
  onOpenMenu: (event: PaneHeaderPointerEvent) => void;
}

function activityPresentation(activity: AgentActivity | undefined): {
  label: string | null;
  tone: ComponentTone;
} {
  if (activity === "running") return { label: "WORKING", tone: "working" };
  if (activity === "waiting") return { label: "BLOCKED", tone: "blocked" };
  if (activity === "complete") return { label: "DONE", tone: "done" };
  if (activity === "failed" || activity === "disconnected")
    return { label: "OFFLINE", tone: "unknown" };
  return { label: activity ? "IDLE" : null, tone: "idle" };
}

/**
 * Domain compound for a live tmux pane. The framebuffer remains a sibling body;
 * this component owns only the one-row title/action chrome above it.
 */
export function TerminalPaneHeader(props: TerminalPaneHeaderProps) {
  const status = () => activityPresentation(props.activity);
  const actionWidth = () => (props.width >= 8 ? 3 : 0);
  const naturalStatusWidth = () =>
    status().label ? terminalDisplayWidth(`[${status().label}]`) + 2 : 0;
  const statusWidth = () =>
    props.width >= actionWidth() + naturalStatusWidth() + 10 ? naturalStatusWidth() : 0;
  const titleWidth = () => Math.max(1, props.width - actionWidth() - statusWidth());
  const title = () => clipTerminal(`${props.focused ? "●" : "○"} ${props.title}`, titleWidth());
  return (
    <box
      id={`terminal-pane-header:${props.paneId}`}
      position="absolute"
      left={0}
      top={0}
      width={props.width}
      height={1}
      zIndex={2}
      flexDirection="row"
      backgroundColor={
        props.terminalFocused
          ? props.theme.roles.surfaces.headerActive
          : props.theme.roles.surfaces.command
      }
      overflow="hidden"
      onMouseDown={(event) => {
        if (event.button === 2) {
          event.stopPropagation();
          props.onOpenMenu(event);
          return;
        }
        props.onSelect();
      }}
    >
      <text
        width={titleWidth()}
        height={1}
        overflow="hidden"
        fg={props.focused ? props.theme.roles.text.link : props.theme.roles.text.secondary}
        attributes={props.focused ? 1 : 0}
      >
        {title()}
      </text>
      {statusWidth() > 0 ? (
        <Badge
          theme={props.theme}
          label={`[${status().label}]`}
          tone={status().tone}
          attention={props.attention}
          width={statusWidth()}
        />
      ) : null}
      {actionWidth() > 0 ? (
        <IconButton
          theme={props.theme}
          icon="⋯"
          label="Pane actions"
          variant="ghost"
          width={actionWidth()}
        />
      ) : null}
      {actionWidth() > 0 ? (
        <box
          id={`terminal-pane-header:${props.paneId}:action:menu`}
          position="absolute"
          right={0}
          top={0}
          width={actionWidth()}
          height={1}
          zIndex={4}
          onMouseDown={(event) => {
            event.stopPropagation();
            props.onOpenMenu(event);
          }}
        />
      ) : null}
    </box>
  );
}
