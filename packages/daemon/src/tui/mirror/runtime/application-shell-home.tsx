import type { InteractionReceipt } from "@tmux-ide/contracts";
import { interactionReceiptTargetLabel } from "@tmux-ide/core";
/* @jsxImportSource @opentui/solid */
import type { JSX } from "solid-js";
import { For, Show } from "solid-js";

import type { SemanticThemeSnapshot } from "../theme.ts";
import { clipTerminal, terminalDisplayWidth } from "../terminal-text.ts";
import { DetailRow } from "../ui/detail-row.tsx";
import { TuiButton } from "../ui/button.tsx";
import type { ApplicationTerminalAgentIndicator } from "./application-terminal-workspace-policy.ts";
import { HomeAgentRoster } from "./application-home-agent-roster.tsx";
import type { HomeAgentRow, HomeAgentSnapshot } from "./application-home-agents.ts";
import type { HomeAgentSelectionSnapshot } from "./application-home-agent-selection.ts";

import { APPLICATION_HOME_WORDMARK, APPLICATION_HOME_WORDMARK_WIDTH } from "../ui/home-wordmark.ts";

export type ApplicationHomeBrandVariant = "wordmark" | "ascii";

/** Keep the marketing wordmark intact, falling back when the agent list needs the room. */
export function applicationHomeBrandVariant(
  width: number,
  height: number,
): ApplicationHomeBrandVariant {
  return width >= APPLICATION_HOME_WORDMARK_WIDTH && height >= 28 ? "ascii" : "wordmark";
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
  readonly onOpenTutorial?: () => void;
  readonly tutorialLabel?: string;
  readonly onCycleTheme?: () => void;
  readonly agentQuery?: string;
  readonly onAgentQueryChange?: (query: string) => void;
  readonly agentFilterLabel?: string;
  readonly agentActivityFilter?: "all" | "working" | "attention";
  readonly onSetAgentActivityFilter?: (value: "all" | "working" | "attention") => void;
  readonly onCycleAgentMachine?: () => void;
  readonly onToggleAgentAttention?: () => void;
  readonly agentRoster?: HomeAgentSnapshot;
  readonly activityDaemonId?: string | null;
  readonly recentPaneActivity?: readonly InteractionReceipt[];
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
  const inset = () =>
    Math.max(
      width() >= 40 ? 2 : width() >= 12 ? 1 : 0,
      props.branded ? Math.floor((width() - 96) / 2) : 0,
    );
  const bodyWidth = () => Math.max(0, width() - inset() * 2);
  const showAscii = () =>
    props.branded &&
    props.agentRoster?.phase === "live" &&
    props.agentRoster.rows.length === 0 &&
    !props.agentQuery &&
    (!props.agentActivityFilter || props.agentActivityFilter === "all") &&
    applicationHomeBrandVariant(bodyWidth(), height()) === "ascii";
  const brandRows = () => (showAscii() ? APPLICATION_HOME_WORDMARK.length : 1);
  const spacious = () => height() >= 14;
  const context = () =>
    clipTerminal(
      props.branded && props.agentRoster
        ? "Your agents, across your machines"
        : `${props.session ?? "No session selected"} · ${props.status}`,
      bodyWidth(),
    );
  const summary = () => {
    if (!props.session || props.agents === undefined) return "Agent signals unavailable";
    const working = props.agents.filter((agent) => agent.activity === "running").length;
    const attention = props.agents.filter((agent) => agent.attention).length;
    return `Current session · ${working} working · ${attention} ${attention === 1 ? "needs" : "need"} attention`;
  };
  const themeLabel = () => `Theme: ${props.theme.setting}`;
  // Use the existing TuiButton cell budget for both its label and hit target.
  const naturalButtonWidth = (label: string, shortcut?: string) =>
    terminalDisplayWidth(label) + (shortcut ? terminalDisplayWidth(shortcut) + 1 : 0) + 2;
  const buttonWidth = (label: string, shortcut?: string) =>
    Math.min(bodyWidth(), naturalButtonWidth(label, shortcut));
  const actionsInRow = () =>
    bodyWidth() >=
    naturalButtonWidth("Open terminals", "F2") +
      naturalButtonWidth("Commands", "F5") +
      (props.onCycleTheme ? naturalButtonWidth(themeLabel()) + 2 : 0) +
      (props.onOpenTutorial ? naturalButtonWidth(props.tutorialLabel ?? "Learn tmux-ide") + 2 : 0) +
      2;
  const reservedRows = () =>
    brandRows() -
    1 +
    (spacious() ? 4 : 2) +
    (actionsInRow() ? 1 : 2 + (props.onCycleTheme ? 1 : 0) + (props.onOpenTutorial ? 1 : 0)) +
    (spacious() ? 1 : 0) +
    (props.note ? (spacious() ? 2 : 1) : 0);
  const activityRows = () => (height() >= 24 && bodyWidth() >= 48 ? 2 : 1);
  const selectedAgent = () =>
    props.agentRoster?.rows.find((row) => row.key === props.agentSelection?.selectedKey);
  // Receipts lack a fleet-wide machine identity. Never attribute a same-named
  // workspace/pane collision to the selected agent.
  const selectedActivity = () => {
    const selected = selectedAgent();
    if (!selected?.paneId || selected.daemonInstanceId !== props.activityDaemonId) return [];
    const matches = props.agentRoster?.rows.filter(
      (row) => row.sessionName === selected.sessionName && row.paneId === selected.paneId,
    );
    if (matches?.length !== 1) return [];
    return (props.recentPaneActivity ?? []).filter(
      (receipt) =>
        receipt.workspaceName === selected.sessionName &&
        receipt.target.kind === "pane" &&
        receipt.target.semanticPaneId === selected.paneId,
    );
  };
  const recentActivity = () =>
    selectedActivity().slice(
      0,
      spacious()
        ? Math.max(
            0,
            Math.min(
              1,
              Math.floor(
                (height() - reservedRows() - (props.agentRoster ? 12 : 2) - 2) / activityRows(),
              ),
            ),
          )
        : 0,
    );
  const activityHeight = () =>
    recentActivity().length > 0 ? recentActivity().length * activityRows() + 2 : 0;
  const paneLabel = (paneId: string) => {
    const matches = props.agentRoster?.rows.filter((row) => row.paneId === paneId) ?? [];
    return matches.length === 1 ? matches[0]!.name : paneId;
  };
  const activityTime = (receipt: InteractionReceipt) => {
    const at = Date.parse(receipt.at);
    return Number.isFinite(at)
      ? `${new Date(at).toISOString().slice(5, 16).replace("T", " ")}Z`
      : "Time unknown";
  };
  const activityPhase = (receipt: InteractionReceipt) =>
    receipt.phase === "accepted"
      ? receipt.operationKind === "workspace.pane.read"
        ? "reading"
        : "sending"
      : receipt.phase === "observed"
        ? receipt.operationKind === "workspace.pane.read"
          ? "read"
          : "sent"
        : receipt.phase === "rejected"
          ? "failed"
          : "timed out";
  const rosterHeight = () => Math.max(0, height() - reservedRows() - activityHeight());

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
      <box height={brandRows()} width={bodyWidth()} flexShrink={0} flexDirection="column">
        <Show
          when={showAscii()}
          fallback={
            <text width={bodyWidth()} height={1} fg={props.theme.roles.text.primary}>
              <strong>
                {clipTerminal(props.branded ? "tmux-ide" : props.project, bodyWidth())}
              </strong>
            </text>
          }
        >
          <For each={APPLICATION_HOME_WORDMARK}>
            {(line) => (
              <text
                width={bodyWidth()}
                height={1}
                flexShrink={0}
                fg={props.theme.roles.text.primary}
              >
                {" ".repeat(
                  Math.max(0, Math.floor((bodyWidth() - APPLICATION_HOME_WORDMARK_WIDTH) / 2)),
                ) + line}
              </text>
            )}
          </For>
        </Show>
      </box>
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
              query={props.agentQuery}
              onQueryChange={props.onAgentQueryChange}
              filterLabel={props.agentFilterLabel}
              activityFilter={props.agentActivityFilter}
              onSetActivityFilter={props.onSetAgentActivityFilter}
              onCycleMachine={props.onCycleAgentMachine}
              onToggleAttention={props.onToggleAgentAttention}
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
        <Show when={activityHeight() > 0}>
          <box
            width={bodyWidth()}
            height={activityHeight()}
            flexShrink={0}
            flexDirection="column"
            overflow="hidden"
          >
            <text height={1} width={bodyWidth()} fg={props.theme.roles.text.secondary}>
              {clipTerminal(`${selectedAgent()?.name ?? "Agent"} · latest activity`, bodyWidth())}
            </text>
            <For each={recentActivity()}>
              {(receipt) => (
                <DetailRow
                  theme={props.theme}
                  width={bodyWidth()}
                  label={interactionReceiptTargetLabel(receipt, paneLabel)}
                  detail={activityPhase(receipt)}
                  description={activityRows() === 2 ? activityTime(receipt) : undefined}
                  attention={receipt.phase === "rejected" || receipt.phase === "timed-out"}
                />
              )}
            </For>
            <text height={1} width={bodyWidth()} fg={props.theme.roles.text.muted}>
              {clipTerminal("Activity reported through tmux-ide", bodyWidth())}
            </text>
          </box>
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
            size="compact"
            variant="ghost"
            background={props.theme.roles.surfaces.canvas}
            onPress={props.onOpenTerminals}
          />
          <TuiButton
            theme={props.theme}
            label="Commands"
            size="compact"
            variant="ghost"
            background={props.theme.roles.surfaces.canvas}
            shortcut="F5"
            width={buttonWidth("Commands", "F5")}
            onPress={props.onOpenCommands}
          />
          <Show when={props.onOpenTutorial}>
            {(open) => (
              <TuiButton
                theme={props.theme}
                label={props.tutorialLabel ?? "Learn tmux-ide"}
                size="compact"
                variant="ghost"
                background={props.theme.roles.surfaces.canvas}
                width={buttonWidth(props.tutorialLabel ?? "Learn tmux-ide")}
                onPress={open()}
              />
            )}
          </Show>
          <Show when={props.onCycleTheme}>
            {(onCycleTheme) => (
              <TuiButton
                theme={props.theme}
                label={themeLabel()}
                width={buttonWidth(themeLabel())}
                size="compact"
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
