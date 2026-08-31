/* @jsxImportSource @opentui/solid */
import type { ApplicationShellProjectionV1 } from "@tmux-ide/contracts";
import type { Accessor, ComponentProps, JSX } from "solid-js";
import { For, Show, createMemo } from "solid-js";

import { shellChromeLayout } from "../shell-chrome.ts";
import { clipTerminal } from "../terminal-text.ts";
import { ApplicationShell } from "../workspace/application-shell-view.tsx";
import {
  applicationShellHitTest,
  projectApplicationShell,
} from "../workspace/application-shell.ts";
import {
  ApplicationTerminalWorkspace,
  terminalAgentStatusLabel,
  type ApplicationTerminalAgentIndicator,
} from "./application-terminal-workspace.tsx";
import {
  applicationPaletteCommands,
  type ApplicationPaletteCommand,
} from "./application-palette-input.ts";
import type { ApplicationPaneRenameDraft } from "./application-pane-rename-input.ts";
import { applicationShellViewport } from "./application-shell-viewport.ts";
export { applicationPaletteKeyAction } from "./application-palette-input.ts";
export { applicationShellViewport } from "./application-shell-viewport.ts";

type TerminalWorkspaceProps = ComponentProps<typeof ApplicationTerminalWorkspace>;
export type RootSurface = "home" | "terminals";
type InputSource = "keyboard" | "mouse";
export type ApplicationShellKeyAction = "home" | "terminals" | "palette-open" | "palette-close";

export type ApplicationHomeBrandVariant = "full" | "compact" | "wordmark";

const APPLICATION_HOME_FULL_LOGO = `   ░██                                             ░██       ░██
   ░██                                                       ░██
░████████ ░█████████████  ░██    ░██ ░██    ░██    ░██ ░████████  ░███████
   ░██    ░██   ░██   ░██ ░██    ░██  ░██  ░██     ░██░██    ░██ ░██    ░██
   ░██    ░██   ░██   ░██ ░██    ░██   ░█████      ░██░██    ░██ ░█████████
   ░██    ░██   ░██   ░██ ░██   ░███  ░██  ░██     ░██░██   ░███ ░██
    ░████ ░██   ░██   ░██  ░█████░██ ░██    ░██    ░██ ░█████░██  ░███████`;

const APPLICATION_HOME_COMPACT_LOGO = [
  "▀█▀ █▄█ █ █ ▀▄▀ ─ █ █▀▄ █▀▀",
  " █  █ █ █▄█ █ █   █ █▄▀ ██▄",
] as const;
const APPLICATION_HOME_FULL_LOGO_WIDTH = 76;
const APPLICATION_HOME_COMPACT_LOGO_WIDTH = 29;

export function applicationHomeBrandVariant(
  width: number,
  height: number,
): ApplicationHomeBrandVariant {
  if (width >= 76 && height >= 23) return "full";
  if (width >= 36 && height >= 13) return "compact";
  return "wordmark";
}

export function applicationShellKeyAction(
  key: { readonly name: string },
  paletteOpen: boolean,
): ApplicationShellKeyAction | null {
  const name = key.name.toLowerCase();
  if (name === "f1") return "home";
  if (name === "f2") return "terminals";
  if (name === "f5") return "palette-open";
  if (name === "escape" && paletteOpen) return "palette-close";
  return null;
}

