/* @jsxImportSource @opentui/solid */
import type { JSX } from "solid-js";
import { Show } from "solid-js";

import type { SemanticThemeSnapshot } from "../theme.ts";
import { clipTerminal, terminalDisplayWidth } from "../terminal-text.ts";
import { TuiButton } from "../ui/button.tsx";
import type { ApplicationTerminalAgentIndicator } from "./application-terminal-workspace-policy.ts";
import { HomeAgentRoster } from "./application-home-agent-roster.tsx";
import type { HomeAgentRow, HomeAgentSnapshot } from "./application-home-agents.ts";
import type { HomeAgentSelectionSnapshot } from "./application-home-agent-selection.ts";

export type ApplicationHomeBrandVariant = "wordmark";

/** Home reserves its cells for workspace information at every terminal size. */
export function applicationHomeBrandVariant(
  _width: number,
  _height: number,
): ApplicationHomeBrandVariant {
  return "wordmark";
}

export interface ApplicationHomeSurfaceProps {
  readonly project: string;
  readonly status: string;
  readonly note: string | null;
  readonly width: number;
  readonly height: number;
  readonly sessionCount: number;
  readonly session?: string | null;
  readonly agents?: readonly ApplicationTerminalAgentIndicator[];
  readonly branded: boolean;
  readonly theme: SemanticThemeSnapshot;
  readonly onOpenTerminals: () => void;
  readonly onOpenCommands: () => void;
  readonly onCycleTheme?: () => void;
  readonly agentRoster?: HomeAgentSnapshot;
  readonly agentSelection?: HomeAgentSelectionSnapshot;
  readonly agentInputActive?: boolean;
  readonly onSelectAgent?: (key: string) => void;
  readonly onMoveAgent?: (delta: number) => void;
  readonly onAgentViewport?: (rows: number) => void;
  readonly onOpenAgent?: (row: HomeAgentRow, source: "keyboard" | "mouse") => void;
  readonly onRetryAgents?: () => void;
  readonly onLoadMoreAgents?: () => void;
}

/** Presentation only: session data, commands, and keyboard admission stay with the shell. */
export function ApplicationHomeSurface(props: ApplicationHomeSurfaceProps): JSX.Element {
  const width = () => Math.max(0, Math.floor(props.width));
  const height = () => Math.max(0, Math.floor(props.height));
  const inset = () => (width() >= 40 ? 2 : width() >= 12 ? 1 : 0);
  const bodyWidth = () => Math.max(0, width() - inset() * 2);
  const spacious = () => height() >= 14;
  const context = () =>
    clipTerminal(`${props.session ?? "No session selected"} · ${props.status}`, bodyWidth());
  const summary = () => {
    if (!props.session || props.agents === undefined) return "Agent signals unavailable";
    const working = props.agents.filter((agent) => agent.activity === "running").length;
    const attention = props.agents.filter((agent) => agent.attention).length;
    return `Current session · ${working} working · ${attention} ${attention === 1 ? "needs" : "need"} attention`;
  };
  const themeLabel = () => `Theme: ${props.theme.setting}`;
  // Use the existing TuiButton cell budget for both its label and hit target.
  const naturalButtonWidth = (label: string, shortcut?: string) =>
    terminalDisplayWidth(label) + (shortcut ? terminalDisplayWidth(shortcut) + 1 : 0) + 4;
  const buttonWidth = (label: string, shortcut?: string) =>
    Math.min(bodyWidth(), naturalButtonWidth(label, shortcut));
  const actionsInRow = () =>
    bodyWidth() >=
    naturalButtonWidth("Open terminals", "F2") +
      naturalButtonWidth("Commands", "F5") +
      (props.onCycleTheme ? naturalButtonWidth(themeLabel()) + 2 : 0) +
      2;
  const rosterHeight = () =>
    Math.max(
      0,
      height() -
        (spacious() ? 4 : 2) -
        (actionsInRow() ? 1 : props.onCycleTheme ? 3 : 2) -
        (spacious() ? 1 : 0) -
        (props.note ? (spacious() ? 2 : 1) : 0),
    );

  return (
    <box
      id="application-home"
      width={width()}
      height={height()}
      paddingLeft={inset()}
      paddingRight={inset()}
      paddingTop={spacious() ? 1 : 0}
      flexDirection="column"
      alignItems="flex-start"
      backgroundColor={props.theme.roles.surfaces.canvas}
      overflow="hidden"
    >
      <text width={bodyWidth()} height={1} flexShrink={0} fg={props.theme.roles.text.primary}>
        <strong>{clipTerminal(props.branded ? "tmux-ide" : props.project, bodyWidth())}</strong>
      </text>
      <box height={spacious() ? 1 : 0} flexShrink={0} />
      <text width={bodyWidth()} height={1} flexShrink={0} fg={props.theme.roles.text.secondary}>
        {context()}
      </text>
      <Show when={props.branded}>
        <Show
          when={props.agentRoster}
          fallback={
            <>
              <text width={bodyWidth()} height={1} flexShrink={0} fg={props.theme.roles.text.muted}>
                {clipTerminal(
                  `${props.sessionCount} ${props.sessionCount === 1 ? "session" : "sessions"} in view`,
                  bodyWidth(),
                )}
              </text>
              <text
                width={bodyWidth()}
                height={1}
                flexShrink={0}
                fg={props.theme.roles.text.primary}
              >
                {clipTerminal(summary(), bodyWidth())}
              </text>
            </>
          }
        >
          {(snapshot) => (
            <HomeAgentRoster
              theme={props.theme}
              width={bodyWidth()}
              height={rosterHeight()}
              snapshot={snapshot()}
              selection={props.agentSelection ?? { selectedKey: null, scrollOffset: 0 }}
              inputActive={props.agentInputActive ?? false}
              onSelect={(key) => props.onSelectAgent?.(key)}
              onMove={(delta) => props.onMoveAgent?.(delta)}
              onViewport={(rows) => props.onAgentViewport?.(rows)}
              onOpen={(row, source) => props.onOpenAgent?.(row, source)}
              onRetry={props.onRetryAgents}
              onLoadMore={props.onLoadMoreAgents}
            />
          )}
        </Show>
        <box height={spacious() ? 1 : 0} flexShrink={0} />
        <box
          width={bodyWidth()}
          flexShrink={0}
          flexDirection={actionsInRow() ? "row" : "column"}
          alignItems="flex-start"
          gap={actionsInRow() ? 2 : 0}
        >
          <TuiButton
            theme={props.theme}
            label="Open terminals"
            shortcut="F2"
            width={buttonWidth("Open terminals", "F2")}
            variant="primary"
            onPress={props.onOpenTerminals}
          />
          <TuiButton
            theme={props.theme}
            label="Commands"
            shortcut="F5"
            width={buttonWidth("Commands", "F5")}
            onPress={props.onOpenCommands}
          />
          <Show when={props.onCycleTheme}>
            {(onCycleTheme) => (
              <TuiButton
                theme={props.theme}
                label={themeLabel()}
                width={buttonWidth(themeLabel())}
                variant="ghost"
                background={props.theme.roles.surfaces.canvas}
                onPress={onCycleTheme()}
              />
            )}
          </Show>
        </box>
      </Show>
      <Show when={props.note}>
        {(note) => (
          <text
            width={bodyWidth()}
            height={1}
            flexShrink={0}
            marginTop={spacious() ? 1 : 0}
            fg={props.theme.roles.text.link}
          >
            {clipTerminal(note(), bodyWidth())}
          </text>
        )}
      </Show>
    </box>
  );
}
