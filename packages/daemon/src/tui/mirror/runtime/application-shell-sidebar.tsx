/* @jsxImportSource @opentui/solid */
import type { AgentActivity } from "@tmux-ide/contracts";
import type { JSX } from "solid-js";
import { For } from "solid-js";

import type { SemanticThemeSnapshot } from "../theme.ts";
import { friendlySessionLabel } from "../terminal-text.ts";
import {
  NavigationRow,
  Surface,
  type AgentBadgeStatus,
  type NavigationRowInputSource,
} from "../ui/index.ts";
import type { projectApplicationShell } from "../workspace/application-shell.ts";
import { terminalAgentStatusLabel } from "./application-terminal-workspace-policy.ts";

export type ApplicationSidebarIntent =
  | Readonly<{
      type: "session.open";
      sessionName: string;
      source: NavigationRowInputSource;
    }>
  | Readonly<{
      type: "agent.open";
      sessionName: string;
      paneId: string;
      source: NavigationRowInputSource;
    }>;

export interface ApplicationShellSidebarProps {
  readonly shell: ReturnType<typeof projectApplicationShell>;
  readonly theme: SemanticThemeSnapshot;
  readonly onIntent?: (intent: ApplicationSidebarIntent) => void;
}

function sessionStatus(state: string): AgentBadgeStatus {
  if (state === "reconnecting") return "blocked";
  if (state === "connected") return "idle";
  return "unknown";
}

function agentStatus(activity: AgentActivity): AgentBadgeStatus {
  if (activity === "waiting" || activity === "failed") return "blocked";
  if (activity === "running") return "working";
  if (activity === "complete") return "done";
  if (activity === "idle") return "idle";
  return "unknown";
}

/** Presentational sidebar with shared row state and typed navigation intents. */
export function ApplicationShellSidebar(props: ApplicationShellSidebarProps): JSX.Element {
  const width = () => props.shell.layout.sidebar.width;
  const rowWidth = () => Math.max(1, width() - 1);
  const sidebarFocused = () => props.shell.semantic.focus.zone === "sidebar";
  const focusedAgentPane = () =>
    props.shell.semantic.sidebar.agents.some(
      (agent) => agent.paneId === props.shell.semantic.focus.appFocusedPaneId,
    )
      ? props.shell.semantic.focus.appFocusedPaneId
      : null;

  return (
    <Surface
      id="application-sidebar"
      theme={props.theme}
      variant="panel"
      width={width()}
      height={props.shell.layout.sidebar.height}
      flexDirection="column"
      paddingLeft={1}
      overflow="hidden"
    >
      <text fg={props.theme.roles.text.link} bg={props.theme.roles.surfaces.panel}>
        <strong>{props.shell.layout.variant === "compact" ? " tmux" : " tmux-ide"}</strong>
      </text>
      <For each={props.shell.semantic.sidebar.sessions}>
        {(session) => {
          const active = () => session.id === props.shell.semantic.sidebar.activeSessionId;
          const status = () => sessionStatus(session.state);
          return (
            <NavigationRow
              theme={props.theme}
              id={`session:${session.id}`}
              label={friendlySessionLabel(session.label)}
              width={rowWidth()}
              marker={active() ? "●" : "○"}
              selected={active()}
              focused={sidebarFocused() && focusedAgentPane() === null && active()}
              status={status()}
              attention={status() === "blocked"}
              onActivate={(source) =>
                props.onIntent?.({ type: "session.open", sessionName: session.label, source })
              }
            />
          );
        }}
      </For>
      <For each={props.shell.semantic.sidebar.agents.length > 0 ? [true] : []}>
        {() => (
          <Surface theme={props.theme} variant="panel" height={1} marginTop={1}>
            <text fg={props.theme.roles.text.secondary} bg={props.theme.roles.surfaces.panel}>
              <strong>Agents</strong>
            </text>
          </Surface>
        )}
      </For>
      <For each={props.shell.semantic.sidebar.agents}>
        {(agent) => {
          const status = () => agentStatus(agent.activity);
          return (
            <NavigationRow
              theme={props.theme}
              id={`agent:${agent.paneId ?? agent.id}`}
              label={agent.name}
              detail={`[${terminalAgentStatusLabel(agent.activity)}]`}
              detailMarker={agent.attention ? "!" : undefined}
              detailAlign="adjacent"
              width={rowWidth()}
              marker={agent.attention ? "!" : "•"}
              focused={sidebarFocused() && agent.paneId === focusedAgentPane()}
              status={status()}
              attention={agent.attention || status() === "blocked"}
              disabled={!agent.paneId}
              onActivate={(source) => {
                if (!agent.paneId) return;
                props.onIntent?.({
                  type: "agent.open",
                  sessionName: props.shell.activeSession,
                  paneId: agent.paneId,
                  source,
                });
              }}
            />
          );
        }}
      </For>
      <box flexGrow={1} />
    </Surface>
  );
}