export interface ApplicationShellViewProps {
  readonly dimensions: Accessor<{ readonly width: number; readonly height: number }>;
  readonly surface: Accessor<RootSurface>;
  readonly semantic: Accessor<ApplicationShellProjectionV1 | null>;
  readonly generationStatus: Accessor<string>;
  readonly sessions: readonly string[] | Accessor<readonly string[]>;
  readonly selectedSession: Accessor<number>;
  readonly bootstrapNote: Accessor<string | null>;
  readonly paletteOpen: Accessor<boolean>;
  readonly paneRenameDialog?: Accessor<ApplicationPaneRenameDraft | null>;
  readonly paletteSelection?: Accessor<number>;
  readonly paletteCommands?: Accessor<readonly ApplicationPaletteCommand[]>;
  readonly terminalRendererSource: Accessor<{
    readonly adapter: TerminalWorkspaceProps["adapter"];
    readonly rendererEpoch: TerminalWorkspaceProps["rendererEpoch"];
  } | null>;
  readonly layout: TerminalWorkspaceProps["layout"];
  readonly focusedPane: Accessor<string | null>;
  readonly rendererFocused?: Accessor<boolean>;
  readonly hostFocusTransitionOwner?: TerminalWorkspaceProps["hostFocusTransitionOwner"];
  readonly theme: TerminalWorkspaceProps["theme"];
  readonly palette: TerminalWorkspaceProps["palette"];
  readonly onOpenSurface: (surface: RootSurface, source: InputSource) => void;
  readonly onOpenSession: (sessionName: string, source: InputSource) => void;
  readonly onOpenAgent?: (sessionName: string, paneId: string, source: InputSource) => void;
  readonly onSetPaletteOpen: (open: boolean, source: InputSource) => void;
  readonly onPaletteActivate?: (
    command: ApplicationPaletteCommand,
    source: InputSource,
    confirmed?: boolean,
  ) => void;
  readonly onCreateWindow?: () => void;
  readonly onBeginPaneRename?: (paneId: string, currentName: string) => void;
  readonly onCancelPaneRename?: () => void;
  readonly paletteCloseArmed?: Accessor<boolean>;
  readonly onSelectPane: TerminalWorkspaceProps["onSelectPane"];
  readonly onResizePreview: TerminalWorkspaceProps["onResizePreview"];
  readonly onResizePane: TerminalWorkspaceProps["onResizePane"];
  readonly onResizePointerIngress?: TerminalWorkspaceProps["onResizePointerIngress"];
  readonly onTerminalInput?: TerminalWorkspaceProps["onTerminalInput"];
  readonly terminalGestureRuntime?: TerminalWorkspaceProps["terminalGestureRuntime"];
  readonly onApplicationMousePointerIngress?: TerminalWorkspaceProps["onApplicationMousePointerIngress"];
  readonly onCopyText?: TerminalWorkspaceProps["onCopyText"];
  readonly onSelectionCopyOwner?: TerminalWorkspaceProps["onSelectionCopyOwner"];
  readonly onSelectionKeyOwner?: TerminalWorkspaceProps["onSelectionKeyOwner"];
  readonly onWindowPresented?: TerminalWorkspaceProps["onWindowPresented"];
  readonly onInteraction?: () => void;
}

