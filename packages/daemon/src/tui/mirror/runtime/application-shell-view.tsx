/* @jsxImportSource @opentui/solid */
import type { ApplicationShellProjectionV1 } from "@tmux-ide/contracts";
import type { Accessor, ComponentProps, JSX } from "solid-js";
import { For, Show, createMemo } from "solid-js";

import { shellChromeLayout, type ShellChromeView } from "../shell-chrome.ts";
import { clipTerminal, friendlySessionLabel } from "../terminal-text.ts";
import {
  ApplicationCatalogTabBar,
  ApplicationShell,
} from "../workspace/application-shell-view.tsx";
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
import { Button } from "../ui/button.tsx";
import { Dialog } from "../ui/dialog.tsx";
import { StatusBar, StatusBarAction, StatusBarGroup, StatusBarSegment } from "../ui/status-bar.tsx";
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
  readonly catalogPhase?: Accessor<"loading" | "live" | "unavailable">;
  readonly catalogNote?: Accessor<string | null>;
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
  readonly onCreateSession?: () => void;
  readonly onCycleTheme?: () => void;
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

const CATALOG_VIEWS: readonly ShellChromeView[] = [
  { id: "home", title: "Home", glyph: "⌂", shortcut: { key: "f1", label: "F1" } },
  {
    id: "terminals",
    title: "Terminals",
    glyph: "●",
    shortcut: { key: "f2", label: "F2" },
  },
] as const;

function CatalogTerminalSurface(props: {
  readonly phase: "loading" | "live" | "unavailable";
  readonly sessionCount: number;
  readonly note: string | null;
  readonly width: number;
  readonly height: number;
  readonly theme: ApplicationShellViewProps["theme"];
  readonly onCreateSession?: () => void;
}): JSX.Element {
  const title = () => {
    if (props.phase === "loading") return "Finding tmux sessions…";
    if (props.phase === "unavailable") return "Reconnecting to tmux-ide…";
    if (props.sessionCount === 0) return "No tmux sessions are running";
    return `${props.sessionCount} tmux ${props.sessionCount === 1 ? "session" : "sessions"} available`;
  };
  const detail = () => {
    if (props.note && !props.note.startsWith("Discovering live tmux sessions")) return props.note;
    if (props.phase === "live" && props.sessionCount === 0)
      return "Start a local workspace here, or open tmux in another terminal.";
    if (props.sessionCount > 0) return "Choose a session from the sidebar to open it.";
    return null;
  };
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
        <strong>Terminals</strong>
      </text>
      <text fg={props.theme.roles.text.secondary}>{clipTerminal(title(), props.width - 4)}</text>
      <Show when={detail()}>
        {(message) => (
          <text fg={props.theme.roles.text.muted}>{clipTerminal(message(), props.width - 4)}</text>
        )}
      </Show>
      <Show when={props.phase === "live" && props.sessionCount === 0 && props.onCreateSession}>
        <Button
          theme={props.theme}
          label="New local session"
          shortcut="N"
          variant="primary"
          onPress={props.onCreateSession}
        />
      </Show>
    </box>
  );
}

