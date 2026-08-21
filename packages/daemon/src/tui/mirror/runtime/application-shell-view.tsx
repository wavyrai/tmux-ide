/* @jsxImportSource @opentui/solid */
import type { ApplicationShellProjectionV1 } from "@tmux-ide/contracts";
import type { Accessor, ComponentProps, JSX } from "solid-js";
import { For, Show, createMemo } from "solid-js";

import { shellChromeLayout } from "../shell-chrome.ts";
import { clipTerminal } from "../terminal-text.ts";
import { ApplicationShell } from "../workspace/application-shell.tsx";
import {
  applicationShellHitTest,
  projectApplicationShell,
} from "../workspace/application-shell.ts";
import { ApplicationTerminalWorkspace } from "./application-terminal-workspace.tsx";

type TerminalWorkspaceProps = ComponentProps<typeof ApplicationTerminalWorkspace>;
type RootSurface = "home" | "terminals";
type InputSource = "keyboard" | "mouse";

export type ApplicationShellKeyAction = "home" | "terminals" | "palette-open" | "palette-close";

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
  readonly sessions: readonly string[];
  readonly selectedSession: Accessor<number>;
  readonly bootstrapNote: Accessor<string | null>;
  readonly paletteOpen: Accessor<boolean>;
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
  readonly onSetPaletteOpen: (open: boolean, source: InputSource) => void;
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
}

/** The one physical terminal viewport after production shell chrome. */
export function applicationShellViewport(
  dimensions: { readonly width: number; readonly height: number },
  hasSemanticShell: boolean,
): { readonly width: number; readonly height: number } {
  if (!hasSemanticShell)
    return {
      width: Math.max(1, dimensions.width),
      height: Math.max(2, dimensions.height - 2),
    };
  const shell = shellChromeLayout(dimensions.width, dimensions.height, 28);
  return {
    width: Math.max(1, shell.main.width),
    height: Math.max(2, shell.main.height - shell.status.height - 1),
  };
}

function HomeSurface(props: {
  readonly project: string;
  readonly status: string;
  readonly note: string | null;
  readonly theme: ApplicationShellViewProps["theme"];
}): JSX.Element {
  return (
    <box flexDirection="column" paddingLeft={2} paddingTop={2} gap={1}>
      <text fg={props.theme.roles.text.primary}>
        <strong>{props.project}</strong>
      </text>
      <text fg={props.theme.roles.text.secondary}>
        A visual client for the tmux sessions you already own.
      </text>
      <text fg={props.theme.roles.text.muted}>{`Workspace state: ${props.status}`}</text>
      <Show when={props.note}>
        {(note) => <text fg={props.theme.roles.text.link}>{note()}</text>}
      </Show>
    </box>
  );
}

function MinimalPalette(props: {
  readonly width: number;
  readonly theme: ApplicationShellViewProps["theme"];
}): JSX.Element {
  const width = Math.max(32, Math.min(58, props.width - 4));
  return (
    <box
      position="absolute"
      left={Math.max(2, Math.floor((props.width - width) / 2))}
      top={3}
      width={width}
      height={7}
      zIndex={100}
      border
      borderStyle="rounded"
      borderColor={props.theme.roles.borders.focused}
      backgroundColor={props.theme.roles.surfaces.panelRaised}
      flexDirection="column"
      paddingLeft={1}
    >
      <text fg={props.theme.roles.text.primary}>
        <strong>Command palette</strong>
      </text>
      <text fg={props.theme.roles.text.link}>F1 Home</text>
      <text fg={props.theme.roles.text.link}>F2 Terminals</text>
      <text fg={props.theme.roles.text.muted}>Esc close</text>
    </box>
  );
}

function ProductionSidebar(props: {
  readonly shell: ReturnType<typeof projectApplicationShell>;
  readonly theme: ApplicationShellViewProps["theme"];
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
          {(agent) => (
            <box height={1} flexDirection="row">
              <text fg={activityTone(agent.activity)}>{agent.attention ? "!" : "•"}</text>
              <text
                fg={
                  agent.attention
                    ? props.theme.roles.statusTone.warning
                    : props.theme.roles.text.secondary
                }
              >
                {clipTerminal(` ${agent.name}`, Math.max(0, width() - 1))}
              </text>
            </box>
          )}
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
          <For each={props.sessions}>
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
                  theme={props.theme}
                />
              }
            >
              <HomeSurface
                project="tmux-ide"
                status={props.generationStatus()}
                note={props.bootstrapNote()}
                theme={props.theme}
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
        <MinimalPalette width={props.dimensions().width} theme={props.theme} />
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
          onMouseDown={(event) => routeChromePointer(event.x, event.y)}
        >
          <ApplicationShell
            theme={props.theme}
            projection={shell}
            help="F5 palette · F1 Home · F2 Terminals · ^q quit"
            note={props.generationStatus()}
            showToolStatus={false}
            sidebar={<ProductionSidebar shell={shell} theme={props.theme} />}
          >
            <Show
              when={props.surface() === "terminals"}
              fallback={
                <HomeSurface
                  project={shell.semantic.project.name}
                  status={props.generationStatus()}
                  note={props.bootstrapNote()}
                  theme={props.theme}
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
                      theme={props.theme}
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
                      onSelectPane={props.onSelectPane}
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
            <MinimalPalette width={props.dimensions().width} theme={props.theme} />
          </Show>
        </box>
      )}
    </Show>
  );
}