function HomeSurface(props: {
  readonly project: string;
  readonly status: string;
  readonly note: string | null;
  readonly width: number;
  readonly height: number;
  readonly sessionCount: number;
  readonly session?: string | null;
  readonly agents?: readonly ApplicationTerminalAgentIndicator[];
  readonly branded: boolean;
  readonly theme: ApplicationShellViewProps["theme"];
  readonly onOpenTerminals: () => void;
  readonly onOpenCommands: () => void;
}): JSX.Element {
  const working = () => props.agents?.filter((agent) => agent.activity === "running").length ?? 0;
  const attention = () => props.agents?.filter((agent) => agent.attention).length ?? 0;
  const variant = () => applicationHomeBrandVariant(props.width, props.height);
  const brandLines = () =>
    variant() === "full"
      ? APPLICATION_HOME_FULL_LOGO.split("\n").map((line) => line.trimEnd())
      : variant() === "compact"
        ? [...APPLICATION_HOME_COMPACT_LOGO]
        : ["tmux-ide"];
  const brandWidth = () =>
    variant() === "full"
      ? APPLICATION_HOME_FULL_LOGO_WIDTH
      : variant() === "compact"
        ? APPLICATION_HOME_COMPACT_LOGO_WIDTH
        : 8;
  const availableWidth = () => Math.max(1, props.width - (props.width >= 8 ? 4 : 0));
  const tagline = () =>
    clipTerminal(
      variant() === "full"
        ? "Your tmux sessions, panes, and coding agents — one resilient workspace."
        : "Your tmux sessions and agents, in one place.",
      availableWidth(),
    );
  const summary = () =>
    clipTerminal(
      `${props.sessionCount} ${props.sessionCount === 1 ? "session" : "sessions"} · ${working()} working · ${attention()} need attention`,
      availableWidth(),
    );
  const context = () =>
    clipTerminal(`${props.session ?? "No session selected"} · ${props.status}`, availableWidth());
  const note = () => (props.note ? clipTerminal(props.note, availableWidth()) : null);
  const actionsInRow = () => props.width >= 42;

  if (!props.branded) {
    return (
      <box
        width={props.width}
        height={props.height}
        flexDirection="column"
        justifyContent="center"
        alignItems="center"
        gap={1}
        overflow="hidden"
      >
        <text fg={props.theme.roles.text.primary}>
          <strong>{clipTerminal(props.project, availableWidth())}</strong>
        </text>
        <text fg={props.theme.roles.text.muted}>{context()}</text>
        <Show when={note()}>
          {(message) => <text fg={props.theme.roles.text.link}>{message()}</text>}
        </Show>
      </box>
    );
  }

  return (
    <box
      width={props.width}
      height={props.height}
      flexDirection="column"
      justifyContent="center"
      alignItems="center"
      gap={variant() === "wordmark" ? 0 : 1}
      overflow="hidden"
    >
      <box width={brandWidth()} flexDirection="column">
        <For each={brandLines()}>
          {(line) => (
            <text width={brandWidth()} fg={props.theme.roles.text.link}>
              {line}
            </text>
          )}
        </For>
      </box>
      <Show when={variant() !== "wordmark"}>
        <text fg={props.theme.roles.text.secondary}>{tagline()}</text>
      </Show>
      <text fg={props.theme.roles.text.primary}>
        <strong>{summary()}</strong>
      </text>
      <text fg={props.theme.roles.text.muted}>{context()}</text>
      <box
        flexDirection={actionsInRow() ? "row" : "column"}
        alignItems="center"
        gap={actionsInRow() ? 2 : 0}
      >
        <box
          height={1}
          backgroundColor={props.theme.roles.selection.hover}
          onMouseDown={(event) => {
            event.stopPropagation();
            props.onOpenTerminals();
          }}
        >
          <text fg={props.theme.roles.text.primary}> F2 Open terminals </text>
        </box>
        <box
          height={1}
          backgroundColor={props.theme.roles.selection.hover}
          onMouseDown={(event) => {
            event.stopPropagation();
            props.onOpenCommands();
          }}
        >
          <text fg={props.theme.roles.text.primary}> F5 Commands </text>
        </box>
      </box>
      <Show when={note()}>
        {(message) => <text fg={props.theme.roles.text.link}>{message()}</text>}
      </Show>
    </box>
  );
}