function CatalogStatusStrip(props: {
  readonly width: number;
  readonly surface: RootSurface;
  readonly phase: "loading" | "live" | "unavailable";
  readonly sessionCount: number;
  readonly note: string | null;
  readonly theme: ApplicationShellViewProps["theme"];
  readonly onOpenCommands: () => void;
  readonly onCreateSession?: () => void;
}): JSX.Element {
  const context = () => (props.surface === "home" ? "Home" : "Terminals");
  const message = () => {
    if (props.note && !props.note.startsWith("Discovering live tmux sessions")) return props.note;
    if (props.phase === "loading") return "Finding tmux sessions";
    if (props.phase === "unavailable") return "Reconnecting to daemon";
    return props.sessionCount === 0
      ? "No sessions running"
      : `${props.sessionCount} ${props.sessionCount === 1 ? "session" : "sessions"} live`;
  };
  const contextWidth = () => Math.min(14, Math.max(6, context().length + 2));
  const canCreate = () =>
    props.phase === "live" && props.sessionCount === 0 && Boolean(props.onCreateSession);
  const actionWidth = () => (canCreate() ? 34 : 15);
  return (
    <StatusBar theme={props.theme} width={props.width}>
      <StatusBarGroup width={contextWidth()}>
        <StatusBarSegment theme={props.theme} label={context()} width={contextWidth()} active />
      </StatusBarGroup>
      <StatusBarGroup grow>
        <StatusBarSegment
          theme={props.theme}
          label={message()}
          tone={props.phase === "unavailable" ? "blocked" : undefined}
        />
      </StatusBarGroup>
      <StatusBarGroup width={actionWidth()} align="end">
        <Show when={canCreate()}>
          <StatusBarAction
            theme={props.theme}
            label="New session"
            shortcut="N"
            width={19}
            onPress={props.onCreateSession!}
          />
        </Show>
        <StatusBarAction
          theme={props.theme}
          label="Commands"
          shortcut="F5"
          width={15}
          primary
          onPress={props.onOpenCommands}
        />
      </StatusBarGroup>
    </StatusBar>
  );
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
  readonly onCycleTheme?: () => void;
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
        <Button
          theme={props.theme}
          label="Open terminals"
          shortcut="F2"
          variant="primary"
          onPress={props.onOpenTerminals}
        />
        <Button theme={props.theme} label="Commands" shortcut="F5" onPress={props.onOpenCommands} />
        <Show when={props.onCycleTheme}>
          {(onCycleTheme) => (
            <Button
              theme={props.theme}
              label={`Theme: ${props.theme.setting}`}
              variant="ghost"
              onPress={onCycleTheme()}
            />
          )}
        </Show>
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
    <Dialog
      theme={props.theme}
      viewportWidth={props.width}
      viewportHeight={props.height}
      width={width()}
      height={7}
      title="Rename pane"
      footer="Enter save · Esc cancel"
      onDismiss={props.onCancel}
    >
      <text
        width={fieldWidth()}
        overflow="hidden"
        fg={props.theme.roles.text.link}
        content={clipTerminal(`${props.draft.value}▏`, fieldWidth())}
      />
    </Dialog>
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
  const visibleCapacity = () => Math.max(1, height() - (height() >= 9 ? 4 : 3));
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
    <Dialog
      theme={props.theme}
      viewportWidth={props.width}
      viewportHeight={props.height}
      width={width()}
      height={height()}
      title={innerWidth() >= 15 ? "Command palette" : "Commands"}
      {...(height() >= 9 ? { footer: "↑↓ choose · Enter open · Esc close" } : {})}
      onDismiss={props.onClose}
    >
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
    </Dialog>
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
                {clipTerminal(` ${friendlySessionLabel(session.label)}`, Math.max(0, width() - 1))}
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
  // Catalog navigation is the first-run wayfinding surface. Keep its two
  // labels visible at compact widths; the icon-only terminal chrome is useful
  // once a workspace needs every column, but is cryptic before one exists.
  const catalogChromeVariant = () =>
    chrome().variant === "compact" ? ("standard" as const) : chrome().variant;
  const phase = (): "loading" | "live" | "unavailable" =>
    props.catalogPhase?.() ?? (sessions().length > 0 ? "live" : "loading");
  const note = () => props.bootstrapNote() ?? props.catalogNote?.() ?? null;
  const homeStatus = () => {
    if (phase() === "loading") return "finding sessions";
    if (phase() === "unavailable") return "reconnecting";
    return sessions().length === 0 ? "ready" : `${sessions().length} available`;
  };
  const topStatus = () => {
    if (phase() === "loading") return " ○ finding sessions ";
    if (phase() === "unavailable") return " ! reconnecting ";
    return sessions().length === 0 ? " ○ no sessions " : ` ● ${sessions().length} live `;
  };
  const showCatalogSidebar = () => props.surface() === "terminals";
  const catalogContentWidth = () =>
    showCatalogSidebar() ? chrome().main.width : props.dimensions().width;
  return (
    <box
      width={props.dimensions().width}
      height={props.dimensions().height}
      flexDirection="column"
      overflow="hidden"
      backgroundColor={props.theme.roles.surfaces.canvas}
    >
      <ApplicationCatalogTabBar
        theme={props.theme}
        width={props.dimensions().width}
        variant={catalogChromeVariant()}
        views={CATALOG_VIEWS}
        activeViewId={props.surface()}
        hoveredIndex={null}
        rightChips={[
          {
            id: "catalog-status",
            label: topStatus(),
            attention: phase() === "unavailable",
            context: phase() === "loading",
          },
        ]}
        onSelectView={(viewId) => {
          if (viewId === "home" || viewId === "terminals") props.onOpenSurface(viewId, "mouse");
        }}
      />
      <box height={chrome().sidebar.height} flexDirection="row" overflow="hidden">
        <Show when={showCatalogSidebar()}>
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
                    {`${props.selectedSession() === index() ? "›" : " "} ${friendlySessionLabel(session)}`}
                  </text>
                </box>
              )}
            </For>
            <Show when={sessions().length === 0}>
              <text fg={props.theme.roles.text.muted}> No sessions yet</text>
            </Show>
            <box flexGrow={1} />
          </box>
        </Show>
        <box
          width={catalogContentWidth()}
          height={chrome().main.height}
          flexDirection="column"
          overflow="hidden"
        >
          <box flexGrow={1} overflow="hidden">
            <Show
              when={props.surface() === "home"}
              fallback={
                <CatalogTerminalSurface
                  phase={phase()}
                  sessionCount={sessions().length}
                  note={note()}
                  width={catalogContentWidth()}
                  height={Math.max(1, chrome().main.height - chrome().status.height)}
                  theme={props.theme}
                  onCreateSession={props.onCreateSession}
                />
              }
            >
              <HomeSurface
                project="tmux-ide"
                status={homeStatus()}
                note={note()}
                width={catalogContentWidth()}
                height={Math.max(1, chrome().main.height - chrome().status.height)}
                sessionCount={sessions().length}
                session={
                  sessions()[props.selectedSession()]
                    ? friendlySessionLabel(sessions()[props.selectedSession()]!)
                    : null
                }
                branded={true}
                theme={props.theme}
                onOpenTerminals={() => props.onOpenSurface("terminals", "mouse")}
                onOpenCommands={() => props.onSetPaletteOpen(true, "mouse")}
                onCycleTheme={props.onCycleTheme}
              />
            </Show>
          </box>
          <Show when={chrome().status.height > 0}>
            <CatalogStatusStrip
              width={catalogContentWidth()}
              surface={props.surface()}
              phase={phase()}
              sessionCount={sessions().length}
              note={note()}
              theme={props.theme}
              onOpenCommands={() => props.onSetPaletteOpen(true, "mouse")}
              onCreateSession={props.onCreateSession}
            />
          </Show>
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
  // OpenTUI retains native renderables aggressively. Key the visual shell by
  // the immutable appearance snapshot so a live theme switch cannot leave
  // previously painted box/framebuffer backgrounds behind. The daemon,
  // terminal parser, and renderer adapter stay resident; only presentation is
  // rebuilt for this rare user action.
  const projectionOwner = createMemo(
    () =>
      projection()
        ? { shell: retainedProjection, theme: props.theme, palette: props.palette }
        : null,
    undefined,
    {
      equals: (previous, next) =>
        previous === next ||
        (previous !== null &&
          next !== null &&
          previous.theme === next.theme &&
          previous.palette === next.palette),
    },
  );
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
      {(appearance) => {
        const shell = appearance.shell;
        return (
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
              theme={appearance.theme}
              projection={shell}
              help="F5 commands"
              onHelp={() => props.onSetPaletteOpen(true, "mouse")}
              note={props.bootstrapNote() ?? props.generationStatus()}
              showToolStatus={false}
              showSidebar={props.surface() === "terminals"}
              sidebar={
                <ProductionSidebar
                  shell={shell}
                  theme={appearance.theme}
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
                    width={shell.layout.width}
                    height={shell.content.height}
                    sessionCount={shell.semantic.sidebar.sessions.length}
                    session={friendlySessionLabel(shell.activeSession)}
                    agents={[...agentIndicators().values()]}
                    branded={true}
                    theme={appearance.theme}
                    onOpenTerminals={() => props.onOpenSurface("terminals", "mouse")}
                    onOpenCommands={() => props.onSetPaletteOpen(true, "mouse")}
                    onCycleTheme={props.onCycleTheme}
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
                        theme={appearance.theme}
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
                        theme={appearance.theme}
                        palette={appearance.palette}
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
                theme={appearance.theme}
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
                  theme={appearance.theme}
                  onCancel={() => props.onCancelPaneRename?.()}
                />
              )}
            </Show>
          </box>
        );
      }}
    </Show>
  );
}