function PaneRenameDialog(props: {
  readonly draft: ApplicationPaneRenameDraft;
  readonly width: number;
  readonly height: number;
  readonly theme: ApplicationShellViewProps["theme"];
  readonly onCancel: () => void;
}): JSX.Element {
  const width = () => Math.max(1, Math.min(52, props.width - (props.width >= 8 ? 4 : 0)));
  const fieldWidth = () => Math.max(1, width() - 4);
  return (
    <box
      position="absolute"
      left={0}
      top={0}
      width={props.width}
      height={props.height}
      zIndex={120}
      onMouseDown={(event) => {
        event.stopPropagation();
        props.onCancel();
      }}
    >
      <box
        position="absolute"
        left={Math.max(0, Math.floor((props.width - width()) / 2))}
        top={Math.max(0, Math.floor((props.height - 7) / 2))}
        width={width()}
        height={7}
        border
        borderStyle="rounded"
        borderColor={props.theme.roles.borders.focused}
        backgroundColor={props.theme.roles.surfaces.panelRaised}
        flexDirection="column"
        paddingLeft={1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <text fg={props.theme.roles.text.primary}>
          <strong>Rename pane</strong>
        </text>
        <text
          width={fieldWidth()}
          overflow="hidden"
          fg={props.theme.roles.text.link}
          content={clipTerminal(`${props.draft.value}▏`, fieldWidth())}
        />
        <text
          width={fieldWidth()}
          overflow="hidden"
          fg={props.theme.roles.text.muted}
          content="Enter save · Esc cancel"
        />
      </box>
    </box>
  );
}

function MinimalPalette(props: {
  readonly width: number;
  readonly height: number;
  readonly selected: number;
  readonly closeArmed: boolean;
  readonly commands: readonly ApplicationPaletteCommand[];
  readonly theme: ApplicationShellViewProps["theme"];
  readonly onActivate: (command: ApplicationPaletteCommand) => void;
  readonly onClose: () => void;
}): JSX.Element {
  const horizontalInset = () => (props.width >= 8 ? 2 : 0);
  const verticalInset = () => (props.height >= 6 ? 1 : 0);
  const width = () => Math.max(1, Math.min(58, props.width - horizontalInset() * 2));
  const height = () =>
    Math.max(3, Math.min(16, props.commands.length + 4, props.height - verticalInset() * 2));
  const innerWidth = () => Math.max(1, width() - 2);
  const commandLabel = (command: ApplicationPaletteCommand): string => {
    if (typeof command === "object") return `Jump to ${command.label} · ${command.sessionName}`;
    if (command === "home")
      return `F1 Home${innerWidth() >= 32 ? " · sessions and agent state" : ""}`;
    if (command === "terminals")
      return `F2 Terminals${innerWidth() >= 32 ? " · control the live tmux session" : ""}`;
    if (command === "new-window") return "New terminal window";
    if (command === "split-right") return "Split pane right";
    if (command === "split-down") return "Split pane down";
    return props.closeArmed ? "Confirm close pane" : "Close pane…";
  };
  // OpenTUI clips the final row against the lower border at very small
  // viewports; retain the existing four-command 20x7 presentation while
  // scrolling longer agent lists only when they exceed the rendered body.
  const visibleCapacity = () => Math.max(1, height() - 1);
  const firstVisible = () =>
    Math.max(0, Math.min(props.selected, props.commands.length - visibleCapacity()));
  const commandRows = () =>
    props.commands
      .slice(firstVisible(), firstVisible() + visibleCapacity())
      .map((command, offset) => {
        const index = firstVisible() + offset;
        return {
          command,
          index,
          label: `${props.selected === index ? "› " : ""}${commandLabel(command)}`,
        };
      });
  return (
    <box
      position="absolute"
      left={0}
      top={0}
      width={props.width}
      height={props.height}
      zIndex={100}
      onMouseDown={(event) => {
        event.stopPropagation();
        props.onClose();
      }}
    >
      <box
        position="absolute"
        left={Math.max(0, Math.floor((props.width - width()) / 2))}
        top={Math.max(0, Math.floor((props.height - height()) / 2))}
        width={width()}
        height={height()}
        border
        borderStyle="rounded"
        borderColor={props.theme.roles.borders.focused}
        backgroundColor={props.theme.roles.surfaces.panelRaised}
        flexDirection="column"
        paddingLeft={1}
        overflow="hidden"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <text width={innerWidth()} fg={props.theme.roles.text.primary} overflow="hidden">
          <strong>{innerWidth() >= 15 ? "Command palette" : "Commands"}</strong>
        </text>
        <For each={commandRows()}>
          {(row) => (
            <text
              width={innerWidth()}
              height={1}
              overflow="hidden"
              content={row.label}
              fg={
                props.closeArmed && row.command === "close-pane"
                  ? props.theme.roles.statusTone.warning
                  : props.selected === row.index
                    ? props.theme.roles.selection.selectionText
                    : props.theme.roles.text.secondary
              }
              bg={
                props.selected === row.index
                  ? props.theme.roles.selection.selection
                  : props.theme.roles.surfaces.panelRaised
              }
              onMouseDown={() => props.onActivate(row.command)}
            />
          )}
        </For>
        <Show when={height() >= 9}>
          <text
            width={innerWidth()}
            overflow="hidden"
            fg={props.theme.roles.text.muted}
            content="↑↓ choose · Enter open · Esc close"
          />
        </Show>
      </box>
    </box>
  );
}

function ProductionSidebar(props: {
  readonly shell: ReturnType<typeof projectApplicationShell>;
  readonly theme: ApplicationShellViewProps["theme"];
  readonly onOpenAgent?: ApplicationShellViewProps["onOpenAgent"];
}): JSX.Element {
  const width = () => props.shell.layout.sidebar.width;
  const sessionTone = (state: string) =>
    state === "reconnecting"
      ? props.theme.roles.statusTone.warning
      : state === "connected"
        ? props.theme.roles.statusTone.success
        : props.theme.roles.statusTone.neutral;
  const activityTone = (activity: string) =>
    activity === "waiting"
      ? props.theme.roles.statusTone.warning
      : activity === "running"
        ? props.theme.roles.statusTone.info
        : activity === "complete"
          ? props.theme.roles.statusTone.success
          : props.theme.roles.statusTone.neutral;
  return (
    <box
      width={width()}
      height={props.shell.layout.sidebar.height}
      flexDirection="column"
      backgroundColor={props.theme.roles.surfaces.panel}
      paddingLeft={1}
      overflow="hidden"
    >
      <text fg={props.theme.roles.text.link}>
        <strong>{props.shell.layout.variant === "compact" ? " tmux" : " tmux-ide"}</strong>
      </text>
      <For each={props.shell.semantic.sidebar.sessions}>
        {(session) => {
          const active = () => session.id === props.shell.semantic.sidebar.activeSessionId;
          return (
            <box
              height={1}
              flexDirection="row"
              backgroundColor={
                active() ? props.theme.roles.selection.selection : props.theme.roles.surfaces.panel
              }
            >
              <text fg={sessionTone(session.state)}>{active() ? "●" : "○"}</text>
              <text
                fg={
                  active()
                    ? props.theme.roles.selection.selectionText
                    : props.theme.roles.text.secondary
                }
              >
                {clipTerminal(` ${session.label}`, Math.max(0, width() - 1))}
              </text>
            </box>
          );
        }}
      </For>
      <Show when={props.shell.semantic.sidebar.agents.length > 0}>
        <box height={1} marginTop={1}>
          <text fg={props.theme.roles.text.secondary}>
            <strong>Agents</strong>
          </text>
        </box>
        <For each={props.shell.semantic.sidebar.agents}>
          {(agent) => {
            const status = () => terminalAgentStatusLabel(agent.activity);
            const suffix = () => ` ${agent.attention ? "! " : ""}[${status()}]`;
            const titleWidth = () => Math.max(1, width() - 2 - suffix().length);
            return (
              <box
                height={1}
                flexDirection="row"
                onMouseDown={(event) => {
                  if (!agent.paneId) return;
                  event.stopPropagation();
                  props.onOpenAgent?.(props.shell.activeSession, agent.paneId, "mouse");
                }}
              >
                <text fg={activityTone(agent.activity)}>{agent.attention ? "!" : "•"}</text>
                <text
                  fg={
                    agent.attention
                      ? props.theme.roles.statusTone.warning
                      : props.theme.roles.text.secondary
                  }
                >
                  {` ${clipTerminal(agent.name, titleWidth())}${suffix()}`}
                </text>
              </box>
            );
          }}
        </For>
      </Show>
      <box flexGrow={1} />
      <box height={1} width={width()} flexDirection="row" overflow="hidden">
        <text fg={props.theme.roles.text.muted}>{props.shell.sidebarHint.pre}</text>
        <text fg={props.theme.roles.text.primary} bg={props.theme.roles.selection.hover}>
          {props.shell.sidebarHint.btn}
        </text>
        <text fg={props.theme.roles.text.muted}>{props.shell.sidebarHint.post}</text>
      </box>
    </box>
  );
}

/** Catalog-backed pre-connection shell. It never pretends to be daemon authority. */
function CatalogShell(props: ApplicationShellViewProps): JSX.Element {
  const sessions = (): readonly string[] =>
    typeof props.sessions === "function" ? props.sessions() : props.sessions;
  const chrome = createMemo(() =>
    shellChromeLayout(props.dimensions().width, props.dimensions().height, 28),
  );
  return (
    <box
      width={props.dimensions().width}
      height={props.dimensions().height}
      flexDirection="column"
      overflow="hidden"
      backgroundColor={props.theme.roles.surfaces.canvas}
    >
      <box
        height={1}
        width={props.dimensions().width}
        flexDirection="row"
        backgroundColor={props.theme.roles.surfaces.header}
      >
        <text fg={props.theme.roles.text.link}>
          <strong> tmux-ide </strong>
        </text>
        <text
          fg={
            props.surface() === "home"
              ? props.theme.roles.selection.selectionText
              : props.theme.roles.text.muted
          }
          onMouseDown={() => props.onOpenSurface("home", "mouse")}
        >
          {" F1 Home "}
        </text>
        <text
          fg={
            props.surface() === "terminals"
              ? props.theme.roles.selection.selectionText
              : props.theme.roles.text.muted
          }
          onMouseDown={() => props.onOpenSurface("terminals", "mouse")}
        >
          {" F2 Terminals "}
        </text>
        <text fg={props.theme.roles.text.muted}> catalog · no workspace authority </text>
      </box>
      <box height={chrome().sidebar.height} flexDirection="row" overflow="hidden">
        <box
          width={chrome().sidebar.width}
          height={chrome().sidebar.height}
          flexDirection="column"
          paddingLeft={1}
          backgroundColor={props.theme.roles.surfaces.panel}
        >
          <text fg={props.theme.roles.text.secondary}>Sessions</text>
          <For each={sessions()}>
            {(session, index) => (
              <box
                height={1}
                backgroundColor={
                  props.selectedSession() === index()
                    ? props.theme.roles.selection.selection
                    : props.theme.roles.surfaces.panel
                }
                onMouseDown={() => props.onOpenSession(session, "mouse")}
              >
                <text
                  fg={
                    props.selectedSession() === index()
                      ? props.theme.roles.selection.selectionText
                      : props.theme.roles.text.secondary
                  }
                >
                  {`${props.selectedSession() === index() ? "›" : " "} ${session}`}
                </text>
              </box>
            )}
          </For>
          <box flexGrow={1} />
          <text fg={props.theme.roles.text.muted}>F5 palette · ^q quit</text>
        </box>
        <box
          width={chrome().main.width}
          height={chrome().main.height}
          flexDirection="column"
          overflow="hidden"
        >
          <box flexGrow={1} overflow="hidden">
            <Show
              when={props.surface() === "home"}
              fallback={
                <HomeSurface
                  project="Terminals"
                  status={props.generationStatus()}
                  note={props.bootstrapNote() ?? "Select a session from Home to connect."}
                  width={chrome().main.width}
                  height={Math.max(1, chrome().main.height - chrome().status.height)}
                  sessionCount={sessions().length}
                  session={sessions()[props.selectedSession()] ?? null}
                  branded={false}
                  theme={props.theme}
                  onOpenTerminals={() => props.onOpenSurface("terminals", "mouse")}
                  onOpenCommands={() => props.onSetPaletteOpen(true, "mouse")}
                />
              }
            >
              <HomeSurface
                project="tmux-ide"
                status={props.generationStatus()}
                note={props.bootstrapNote()}
                width={chrome().main.width}
                height={Math.max(1, chrome().main.height - chrome().status.height)}
                sessionCount={sessions().length}
                session={sessions()[props.selectedSession()] ?? null}
                branded={true}
                theme={props.theme}
                onOpenTerminals={() => props.onOpenSurface("terminals", "mouse")}
                onOpenCommands={() => props.onSetPaletteOpen(true, "mouse")}
              />
            </Show>
          </box>
          <box height={chrome().status.height} backgroundColor={props.theme.roles.surfaces.header}>
            <text fg={props.theme.roles.text.muted}>
              {` ${props.generationStatus()} · ↑↓ choose · Enter open`}
            </text>
          </box>
        </box>
      </box>
      <Show when={props.paletteOpen()}>
        <MinimalPalette
          width={props.dimensions().width}
          height={props.dimensions().height}
          selected={props.paletteSelection?.() ?? 0}
          closeArmed={props.paletteCloseArmed?.() ?? false}
          commands={props.paletteCommands?.() ?? applicationPaletteCommands(null)}
          theme={props.theme}
          onActivate={(command) => {
            if (props.onPaletteActivate) props.onPaletteActivate(command, "mouse");
            else if (command === "home" || command === "terminals")
              props.onOpenSurface(command, "mouse");
          }}
          onClose={() => props.onSetPaletteOpen(false, "mouse")}
        />
      </Show>
    </box>
  );
}

/** Pure Solid composition over the WorkspaceClient semantic projection. */
export function ApplicationShellView(props: ApplicationShellViewProps): JSX.Element {
  const projection = createMemo(() => {
    const semantic = props.semantic();
    if (!semantic) return null;
    return projectApplicationShell({
      width: props.dimensions().width,
      height: props.dimensions().height,
      preferredSidebarWidth: 28,
      shell: semantic,
      hoveredTabIndex: null,
      quitHint: "^q quit",
    });
  });
  // Generation snapshots and semantic projections are immutable publications,
  // so both wrappers are freshly allocated for ordinary authority/presence
  // progress. Preserve the terminal owner unless the actual renderer changes.
  const terminalRendererSource = createMemo(() => props.terminalRendererSource(), undefined, {
    equals: (previous, next) =>
      previous?.adapter === next?.adapter && previous?.rendererEpoch === next?.rendererEpoch,
  });
  // This stable reactive facade keeps Solid/OpenTUI ownership anchored while
  // exposing every property from the latest immutable semantic projection.
  const retainedProjection = new Proxy({} as NonNullable<ReturnType<typeof projection>>, {
    get: (_target, property) => Reflect.get(projection()!, property),
  });
  const projectionOwner = createMemo(() => (projection() ? retainedProjection : null));
  const agentIndicators = createMemo<ReadonlyMap<string, ApplicationTerminalAgentIndicator>>(
    () =>
      new Map(
        (props.semantic()?.sidebar.agents ?? []).flatMap((agent) =>
          agent.paneId
            ? [
                [
                  agent.paneId,
                  {
                    name: agent.name,
                    activity: agent.activity,
                    attention: agent.attention,
                  },
                ] as const,
              ]
            : [],
        ),
      ),
  );
  const routeChromePointer = (x: number, y: number): void => {
    const shell = projection();
    if (!shell) return;
    const hit = applicationShellHitTest(shell, x, y);
    if (hit?.kind === "view") props.onOpenSurface(hit.viewId, "mouse");
    else if (hit?.kind === "session") props.onOpenSession(hit.session, "mouse");
    else if (hit?.kind === "palette") props.onSetPaletteOpen(true, "mouse");
  };

  return (
    <Show when={projectionOwner()} keyed fallback={<CatalogShell {...props} />}>
      {(shell) => (
        <box
          width={props.dimensions().width}
          height={props.dimensions().height}
          position="relative"
          overflow="hidden"
          onMouseDown={(event) => {
            props.onInteraction?.();
            routeChromePointer(event.x, event.y);
          }}
        >
          <ApplicationShell
            theme={props.theme}
            projection={shell}
            help="^o pane · ^t window · F5 split/close · ^q put away"
            note={props.bootstrapNote() ?? props.generationStatus()}
            showToolStatus={false}
            sidebar={
              <ProductionSidebar
                shell={shell}
                theme={props.theme}
                onOpenAgent={props.onOpenAgent}
              />
            }
          >
            <Show
              when={props.surface() === "terminals"}
              fallback={
                <HomeSurface
                  project={shell.semantic.project.name}
                  status={props.generationStatus()}
                  note={props.bootstrapNote()}
                  width={shell.content.width}
                  height={shell.content.height}
                  sessionCount={shell.semantic.sidebar.sessions.length}
                  session={shell.activeSession}
                  agents={[...agentIndicators().values()]}
                  branded={true}
                  theme={props.theme}
                  onOpenTerminals={() => props.onOpenSurface("terminals", "mouse")}
                  onOpenCommands={() => props.onSetPaletteOpen(true, "mouse")}
                />
              }
            >
              <box
                position="relative"
                width={shell.content.width}
                height={shell.content.height}
                overflow="hidden"
              >
                <Show
                  when={terminalRendererSource()}
                  keyed
                  fallback={
                    <HomeSurface
                      project="Terminal workspace"
                      status={props.generationStatus()}
                      note={props.bootstrapNote() ?? "Waiting for a coherent terminal frame."}
                      width={shell.content.width}
                      height={shell.content.height}
                      sessionCount={shell.semantic.sidebar.sessions.length}
                      session={shell.activeSession}
                      branded={false}
                      theme={props.theme}
                      onOpenTerminals={() => props.onOpenSurface("terminals", "mouse")}
                      onOpenCommands={() => props.onSetPaletteOpen(true, "mouse")}
                    />
                  }
                >
                  {(source) => (
                    <ApplicationTerminalWorkspace
                      layout={props.layout}
                      adapter={source.adapter}
                      rendererEpoch={source.rendererEpoch}
                      width={shell.content.width}
                      height={Math.max(2, shell.content.height - 1)}
                      topOffset={1}
                      originX={shell.content.x}
                      originY={shell.content.y}
                      focusedPane={props.focusedPane()}
                      rendererFocused={props.rendererFocused?.() ?? props.focusedPane() !== null}
                      hostFocusTransitionOwner={props.hostFocusTransitionOwner}
                      theme={props.theme}
                      palette={props.palette}
                      agentIndicators={agentIndicators}
                      onSelectPane={props.onSelectPane}
                      onCreateWindow={props.onCreateWindow}
                      onPaneContextAction={(paneId, action, currentName) => {
                        if (action === "rename-pane")
                          props.onBeginPaneRename?.(paneId, currentName);
                        else props.onPaletteActivate?.(action, "mouse", true);
                      }}
                      onResizePreview={props.onResizePreview}
                      onResizePane={props.onResizePane}
                      onResizePointerIngress={props.onResizePointerIngress}
                      onTerminalInput={props.onTerminalInput}
                      terminalGestureRuntime={props.terminalGestureRuntime}
                      onApplicationMousePointerIngress={props.onApplicationMousePointerIngress}
                      onCopyText={props.onCopyText}
                      onSelectionCopyOwner={props.onSelectionCopyOwner}
                      onSelectionKeyOwner={props.onSelectionKeyOwner}
                      onWindowPresented={props.onWindowPresented}
                    />
                  )}
                </Show>
              </box>
            </Show>
          </ApplicationShell>
          <Show when={props.paletteOpen()}>
            <MinimalPalette
              width={props.dimensions().width}
              height={props.dimensions().height}
              selected={props.paletteSelection?.() ?? 0}
              closeArmed={props.paletteCloseArmed?.() ?? false}
              commands={props.paletteCommands?.() ?? applicationPaletteCommands(props.semantic())}
              theme={props.theme}
              onActivate={(command) => {
                if (props.onPaletteActivate) props.onPaletteActivate(command, "mouse");
                else if (command === "home" || command === "terminals")
                  props.onOpenSurface(command, "mouse");
              }}
              onClose={() => props.onSetPaletteOpen(false, "mouse")}
            />
          </Show>
          <Show when={props.paneRenameDialog?.()} keyed>
            {(draft) => (
              <PaneRenameDialog
                draft={draft}
                width={props.dimensions().width}
                height={props.dimensions().height}
                theme={props.theme}
                onCancel={() => props.onCancelPaneRename?.()}
              />
            )}
          </Show>
        </box>
      )}
    </Show>
  );
}
